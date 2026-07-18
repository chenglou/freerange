import {
  remainderNumbers,
  roundedNumber,
  squareRootNumber,
  nextDown,
  nextUp,
  absoluteNumber,
  addNumbers,
  constantNumber,
  divideNumbers,
  divideNumbersNonzeroDivisor,
  floorNumber,
  includesZero,
  isDefinitelyZero,
  isFiniteNumber,
  maximumNumbers,
  minimumNumbers,
  multiplyNumbers,
  pointExcluded,
  subtractNumbers,
  type AbstractNumber,
} from '../domain/number.ts'
import {
  joinValues,
  recordProperty,
  recordValue,
  tryJoinValues,
  unknownBoolean,
  type AbstractBoolean,
  type AbstractRecord,
  type AbstractTaggedUnion,
  type AbstractValue,
  type TaggedVariant,
} from '../domain/value.ts'
import type {FunctionID, SiteID, ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import {coveringKindValue, declaredKindOf, type ProgramIR} from '../ir/program.ts'
import {
  addPrecondition,
  peelNonzero,
  canonicalValueKey,
  numericExpression,
  resolveStoredValue,
  sameRuntimeValue,
  staticRequirement,
  type ExpressionContext,
} from '../requirements/infer.ts'
import type {BoundsAssumption, InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import {completedEvaluation, type FunctionEvaluation, type RequirementFailure, type Stop} from './outcome.ts'
import {
  addValueFact,
  cloneState,
  hasIndexFact,
  hasNonzeroFact,
  type ExecutionState,
  type SharedState,
  type ValueFact,
} from './state.ts'

type EvaluateFunction = (
  functionID: FunctionID,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  callStack: FunctionID[],
  valueFacts: ValueFact[],
  parameterIdentityKeys: string[],
  identityNamespace: string,
) => FunctionEvaluation

export type TransferContext = {
  program: ProgramIR
  callStack: FunctionID[]
  expressionContext: ExpressionContext
  preconditions: InferredPrecondition[]
  // Element reads the engine could not prove in bounds — the peer of preconditions,
  // accumulated per evaluation and adopted from completed callees the same way.
  boundsAssumptions: BoundsAssumption[]
  evaluateFunction: EvaluateFunction
}

// TypeScript's narrowing is an open-ended set of rules; the analyzer models the common
// shapes (null checks, ?? , nested guards) and consults the checker's types at every
// gate, but a value can still reach an operation whose kind the local narrowing did not
// establish. That is a mismatch between two narrowing systems, not an accepted-subset
// violation, so it degrades to a per-path stop (owner decision) instead of crashing the
// run — thrown here, converted to a stop at the single catch in evaluateInstruction.
class KindMismatch extends Error {
  constructor(message: string, readonly value: ValueID) {
    super(message)
  }
}

type ValueStep = {kind: 'value'; value: AbstractValue}

// One instruction either produces a value, records an assertion observation, or stops the
// current path.
export type StepResult =
  | ValueStep
  | {
      kind: 'assertion'
      assertion: number
      observation: AbstractBoolean
      value: Extract<AbstractValue, {kind: 'void'}>
    }
  | {kind: 'stop'; stop: Stop}
  // The path ends contributing nothing — a call to a function that throws on every path,
  // behaving exactly like an inline throw: no return value, no stop record.
  | {kind: 'ends'}

function failedRequirement(failure: RequirementFailure): StepResult {
  return {kind: 'stop', stop: {
    site: failure.site,
    reason: {kind: 'requirementFailure', failure, callee: null},
  }}
}

// The three ways an instruction arm produces its value, typed so a freshly computed number
// cannot leave evaluateInstruction without the blame stamp: value() rejects numbers at the
// type level, computedNumber() stamps, and passthroughValue() is the one named escape hatch
// for values whose numbers were already stamped where they were produced (reads, call
// results, constants — stamping constants would newly blame overflowing literals).
function value(result: Exclude<AbstractValue, AbstractNumber>): ValueStep {
  return {kind: 'value', value: result}
}

function passthroughValue(result: AbstractValue): ValueStep {
  return {kind: 'value', value: result.kind === 'number' ? normalizeRefinedNumber(result) : result}
}

// Report annotations only: a degraded result inherits the relevant operand site, or, when
// every operand still had the property, records this operation. Finiteness and NaN use
// separate sites because an overflow can enable a later operation to produce NaN without
// being the operation that produced it.
function computedNumber(raw: AbstractNumber, operands: AbstractNumber[], site: SiteID): ValueStep {
  return {kind: 'value', value: withLossBlame(normalizeRefinedNumber(raw), operands, site)}
}

function withLossBlame(result: AbstractNumber, operands: AbstractNumber[], site: SiteID): AbstractNumber {
  if (isFiniteNumber(result) && !result.mayBeNaN) return result
  let annotated = result
  if (!isFiniteNumber(result) && result.nonFiniteSite == null) {
    const carrier = operands.find(operand => !isFiniteNumber(operand) && operand.nonFiniteSite != null)
    const nonFiniteSite = carrier?.nonFiniteSite
      ?? (operands.every(operand => isFiniteNumber(operand)) ? site : undefined)
    if (nonFiniteSite != null) annotated = {...annotated, nonFiniteSite}
  }
  if (result.mayBeNaN && result.nanSite == null) {
    const carrier = operands.find(operand => operand.mayBeNaN && operand.nanSite != null)
    const nanSite = carrier?.nanSite
      ?? (operands.every(operand => !operand.mayBeNaN) ? site : undefined)
    if (nanSite != null) annotated = {...annotated, nanSite}
  }
  return annotated
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
      const missingElementSite = possiblyMissingElementReadSite(
        state,
        error.value,
        context.expressionContext.instructionByValue,
      )
      if (missingElementSite != null) {
        return {kind: 'stop', stop: {site: missingElementSite, reason: {kind: 'possiblyMissingElement'}}}
      }
      return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'kindMismatch'}}}
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
    case 'opaqueConstant': return value(
      instruction.content == null ? {kind: 'opaque'} : {kind: 'opaque', content: instruction.content})
    case 'unknownBoolean': return value(unknownBoolean())
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
      const index = requiredNumberWithFacts(state, instruction.index, context.expressionContext)
      const element = sequence.kind === 'tuple'
        ? tupleElement(sequence, index)
        : sequence.element
      const length = sequence.kind === 'tuple' ? constantNumber(sequence.elements.length) : sequence.length
      const indexKey = canonicalValueKey(instruction.index, context.expressionContext)
      const arrayKey = canonicalValueKey(instruction.array, context.expressionContext)
      const assumedValid = hasIndexFact(state.valueFacts, 'validIndex', indexKey, arrayKey)
      // Three proofs of in-bounds: a complete prior requirement, intervals, or the strict
      // below-length half from a guard combined with the index's own integer/nonnegative
      // facts. A for-of loop reaches the same third proof through its generated guard.
      const inBounds = assumedValid
        || (index.integer && !index.mayBeNaN && index.lower >= 0 && index.upper < length.lower)
        || (index.integer && !index.mayBeNaN && index.lower >= 0
          && hasIndexFact(state.valueFacts, 'belowLength', indexKey, arrayKey))
      // A provably out-of-bounds read: for the asserted form the assertion lied; for the
      // bare form the value is exactly undefined. An empty sequence is the special case
      // where every read is out of bounds.
      const firstPossibleIndex = Math.ceil(Math.max(index.lower, 0))
      const lastPossibleIndex = Math.floor(Math.min(index.upper, length.upper - 1))
      const provablyOut = element == null
        // Array indexes are nonnegative integers below the array's length. If the index
        // and length ranges admit no such integer, every concrete read misses.
        || firstPossibleIndex > lastPossibleIndex
      if (provablyOut) {
        if (instruction.mode === 'asserted') {
          return failedRequirement({kind: 'elementInBounds', site: instruction.site})
        }
        return value({kind: 'nullish', sentinels: 'undefined'})
      }
      if (instruction.mode === 'bare' || instruction.mode === 'bareUnchecked') {
        // Bare arr[i] types T | undefined; a proven read cannot miss, an unproven one
        // honestly carries the possibility.
        return inBounds
          ? passthroughValue(element)
          : passthroughValue(joinValues({kind: 'nullish', sentinels: 'undefined'}, element))
      }
      if (!inBounds) {
        // The caller-actionable form wins when both sides are nameable: a requires line
        // the caller can satisfy, instead of an assumes line the entry merely rests on.
        const indexExpression = numericExpression(instruction.index, context.expressionContext)
        const sequenceExpression = numericExpression(instruction.array, context.expressionContext)
        if (indexExpression != null && sequenceExpression != null) {
          addPrecondition(context.preconditions, {
            kind: 'inBounds',
            index: indexExpression,
            sequence: sequenceExpression,
            site: instruction.site,
          })
        } else {
          addBoundsAssumption(context.boundsAssumptions, {site: instruction.site, kind: 'elementInBounds'})
        }
        // The function's contract now assumes this read is valid. Keep the index facts
        // and the exact array/index relationship for later reads on this path.
        writeThroughProducers(
          state, instruction.index, validIndexNumber(index),
          context.expressionContext.instructionByValue,
        )
        addValueFact(state.valueFacts, {kind: 'validIndex', index: indexKey, array: arrayKey})
      }
      return passthroughValue(element)
    }
    case 'numberCheck': {
      const operand = requiredNumberWithFacts(state, instruction.value, context.expressionContext)
      return value(evaluateNumberCheck(instruction.predicate, operand))
    }
    case 'tagCheck': {
      const operand = requiredValue(state, instruction.union)
      // A plain record can reach a tag check: a builder whose declared return is a single
      // variant produces a record, and the caller's union-typed binding checks its tag.
      // The record's tag value is an opaque string the analysis never learned, so the
      // check is honestly unknown and both branches analyze — the same dispatch the
      // shared-shape classification used to give this code.
      if (operand.kind === 'record') return value(unknownBoolean())
      const union = requiredTaggedUnion(state, instruction.union)
      const matches = union.variants.some(variant => variant.tagValue === instruction.tagValue)
      const misses = union.variants.some(variant => variant.tagValue !== instruction.tagValue)
      const equals: AbstractBoolean = {kind: 'boolean', canBeTrue: matches, canBeFalse: misses}
      return value(instruction.negated
        ? {kind: 'boolean', canBeTrue: equals.canBeFalse, canBeFalse: equals.canBeTrue}
        : equals)
    }
    case 'nullishCheck': {
      const operand = requiredValue(state, instruction.value)
      // Opaque carries no claims, so the runtime value may itself be null or undefined —
      // an unknown-typed parameter often is. A bare opaque, or a maybeNullish whose inner
      // is opaque, therefore answers unknown: the sentinels set only describes what the
      // nullish side of a join contributed, not what the opaque side may hold. (A review
      // round caught the old definitely-false answer publishing a dead branch for
      // `if (value === undefined)` on an unknown-typed value.)
      const opaqueInside = operand.kind === 'opaque'
        || (operand.kind === 'maybeNullish' && operand.inner.kind === 'opaque')
      const canBeSentinel = opaqueInside
        || (operand.kind === 'nullish' || operand.kind === 'maybeNullish'
          ? instruction.sentinel === 'nullish' || sentinelsAdmit(operand.sentinels, instruction.sentinel)
          : false)
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
      const slot = state.shared[instruction.binding]
      if (slot === undefined) throw new Error(`Unknown module binding ${instruction.binding}`)
      if (slot === null) {
        return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'moduleRead', binding: instruction.binding}}}
      }
      return passthroughValue(slot)
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
        state.shared[instruction.binding] = assigned
      }
      return passthroughValue(assigned)
    }
    case 'moduleHavoc': {
      const binding = context.program.moduleBindings[instruction.binding]
      if (binding == null) throw new Error(`Unknown module binding ${instruction.binding}`)
      const declaredKind = declaredKindOf(binding.category)
      // Covering, not assumed-finite: values computed from this slot can publish without
      // any assumes line, so the reset must include NaN and infinities.
      state.shared[instruction.binding] = declaredKind == null
        ? null
        : coveringKindValue(declaredKind)
      return value({kind: 'void'})
    }
    case 'object': {
      const record = recordValue(instruction.properties.map(property => ({
        name: property.name,
        value: requiredValue(state, property.value),
      })))
      if (instruction.tag == null) return value(record)
      // The variant pin comes from the tag property's VALUE — known string content (a
      // written literal, or a tag seeded from its declared variant and carried through
      // spreads and bindings) or an exact boolean. The checker's TYPE for the tag is
      // deliberately not consulted: a review round chained three assertion launders
      // (cast tag, quoted-key cast tag, spread of a cast-tagged template) through the
      // type channel, while erased casts by construction carry no content. A tag value
      // the engine cannot pin leaves the literal a plain record, whose tag checks
      // dispatch as unknown booleans and whose reads fall to the record-hull backstop.
      const tagPropertyValue = recordProperty(record, instruction.tag.property)
      const pinned = tagPropertyValue?.kind === 'opaque' && tagPropertyValue.content != null
        ? tagPropertyValue.content
        : tagPropertyValue?.kind === 'boolean' && tagPropertyValue.canBeTrue !== tagPropertyValue.canBeFalse
          ? tagPropertyValue.canBeTrue
          : null
      if (pinned == null) return value(record)
      return value({
        kind: 'taggedUnion',
        tagProperty: instruction.tag.property,
        variants: [{tagValue: pinned, record}],
      })
    }
    case 'property': {
      const object = requiredValue(state, instruction.object)
      // A read through a tagged union: a single remaining variant (after a tag check)
      // reads like the plain record it is; with several variants left, a property every
      // variant carries reads as the join of the per-variant values — a fact true no
      // matter which shape the value is. A property only SOME variants carry needs a tag
      // check first, and reaching here without one is an unmodeled-narrowing stop, not a
      // crash (requiredRecord throws KindMismatch below for non-record kinds already).
      if (object.kind === 'taggedUnion') {
        const variantProperty = (variant: TaggedVariant): AbstractValue => {
          const inVariant = recordProperty(variant.record, instruction.property)
          if (inVariant == null) {
            throw new KindMismatch(`Variant ${variant.tagValue} has no property ${instruction.property}`, instruction.object)
          }
          return inVariant
        }
        const [firstVariant, ...restVariants] = object.variants
        let joined: AbstractValue = variantProperty(firstVariant)
        for (const variant of restVariants) {
          const next = tryJoinValues(joined, variantProperty(variant))
          if (next == null) {
            throw new KindMismatch(`Property ${instruction.property} mixes kinds across variants`, instruction.object)
          }
          joined = next
        }
        return passthroughValue(joined)
      }
      const record = requiredRecord(state, instruction.object)
      const propertyValue = recordProperty(record, instruction.property)
      // A missing property is an honest per-path stop, not a crash: a tagged union that
      // met a plain record degraded to their shared hull, and a read past the hull is
      // exactly a narrowing the analysis did not model. (Before hulls existed this was a
      // gate-bug tripwire; the backstop bucket is what review rounds audit now.)
      if (propertyValue == null) {
        throw new KindMismatch(`Record has no property ${instruction.property}`, instruction.object)
      }
      return passthroughValue(propertyValue)
    }
    case 'compare': {
      // Equality dispatches on the operand kind: booleans answer from their exact
      // two-point lattice, numbers from their intervals.
      const left = requiredValue(state, instruction.left)
      const right = requiredValue(state, instruction.right)
      const same = sameRuntimeValue(instruction.left, instruction.right, context.expressionContext)
      if (left.kind === 'boolean' && right.kind === 'boolean'
        && (instruction.operator === 'equal' || instruction.operator === 'notEqual')) {
        if (same) return value(exactBoolean(instruction.operator === 'equal'))
        return value(compareBooleans(left, right, instruction.operator === 'notEqual'))
      }
      const leftNumber = requiredNumberWithFacts(state, instruction.left, context.expressionContext)
      const rightNumber = requiredNumberWithFacts(state, instruction.right, context.expressionContext)
      if (same) {
        return value(compareSameNumber(intersectSameNumbers(leftNumber, rightNumber), instruction.operator))
      }
      const intervalResult = compareNumbers(leftNumber, rightNumber, instruction.operator)
      return value(intervalResult)
    }
    case 'parsedNumber': return computedNumber({
      kind: 'number',
      lower: Number.NEGATIVE_INFINITY,
      upper: Number.POSITIVE_INFINITY,
      integer: instruction.integer,
      mayBeNaN: true,
    }, [], instruction.site)
    case 'stringLength': return computedNumber({
      kind: 'number',
      lower: 0,
      upper: Number.MAX_SAFE_INTEGER,
      integer: true,
      mayBeNaN: false,
    }, [], instruction.site)
    case 'mathUnary': {
      const operand = requiredNumberWithFacts(state, instruction.value, context.expressionContext)
      return computedNumber(
        instruction.operator === 'sqrt' ? squareRootNumber(operand) : roundedNumber(instruction.operator, operand),
        [operand],
        instruction.site,
      )
    }
    case 'floor': {
      const operand = requiredNumberWithFacts(state, instruction.value, context.expressionContext)
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
      const operand = requiredNumberWithFacts(state, instruction.value, context.expressionContext)
      return computedNumber(absoluteNumber(operand), [operand], instruction.site)
    }
    case 'not': {
      const operand = requiredBoolean(state, instruction.value)
      return value({kind: 'boolean', canBeTrue: operand.canBeFalse, canBeFalse: operand.canBeTrue})
    }
    case 'staticAssert': {
      const observation = staticAssertionObservation(instruction.value, state, context)
      return {kind: 'assertion', assertion: instruction.assertion, observation, value: {kind: 'void'}}
    }
    case 'staticRequire': {
      const condition = requiredValue(state, instruction.value)
      if (condition.kind !== 'boolean') {
        return failedRequirement({kind: 'declared', site: instruction.site, status: 'unproven'})
      }
      const check = context.expressionContext.instructionByValue[instruction.value]
      if (check?.kind !== 'compare' && check?.kind !== 'numberCheck') {
        return failedRequirement({kind: 'declared', site: instruction.site, status: 'unproven'})
      }
      if (!condition.canBeTrue) {
        return failedRequirement({kind: 'declared', site: instruction.site, status: 'refuted'})
      }
      if (!condition.canBeFalse) return value({kind: 'void'})
      const requirement = staticRequirement(check, instruction.site, context.expressionContext)
      if (requirement == null) {
        return failedRequirement({kind: 'declared', site: instruction.site, status: 'unproven'})
      }
      const refined = refineCheck(state, check, true, context.expressionContext)
      if (refined == null) {
        return failedRequirement({kind: 'declared', site: instruction.site, status: 'refuted'})
      }
      state.values = refined.values
      state.shared = refined.shared
      state.valueFacts = refined.valueFacts
      addPrecondition(context.preconditions, requirement)
      return value({kind: 'void'})
    }
    case 'minimum': {
      const operands = instruction.values.map(id => requiredNumberWithFacts(state, id, context.expressionContext))
      return computedNumber(minimumNumbers(operands), operands, instruction.site)
    }
    case 'maximum': {
      const operands = instruction.values.map(id => requiredNumberWithFacts(state, id, context.expressionContext))
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
      // Parameters use their caller arguments' identity keys. The same small fact list
      // therefore works inside the callee and comes back after every normal return, so a
      // requirement established by a completed helper call applies below that call.
      const argumentKeys = instruction.arguments.map(id => canonicalValueKey(id, context.expressionContext))
      const calleeNamespace = `${context.expressionContext.identityNamespace}call:${instruction.function}:${instruction.site}/`
      const evaluation = context.evaluateFunction(
        instruction.function,
        arguments_,
        argumentExpressions,
        state.shared,
        context.callStack,
        state.valueFacts,
        argumentKeys,
        calleeNamespace,
      )
      // A partial callee's result is discarded wholesale: the callee ran on a clone, and
      // state.shared is assigned only on the complete path below, so a partial callee's
      // module writes cannot become this caller's state.
      const completed = completedEvaluation(evaluation)
      if (completed == null) {
        // A callee that throws on every path is fully analyzed; the call just never
        // returns, so this path ends exactly like an inline throw — silently. A guarded
        // `if (bad) return fail(x)` then reports the same full contract the throw
        // spelling gets.
        if (evaluation.stops.length === 0 && evaluation.normal == null) {
          for (const precondition of evaluation.preconditions) addPrecondition(context.preconditions, precondition)
          for (const assumption of evaluation.boundsAssumptions) addBoundsAssumption(context.boundsAssumptions, assumption)
          return {kind: 'ends'}
        }
        const requirementFailure = evaluation.stops.find(stop => stop.reason.kind === 'requirementFailure')
        if (requirementFailure?.reason.kind === 'requirementFailure') {
          const reason = requirementFailure.reason
          return {kind: 'stop', stop: {
            site: instruction.site,
            reason: {...reason, callee: instruction.function},
          }}
        }
        return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'calleeStopped', callee: instruction.function}}}
      }
      state.shared = completed.sharedState
      state.valueFacts = completed.valueFacts.filter(fact =>
        !valueFactUsesNamespace(fact, calleeNamespace))
      for (const precondition of completed.preconditions) addPrecondition(context.preconditions, precondition)
      for (const assumption of completed.boundsAssumptions) addBoundsAssumption(context.boundsAssumptions, assumption)
      return passthroughValue(completed.returnValue)
    }
    case 'binary': {
      const left = requiredNumberWithFacts(state, instruction.left, context.expressionContext)
      const right = requiredNumberWithFacts(state, instruction.right, context.expressionContext)
      const sameOperand = sameRuntimeValue(
        instruction.left,
        instruction.right,
        context.expressionContext,
      ) ? intersectSameNumbers(left, right) : null
      if (
        (instruction.operator === 'divide' || instruction.operator === 'remainder')
        && isDefinitelyZero(right)
      ) {
        return failedRequirement({
          kind: 'nonzeroDivisor',
          site: instruction.site,
          operation: instruction.operator === 'divide' ? 'division' : 'remainder',
        })
      }
      if (
        (instruction.operator === 'divide' || instruction.operator === 'remainder')
        && includesZero(right)
      ) {
        const operation = instruction.operator === 'divide' ? 'division' : 'remainder'
        const expression = numericExpression(instruction.right, context.expressionContext)
        if (expression == null) {
          // The divisor is not expressible over the caller's arguments (a join, a module
          // read, an element read, a call result, or an exhausted expression walk), so no
          // requirement can be minted. Record the nonzero assumption instead of stopping —
          // the same channel asserted element reads use — and compute below as if it
          // holds: a zero divisor at runtime violates the printed assumes line, making
          // the downstream claims vacuous, exactly like every other assumes line.
          addBoundsAssumption(context.boundsAssumptions, {site: instruction.site, kind: 'nonzeroDivisor'})
        } else {
          addPrecondition(context.preconditions, peelNonzero(expression, instruction.site, operation))
        }
        // Preconditions and assumptions are promises made by the caller. Later uses of
        // this same stored divisor on this path may rely on the promise just recorded.
        recordNonzeroValueFact(state, instruction.right, context.expressionContext)
        writeThroughProducers(
          state,
          instruction.right,
          excludePointFrom(right, constantNumber(0)),
          context.expressionContext.instructionByValue,
        )
        // Ensures assume the requires: with the nonzero requirement recorded, the quotient
        // is computed over the divisor's range with zero cut out. An integer divisor gives
        // a genuinely finite result; a non-integer one can still sit arbitrarily close to
        // zero and stays possibly non-finite. The remainder is bounded by both operands.
        return computedNumber(
          sameOperand == null
            ? instruction.operator === 'divide'
              ? divideNumbersNonzeroDivisor(left, right)
              : remainderNumbers(left, right, true)
            : evaluateSameOperandBinary(instruction.operator, sameOperand),
          [left, right],
          instruction.site,
        )
      }
      return computedNumber(
        sameOperand == null
          ? evaluateBinary(instruction.operator, left, right)
          : evaluateSameOperandBinary(instruction.operator, sameOperand),
        [left, right],
        instruction.site,
      )
    }
  }
}

