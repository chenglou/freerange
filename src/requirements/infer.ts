import type {SiteID, ValueID} from '../ir/ids.ts'
import type {EdgeIR, InstructionIR} from '../ir/instructions.ts'
import type {FunctionIR} from '../ir/program.ts'
import type {InferredPrecondition, NumericExpression} from './model.ts'

export type ParameterPathResolver = (parameter: number, properties: string[]) => NumericExpression[]

export type ExpressionContext = {
  parameterExpressions: Array<NumericExpression | null>
  parameterPathResolver?: ParameterPathResolver
  // Calls pass the caller's value keys directly, so duplicate arguments and facts created
  // in a callee refer to the same identity as the caller. Local keys use a nested namespace
  // to avoid colliding with the caller's ValueIDs.
  parameterIdentityKeys: string[]
  identityNamespace: string
  parameterIndexByValue: Array<number | undefined>
  blockParameterSources: Array<Array<{edge: EdgeIR; value: ValueID}> | undefined>
  activeEdges: Set<EdgeIR>
  instructionByValue: Array<InstructionIR | undefined>
  instructionCount: number
  maximumPropertyPathLength: number
}

export function createExpressionContext(
  fn: FunctionIR,
  parameterExpressions: Array<NumericExpression | null>,
  parameterPathResolver?: ParameterPathResolver,
  parameterIdentityKeys?: string[],
  identityNamespace = `${fn.name}/`,
): ExpressionContext {
  const identityKeys = parameterIdentityKeys ?? fn.parameters.map((_, index) => `p${index}`)
  if (identityKeys.length !== fn.parameters.length) {
    throw new Error(`Expected ${fn.parameters.length} parameter identity keys for ${fn.name}`)
  }
  const context: ExpressionContext = {
    parameterExpressions,
    ...(parameterPathResolver == null ? {} : {parameterPathResolver}),
    parameterIdentityKeys: identityKeys,
    identityNamespace,
    parameterIndexByValue: [],
    blockParameterSources: [],
    activeEdges: new Set(),
    instructionByValue: [],
    instructionCount: 0,
    maximumPropertyPathLength: 0,
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    context.parameterIndexByValue[fn.parameters[index]!.value] = index
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      context.instructionByValue[instruction.result] = instruction
      context.instructionCount += 1
    }
    const addEdge = (edge: {block: number; arguments: ValueID[]}): void => {
      const target = fn.blocks[edge.block]
      if (target == null || target.parameters.length !== edge.arguments.length) return
      for (let index = 0; index < edge.arguments.length; index++) {
        const parameter = target.parameters[index]!
        context.blockParameterSources[parameter] = [
          ...(context.blockParameterSources[parameter] ?? []),
          {edge, value: edge.arguments[index]!},
        ]
      }
    }
    if (block.terminator.kind === 'jump') addEdge(block.terminator.target)
    if (block.terminator.kind === 'branch') {
      addEdge(block.terminator.whenTrue)
      addEdge(block.terminator.whenFalse)
    }
  }
  const depthByValue: Array<number | undefined> = []
  const propertyDepth = (value: ValueID): number => {
    const known = depthByValue[value]
    if (known != null) return known
    const instruction = context.instructionByValue[value]
    const depth = instruction?.kind === 'property' ? 1 + propertyDepth(instruction.object) : 0
    depthByValue[value] = depth
    return depth
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      context.maximumPropertyPathLength = Math.max(
        context.maximumPropertyPathLength,
        propertyDepth(instruction.result),
      )
    }
  }
  return context
}

