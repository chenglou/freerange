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
import {joinValues, recordProperty, recordValue, unknownBoolean, type AbstractBoolean, type AbstractRecord, type AbstractValue} from '../domain/value.ts'
import type {FunctionID, SiteID, ValueID} from '../ir/ids.ts'
import {forEachOperand, type ComparisonOperator, type EdgeIR, type InstructionIR} from '../ir/instructions.ts'
import {coveringKindValue, declaredKindOf, type FunctionIR, type ProgramIR} from '../ir/program.ts'
import {
  addPrecondition,
  numericExpression,
  type ExpressionContext,
} from '../requirements/infer.ts'
import type {BoundsAssumption, InferredPrecondition, NumericExpression} from '../requirements/model.ts'
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
  // Element reads the engine could not prove in bounds — the peer of preconditions,
  // accumulated per evaluation and adopted from completed callees the same way.
  boundsAssumptions: BoundsAssumption[]
  // By ValueID: whether any consumer other than a compare instruction reads the value. A
  // division consumed only by comparisons needs no nonzero requirement: a NaN or Infinity
  // quotient just makes the comparison false-or-true, which the boolean domain already
  // covers, and the non-finiteness cannot reach a return value or a write. This is the
  // first piece of deriving requirements from the final guarantee instead of the operation.
  usedOutsideCompare: boolean[]
  evaluateFunction: EvaluateFunction
}

// TypeScript's narrowing is an open-ended set of rules; the analyzer models the common
// shapes (null checks, ?? , nested guards) and consults the checker's types at every
// gate, but a value can still reach an operation whose kind the local narrowing did not
// establish. That is a mismatch between two narrowing systems, not an accepted-subset
// violation, so it degrades to a per-path stop (owner decision) instead of crashing the
// run — thrown here, converted to a stop at the single catch in evaluateInstruction.
class KindMismatch extends Error {}

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
  try {
    return evaluateInstructionKinded(instruction, state, context)
  } catch (error) {
    if (error instanceof KindMismatch) {
      return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'unmodeledNarrowing'}}}
    }
    throw error
  }
}

function evaluateInstructionKinded(
  instruction: InstructionIR,
  state: ExecutionState,
  context: TransferContext,
): StepResult {
  switch (instruction.kind) {
    case 'constant': return passthroughValue(constantNumber(instruction.value))
    case 'nullishConstant': return value({kind: 'nullish', sentinels: instruction.sentinel})
    case 'arrayLiteral': {
      const elements = instruction.elements.map(id => requiredValue(state, id))
      if (instruction.form === 'tuple') return value({kind: 'tuple', elements})
      const element = elements.length === 0 ? null : elements.reduce((joined, next) => joinValues(joined, next))
      return value({kind: 'array', element, length: constantNumber(instruction.elements.length)})
    }
    case 'arrayLength': {
      const sequence = requiredSequence(state, instruction.array)
      return passthroughValue(sequence.kind === 'tuple'
        ? constantNumber(sequence.elements.length)
        : sequence.length)
    }
    case 'arrayIndex': {
      const sequence = requiredSequence(state, instruction.array)
      const index = requiredNumber(state, instruction.index)
      const element = sequence.kind === 'tuple'
        ? tupleElement(sequence, index)
        : sequence.element
      const length = sequence.kind === 'tuple' ? constantNumber(sequence.elements.length) : sequence.length
      const inBounds = instruction.provenBounds
        || (index.integer && !index.mayBeNaN && index.lower >= 0 && index.upper < length.lower)
      // A provably out-of-bounds read: for the asserted form the assertion lied; for the
      // bare form the value is exactly undefined. An empty sequence is the special case
      // where every read is out of bounds.
      const provablyOut = element == null
        || (index.integer && !index.mayBeNaN && (index.lower >= length.upper || index.upper < 0))
      if (provablyOut) {
        if (instruction.asserted) {
          return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'outOfBoundsRead'}}}
        }
        return value({kind: 'nullish', sentinels: 'undefined'})
      }
      if (!instruction.asserted) {
        // Bare arr[i] types T | undefined; a proven read cannot miss, an unproven one
        // honestly carries the possibility.
        return inBounds
          ? passthroughValue(element)
          : passthroughValue(joinValues({kind: 'nullish', sentinels: 'undefined'}, element))
      }
      if (!inBounds) addBoundsAssumption(context.boundsAssumptions, {site: instruction.site})
      return passthroughValue(element)
    }
    case 'nullishCheck': {
      const operand = requiredValue(state, instruction.value)
      const canBeSentinel = operand.kind === 'nullish' || operand.kind === 'maybeNullish'
        ? instruction.sentinel === 'nullish' || sentinelsAdmit(operand.sentinels, instruction.sentinel)
        : false
      const canMiss = operand.kind === 'nullish'
        // A pure missing value fails a strict check only when it can be the OTHER sentinel.
        ? instruction.sentinel !== 'nullish' && operand.sentinels !== instruction.sentinel
        : true
      const equals: AbstractBoolean = {kind: 'boolean', canBeTrue: canBeSentinel, canBeFalse: canMiss}
      return value(instruction.negated
        ? {kind: 'boolean', canBeTrue: equals.canBeFalse, canBeFalse: equals.canBeTrue}
        : equals)
    }
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
      for (const assumption of completed.boundsAssumptions) addBoundsAssumption(context.boundsAssumptions, assumption)
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

