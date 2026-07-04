import {
  absoluteNumber,
  addNumbers,
  constantNumber,
  divideNumbers,
  divideNumbersNonzeroDivisor,
  floorNumber,
  includesZero,
  isFiniteNumber,
  maximumNumbers,
  minimumNumbers,
  multiplyNumbers,
  subtractNumbers,
  type AbstractNumber,
} from '../domain/number.ts'
import {recordProperty, recordValue, unknownBoolean, type AbstractBoolean, type AbstractRecord, type AbstractValue} from '../domain/value.ts'
import type {FunctionID, SiteID, ValueID} from '../ir/ids.ts'
import {forEachOperand, type ComparisonOperator, type EdgeIR, type InstructionIR} from '../ir/instructions.ts'
import {coveringKindValue, declaredKindOf, type FunctionIR, type ProgramIR} from '../ir/program.ts'
import {
  addPrecondition,
  numericExpression,
  type ExpressionContext,
} from '../requirements/infer.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import {completedEvaluation, type FunctionEvaluation, type Stop} from './outcome.ts'
import {cloneState, type ExecutionState, type SharedState} from './state.ts'

type EvaluateFunction = (
  functionID: FunctionID,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  callStack: FunctionID[],
) => FunctionEvaluation

export type TransferContext = {
  program: ProgramIR
  callStack: FunctionID[]
  expressionContext: ExpressionContext
  preconditions: InferredPrecondition[]
  // By ValueID: whether any consumer other than a compare instruction reads the value. A
  // division consumed only by comparisons needs no nonzero requirement: a NaN or Infinity
  // quotient just makes the comparison false-or-true, which the boolean domain already
  // covers, and the non-finiteness cannot reach a return value or a write. This is the
  // first piece of deriving requirements from the final guarantee instead of the operation.
  usedOutsideCompare: boolean[]
  evaluateFunction: EvaluateFunction
}

// One instruction either produces a value or stops the current path.
export type StepResult =
  | {kind: 'value'; value: AbstractValue}
  | {kind: 'stop'; stop: Stop}

// The three ways an instruction arm produces its value, typed so a freshly computed number
// cannot leave evaluateInstruction without the blame stamp: value() rejects numbers at the
// type level, computedNumber() stamps, and passthroughValue() is the one named escape hatch
// for values whose numbers were already stamped where they were produced (reads, call
// results, constants — stamping constants would newly blame overflowing literals).
function value(result: Exclude<AbstractValue, AbstractNumber>): StepResult {
  return {kind: 'value', value: result}
}

function passthroughValue(result: AbstractValue): StepResult {
  return {kind: 'value', value: result}
}

// The blame annotation (see AbstractNumber.lossSite — never semantics): a degraded result
// inherits the earliest operand's loss site, or, when the operands were all clean, stamps
// this operation as where finiteness or NaN-freedom died.
function computedNumber(raw: AbstractNumber, operands: AbstractNumber[], site: SiteID): StepResult {
  return {kind: 'value', value: withLossBlame(raw, operands, site)}
}

function withLossBlame(result: AbstractNumber, operands: AbstractNumber[], site: SiteID): AbstractNumber {
  if (isFiniteNumber(result) && !result.mayBeNaN) return result
  if (result.lossSite != null) return result
  const carrier = operands.find(operand => operand.lossSite != null)
  if (carrier?.lossSite != null) return {...result, lossSite: carrier.lossSite}
  const lostFinite = !isFiniteNumber(result) && operands.every(operand => isFiniteNumber(operand))
  const gainedNaN = result.mayBeNaN && operands.every(operand => !operand.mayBeNaN)
  if (lostFinite || gainedNaN) return {...result, lossSite: site}
  return result
}

// See TransferContext.usedOutsideCompare. Terminator uses (return values, branch
// conditions, block-parameter arguments) all count as outside; the per-instruction operand
// enumeration lives with the instruction type (forEachOperand), so only the compare
// exemption is decided here.
export function collectNonCompareUses(fn: FunctionIR): boolean[] {
  const used: boolean[] = []
  const markEdge = (edge: EdgeIR): void => {
    for (const argument of edge.arguments) used[argument] = true
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind === 'compare') continue
      forEachOperand(instruction, operand => { used[operand] = true })
    }
    switch (block.terminator.kind) {
      case 'return': if (block.terminator.value != null) used[block.terminator.value] = true; break
      case 'branch': used[block.terminator.condition] = true; markEdge(block.terminator.whenTrue); markEdge(block.terminator.whenFalse); break
      case 'jump': markEdge(block.terminator.target); break
      case 'stop': break
    }
  }
  return used
}