export function addBoundsAssumption(assumptions: BoundsAssumption[], candidate: BoundsAssumption): void {
  if (!assumptions.some(assumption => assumption.site === candidate.site && assumption.kind === candidate.kind)) {
    assumptions.push(candidate)
  }
}

function valueFactUsesNamespace(fact: ValueFact, namespace: string): boolean {
  const marker = `v:${namespace}`
  if (fact.kind === 'nonzero') return fact.value.includes(marker)
  return fact.index.includes(marker) || fact.array.includes(marker)
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
function requiredTaggedUnion(state: ExecutionState, id: ValueID): AbstractTaggedUnion {
  const operand = requiredValue(state, id)
  if (operand.kind !== 'taggedUnion') throw new KindMismatch(`IR value ${id} is not a tagged union`, id)
  return operand
}

// The branch where route.type === 'lightbox' held keeps only the matching variants; the
// other branch keeps the rest. A side with no variants left is impossible and prunes.
// Written through the producer chain like every refinement, so the union binding itself
// narrows, not just the read.
function refineTagCheck(
  state: ExecutionState,
  check: Extract<InstructionIR, {kind: 'tagCheck'}>,
  truth: boolean,
  producers: Array<InstructionIR | undefined>,
): ExecutionState | null {
  const result = cloneState(state)
  // A record operand has nothing to refine (its tag value was never learned); both
  // branches keep the state, mirroring the unknown-boolean evaluation above.
  if (requiredValue(result, check.union).kind === 'record') return result
  const union = requiredTaggedUnion(result, check.union)
  const wantMatch = truth !== check.negated
  const [firstKept, ...restKept] = union.variants.filter(variant => (variant.tagValue === check.tagValue) === wantMatch)
  if (firstKept == null) return null
  writeThroughProducers(result, check.union, {kind: 'taggedUnion', tagProperty: union.tagProperty, variants: [firstKept, ...restKept]}, producers)
  return result
}

function refineNullishCheck(
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
      // An opaque inner can be either sentinel at runtime, beyond what the wrapper's
      // sentinels set lists — the branch stays live and widens to both.
      const opaqueInner = operand.inner.kind === 'opaque'
      if (sentinel === 'nullish') {
        return {kind: 'nullish', sentinels: opaqueInner ? 'both' : operand.sentinels}
      }
      return sentinelsAdmit(operand.sentinels, sentinel) || opaqueInner
        ? {kind: 'nullish', sentinels: sentinel}
        : null
    }
    // A bare opaque may be the sentinel too; this branch pins it down to exactly that.
    if (operand.kind === 'opaque') {
      return {kind: 'nullish', sentinels: sentinel === 'nullish' ? 'both' : sentinel}
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
// in: with `const copy = {columns: grid.columns}`, narrowing copy.columns narrows
// grid.columns, since the copy's property IS the stored grid.columns read); length reads
// rebuild the array's length interval. Every write MEETS the destination's current value
// — a refinement of a stale read must not widen a fresher narrowing already sitting in
// the record.
function writeThroughProducers(
  state: ExecutionState,
  id: ValueID,
  refined: AbstractValue,
  producers: Array<InstructionIR | undefined>,
): void {
  const current = state.values[id]
  const met = current == null ? refined : meetValues(current, refined)
  state.values[id] = met
  const producer = producers[id]
  if (producer?.kind === 'property') {
    const parent = state.values[producer.object]
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
    // A property read through a tagged union (box.owner after a tag check on box, or a
    // shared property before one): the refinement meets into every variant that carries
    // the property, so the narrowing sticks on the union binding, not just this read.
    if (parent?.kind === 'taggedUnion') {
      const rebuildVariant = (variant: TaggedVariant): TaggedVariant => {
        const existing = recordProperty(variant.record, producer.property)
        if (existing == null) return variant
        return {
          tagValue: variant.tagValue,
          record: {
            kind: 'record',
            properties: variant.record.properties.map(property =>
              property.name === producer.property
                ? {name: property.name, value: meetValues(property.value, met)}
                : property),
          },
        }
      }
      const [firstVariant, ...restVariants] = parent.variants
      const rebuilt: AbstractValue = {
        kind: 'taggedUnion',
        tagProperty: parent.tagProperty,
        variants: [rebuildVariant(firstVariant), ...restVariants.map(rebuildVariant)],
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
    const parent = state.values[producer.array]
    if (parent?.kind !== 'array') return
    const length = meetValues(parent.length, met)
    if (length.kind !== 'number') return
    writeThroughProducers(state, producer.array, {kind: 'array', element: parent.element, length}, producers)
  }
}

// The intersection of two covers of the same runtime value — both are supersets of the
// truth, so keeping the tighter fact per dimension is sound. Numbers intersect bounds;
// records, arrays, and tuples meet their structure pointwise (a rebuilt array must not
// clobber a fresher length narrowing already on the destination); anything else keeps the
// refined side.
function meetValues(current: AbstractValue, refined: AbstractValue): AbstractValue {
  // An exhaustive switch on the refined side, like widenValue: every kind states its
  // meet behavior, so a future kind cannot silently discard the current side's facts.
  switch (refined.kind) {
    case 'number': {
      if (current.kind !== 'number') return refined
      let met = normalizeRefinedNumber({
        kind: 'number',
        lower: Math.max(current.lower, refined.lower),
        upper: Math.min(current.upper, refined.upper),
        integer: current.integer || refined.integer,
        mayBeNaN: current.mayBeNaN && refined.mayBeNaN,
      })
      // An intersection keeps every fact either cover proved; only one point fits the
      // field, and the refined side's is the fresher fact.
      const excludedPoint = refined.excludesPoint ?? current.excludesPoint
      if (excludedPoint != null) met = normalizeRefinedNumber({...met, excludesPoint: excludedPoint})
      if (!isFiniteNumber(met)) {
        const nonFiniteSite = refined.nonFiniteSite ?? current.nonFiniteSite
        if (nonFiniteSite != null) met.nonFiniteSite = nonFiniteSite
      }
      if (met.mayBeNaN) {
        const nanSite = refined.nanSite ?? current.nanSite
        if (nanSite != null) met.nanSite = nanSite
      }
      return met
    }
    case 'record': {
      if (current.kind !== 'record') return refined
      return {
        kind: 'record',
        properties: refined.properties.map(property => {
          const existing = recordProperty(current, property.name)
          return existing == null ? property : {name: property.name, value: meetValues(existing, property.value)}
        }),
      }
    }
    case 'array': {
      if (current.kind !== 'array') return refined
      const length = meetValues(current.length, refined.length)
      const element = current.element == null ? refined.element
        : refined.element == null ? current.element
        : meetValues(current.element, refined.element)
      return {kind: 'array', element, length: length.kind === 'number' ? length : refined.length}
    }
    case 'tuple': {
      if (current.kind !== 'tuple' || current.elements.length !== refined.elements.length) return refined
      return {kind: 'tuple', elements: refined.elements.map((element, index) => meetValues(current.elements[index]!, element))}
    }
    // No pointwise structure to intersect (or, for taggedUnion, none the refinements
    // produce today): the refined side is the fresher cover of the same runtime value.
    case 'boolean':
    case 'void':
    case 'nullish':
    case 'maybeNullish':
    case 'opaque':
    case 'taggedUnion':
      return refined
  }
}

function evaluateNumberCheck(predicate: 'integer' | 'finite' | 'nan', operand: AbstractNumber): AbstractBoolean {
  const finiteLower = Math.max(operand.lower, -Number.MAX_VALUE)
  const finiteUpper = Math.min(operand.upper, Number.MAX_VALUE)
  if (predicate === 'nan') {
    // The domain cannot express "always NaN", so the false side stays possible.
    return {kind: 'boolean', canBeTrue: operand.mayBeNaN, canBeFalse: true}
  }
  if (predicate === 'finite') {
    return {
      kind: 'boolean',
      // True is possible when a finite inhabitant exists; false when NaN or an infinity can.
      canBeTrue: finiteLower <= finiteUpper,
      canBeFalse: operand.mayBeNaN || !isFiniteNumber(operand),
    }
  }
  return {
    kind: 'boolean',
    // Number.isInteger is false for NaN and the infinities, so the true side needs a
    // finite integer inhabitant and the false side anything else.
    canBeTrue: Math.ceil(finiteLower) <= Math.floor(finiteUpper),
    canBeFalse: !operand.integer || operand.mayBeNaN || !isFiniteNumber(operand),
  }
}

function refineNumberCheck(
  state: ExecutionState,
  check: Extract<InstructionIR, {kind: 'numberCheck'}>,
  truth: boolean,
  producers: Array<InstructionIR | undefined>,
): ExecutionState | null {
  const result = cloneState(state)
  const operand = requiredNumber(result, check.value)
  if (check.predicate === 'nan') {
    // The passing branch holds exactly NaN — not representable as a refinement, so the
    // unrefined operand stays as its sound cover, and the branch prunes outright when the
    // value provably cannot be NaN. The failing branch launders: mayBeNaN clears.
    if (truth) return operand.mayBeNaN ? result : null
    const laundered: AbstractNumber = {...operand, mayBeNaN: false}
    writeThroughProducers(result, check.value, laundered, producers)
    return result
  }
  if (truth) {
    // The passing branch proves finiteness for both predicates (isInteger rejects the
    // infinities too), and integrality snaps the bounds inward.
    let refined: AbstractNumber = {
      ...operand,
      mayBeNaN: false,
      lower: Math.max(operand.lower, -Number.MAX_VALUE),
      upper: Math.min(operand.upper, Number.MAX_VALUE),
    }
    if (check.predicate === 'integer') {
      refined = {...refined, integer: true, lower: Math.ceil(refined.lower), upper: Math.floor(refined.upper)}
    }
    if (refined.lower > refined.upper) return null
    writeThroughProducers(result, check.value, refined, producers)
    return result
  }
  // The failing branch holds NaN, the infinities, and (for isInteger) every non-integer —
  // none of which an interval can carve out, except the one provable contradiction: a
  // value already finite and NaN-free cannot fail isFinite at all.
  if (check.predicate === 'finite' && !operand.mayBeNaN && isFiniteNumber(operand)) return null
  return result
}

function refineComparison(
  state: ExecutionState,
  comparison: Extract<InstructionIR, {kind: 'compare'}>,
  truth: boolean,
  expressionContext: ExpressionContext,
): ExecutionState | null {
  const producers = expressionContext.instructionByValue
  const result = cloneState(state)
  // Boolean equality refines exactly over the two-point lattice: in the branch where
  // flag === true held, flag IS true. A contradiction (both sides known, and the branch
  // demands they differ from what they are) prunes.
  const leftOperand = requiredValue(result, comparison.left)
  const rightOperand = requiredValue(result, comparison.right)
  if (leftOperand.kind === 'boolean' && rightOperand.kind === 'boolean') {
    const equalHolds = truth === (comparison.operator === 'equal')
    const known = (side: AbstractBoolean): boolean | null =>
      side.canBeTrue === side.canBeFalse ? null : side.canBeTrue
    const refineTo = (id: ValueID, mustBe: boolean): boolean => {
      const current = requiredBoolean(result, id)
      if (mustBe ? !current.canBeTrue : !current.canBeFalse) return false
      writeThroughProducers(result, id, {kind: 'boolean', canBeTrue: mustBe, canBeFalse: !mustBe}, producers)
      return true
    }
    const leftKnown = known(leftOperand)
    const rightKnown = known(rightOperand)
    if (rightKnown != null && !refineTo(comparison.left, equalHolds ? rightKnown : !rightKnown)) return null
    if (leftKnown != null && !refineTo(comparison.right, equalHolds ? leftKnown : !leftKnown)) return null
    return result
  }
  const left = requiredNumberWithFacts(result, comparison.left, expressionContext)
  const right = requiredNumberWithFacts(result, comparison.right, expressionContext)
  const operator = truth ? comparison.operator : invertedComparison(comparison.operator)
  // The branch where the written condition did not hold is also where a NaN operand lands,
  // with the OTHER operand unconstrained. Inverting an ordered comparison and refining
  // bounds is only sound when neither operand can be NaN; e.g. with a possibly-NaN clamp
  // result as the right operand, `if (x < clamped) ... else return x` reaches the else
  // with any x at all whenever clamped is NaN. The not-equal refinement is exempt: it only
  // cuts interval points, which never rules out a NaN inhabitant, and NaN lands on the
  // not-equal side anyway (NaN !== c is true).
  if (!truth && operator !== 'equal' && (left.mayBeNaN || right.mayBeNaN)) return result
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
      const intersection = intersectSameNumbers(left, right)
      refinedLeft = intersection
      refinedRight = intersection
      break
    }
    case 'notEqual': {
      refinedLeft = excludePointFrom(left, right)
      refinedRight = excludePointFrom(right, left)
      break
    }
  }
  // The bounds-check idiom: in the branch where `i < arr.length` held, record the pair —
  // the below-length half of in-bounds that no interval can carry (a relation between two
  // unknowns). The `i > arr.length`-failed spelling arrives here as the inverted
  // lessThanOrEqual and is deliberately NOT recorded: <= length is one past the last
  // element. Only the strict form proves a valid index.
  if (operator === 'lessThan') {
    const rightProducer = producers[comparison.right]
    if (rightProducer?.kind === 'arrayLength') {
      addValueFact(result.valueFacts, {
        kind: 'belowLength',
        index: canonicalValueKey(comparison.left, expressionContext),
        array: canonicalValueKey(rightProducer.array, expressionContext),
      })
    }
  }
  if (operator === 'greaterThan') {
    const leftProducer = producers[comparison.left]
    if (leftProducer?.kind === 'arrayLength') {
      addValueFact(result.valueFacts, {
        kind: 'belowLength',
        index: canonicalValueKey(comparison.right, expressionContext),
        array: canonicalValueKey(leftProducer.array, expressionContext),
      })
    }
  }
  const emptied = refinedLeft.lower > refinedLeft.upper || refinedRight.lower > refinedRight.upper
  // NaN fails every ordered comparison and ===, so it never reaches the branch where that
  // condition held, and it always reaches the branch where it failed. Not-equal is the
  // mirror image: NaN !== c is true, so NaN lands on the not-equal side and mayBeNaN must
  // survive there.
  const holdsForNaN = operator === 'notEqual'
  if (emptied) {
    // The interval refinement only rules out the non-NaN inhabitants; a NaN operand still
    // lands on the side its comparison semantics allow (e.g. `x > -1 ? 1 : 0` with x
    // possibly NaN takes the 0 arm at runtime, and `x !== x` style emptiness keeps the
    // NaN inhabitant on the not-equal side). Keep the unrefined values — a superset —
    // rather than pruning the branch.
    if ((!truth || holdsForNaN) && (left.mayBeNaN || right.mayBeNaN)) return cloneState(state)
    return null
  }
  if (truth && !holdsForNaN) {
    refinedLeft = {...refinedLeft, mayBeNaN: false}
    refinedRight = {...refinedRight, mayBeNaN: false}
  }
  // Through the producer chain, like the null-check refinement: narrowing an
  // arrayLength's result rebuilds the array value with the narrowed length (so
  // `if (values.length > 0) values[0]!` proves the read), and narrowing a property read
  // rebuilds the record.
  writeThroughProducers(result, comparison.left, refinedLeft, producers)
  writeThroughProducers(result, comparison.right, refinedRight, producers)
  recordNonzeroComparisonFacts(result, comparison, expressionContext)
  return result
}

// The check instructions whose branch outcomes refine the state. The list is the single
// source of truth: the branch terminator asks membership here, and refineCheck's switch
// is exhaustive over exactly these kinds — a new check kind added to the list gets a
// compile error until refineCheck says how it refines.
const refinableCheckKinds = ['compare', 'nullishCheck', 'numberCheck', 'tagCheck'] as const
export type RefinableCheck = Extract<InstructionIR, {kind: (typeof refinableCheckKinds)[number]}>

export function asRefinableCheck(instruction: InstructionIR | undefined): RefinableCheck | undefined {
  if (instruction == null) return undefined
  return (refinableCheckKinds as readonly string[]).includes(instruction.kind)
    ? instruction as RefinableCheck
    : undefined
}

// One dispatch for both branch arms; each refine function clones internally. Returns null
// when the refinement proves the branch cannot be taken.
export function refineCheck(
  state: ExecutionState,
  check: RefinableCheck,
  truth: boolean,
  expressionContext: ExpressionContext,
): ExecutionState | null {
  switch (check.kind) {
    case 'compare': return refineComparison(state, check, truth, expressionContext)
    case 'nullishCheck': return refineNullishCheck(state, check, truth, expressionContext.instructionByValue)
    case 'numberCheck': return refineNumberCheck(state, check, truth, expressionContext.instructionByValue)
    case 'tagCheck': return refineTagCheck(state, check, truth, expressionContext.instructionByValue)
  }
}

function requiredNumber(state: ExecutionState, id: ValueID): AbstractNumber {
  const value = requiredValue(state, id)
  if (value.kind !== 'number') throw new KindMismatch(`IR value ${id} is not a number`, id)
  return value
}

function requiredNumberWithFacts(
  state: ExecutionState,
  id: ValueID,
  expressionContext: ExpressionContext,
): AbstractNumber {
  const result = numberWithFacts(state, id, expressionContext)
  if (result == null) throw new KindMismatch(`IR value ${id} is not a number`, id)
  return result
}

function numberWithFacts(
  state: ExecutionState,
  id: ValueID,
  expressionContext: ExpressionContext,
): AbstractNumber | null {
  const held = state.values[id]
  if (held?.kind !== 'number') return null
  let result = held
  const key = canonicalValueKey(id, expressionContext)
  if (state.valueFacts.some(fact => fact.kind === 'validIndex' && fact.index === key)) {
    result = validIndexNumber(result)
  }
  if (hasNonzeroFact(state.valueFacts, key)) result = excludePointFrom(result, constantNumber(0))
  return result
}

function validIndexNumber(value: AbstractNumber): AbstractNumber {
  return {
    ...value, integer: true, mayBeNaN: false,
    lower: Math.ceil(Math.max(value.lower, 0)),
    upper: Math.floor(value.upper),
  }
}

function recordNonzeroComparisonFacts(
  state: ExecutionState,
  check: Extract<InstructionIR, {kind: 'compare'}>,
  expressionContext: ExpressionContext,
): void {
  for (const id of [check.left, check.right]) {
    if (expressionContext.instructionByValue[id]?.kind === 'constant') continue
    const held = requiredValue(state, id)
    if (held.kind === 'number' && !includesZero(held)) recordNonzeroValueFact(state, id, expressionContext)
  }
}

function recordNonzeroValueFact(
  state: ExecutionState,
  value: ValueID,
  expressionContext: ExpressionContext,
): void {
  addValueFact(state.valueFacts, {kind: 'nonzero', value: canonicalValueKey(value, expressionContext)})
}

export function requiredBoolean(state: ExecutionState, id: ValueID): AbstractBoolean {
  const value = requiredValue(state, id)
  if (value.kind !== 'boolean') throw new KindMismatch(`IR value ${id} is not a boolean`, id)
  return value
}

// The branch terminator's condition read, with the same KindMismatch-to-stop conversion
// evaluateInstruction gives instruction operands. The static type of a condition can lie
// about the value's kind — `if (setting as boolean)` passes the boolean-condition gate on
// the checker's word while the erased cast's value is opaque — and the terminator sits
// outside evaluateInstruction's catch, so without this wrapper the mismatch that every
// other opaque use converts to an honest stop escaped as a crash (a review round ran it).
export function branchConditionOutcome(
  state: ExecutionState,
  id: ValueID,
  site: SiteID,
  expressionContext: ExpressionContext,
): {kind: 'value'; value: AbstractBoolean} | {kind: 'stop'; stop: Stop} {
  try {
    return {kind: 'value', value: requiredBoolean(state, id)}
  } catch (error) {
    if (error instanceof KindMismatch) {
      const missingElementSite = possiblyMissingElementReadSite(
        state,
        id,
        expressionContext.instructionByValue,
      )
      if (missingElementSite != null) {
        return {kind: 'stop', stop: {site: missingElementSite, reason: {kind: 'possiblyMissingElement'}}}
      }
      return {kind: 'stop', stop: {site, reason: {kind: 'kindMismatch'}}}
    }
    throw error
  }
}

function possiblyMissingElementReadSite(
  state: ExecutionState,
  valueID: ValueID,
  producers: Array<InstructionIR | undefined>,
): SiteID | null {
  const producer = producers[valueID]
  if (producer?.kind !== 'arrayIndex' || producer.mode !== 'bareUnchecked') return null
  const value = state.values[valueID]
  if (value == null) return null
  const canBeUndefined = (value.kind === 'nullish' || value.kind === 'maybeNullish')
    && value.sentinels !== 'null'
  return canBeUndefined ? producer.site : null
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
  if (value.kind !== 'tuple' && value.kind !== 'array') throw new KindMismatch(`IR value ${id} is not an array`, id)
  return value
}

function requiredRecord(state: ExecutionState, id: ValueID): AbstractRecord {
  const value = requiredValue(state, id)
  if (value.kind !== 'record') throw new KindMismatch(`IR value ${id} is not a record`, id)
  return value
}

export function requiredValue(state: ExecutionState, id: ValueID): AbstractValue {
  const value = state.values[id]
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
    case 'remainder': return remainderNumbers(left, right, false)
  }
}

function intersectSameNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  const met = meetValues(left, right)
  if (met.kind !== 'number') throw new Error('Meeting two numbers produced a non-number')
  return met
}