// Follow assignments and reads through records built in this function. The returned IR
// value is the value that was actually stored, so ordinary analysis, assertion proofs,
// and requirement expressions all use the same definition of identity.
export function resolveStoredValue(value: ValueID, context: ExpressionContext): ValueID {
  const producer = context.instructionByValue[value]
  if (producer?.kind === 'moduleWrite') return resolveStoredValue(producer.value, context)
  if (producer?.kind === 'property') {
    const object = resolveStoredValue(producer.object, context)
    const objectProducer = context.instructionByValue[object]
    if (objectProducer?.kind === 'object') {
      const property = objectProducer.properties.find(candidate => candidate.name === producer.property)
      if (property != null) return resolveStoredValue(property.value, context)
    }
  }
  return value
}

// The producer walk expands a value's defining DAG into an expression tree, and a value
// used twice appears twice — chained squaring (`const b = a * a; const c = b * b`) doubles
// per level, so tree size is exponential in the worst case while the DAG stays linear.
// The budget is by construction, not a magic number: each visit charges against the
// function's own instruction count, so a requirement can never be more complex than the
// function that produced it. Exhaustion returns null, which surfaces as the nonzero-divisor
// assumes line (or the element-in-bounds assumes line for element reads) — analysis keeps
// going either way.
export function numericExpression(value: ValueID, context: ExpressionContext): NumericExpression | null {
  let remainingVisits = context.instructionCount
  const walk = (current: ValueID): NumericExpression | null => {
    const stored = resolveStoredValue(current, context)
    if (stored !== current) return walk(stored)
    const parameterPath = parameterPathForValue(current, context)
    if (parameterPath != null) {
      if (context.parameterPathResolver != null) {
        return oneExpression(context.parameterPathResolver(parameterPath.parameter, parameterPath.properties))
      }
      return appendProperties(
        context.parameterExpressions[parameterPath.parameter] ?? null,
        parameterPath.properties,
      )
    }
    const instruction = context.instructionByValue[current]
    if (instruction == null) return null
    // Only an instruction expansion is charged — re-expanding the same instruction is
    // exactly what the duplication blowup repeats, while parameter and constant leaves are
    // bounded by the expansions' own fan-in.
    if (remainingVisits <= 0) return null
    remainingVisits -= 1
    switch (instruction.kind) {
      case 'constant': return {kind: 'constant', value: instruction.value}
      case 'binary': {
        const left = walk(instruction.left)
        const right = walk(instruction.right)
        return left == null || right == null
          ? null
          : {kind: 'binary', operator: instruction.operator, left, right}
      }
      case 'floor': {
        const operand = walk(instruction.value)
        return operand == null ? null : {kind: 'floor', operand}
      }
      // A module write's result is the assigned value, so the written expression carries over.
      case 'moduleWrite': return walk(instruction.value)
      // Requirement expressions name only the function's own parameters; a module binding is
      // not caller-visible, so a requirement cannot name it.
      case 'moduleRead':
      case 'moduleHavoc':
      case 'platformValue':
      case 'booleanConstant':
      case 'not':
      case 'absolute':
      case 'call':
      case 'compare':
      case 'maximum':
      case 'minimum':
      case 'object':
      case 'nullishConstant':
      case 'opaqueConstant':
      case 'unknownBoolean':
      case 'mathUnary':
      case 'stringLength':
      case 'parsedNumber':
      case 'numberCheck':
      case 'staticRequire':
      case 'staticAssert':
      case 'tagCheck':
      case 'nullishCheck':
      case 'arrayLiteral':
      case 'arrayIndex': return null
      // An array's length is fixed at construction (no push in the subset), so a length
      // read over a nameable array could join the expression language later; not yet.
      case 'arrayLength': return null
      case 'property': {
        const base = walk(instruction.object)
        return base == null ? null : {kind: 'property', base, name: instruction.property}
      }
    }
  }
  return walk(value)
}