export function addBoundsAssumption(assumptions: BoundsAssumption[], candidate: BoundsAssumption): void {
  if (!assumptions.some(assumption => assumption.site === candidate.site)) assumptions.push(candidate)
}

function sentinelsAdmit(sentinels: 'null' | 'undefined' | 'both', sentinel: 'null' | 'undefined'): boolean {
  return sentinels === 'both' || sentinels === sentinel
}

function withoutSentinel(sentinels: 'null' | 'undefined' | 'both', sentinel: 'null' | 'undefined'): 'null' | 'undefined' | null {
  if (sentinels === 'both') return sentinel === 'null' ? 'undefined' : 'null'
  return sentinels === sentinel ? null : sentinels
}

// Narrows the checked value along one branch of `x === null` and friends, and writes the
// narrowed value back through the producer chain: when the checked value is a property
// read, the parent record's property is replaced too (sound because values are immutable
// — the property cannot differ between this read and the next), so `if (point.x !== null)
// return point.x + 1` narrows both reads. Returns null when the branch is impossible
// (e.g. the value cannot be the checked sentinel).
export function refineNullishCheck(
  state: ExecutionState,
  check: Extract<InstructionIR, {kind: 'nullishCheck'}>,
  truth: boolean,
  producers: Array<InstructionIR | undefined>,
): ExecutionState | null {
  const result = cloneState(state)
  const operand = requiredValue(result, check.value)
  const isSentinel = truth !== check.negated
  const refined = refineForSentinel(operand, check.sentinel, isSentinel)
  if (refined == null) return null
  writeThroughProducers(result, check.value, refined, producers)
  return result
}

function refineForSentinel(
  operand: AbstractValue,
  sentinel: 'null' | 'undefined' | 'nullish',
  isSentinel: boolean,
): AbstractValue | null {
  if (isSentinel) {
    // This branch requires the value to BE the sentinel.
    if (operand.kind === 'nullish') {
      if (sentinel === 'nullish') return operand
      return sentinelsAdmit(operand.sentinels, sentinel) ? {kind: 'nullish', sentinels: sentinel} : null
    }
    if (operand.kind === 'maybeNullish') {
      if (sentinel === 'nullish') return {kind: 'nullish', sentinels: operand.sentinels}
      return sentinelsAdmit(operand.sentinels, sentinel) ? {kind: 'nullish', sentinels: sentinel} : null
    }
    // A value that is never missing cannot take this branch.
    return null
  }
  // This branch requires the value NOT to be the sentinel.
  if (operand.kind === 'nullish') {
    if (sentinel === 'nullish') return null
    const remaining = withoutSentinel(operand.sentinels, sentinel)
    return remaining == null ? null : {kind: 'nullish', sentinels: remaining}
  }
  if (operand.kind === 'maybeNullish') {
    if (sentinel === 'nullish') return operand.inner
    const remaining = withoutSentinel(operand.sentinels, sentinel)
    return remaining == null ? operand.inner : {kind: 'maybeNullish', inner: operand.inner, sentinels: remaining}
  }
  return operand
}