// These are JavaScript operations on one already-evaluated value, not algebraic rewrites
// of two expressions that happen to look alike. In particular, x + x cannot combine
// opposite infinities, while x - x can still be NaN when x is infinite.
function evaluateSameOperandBinary(
  operator: Extract<InstructionIR, {kind: 'binary'}>['operator'],
  operand: AbstractNumber,
): AbstractNumber {
  switch (operator) {
    case 'add': {
      const doubled = addNumbers(operand, operand)
      return {...doubled, mayBeNaN: operand.mayBeNaN}
    }
    case 'subtract': return {
      kind: 'number',
      lower: 0,
      upper: 0,
      integer: true,
      mayBeNaN: operand.mayBeNaN || !isFiniteNumber(operand),
    }
    case 'multiply': {
      const lowerSquare = operand.lower * operand.lower
      const upperSquare = operand.upper * operand.upper
      const crossesZero = operand.lower <= 0 && operand.upper >= 0
      return {
        kind: 'number',
        lower: crossesZero
          ? operand.integer && operand.excludesPoint === 0 ? 1 : 0
          : Math.min(lowerSquare, upperSquare),
        upper: Math.max(lowerSquare, upperSquare),
        integer: operand.integer,
        mayBeNaN: operand.mayBeNaN,
      }
    }
    case 'divide': return {
      kind: 'number',
      lower: 1,
      upper: 1,
      integer: true,
      mayBeNaN: operand.mayBeNaN || !isFiniteNumber(operand),
    }
    case 'remainder': return {
      kind: 'number',
      lower: 0,
      upper: 0,
      integer: true,
      mayBeNaN: operand.mayBeNaN || !isFiniteNumber(operand),
    }
  }
}