export function evaluateInstruction(
  instruction: InstructionIR,
  state: ExecutionState,
  context: TransferContext,
): StepResult {
  switch (instruction.kind) {
    case 'constant': return passthroughValue(constantNumber(instruction.value))
    case 'booleanConstant': return value({
      kind: 'boolean',
      canBeTrue: instruction.value,
      canBeFalse: !instruction.value,
    })
    case 'moduleRead': {
      const slot = state.shared.modules[instruction.binding]
      if (slot == null) throw new Error(`Unknown module binding ${instruction.binding}`)
      if (slot.kind === 'uninitialized') {
        return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'moduleRead', binding: instruction.binding}}}
      }
      return passthroughValue(slot.value)
    }
    case 'moduleWrite': {
      const assigned = requiredValue(state, instruction.value)
      const binding = context.program.moduleBindings[instruction.binding]
      if (binding == null) throw new Error(`Unknown module binding ${instruction.binding}`)
      // An opaque binding's declared type spans value kinds (e.g. `unknown`), so two paths
      // could put a number and a boolean in one slot and meet at a join, which only handles
      // matching kinds. Reads of opaque bindings stop regardless, so the slot stays
      // uninitialized instead of holding a value nothing may consume. Every other writable
      // category is single-kind: value/kind writes are type-checked against the declared
      // number, boolean, or record shape.
      if (binding.category.kind !== 'opaque') {
        state.shared.modules[instruction.binding] = {kind: 'value', value: assigned}
      }
      return passthroughValue(assigned)
    }
    case 'moduleHavoc': {
      const binding = context.program.moduleBindings[instruction.binding]
      if (binding == null) throw new Error(`Unknown module binding ${instruction.binding}`)
      const declaredKind = declaredKindOf(binding.category)
      // Covering, not assumed-finite: values computed from this slot can publish without
      // any assumes line, so the reset must include NaN and infinities.
      state.shared.modules[instruction.binding] = declaredKind == null
        ? {kind: 'uninitialized'}
        : {kind: 'value', value: coveringKindValue(declaredKind)}
      return value({kind: 'void'})
    }
    case 'object': return value(recordValue(instruction.properties.map(property => ({
      name: property.name,
      value: requiredValue(state, property.value),
    }))))
    case 'property': {
      const record = requiredRecord(state, instruction.object)
      const propertyValue = recordProperty(record, instruction.property)
      // The static type only exposes properties present on every value the expression can
      // hold, and record joins keep exactly those, so a type-checked read always finds its
      // property.
      if (propertyValue == null) throw new Error(`Record has no property ${instruction.property}`)
      return passthroughValue(propertyValue)
    }
    case 'compare': return value(compareNumbers(
      requiredNumber(state, instruction.left),
      requiredNumber(state, instruction.right),
      instruction.operator,
    ))
    case 'floor': {
      const operand = requiredNumber(state, instruction.value)
      return computedNumber(floorNumber(operand), [operand], instruction.site)
    }
    case 'platformValue': return passthroughValue({
      kind: 'number',
      lower: instruction.lower,
      upper: instruction.upper,
      integer: instruction.integer,
      mayBeNaN: false,
    })
    case 'absolute': {
      const operand = requiredNumber(state, instruction.value)
      return computedNumber(absoluteNumber(operand), [operand], instruction.site)
    }
    case 'not': {
      const operand = requiredBoolean(state, instruction.value)
      return value({kind: 'boolean', canBeTrue: operand.canBeFalse, canBeFalse: operand.canBeTrue})
    }
    case 'minimum': {
      const operands = instruction.values.map(id => requiredNumber(state, id))
      return computedNumber(minimumNumbers(operands), operands, instruction.site)
    }
    case 'maximum': {
      const operands = instruction.values.map(id => requiredNumber(state, id))
      return computedNumber(maximumNumbers(operands), operands, instruction.site)
    }
    case 'call': {
      const callee = context.program.functions[instruction.function]
      if (callee == null) throw new Error(`Unknown function ${instruction.function}`)
      if (callee.kind === 'unsupported') {
        return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'calleeStopped', callee: instruction.function}}}
      }
      if (context.callStack.includes(instruction.function)) {
        return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'recursion', callee: instruction.function}}}
      }
      const arguments_ = instruction.arguments.map(id => requiredValue(state, id))
      const argumentExpressions = instruction.arguments.map(id => numericExpression(id, context.expressionContext))
      const evaluation = context.evaluateFunction(
        instruction.function,
        arguments_,
        argumentExpressions,
        state.shared,
        context.callStack,
      )
      // A partial callee's result is discarded wholesale: the callee ran on a clone, and
      // state.shared is assigned only on the complete path below, so a partial callee's
      // module writes cannot become this caller's state.
      const completed = completedEvaluation(evaluation)
      if (completed == null) {
        return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'calleeStopped', callee: instruction.function}}}
      }
      state.shared = completed.sharedState
      for (const precondition of completed.preconditions) addPrecondition(context.preconditions, precondition)
      return passthroughValue(completed.returnValue)
    }
    case 'binary': {
      const left = requiredNumber(state, instruction.left)
      const right = requiredNumber(state, instruction.right)
      if (
        instruction.operator === 'divide'
        && includesZero(right)
        && context.usedOutsideCompare[instruction.result] === true
      ) {
        const expression = numericExpression(instruction.right, context.expressionContext)
        if (expression == null) {
          return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'divisorUnknown'}}}
        }
        addPrecondition(context.preconditions, {kind: 'nonzero', expression, site: instruction.site})
        // Ensures assume the requires: with the nonzero requirement recorded, the quotient
        // is computed over the divisor's range with zero cut out. An integer divisor gives
        // a genuinely finite result; a non-integer one can still sit arbitrarily close to
        // zero and stays possibly non-finite.
        return computedNumber(divideNumbersNonzeroDivisor(left, right), [left, right], instruction.site)
      }
      return computedNumber(evaluateBinary(instruction.operator, left, right), [left, right], instruction.site)
    }
  }
}