export function numericExpressionsAtPath(
  value: ValueID,
  properties: string[],
  context: ExpressionContext,
): NumericExpression[] {
  const maximumPathLength = Math.max(context.maximumPropertyPathLength, properties.length)
  type PathExpressions = {expressions: NumericExpression[]; complete: boolean}
  const memo = new Map<string, PathExpressions>()
  const visiting = new Set<string>()
  const walk = (current: ValueID, path: string[]): PathExpressions => {
    if (path.length > maximumPathLength) return {expressions: [], complete: false}
    const key = `${current}:${JSON.stringify(path)}`
    const known = memo.get(key)
    if (known != null) return known
    // A loop back to the same value/path contributes no new source. Other incoming
    // edges still decide whether the path is completely expressible.
    if (visiting.has(key)) return {expressions: [], complete: true}
    visiting.add(key)
    const producer = context.instructionByValue[current]
    let result: PathExpressions
    if (producer?.kind === 'property') {
      result = walk(producer.object, [producer.property, ...path])
    } else {
      const stored = resolveStoredValue(current, context)
      if (stored !== current) {
        result = walk(stored, path)
      } else {
        const [property, ...rest] = path
        if (property != null && producer?.kind === 'object') {
          const field = producer.properties.find(candidate => candidate.name === property)
          result = field == null ? {expressions: [], complete: false} : walk(field.value, rest)
        } else if (context.blockParameterSources[current] != null) {
          const sources = context.blockParameterSources[current]
            .filter(source => context.activeEdges.has(source.edge))
            .map(source => walk(source.value, path))
          result = {
            expressions: distinctExpressions(sources.flatMap(source => source.expressions)),
            complete: sources.length > 0 && sources.every(source => source.complete),
          }
        } else {
          const expression = appendProperties(numericExpression(current, context), path)
          result = expression == null
            ? {expressions: [], complete: false}
            : {expressions: [expression], complete: true}
        }
      }
    }
    visiting.delete(key)
    memo.set(key, result)
    return result
  }
  const result = walk(value, properties)
  return result.complete ? result.expressions : []
}

function numericExpressions(value: ValueID, context: ExpressionContext): NumericExpression[] {
  const stored = resolveStoredValue(value, context)
  const parameterPath = parameterPathForValue(stored, context)
  if (parameterPath != null && context.parameterPathResolver != null) {
    return context.parameterPathResolver(parameterPath.parameter, parameterPath.properties)
  }
  const expression = numericExpression(stored, context)
  return expression == null ? [] : [expression]
}

function parameterPathForValue(
  value: ValueID,
  context: ExpressionContext,
): {parameter: number; properties: string[]} | null {
  const parameter = context.parameterIndexByValue[value]
  if (parameter != null) return {parameter, properties: []}
  const producer = context.instructionByValue[value]
  if (producer?.kind !== 'property') return null
  const base = parameterPathForValue(producer.object, context)
  return base == null ? null : {...base, properties: [...base.properties, producer.property]}
}

function appendProperties(
  base: NumericExpression | null,
  properties: string[],
): NumericExpression | null {
  if (base == null) return null
  let expression = base
  for (const name of properties) expression = {kind: 'property', base: expression, name}
  return expression
}

export function staticRequirements(
  instruction: InstructionIR | undefined,
  site: SiteID,
  context: ExpressionContext,
): Array<Extract<InferredPrecondition, {kind: 'declaredComparison' | 'numberCheck'}>> {
  if (instruction?.kind === 'compare') {
    const left = numericExpression(instruction.left, context)
    const right = numericExpression(instruction.right, context)
    return left == null || right == null
      ? []
      : [{kind: 'declaredComparison', operator: instruction.operator, left, right, site}]
  }
  if (instruction?.kind === 'numberCheck') {
    const expressions = instruction.predicate === 'finite'
      ? numericExpressions(instruction.value, context)
      : [numericExpression(instruction.value, context)].filter(
        (expression): expression is NumericExpression => expression != null,
      )
    return expressions.map(expression => ({
      kind: 'numberCheck',
      predicate: instruction.predicate,
      expression,
      origin: 'written',
      site,
    }))
  }
  return []
}

