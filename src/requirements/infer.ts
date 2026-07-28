import type {AbstractValue} from '../domain/value.ts'
import {
  createValueIdentityOwner,
  sameValueIdentity,
  type ValueIdentity,
  type ValueIdentityOwner,
} from '../domain/value-identity.ts'
import type {ExecutionState, ValueFact} from '../engine/state.ts'
import type {SiteID, ValueID} from '../ir/ids.ts'
import type {InstructionIR} from '../ir/instructions.ts'
import type {FunctionIR} from '../ir/program.ts'
import type {InferredPrecondition, NumericExpression} from './model.ts'

export type ValueReference = {
  value: ValueID
  context: ExpressionContext
  state: ExecutionState | undefined
}

export type ConditionBranch = {
  parameterValues: AbstractValue[]
  valueFacts: ValueFact[]
}

export type ConditionReference = {
  context: ExpressionContext
  whenTrue: ConditionBranch | null
  whenFalse: ConditionBranch | null
}

export type ExpressionContext = {
  parameterExpressions: Array<NumericExpression | null>
  // Calls pass the caller's identities directly, so duplicate arguments and facts created
  // in a callee refer to the same stored value. Local identities use the evaluation's
  // owner token, which distinguishes separate calls without encoding the call path.
  parameterIdentities: ValueIdentity[]
  parameterOrigins: Array<ValueReference | null>
  // Only calls with one reachable return calculation receive a return reference. A joined
  // return value has no single calculation that source inlining could expose.
  callReturns: Array<ValueReference | undefined>
  callConditions: Array<ConditionReference | undefined>
  identityOwner: ValueIdentityOwner
  identityByValue: Array<ValueIdentity | undefined>
  parameterValueIDs: ValueID[]
  parameterIndexByValue: Array<number | undefined>
  parameterAliasesByValue: Array<ValueID[] | undefined>
  instructionByValue: Array<InstructionIR | undefined>
  instructionCount: number
}

export function createExpressionContext(
  fn: FunctionIR,
  parameterExpressions: Array<NumericExpression | null>,
  parameterIdentities?: ValueIdentity[],
  identityOwner = createValueIdentityOwner(),
  parameterOrigins?: Array<ValueReference | null>,
): ExpressionContext {
  const context: ExpressionContext = {
    parameterExpressions,
    parameterIdentities: [],
    parameterOrigins: parameterOrigins ?? fn.parameters.map(() => null),
    callReturns: [],
    callConditions: [],
    identityOwner,
    identityByValue: [],
    parameterValueIDs: fn.parameters.map(parameter => parameter.value),
    parameterIndexByValue: [],
    parameterAliasesByValue: [],
    instructionByValue: [],
    instructionCount: 0,
  }
  context.parameterIdentities = parameterIdentities
    ?? fn.parameters.map(parameter => ({
      kind: 'local',
      owner: identityOwner,
      value: parameter.value,
    }))
  if (context.parameterIdentities.length !== fn.parameters.length) {
    throw new Error(`Expected ${fn.parameters.length} parameter identities for ${fn.name}`)
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    context.parameterIndexByValue[fn.parameters[index]!.value] = index
  }
  const parameterGroups: Array<{identity: ValueIdentity; values: ValueID[]}> = []
  for (let index = 0; index < fn.parameters.length; index++) {
    const identity = context.parameterIdentities[index]!
    const existing = parameterGroups.find(group =>
      sameValueIdentity(group.identity, identity))
    if (existing == null) {
      parameterGroups.push({identity, values: [fn.parameters[index]!.value]})
    } else {
      existing.values.push(fn.parameters[index]!.value)
    }
  }
  for (const {values} of parameterGroups) {
    if (values.length < 2) continue
    for (const value of values) context.parameterAliasesByValue[value] = values
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      context.instructionByValue[instruction.result] = instruction
      context.instructionCount += 1
    }
  }
  return context
}

// Follow the source operations that survive extracting an expression into a helper.
// Block parameters and joined returns remain boundaries because neither has one producer.
export function resolveValueReference(reference: ValueReference): ValueReference {
  return resolveReference(reference, true)
}

// Projection may enter completed callees, but changes outside the direct caller flow back
// when that caller itself completes. Stop at its parameters instead of walking the entire
// outer call chain on every inner call.
export function resolveProjectedValueReference(
  reference: ValueReference,
  caller: ExpressionContext,
): ValueReference {
  return resolveReference(reference, true, new Map(), caller)
}

// Numeric expressions and identity keys have already substituted each parameter at the
// call boundary, so their walk stops at parameters. A record property still follows the
// record argument itself, allowing `{value}` to expose the value actually stored.
function resolveSubstitutedReference(reference: ValueReference): ValueReference {
  return resolveReference(reference, false)
}