export function refineComparison(
  state: ExecutionState,
  comparison: Extract<InstructionIR, {kind: 'compare'}>,
  truth: boolean,
): ExecutionState | null {
  if (!truth && comparison.operator === 'equal') return cloneState(state)
  const result = cloneState(state)
  const left = requiredNumber(result, comparison.left)
  const right = requiredNumber(result, comparison.right)
  // The false branch means "the written condition did not hold" — which is also where a
  // NaN operand lands, with the OTHER operand unconstrained. Inverting the comparison and
  // refining bounds is only sound when neither operand can be NaN; e.g. with a possibly-NaN
  // clamp result as the right operand, `if (x < clamped) ... else return x` reaches the
  // else with any x at all whenever clamped is NaN.
  if (!truth && (left.mayBeNaN || right.mayBeNaN)) return result
  const operator = truth ? comparison.operator : invertedComparison(comparison.operator)
  let refinedLeft = left
  let refinedRight = right
  switch (operator) {
    case 'lessThan':
      refinedLeft = withBounds(left, left.lower, strictUpper(right.upper, left.integer))
      refinedRight = withBounds(right, strictLower(left.lower, right.integer), right.upper)
      break
    case 'lessThanOrEqual':
      refinedLeft = withBounds(left, left.lower, Math.min(left.upper, right.upper))
      refinedRight = withBounds(right, Math.max(right.lower, left.lower), right.upper)
      break
    case 'greaterThan':
      refinedLeft = withBounds(left, strictLower(right.lower, left.integer), left.upper)
      refinedRight = withBounds(right, right.lower, strictUpper(left.upper, right.integer))
      break
    case 'greaterThanOrEqual':
      refinedLeft = withBounds(left, Math.max(left.lower, right.lower), left.upper)
      refinedRight = withBounds(right, right.lower, Math.min(right.upper, left.upper))
      break
    case 'equal': {
      const lower = Math.max(left.lower, right.lower)
      const upper = Math.min(left.upper, right.upper)
      refinedLeft = withBounds(left, lower, upper)
      refinedRight = withBounds(right, lower, upper)
      break
    }
  }
  const emptied = refinedLeft.lower > refinedLeft.upper || refinedRight.lower > refinedRight.upper
  // NaN fails every comparison, so it never reaches the branch where the written condition
  // held, and it always reaches the branch where it failed.
  if (truth) {
    if (emptied) return null
    refinedLeft = {...refinedLeft, mayBeNaN: false}
    refinedRight = {...refinedRight, mayBeNaN: false}
  } else if (emptied) {
    // The interval refinement only rules out the non-NaN inhabitants; a NaN operand still
    // lands here (e.g. `x > -1 ? 1 : 0` with x possibly NaN takes the 0 arm at runtime).
    // Keep the unrefined values — a superset — rather than pruning the branch.
    if (left.mayBeNaN || right.mayBeNaN) return cloneState(state)
    return null
  }
  result.frame.values[comparison.left] = refinedLeft
  result.frame.values[comparison.right] = refinedRight
  return result
}