// Assertion-only comparison proofs walk the immutable producer graph. Producer edges
// point to earlier values, so literal reads terminate without cycle tracking. Ordering
// rules may revisit the same pair through several min/max operands, so those pairs remain
// memoized before their producers are expanded.

function staticAssertionObservation(
  valueID: ValueID,
  state: ExecutionState,
  context: TransferContext,
): AbstractBoolean {
  const held = requiredValue(state, valueID)
  // Lowering accepts boolean conditions. If an erased type assertion hid the runtime
  // kind, the assertion remains unproven instead of stopping the function analysis.
  if (held.kind !== 'boolean') return unknownBoolean()
  if (!held.canBeTrue || !held.canBeFalse) return held
  const producer = context.expressionContext.instructionByValue[valueID]
  if (producer?.kind === 'not') {
    const operand = staticAssertionObservation(producer.value, state, context)
    return {kind: 'boolean', canBeTrue: operand.canBeFalse, canBeFalse: operand.canBeTrue}
  }
  if (producer?.kind !== 'compare') return held
  const left = numberWithFacts(state, producer.left, context.expressionContext)
  const right = numberWithFacts(state, producer.right, context.expressionContext)
  if (left == null || right == null) return held
  return comparisonLocalProof(left, right, producer, state, context) ?? held
}