// frame[id] := refined, then rebuild the enclosing value when id was produced by a
// structural read, recursively — later reads see the narrowed value. Property reads
// rebuild the record (and chase through a freshly built record into the value that went
// in: narrowing {...grid}.columns narrows grid.columns, since the copy's property IS the
// original's); length reads rebuild the array's length interval. Every write MEETS the
// destination's current value — a refinement of a stale read must not widen a fresher
// narrowing already sitting in the record.
function writeThroughProducers(
  state: ExecutionState,
  id: ValueID,
  refined: AbstractValue,
  producers: Array<InstructionIR | undefined>,
): void {
  const current = state.frame.values[id]
  const met = current == null ? refined : meetValues(current, refined)
  state.frame.values[id] = met
  const producer = producers[id]
  if (producer?.kind === 'property') {
    const parent = state.frame.values[producer.object]
    if (parent?.kind === 'record') {
      const rebuilt: AbstractValue = {
        kind: 'record',
        properties: parent.properties.map(property =>
          property.name === producer.property
            ? {name: property.name, value: meetValues(property.value, met)}
            : property),
      }
      writeThroughProducers(state, producer.object, rebuilt, producers)
    }
    // A read through a freshly built record narrows the value that went in.
    const parentProducer = producers[producer.object]
    if (parentProducer?.kind === 'object') {
      const source = parentProducer.properties.find(property => property.name === producer.property)
      if (source != null) writeThroughProducers(state, source.value, met, producers)
    }
    return
  }
  if (producer?.kind === 'arrayLength' && met.kind === 'number') {
    const parent = state.frame.values[producer.array]
    if (parent?.kind !== 'array') return
    writeThroughProducers(state, producer.array, {kind: 'array', element: parent.element, length: met}, producers)
  }
}

// The intersection of two covers of the same runtime value — both are supersets of the
// truth, so keeping the tighter fact per dimension is sound. Numbers intersect bounds;
// everything else keeps the refined side (records met pointwise would recurse; the
// refinement chain only ever writes number-bearing shapes today).
function meetValues(current: AbstractValue, refined: AbstractValue): AbstractValue {
  if (current.kind === 'number' && refined.kind === 'number') {
    const met: AbstractNumber = {
      kind: 'number',
      lower: Math.max(current.lower, refined.lower),
      upper: Math.min(current.upper, refined.upper),
      integer: current.integer || refined.integer,
      mayBeNaN: current.mayBeNaN && refined.mayBeNaN,
    }
    const lossSite = refined.lossSite ?? current.lossSite
    return lossSite == null ? met : {...met, lossSite}
  }
  return refined
}

export function refineComparison(
  state: ExecutionState,
  comparison: Extract<InstructionIR, {kind: 'compare'}>,
  truth: boolean,
  producers: Array<InstructionIR | undefined>,
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
  // Through the producer chain, like the null-check refinement: narrowing an
  // arrayLength's result rebuilds the array value with the narrowed length (so
  // `if (values.length > 0) values[0]!` proves the read), and narrowing a property read
  // rebuilds the record.
  writeThroughProducers(result, comparison.left, refinedLeft, producers)
  writeThroughProducers(result, comparison.right, refinedRight, producers)
  return result
}

function requiredNumber(state: ExecutionState, id: ValueID): AbstractNumber {
  const value = requiredValue(state, id)
  if (value.kind !== 'number') throw new KindMismatch(`IR value ${id} is not a number`)
  return value
}

export function requiredBoolean(state: ExecutionState, id: ValueID): AbstractBoolean {
  const value = requiredValue(state, id)
  if (value.kind !== 'boolean') throw new KindMismatch(`IR value ${id} is not a boolean`)
  return value
}

// A constant in-bounds index picks the exact tuple element; anything else takes the hull.
// Returns null only for the empty tuple.
function tupleElement(tuple: Extract<AbstractValue, {kind: 'tuple'}>, index: AbstractNumber): AbstractValue | null {
  if (tuple.elements.length === 0) return null
  if (index.integer && !index.mayBeNaN && index.lower === index.upper) {
    const exact = tuple.elements[index.lower]
    if (exact != null) return exact
  }
  return tuple.elements.reduce((joined, next) => joinValues(joined, next))
}

function requiredSequence(state: ExecutionState, id: ValueID): Extract<AbstractValue, {kind: 'tuple' | 'array'}> {
  const value = requiredValue(state, id)
  if (value.kind !== 'tuple' && value.kind !== 'array') throw new KindMismatch(`IR value ${id} is not an array`)
  return value
}

function requiredRecord(state: ExecutionState, id: ValueID): AbstractRecord {
  const value = requiredValue(state, id)
  if (value.kind !== 'record') throw new KindMismatch(`IR value ${id} is not a record`)
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