function requiredNumber(state: ExecutionState, id: ValueID): AbstractNumber {
  const value = requiredValue(state, id)
  if (value.kind !== 'number') throw new Error(`IR value ${id} is not a number`)
  return value
}

export function requiredBoolean(state: ExecutionState, id: ValueID): AbstractBoolean {
  const value = requiredValue(state, id)
  if (value.kind !== 'boolean') throw new Error(`IR value ${id} is not a boolean`)
  return value
}

function requiredRecord(state: ExecutionState, id: ValueID): AbstractRecord {
  const value = requiredValue(state, id)
  if (value.kind !== 'record') throw new Error(`IR value ${id} is not a record`)
  return value
}

export function requiredValue(state: ExecutionState, id: ValueID): AbstractValue {
  const value = state.frame.values[id]
  if (value == null) throw new Error(`Missing IR value ${id}`)
  return value
}

function evaluateBinary(
  operator: Extract<InstructionIR, {kind: 'binary'}>['operator'],
  left: AbstractNumber,
  right: AbstractNumber,
): AbstractNumber {
  switch (operator) {
    case 'add': return addNumbers(left, right)
    case 'subtract': return subtractNumbers(left, right)
    case 'multiply': return multiplyNumbers(left, right)
    case 'divide': return divideNumbers(left, right)
  }
}

function compareNumbers(left: AbstractNumber, right: AbstractNumber, operator: ComparisonOperator): AbstractBoolean {
  if (left.mayBeNaN || right.mayBeNaN) return unknownBoolean()
  switch (operator) {
    case 'lessThan': return booleanRange((left.upper < right.lower), (left.lower >= right.upper))
    case 'lessThanOrEqual': return booleanRange((left.upper <= right.lower), (left.lower > right.upper))
    case 'greaterThan': return compareNumbers(right, left, 'lessThan')
    case 'greaterThanOrEqual': return compareNumbers(right, left, 'lessThanOrEqual')
    case 'equal': {
      const definitelyEqual = left.lower === left.upper && right.lower === right.upper && left.lower === right.lower
      const definitelyDifferent = left.upper < right.lower || right.upper < left.lower
      return booleanRange(definitelyEqual, definitelyDifferent)
    }
  }
}

function booleanRange(definitelyTrue: boolean, definitelyFalse: boolean): AbstractBoolean {
  return {
    kind: 'boolean',
    canBeTrue: !definitelyFalse,
    canBeFalse: !definitelyTrue,
  }
}

function invertedComparison(operator: ComparisonOperator): ComparisonOperator {
  switch (operator) {
    case 'lessThan': return 'greaterThanOrEqual'
    case 'lessThanOrEqual': return 'greaterThan'
    case 'greaterThan': return 'lessThanOrEqual'
    case 'greaterThanOrEqual': return 'lessThan'
    case 'equal': return 'equal'
  }
}

function withBounds(value: AbstractNumber, lower: number, upper: number): AbstractNumber {
  let refinedLower = Math.max(value.lower, lower)
  let refinedUpper = Math.min(value.upper, upper)

  // An integer interval refined by a non-strict comparison against a non-integer bound
  // (`if (count >= 3.2)`) would keep the fractional bound. Snap to the integer hull —
  // exact, since only integers inhabit the interval. Left unsnapped, the bounds and the
  // integer flag disagree: [3.2, 3.4] passes the lower > upper emptiness check while
  // containing no value, and a later comparison can prune both branch edges, stranding
  // the evaluation with no path end at all.
  if (value.integer) {
    refinedLower = Math.ceil(refinedLower)
    refinedUpper = Math.floor(refinedUpper)
  }
  // A possibly infinite value lives at its interval's infinite end, so a refinement that
  // clips the interval to finite bounds also proves finiteness — with finiteness derived
  // from the bounds, that now holds by construction.
  return {...value, lower: refinedLower, upper: refinedUpper}
}

function strictLower(value: number, integer: boolean): number {
  return integer ? Math.floor(value) + 1 : value
}

function strictUpper(value: number, integer: boolean): number {
  return integer ? Math.ceil(value) - 1 : value
}