function comparisonLocalProof(
  left: AbstractNumber,
  right: AbstractNumber,
  instruction: Extract<InstructionIR, {kind: 'compare'}>,
  state: ExecutionState,
  context: TransferContext,
): AbstractBoolean | null {
  if (left.mayBeNaN || right.mayBeNaN) return null
  const proof = createComparisonProof(state, context.expressionContext)

  switch (instruction.operator) {
    case 'lessThan': {
      if (proof.strictlyBelow(instruction.left, instruction.right)) return exactBoolean(true)
      return proof.atMost(instruction.right, instruction.left) ? exactBoolean(false) : null
    }
    case 'lessThanOrEqual': {
      if (proof.atMost(instruction.left, instruction.right)) return exactBoolean(true)
      return proof.strictlyBelow(instruction.right, instruction.left) ? exactBoolean(false) : null
    }
    case 'greaterThan': {
      if (proof.strictlyBelow(instruction.right, instruction.left)) return exactBoolean(true)
      return proof.atMost(instruction.left, instruction.right) ? exactBoolean(false) : null
    }
    case 'greaterThanOrEqual': {
      if (proof.atMost(instruction.right, instruction.left)) return exactBoolean(true)
      return proof.strictlyBelow(instruction.left, instruction.right) ? exactBoolean(false) : null
    }
    case 'equal': {
      return proof.strictlyBelow(instruction.left, instruction.right)
        || proof.strictlyBelow(instruction.right, instruction.left) ? exactBoolean(false) : null
    }
    case 'notEqual': {
      return proof.strictlyBelow(instruction.left, instruction.right)
        || proof.strictlyBelow(instruction.right, instruction.left) ? exactBoolean(true) : null
    }
  }
}