function resolveReference(
  reference: ValueReference,
  followParameterOrigins: boolean,
  statesByContext = new Map<ExpressionContext, ExecutionState>(),
  stopAtParametersIn: ExpressionContext | null = null,
): ValueReference {
  const initialState = statesByContext.get(reference.context)
    ?? reference.state
  if (initialState != null) statesByContext.set(reference.context, initialState)
  let current = initialState == null
    ? reference
    : {...reference, state: initialState}
  const visited = new Map<ExpressionContext, Set<ValueID>>()
  while (true) {
    const stored = resolveStoredValue(current.value, current.context)
    if (stored !== current.value) {
      current = {...current, value: stored}
      continue
    }

    const parameterIndex = current.context.parameterIndexByValue[current.value]
    if (parameterIndex != null
      && (!followParameterOrigins || current.context === stopAtParametersIn)) {
      return current
    }

    const visitedValues = visited.get(current.context) ?? new Set<ValueID>()
    if (visitedValues.has(current.value)) return current
    visitedValues.add(current.value)
    visited.set(current.context, visitedValues)

    if (parameterIndex != null) {
      const parameterOrigin = current.context.parameterOrigins[parameterIndex]
      if (parameterOrigin != null) {
        const state = statesByContext.get(parameterOrigin.context)
          ?? parameterOrigin.state
        if (state != null) statesByContext.set(parameterOrigin.context, state)
        current = state == null
          ? parameterOrigin
          : {...parameterOrigin, state}
        continue
      }
    }

    const returned = current.context.callReturns[current.value]
    if (returned != null) {
      const state = statesByContext.get(returned.context) ?? returned.state
      if (state != null) statesByContext.set(returned.context, state)
      current = state == null ? returned : {...returned, state}
      continue
    }

    const producer = current.context.instructionByValue[current.value]
    if (producer?.kind !== 'property') return current
    const object = resolveReference({
      value: producer.object,
      context: current.context,
      state: current.state,
    }, true, statesByContext, stopAtParametersIn)
    const objectProducer = object.context.instructionByValue[object.value]
    if (objectProducer?.kind !== 'object') return current
    const property = objectProducer.properties.find(candidate =>
      candidate.name === producer.property)
    if (property == null) return current
    current = {
      value: property.value,
      context: object.context,
      state: object.state,
    }
  }
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
  const creditedContexts = new Set<ExpressionContext>([context])
  const walk = (raw: ValueReference): NumericExpression | null => {
    const current = resolveSubstitutedReference(raw)
    if (!creditedContexts.has(current.context)) {
      creditedContexts.add(current.context)
      remainingVisits += current.context.instructionCount
    }
    const parameterIndex = current.context.parameterIndexByValue[current.value]
    if (parameterIndex != null) {
      return current.context.parameterExpressions[parameterIndex] ?? null
    }
    const instruction = current.context.instructionByValue[current.value]
    if (instruction == null) return null
    // Only an instruction expansion is charged — re-expanding the same instruction is
    // exactly what the duplication blowup repeats, while parameter and constant leaves are
    // bounded by the expansions' own fan-in.
    if (remainingVisits <= 0) return null
    remainingVisits -= 1
    switch (instruction.kind) {
      case 'constant': return {kind: 'constant', value: instruction.value}
      case 'binary': {
        const left = walk({
          value: instruction.left,
          context: current.context,
          state: current.state,
        })
        const right = walk({
          value: instruction.right,
          context: current.context,
          state: current.state,
        })
        return left == null || right == null
          ? null
          : {kind: 'binary', operator: instruction.operator, left, right}
      }
      case 'floor': {
        const operand = walk({
          value: instruction.value,
          context: current.context,
          state: current.state,
        })
        return operand == null ? null : {kind: 'floor', operand}
      }
      // A module write's result is the assigned value, so the written expression carries over.
      case 'moduleWrite': return walk({
        value: instruction.value,
        context: current.context,
        state: current.state,
      })
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
        const base = walk({
          value: instruction.object,
          context: current.context,
          state: current.state,
        })
        return base == null ? null : {kind: 'property', base, name: instruction.property}
      }
    }
  }
  return walk({value, context, state: undefined})
}

export function staticRequirement(
  instruction: InstructionIR | undefined,
  site: SiteID,
  context: ExpressionContext,
  purpose?: 'finiteInput',
): Extract<InferredPrecondition, {kind: 'declaredComparison' | 'declaredNumberCheck'}> | null {
  if (instruction?.kind === 'compare') {
    const left = numericExpression(instruction.left, context)
    const right = numericExpression(instruction.right, context)
    return left == null || right == null
      ? null
      : {kind: 'declaredComparison', operator: instruction.operator, left, right, site}
  }
  if (instruction?.kind === 'numberCheck') {
    const expression = numericExpression(instruction.value, context)
    return expression == null
      ? null
      : {kind: 'declaredNumberCheck', predicate: instruction.predicate, expression, site, ...(purpose == null ? {} : {purpose})}
  }
  return null
}

