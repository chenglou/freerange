import type {SiteID, ValueID} from '../ir/ids.ts'
import type {InstructionIR} from '../ir/instructions.ts'
import type {FunctionIR} from '../ir/program.ts'
import type {InferredPrecondition, NumericExpression} from './model.ts'

export type ExpressionContext = {
  parameterExpressions: Array<NumericExpression | null>
  parameterIndexByValue: Array<number | undefined>
  instructionByValue: Array<InstructionIR | undefined>
  // The walk budget below, reset per top-level numericExpression call.
  instructionCount: number
  remainingVisits: number
}

export function createExpressionContext(
  fn: FunctionIR,
  parameterExpressions: Array<NumericExpression | null>,
): ExpressionContext {
  const context: ExpressionContext = {
    parameterExpressions,
    parameterIndexByValue: [],
    instructionByValue: [],
    instructionCount: 0,
    remainingVisits: 0,
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    context.parameterIndexByValue[fn.parameters[index]!.value] = index
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      context.instructionByValue[instruction.result] = instruction
      context.instructionCount += 1
    }
  }
  return context
}

// The producer walk expands a value's defining DAG into an expression tree, and a value
// used twice appears twice — chained squaring (`const b = a * a; const c = b * b`) doubles
// per level, so tree size is exponential in the worst case while the DAG stays linear.
// The budget is by construction, not a magic number: each visit charges against the
// function's own instruction count, so a requirement can never be more complex than the
// function that produced it. Exhaustion returns null, which surfaces as the honest
// divisorUnknown stop (or the assumes fallback for element reads).
export function numericExpression(value: ValueID, context: ExpressionContext): NumericExpression | null {
  context.remainingVisits = context.instructionCount
  return walkExpression(value, context)
}

function walkExpression(value: ValueID, context: ExpressionContext): NumericExpression | null {
  const parameterIndex = context.parameterIndexByValue[value]
  if (parameterIndex != null) return context.parameterExpressions[parameterIndex] ?? null
  const instruction = context.instructionByValue[value]
  if (instruction == null) return null
  // Only an instruction expansion is charged — re-expanding the same instruction is
  // exactly what the duplication blowup repeats, while parameter and constant leaves are
  // bounded by the expansions' own fan-in.
  if (context.remainingVisits <= 0) return null
  context.remainingVisits -= 1
  switch (instruction.kind) {
    case 'constant': return {kind: 'constant', value: instruction.value}
    case 'binary': {
      const left = walkExpression(instruction.left, context)
      const right = walkExpression(instruction.right, context)
      return left == null || right == null
        ? null
        : {kind: 'binary', operator: instruction.operator, left, right}
    }
    case 'floor': {
      const operand = walkExpression(instruction.value, context)
      return operand == null ? null : {kind: 'floor', operand}
    }
    // A module write's result is the assigned value, so the written expression carries over.
    case 'moduleWrite': return walkExpression(instruction.value, context)
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
    case 'tagCheck':
    case 'inCheck':
    case 'nullishCheck':
    case 'arrayLiteral':
    case 'arrayIndex': return null
    // An array's length is fixed at construction (no push in the subset), so a length
    // read over a nameable array could join the expression language later; not yet.
    case 'arrayLength': return null
    case 'property': {
      // A read through a freshly built record resolves to the value that went in — the
      // record is immutable, so `{...grid}.columns` IS grid.columns. This keeps spread
      // copies nameable: dividing by copy.columns still requires grid.columns nonzero.
      const producer = context.instructionByValue[instruction.object]
      if (producer?.kind === 'object') {
        const source = producer.properties.find(property => property.name === instruction.property)
        if (source != null) return walkExpression(source.value, context)
      }
      const base = walkExpression(instruction.object, context)
      return base == null ? null : {kind: 'property', base, name: instruction.property}
    }
  }
}

// A stable name for the runtime value an IR value holds, used to key valid-index pairs:
// two reads of config.sizes lower to distinct IR values, but both canonicalize to the
// same key, so the bounds-check guard matches the element read. Sound because the walked
// forms cannot change between occurrences — parameters and module reads resolve by
// binding identity, and a property read off the same base names the same immutable
// record's property. A rebound local resolves to a different underlying value, giving a
// different key by construction.
export function canonicalValueKey(value: ValueID, context: ExpressionContext): string {
  const parameterIndex = context.parameterIndexByValue[value]
  if (parameterIndex != null) return `p${parameterIndex}`
  const producer = context.instructionByValue[value]
  if (producer?.kind === 'property') return `${canonicalValueKey(producer.object, context)}.${producer.property}`
  if (producer?.kind === 'moduleRead') return `m${producer.binding}`
  return `v${value}`
}

export function addPrecondition(preconditions: InferredPrecondition[], candidate: InferredPrecondition): void {
  if (!preconditions.some(precondition => samePrecondition(precondition, candidate))) preconditions.push(candidate)
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

// Deduplication is by expression only: when two operations need the same requirement, the
// first causing site wins. Switching to one record per operation is deferred until reports
// group requirements per operation.
function samePrecondition(left: InferredPrecondition, right: InferredPrecondition): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'inBounds' && right.kind === 'inBounds') {
    return sameExpression(left.index, right.index) && sameExpression(left.sequence, right.sequence)
  }
  if (left.kind === 'inBounds' || right.kind === 'inBounds') return false
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