function createComparisonProof(
  state: ExecutionState,
  context: ExpressionContext,
): {
  same: (left: ValueID, right: ValueID) => boolean
  atMost: (left: ValueID, right: ValueID) => boolean
  strictlyBelow: (left: ValueID, right: ValueID) => boolean
} {
  const atMostMemo = new Map<string, boolean>()

  const heldNumber = (value: ValueID): AbstractNumber | null => {
    return numberWithFacts(state, resolveStoredValue(value, context), context)
  }

  const same = (left: ValueID, right: ValueID): boolean => sameRuntimeValue(left, right, context)

  const nonnegative = (value: ValueID): boolean => {
    const held = heldNumber(value)
    return held != null && held.lower >= 0 && !held.mayBeNaN
  }

  const atMost = (rawLeft: ValueID, rawRight: ValueID): boolean => {
    const left = resolveStoredValue(rawLeft, context)
    const right = resolveStoredValue(rawRight, context)
    if (same(left, right)) return true

    const leftNumber = heldNumber(left)
    const rightNumber = heldNumber(right)
    if (leftNumber != null && rightNumber != null
      && !leftNumber.mayBeNaN && !rightNumber.mayBeNaN
      && leftNumber.upper <= rightNumber.lower) return true

    const key = `${left}:${right}`
    const cached = atMostMemo.get(key)
    if (cached != null) return cached
    atMostMemo.set(key, false)

    const leftProducer = context.instructionByValue[left]
    const rightProducer = context.instructionByValue[right]
    let answer = false

    // The defining operand is the cheapest and most common selection proof:
    // min(x, y) <= x and x <= max(x, y). Try exact identity before recursive rules.
    if (leftProducer?.kind === 'minimum') {
      answer = leftProducer.values.some(operand => same(operand, right))
    }
    if (!answer && rightProducer?.kind === 'maximum') {
      answer = rightProducer.values.some(operand => same(left, operand))
    }

    // Math.min and Math.max are monotone in corresponding operands. Keeping the written
    // operand order makes the rule linear and predictable; agents can align equivalent
    // clamps instead of asking the checker to search permutations.
    if (leftProducer?.kind === 'minimum' && rightProducer?.kind === 'minimum'
      && leftProducer.values.length === rightProducer.values.length) {
      answer = leftProducer.values.every((operand, index) =>
        atMost(operand, rightProducer.values[index]!))
    }

    if (!answer && leftProducer?.kind === 'binary'
      && leftProducer.operator === 'subtract'
      && nonnegative(leftProducer.right)) {
      answer = atMost(leftProducer.left, right)
    }
    if (!answer && rightProducer?.kind === 'binary' && rightProducer.operator === 'add') {
      if (nonnegative(rightProducer.right)) answer = atMost(left, rightProducer.left)
      if (!answer && nonnegative(rightProducer.left)) answer = atMost(left, rightProducer.right)
    }
    if (!answer && leftProducer?.kind === 'binary' && leftProducer.operator === 'multiply'
      && rightProducer?.kind === 'binary' && rightProducer.operator === 'multiply') {
      const leftForms = [[leftProducer.left, leftProducer.right], [leftProducer.right, leftProducer.left]] as const
      const rightForms = [[rightProducer.left, rightProducer.right], [rightProducer.right, rightProducer.left]] as const
      for (const [leftBase, leftFactor] of leftForms) {
        for (const [rightBase, rightFactor] of rightForms) {
          if (same(leftFactor, rightFactor)
            && nonnegative(leftFactor)
            && atMost(leftBase, rightBase)) answer = true
        }
      }
    }

    // Expanding max(xs) <= min(ys) requires the full xs-by-ys relation. That work grows
    // quadratically with user-written operands, so aggregate selection proofs compose on
    // only one side. Bind and assert the relevant component relationship instead.
    if (!answer && leftProducer?.kind === 'maximum' && rightProducer?.kind === 'minimum') {
      atMostMemo.set(key, false)
      return false
    }

    // Selection rules come last because expanding every operand is the broadest search.
    // Direct add/subtract and common-factor proofs above usually identify the written
    // relationship before the broader selection rules need to inspect every operand.
    if (!answer && leftProducer?.kind === 'maximum') {
      answer = leftProducer.values.every(operand => atMost(operand, right))
    }
    if (!answer && rightProducer?.kind === 'maximum') {
      answer = rightProducer.values.some(operand => atMost(left, operand))
    }
    if (!answer && leftProducer?.kind === 'minimum') {
      answer = leftProducer.values.some(operand => atMost(operand, right))
    }
    if (!answer && rightProducer?.kind === 'minimum') {
      answer = rightProducer.values.every(operand => atMost(left, operand))
    }

    atMostMemo.set(key, answer)
    return answer
  }

  const strictlyBelow = (rawLeft: ValueID, rawRight: ValueID): boolean => {
    const left = resolveStoredValue(rawLeft, context)
    const right = resolveStoredValue(rawRight, context)
    const leftNumber = heldNumber(left)
    const rightNumber = heldNumber(right)
    if (leftNumber != null && rightNumber != null
      && !leftNumber.mayBeNaN && !rightNumber.mayBeNaN
      && leftNumber.upper < rightNumber.lower) return true

    const producer = context.instructionByValue[left]
    if (producer?.kind !== 'binary' || producer.operator !== 'remainder'
      || !same(producer.right, right)) return false
    const divisor = heldNumber(producer.right)
    return divisor != null && !divisor.mayBeNaN && divisor.lower > 0
  }

  return {same, atMost, strictlyBelow}
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
      const definitelyDifferent = left.upper < right.lower
        || right.upper < left.lower
        || (left.lower === left.upper && pointExcluded(right, left.lower))
        || (right.lower === right.upper && pointExcluded(left, right.lower))
      return booleanRange(definitelyEqual, definitelyDifferent)
    }
    case 'notEqual': {
      const equal = compareNumbers(left, right, 'equal')
      return {kind: 'boolean', canBeTrue: equal.canBeFalse, canBeFalse: equal.canBeTrue}
    }
  }
}