// A stable identity for the runtime value an IR value holds. Forward value facts and exact
// same-value operations share this rule instead of maintaining separate notions of
// identity. Property and array reads are stable under the accepted subset's immutability
// rules; module and platform reads stay value-keyed because they may change between reads.
export function canonicalValueIdentity(
  value: ValueID,
  context: ExpressionContext,
): ValueIdentity {
  return canonicalReferenceIdentity({value, context, state: undefined})
}

function canonicalReferenceIdentity(reference: ValueReference): ValueIdentity {
  const resolved = resolveSubstitutedReference(reference)
  const cached = resolved.context.identityByValue[resolved.value]
  if (cached != null) return cached
  const parameterIndex = resolved.context.parameterIndexByValue[resolved.value]
  if (parameterIndex != null) {
    const identity = resolved.context.parameterIdentities[parameterIndex]
    if (identity == null) throw new Error(`Missing identity for parameter ${parameterIndex}`)
    resolved.context.identityByValue[resolved.value] = identity
    return identity
  }
  const producer = resolved.context.instructionByValue[resolved.value]
  let identity: ValueIdentity
  if (producer?.kind === 'property') {
    identity = {
      kind: 'property',
      object: canonicalReferenceIdentity({
        value: producer.object,
        context: resolved.context,
        state: resolved.state,
      }),
      property: producer.property,
    }
  } else if (producer?.kind === 'arrayLength') {
    identity = {
      kind: 'property',
      object: canonicalReferenceIdentity({
        value: producer.array,
        context: resolved.context,
        state: resolved.state,
      }),
      property: 'length',
    }
  } else if (producer?.kind === 'stringLength') {
    identity = {
      kind: 'property',
      object: canonicalReferenceIdentity({
        value: producer.value,
        context: resolved.context,
        state: resolved.state,
      }),
      property: 'length',
    }
  } else if (producer?.kind === 'arrayIndex') {
    identity = {
      kind: 'arrayIndex',
      array: canonicalReferenceIdentity({
        value: producer.array,
        context: resolved.context,
        state: resolved.state,
      }),
      index: canonicalReferenceIdentity({
        value: producer.index,
        context: resolved.context,
        state: resolved.state,
      }),
    }
  } else {
    identity = {
      kind: 'local',
      owner: resolved.context.identityOwner,
      value: resolved.value,
    }
  }
  resolved.context.identityByValue[resolved.value] = identity
  return identity
}

export function sameRuntimeValue(left: ValueID, right: ValueID, context: ExpressionContext): boolean {
  return left === right || sameValueIdentity(
    canonicalValueIdentity(left, context),
    canonicalValueIdentity(right, context),
  )
}

export function addPrecondition(preconditions: InferredPrecondition[], candidate: InferredPrecondition): void {
  if (candidate.kind === 'declaredNumberCheck') {
    if (candidate.predicate === 'finite' && preconditions.some(precondition =>
      precondition.kind === 'declaredNumberCheck'
      && (precondition.predicate === 'integer' || precondition.predicate === 'finite')
      && sameExpression(precondition.expression, candidate.expression))) return
    if (candidate.predicate === 'integer') {
      const redundantFinite = preconditions.findIndex(precondition =>
        precondition.kind === 'declaredNumberCheck'
        && precondition.predicate === 'finite'
        && sameExpression(precondition.expression, candidate.expression))
      if (redundantFinite >= 0) preconditions.splice(redundantFinite, 1)
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

export function constantRequirementStatus(
  requirement: Extract<InferredPrecondition, {kind: 'declaredComparison' | 'declaredNumberCheck'}>,
): boolean | null {
  if (requirement.kind === 'declaredNumberCheck') {
    const value = constantNumericExpression(requirement.expression)
    if (value == null) return null
    switch (requirement.predicate) {
      case 'finite': return Number.isFinite(value)
      case 'integer': return Number.isInteger(value)
      case 'nan': return Number.isNaN(value)
    }
  }
  const left = constantNumericExpression(requirement.left)
  const right = constantNumericExpression(requirement.right)
  if (left == null || right == null) return null
  switch (requirement.operator) {
    case 'lessThan': return left < right
    case 'lessThanOrEqual': return left <= right
    case 'greaterThan': return left > right
    case 'greaterThanOrEqual': return left >= right
    case 'equal': return left === right
    case 'notEqual': return left !== right
  }
}

function constantNumericExpression(expression: NumericExpression): number | null {
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
  if (left.kind === 'declaredNumberCheck' && right.kind === 'declaredNumberCheck') {
    return left.predicate === right.predicate && sameExpression(left.expression, right.expression)
  }
  if (left.kind === 'declaredNumberCheck' || right.kind === 'declaredNumberCheck') return false
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