export function constantNumericExpression(expression: NumericExpression): number | null {
  switch (expression.kind) {
    case 'constant': return expression.value
    case 'parameter':
    case 'property': return null
    case 'floor': {
      const operand = constantNumericExpression(expression.operand)
      return operand == null ? null : Math.floor(operand)
    }
    case 'binary': {
      const left = constantNumericExpression(expression.left)
      const right = constantNumericExpression(expression.right)
      if (left == null || right == null) return null
      switch (expression.operator) {
        case 'add': return left + right
        case 'subtract': return left - right
        case 'multiply': return left * right
        case 'divide': return left / right
        case 'remainder': return left % right
      }
    }
  }
}

function oneExpression(expressions: NumericExpression[]): NumericExpression | null {
  const [first, ...rest] = expressions
  return first != null && rest.every(expression => sameExpression(first, expression)) ? first : null
}

function distinctExpressions(expressions: NumericExpression[]): NumericExpression[] {
  const distinct: NumericExpression[] = []
  for (const expression of expressions) {
    if (!distinct.some(candidate => sameExpression(candidate, expression))) distinct.push(expression)
  }
  return distinct
}

// A stable name for the runtime value an IR value holds. Forward value facts and exact
// same-value operations share this rule instead of maintaining separate notions of
// identity. Property and array reads are stable under the accepted subset's immutability
// rules; module and platform reads stay value-keyed because they may change between reads.
export function canonicalValueKey(value: ValueID, context: ExpressionContext): string {
  const stored = resolveStoredValue(value, context)
  if (stored !== value) return canonicalValueKey(stored, context)
  const parameterIndex = context.parameterIndexByValue[value]
  if (parameterIndex != null) return context.parameterIdentityKeys[parameterIndex] ?? `p${parameterIndex}`
  const producer = context.instructionByValue[value]
  if (producer?.kind === 'property') {
    return `${canonicalValueKey(producer.object, context)}.${JSON.stringify(producer.property)}`
  }
  if (producer?.kind === 'arrayLength') return `${canonicalValueKey(producer.array, context)}.length`
  if (producer?.kind === 'stringLength') return `${canonicalValueKey(producer.value, context)}.length`
  if (producer?.kind === 'arrayIndex') {
    return `${canonicalValueKey(producer.array, context)}[${canonicalValueKey(producer.index, context)}]`
  }
  return `v:${context.identityNamespace}${value}`
}

export function sameRuntimeValue(left: ValueID, right: ValueID, context: ExpressionContext): boolean {
  return left === right || canonicalValueKey(left, context) === canonicalValueKey(right, context)
}

export function addPrecondition(preconditions: InferredPrecondition[], candidate: InferredPrecondition): void {
  if (candidate.kind === 'numberCheck' && candidate.predicate !== 'nan') {
    const strength = candidate.predicate === 'integer' ? 2 : 1
    for (let index = preconditions.length - 1; index >= 0; index--) {
      const existing = preconditions[index]!
      if (existing.kind !== 'numberCheck' || existing.predicate === 'nan'
        || !sameExpression(existing.expression, candidate.expression)) continue
      const existingStrength = existing.predicate === 'integer' ? 2 : 1
      if (existingStrength > strength) return
      if (existingStrength === strength) {
        // A written condition is the clearest origin when the automatic input rule says
        // the same thing. Equal automatic conditions keep the first, nearest origin.
        if (existing.origin === 'written' || candidate.origin === 'input') return
      }
      preconditions.splice(index, 1)
    }
  }
  if (!preconditions.some(precondition => samePrecondition(precondition, candidate))) preconditions.push(candidate)
}

export function numericParameterPath(
  expression: NumericExpression,
): {parameter: number; properties: string[]} | null {
  if (expression.kind === 'parameter') return {parameter: expression.index, properties: []}
  if (expression.kind !== 'property') return null
  const base = numericParameterPath(expression.base)
  return base == null ? null : {...base, properties: [...base.properties, expression.name]}
}