function compareSameNumber(operand: AbstractNumber, operator: ComparisonOperator): AbstractBoolean {
  switch (operator) {
    case 'lessThan':
    case 'greaterThan': return exactBoolean(false)
    case 'equal':
    case 'lessThanOrEqual':
    case 'greaterThanOrEqual': return operand.mayBeNaN ? unknownBoolean() : exactBoolean(true)
    case 'notEqual': return operand.mayBeNaN ? unknownBoolean() : exactBoolean(false)
  }
}

function exactBoolean(answer: boolean): AbstractBoolean {
  return {kind: 'boolean', canBeTrue: answer, canBeFalse: !answer}
}

// Exact over the two-point lattice: definitely equal when both sides are the same known
// constant, definitely different when they are opposite known constants.
function compareBooleans(left: AbstractBoolean, right: AbstractBoolean, negated: boolean): AbstractBoolean {
  const leftKnown = left.canBeTrue !== left.canBeFalse
  const rightKnown = right.canBeTrue !== right.canBeFalse
  const definitelyEqual = leftKnown && rightKnown && left.canBeTrue === right.canBeTrue
  const definitelyDifferent = leftKnown && rightKnown && left.canBeTrue !== right.canBeTrue
  const equals = booleanRange(definitelyEqual, definitelyDifferent)
  return negated ? {kind: 'boolean', canBeTrue: equals.canBeFalse, canBeFalse: equals.canBeTrue} : equals
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
    case 'equal': return 'notEqual'
    case 'notEqual': return 'equal'
  }
}