// Rewrites a nonzero obligation into the simplest condition the caller can read, peeling
// only float-EXACT layers so the biconditional survives:
// - X - c is nonzero  <=>  X is not c   (IEEE subtraction is zero only on exact equality)
// - X + c is nonzero  <=>  X is not -c  (same argument)
// - c * X is nonzero  <=>  X is nonzero, when |c| >= 1 and finite (|c * x| >= |x| can
//   never underflow to zero; small constants CAN — 1e-200 * 1e-200 is 0 — so those stay)
// - X / c never peels: a tiny dividend over a huge divisor underflows to zero.
// The multiply case recurses (still a nonzero form); a peel against a constant ends the
// chain (width is not 4 is an endpoint — further peeling through rounding would lie).
// Termination is structural: every step shrinks the expression.
export function peelNonzero(expression: NumericExpression, site: SiteID, operation: 'division' | 'remainder'): InferredPrecondition {
  if (expression.kind === 'binary') {
    const {operator, left, right} = expression
    const constantSide = right.kind === 'constant' ? right : left.kind === 'constant' ? left : null
    const otherSide = right.kind === 'constant' ? left : right
    if (constantSide != null && Number.isFinite(constantSide.value)) {
      if (operator === 'subtract') {
        // c - X and X - c both peel to X is not c.
        return {kind: 'notEqualConstant', expression: otherSide, value: constantSide.value, operation, site}
      }
      if (operator === 'add') {
        return {kind: 'notEqualConstant', expression: otherSide, value: -constantSide.value, operation, site}
      }
      if (operator === 'multiply' && Math.abs(constantSide.value) >= 1) {
        return peelNonzero(otherSide, site, operation)
      }
    }
  }
  return {kind: 'nonzero', expression, operation, site}
}

// Keep one condition per originating operation. Propagated requirements retain the
// operation's site, so repeated calls with the same substituted expression collapse while
// separate operations that need the same condition remain separate findings.
function samePrecondition(left: InferredPrecondition, right: InferredPrecondition): boolean {
  if (left.site !== right.site) return false
  if (left.kind !== right.kind) return false
  if (left.kind === 'inBounds' && right.kind === 'inBounds') {
    return sameExpression(left.index, right.index) && sameExpression(left.sequence, right.sequence)
  }
  if (left.kind === 'inBounds' || right.kind === 'inBounds') return false
  if (left.kind === 'declaredComparison' && right.kind === 'declaredComparison') {
    return left.operator === right.operator
      && sameExpression(left.left, right.left)
      && sameExpression(left.right, right.right)
  }
  if (left.kind === 'declaredComparison' || right.kind === 'declaredComparison') return false
  if (left.kind === 'numberCheck' && right.kind === 'numberCheck') {
    return left.predicate === right.predicate && sameExpression(left.expression, right.expression)
  }
  if (left.kind === 'numberCheck' || right.kind === 'numberCheck') return false
  if (left.kind === 'notEqualConstant' && right.kind === 'notEqualConstant' && left.value !== right.value) return false
  return sameExpression(left.expression, right.expression)
}

function sameExpression(left: NumericExpression, right: NumericExpression): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'parameter': return left.index === (right as Extract<NumericExpression, {kind: 'parameter'}>).index
    case 'constant': return left.value === (right as Extract<NumericExpression, {kind: 'constant'}>).value
    case 'binary': {
      const other = right as Extract<NumericExpression, {kind: 'binary'}>
      return left.operator === other.operator
        && sameExpression(left.left, other.left)
        && sameExpression(left.right, other.right)
    }
    case 'floor': return sameExpression(left.operand, (right as Extract<NumericExpression, {kind: 'floor'}>).operand)
    case 'property': {
      const other = right as Extract<NumericExpression, {kind: 'property'}>
      return left.name === other.name && sameExpression(left.base, other.base)
    }
  }
}