// x !== other: when the other side is a single known point, cut it from x — at an
// interval endpoint (integers step by one, floats step to the adjacent representable
// double), or via the excluded-point cut when the point sits strictly inside the bounds.
// One point is the cap: a second !== guard replaces the first cut rather than growing a
// set, which is sound (dropping a fact only widens) and keeps the domain flat.
function excludePointFrom(value: AbstractNumber, other: AbstractNumber): AbstractNumber {
  if (other.lower !== other.upper || other.mayBeNaN) return value
  const point = other.lower
  let refined = value
  if (refined.lower === point) refined = {...refined, lower: strictLower(point, refined.integer)}
  if (refined.upper === point) refined = {...refined, upper: strictUpper(point, refined.integer)}
  if (refined.lower < point && point < refined.upper) refined = {...refined, excludesPoint: point}
  return refined
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
  return normalizeRefinedNumber({...value, lower: refinedLower, upper: refinedUpper})
}

// Keep the number record internally consistent after an intersection. Exact integer
// singletons are integers regardless of how they were reached, and an excluded point
// that becomes an endpoint moves the endpoint past that impossible value.
function normalizeRefinedNumber(value: AbstractNumber): AbstractNumber {
  let lower = value.lower
  let upper = value.upper
  const integer = value.integer || (lower === upper && Number.isInteger(lower))
  const {excludesPoint, ...rest} = value
  if (excludesPoint != null) {
    if (lower === excludesPoint) lower = strictLower(excludesPoint, integer)
    if (upper === excludesPoint) upper = strictUpper(excludesPoint, integer)
  }
  const normalized: AbstractNumber = {...rest, lower, upper, integer}
  if (excludesPoint != null && lower < excludesPoint && excludesPoint < upper) {
    normalized.excludesPoint = excludesPoint
  }
  return normalized
}

// The exact refinement for a strict comparison: for integers the next integer, for floats
// the adjacent representable double — runtime x > b implies x >= nextUp(b), so `if
// (height > 0)` proves the divisor nonzero instead of keeping zero as a closed bound.
function strictLower(value: number, integer: boolean): number {
  return integer ? Math.floor(value) + 1 : nextUp(value)
}

function strictUpper(value: number, integer: boolean): number {
  return integer ? Math.ceil(value) - 1 : nextDown(value)
}
