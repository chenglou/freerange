import {constantNumber} from '../domain/number.ts'
import {holdsStructure, joinValues, type AbstractValue} from '../domain/value.ts'
import type {ValueIdentity, ValueIdentityOwner} from '../domain/value-identity.ts'
import type {BlockID, FunctionID, SiteID, ValueID} from '../ir/ids.ts'
import {functionUsage, transitiveModuleBindings} from '../ir/function-usage.ts'
import {finiteInputExpression, finiteInputs} from '../ir/finite-inputs.ts'
import type {EdgeIR} from '../ir/instructions.ts'
import {declaredKindOf, declaredKindValue, type BlockIR, type FunctionIR, type ProgramIR} from '../ir/program.ts'
import {
  addPrecondition,
  constantRequirementStatus,
  createExpressionContext,
  staticRequirement,
} from '../requirements/infer.ts'
import type {BoundsAssumption, InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import {
  completedEvaluation,
  type AssertionVerdict,
  type FunctionAnalysis,
  type FunctionEvaluation,
  type LoweredFunctionAnalysis,
  type ProgramAnalysis,
  type Stop,
} from './outcome.ts'
import {
  cloneSharedState,
  cloneState,
  emptySharedState,
  intersectValueFacts,
  joinModuleSlots,
  mergeStates,
  type ExecutionState,
  type JoinFact,
  type SharedState,
  type ValueFact,
} from './state.ts'
import {createJoinFlow} from './join-flow.ts'
import {
  asRefinableCheck,
  branchConditionOutcome,
  chargeRelationalWork,
  createStaticRelationCounters,
  createStaticRelations,
  evaluateInstruction,
  refineCheck,
  relationalAtMost,
  relationalNonnegative,
  requiredValue,
  type StaticRelationCounters,
  type StaticRelations,
  type TransferContext,
} from './transfer.ts'

// A termination backstop, not an iteration budget: the count is fixed-point rounds of one
// loop header's abstract state, unrelated to runtime iteration counts. Widening makes
// ordinary counting loops converge in two or three rounds.
const maximumLoopHeaderUpdates = 16

// The static-relations prototype is off unless FREERANGE_STATIC_RELATIONS=1. With it on, the
// relational rules in transfer.ts and the join facts below run only for interior
// console.assert proofs (see StaticRelations in transfer.ts).
// Passing a counters object turns the mode on for this analysis and collects its cap hits.
export function analyzeProgram(
  program: ProgramIR,
  staticRelations: StaticRelationCounters | null = process.env['FREERANGE_STATIC_RELATIONS'] === '1'
    ? createStaticRelationCounters()
    : null,
): ProgramAnalysis {
  const analysis = analyzeProgramWith(program, staticRelations)
  if (staticRelations != null && process.env['FREERANGE_STATIC_RELATIONS_DEBUG'] === '1') {
    const counters = staticRelations
    console.error(`static relations cap hits: closure budget ${counters.closureBudget}, fact cap ${counters.factCap}, join candidates ${counters.joinCandidates}, join facts ${counters.joinFacts}, evaluation work ${counters.evaluationWork}; peak work per instruction ${counters.peakWorkPerInstruction.toFixed(2)}`)
  }
  return analysis
}

function analyzeProgramWith(program: ProgramIR, staticRelations: StaticRelationCounters | null): ProgramAnalysis {
  // The initializer's slots start uninitialized — a top-level read before the writing
  // declaration must stop — except imported constants: the exporting module ran before
  // this module's first statement, so the slot already holds the literal. (A cycle read
  // that beats the exporting declaration throws instead of yielding a stale value; see
  // importedCategory in src/lower/module.ts.)
  const initializerState = emptySharedState(program.moduleBindings.length)
  for (let binding = 0; binding < program.moduleBindings.length; binding++) {
    const category = program.moduleBindings[binding]!.category
    if (category.kind === 'importedConstant') {
      initializerState[binding] = constantNumber(category.value)
    }
  }
  // The initializer runs first, so top-level calls into declared functions see the module
  // state built so far, and its results decide what later function analysis may trust.
  const initializer = runEvaluation(
    program.initializer,
    null,
    [],
    [],
    initializerState,
    program,
    [],
    staticRelations,
  )
  const moduleValues = publishedModuleValues(program, initializer.run, initializer.evaluation)
  const functionEntrySharedState = seedModuleSlots(program, moduleValues)
  const moduleReads = transitiveModuleBindings(functionUsage(program))
  const initializerBounds = initializer.evaluation.boundsAssumptions
  const functions: FunctionAnalysis[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const fn = program.functions[functionID]!
    if (fn.kind === 'unsupported') {
      functions.push({kind: 'notLowered', lowering: fn})
      continue
    }
    const arguments_: AbstractValue[] = []
    const argumentExpressions: Array<NumericExpression | null> = []
    const sharedState = cloneSharedState(functionEntrySharedState)
    for (let index = 0; index < fn.parameters.length; index++) {
      const parameter = fn.parameters[index]!
      // Seeded from the declared kind — the same assumed-finite constructor module hedges
      // use, with the assumes lines carrying the conditionality. Every parameter is
      // nameable in requirement expressions; only numeric operations ever surface one, so
      // a non-numeric parameter's expression is simply never printed.
      arguments_.push(declaredKindValue(parameter.type))
      argumentExpressions.push({kind: 'parameter', index})
    }
    const {evaluation} = runEvaluation(
      fn,
      functionID,
      arguments_,
      argumentExpressions,
      sharedState,
      program,
      [],
      staticRelations,
      {
        boundsAssumptions: moduleReads[functionID]!.size > 0 ? initializerBounds : [],
      },
    )
    functions.push(publishedAnalysis(fn, evaluation))
  }
  return {
    functions,
    initializer: publishedAnalysis(program.initializer, initializer.evaluation),
    moduleValues,
  }
}

function publishedAnalysis(fn: FunctionIR, evaluation: FunctionEvaluation): LoweredFunctionAnalysis {
  const completed = completedEvaluation(evaluation)
  if (completed != null) {
    return {
      kind: 'analyzed',
      lowering: fn,
      preconditions: publishedPreconditions(fn, completed.preconditions),
      boundsAssumptions: completed.boundsAssumptions,
      returnValue: completed.returnValue,
      assertions: evaluation.assertions,
    }
  }
  const [firstStop, ...laterStops] = evaluation.stops
  // Every path throws: the function is fully analyzed, it just never returns normally —
  // no ensures lines exist to print, and callers stop honestly at the call.
  if (firstStop == null && evaluation.normal == null) {
    return {
      kind: 'analyzed',
      lowering: fn,
      preconditions: publishedPreconditions(fn, evaluation.preconditions),
      boundsAssumptions: evaluation.boundsAssumptions,
      returnValue: {kind: 'void'},
      assertions: evaluation.assertions,
    }
  }
  if (firstStop == null) throw new Error(`Function ${fn.name} has no reachable return`)
  return {
    kind: 'partial',
    lowering: fn,
    stops: [firstStop, ...laterStops],
    observedReturn: evaluation.normal == null ? null : {value: evaluation.normal.returnValue},
    observedNeeds: evaluation.preconditions,
    observedBoundsAssumptions: evaluation.boundsAssumptions,
    assertions: evaluation.assertions,
  }
}

function publishedPreconditions(
  fn: FunctionIR,
  evaluated: InferredPrecondition[],
): InferredPrecondition[] {
  const preconditions: InferredPrecondition[] = []
  for (const input of finiteInputs(fn)) {
    preconditions.push({
      kind: 'declaredNumberCheck',
      predicate: 'finite',
      expression: finiteInputExpression(input),
      site: input.site,
      purpose: 'finiteInput',
    })
  }
  const expressionContext = createExpressionContext(
    fn,
    fn.parameters.map((_, index) => ({kind: 'parameter', index})),
  )
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind !== 'staticRequire' || instruction.purpose === 'finiteInput') continue
      const requirement = staticRequirement(
        expressionContext.instructionByValue[instruction.value],
        instruction.site,
        expressionContext,
      )
      if (requirement != null && constantRequirementStatus(requirement) == null) {
        addPrecondition(preconditions, requirement)
      }
    }
  }
  for (const precondition of evaluated) addPrecondition(preconditions, precondition)
  return preconditions
}

// What each function's module slots start from. A published value is trusted exactly, and
// so is an imported constant's literal; otherwise a binding of representable declared kind
// (number, boolean, record shape) contributes that kind, and every other binding stays
// uninitialized so reads stop.
function seedModuleSlots(program: ProgramIR, moduleValues: Array<AbstractValue | null>): SharedState {
  return program.moduleBindings.map((binding, index) => {
    const published = moduleValues[index]
    if (published != null) return published
    if (binding.category.kind === 'importedConstant') {
      return constantNumber(binding.category.value)
    }
    const declaredKind = declaredKindOf(binding.category)
    if (declaredKind == null) return null
    return declaredKindValue(declaredKind)
  })
}

// The values functions may trust, per binding: the binding's category must allow a value,
// and the slot must be initialized at every path end of the initializer, stops included,
// because uninitialized dominates the join. No write rule is needed on top of that: the
// whole-file scan already demoted every binding that anything besides its declaration
// writes, so a trusted slot changes exactly once. A declaration the analysis never reached,
// e.g. one past a stop, leaves the slot uninitialized in that stop's captured state, so
// the binding publishes nothing.
function publishedModuleValues(
  program: ProgramIR,
  run: EvaluationRun,
  evaluation: FunctionEvaluation,
): Array<AbstractValue | null> {
  const end = evaluation.normal == null
    ? run.moduleEnd
    : run.moduleEnd == null
      ? evaluation.normal.sharedState
      : joinModuleSlots(run.moduleEnd, evaluation.normal.sharedState)

  // Exact publishing of a value holding a structure (records, tuples, arrays — nullish-wrapped
  // included) additionally requires the whole file to be fully analyzed. Analyzed code
  // cannot write into an object, but rejected function bodies and skipped statements run at
  // runtime too, and they can mutate a structure through any alias — `Object.assign(config,
  // ...)` or `queue?.push(x)` inside a function that never lowered, invisible to the
  // whole-file write scan because the binding sits in argument or receiver position, not
  // write position. Scalars are unaffected: a number is copied on read, so only a
  // write-position form on the binding itself can change it, and the scan sees those even
  // in rejected bodies. When the file is not fully analyzed, a structural binding falls back
  // to its declared kind: the declared-shape hedge with per-leaf assumes lines, or, for a
  // record typed through a declaration-file mapped type, a claim-free value whose reads stop.
  // Whether a binding holds a structure is decided from the value initialization built, not
  // from the declared kind, because such a mapped type, e.g. `const config: Readonly<{gap:
  // number}> = {gap: 8}`, classifies as opaque yet holds a record. Other modules can still
  // modify a published structure after initialization; the report prints that assumption on
  // every function whose result rests on such a structure.
  const fullyAnalyzed = evaluation.stops.length === 0
    && program.initializerSkips.length === 0
    && program.functions.every(lowered => lowered.kind === 'lowered')

  return program.moduleBindings.map((binding, index) => {
    if (binding.category.kind !== 'value' && binding.category.kind !== 'function') return null
    const slot = end?.[index] ?? null
    if (slot != null && holdsStructure(slot) && !fullyAnalyzed) return null
    return slot
  })
}

// One entry per reachable block: the joined state flowing into the block, and how many
// times that state has been updated (loop headers widen from the second update on).
type IncomingState = {
  state: ExecutionState
  updateCount: number
}

// One block's bookkeeping for the run; every field lives and dies with the evaluation, so
// they share one record per block instead of parallel arrays that could drift apart.
type BlockRun = {
  incoming: IncomingState | null
  // Whether any visit stopped in the block, at an instruction or at its stop terminator.
  // The failed-header closure treats a stopped block as cut.
  stopped: boolean
  // A loop header whose state never stabilized. Returns reachable from a failed header
  // are not evidence — they were computed from a state short of its fixed point.
  failedHeader: boolean
  // The latest return recorded from the block; overwritten on re-visits (incoming states
  // grow monotonically, so the last visit supersedes earlier ones) and joined only after
  // the worklist drains.
  pendingReturn: {value: AbstractValue; shared: SharedState; valueFacts: ValueFact[]} | null
}

type AssertionObservation = {
  sawDefinitelyTrue: boolean
  sawDefinitelyFalse: boolean
  sawMaybeFalse: boolean
}

// Everything one evaluation accumulates; created and discarded together.
type EvaluationRun = {
  fn: FunctionIR
  // Dense, indexed by BlockID.
  blocks: BlockRun[]
  queue: BlockID[]
  stops: Stop[]
  // Dense by FunctionIR.assertions index when present.
  assertionObservations: Array<AssertionObservation | undefined>
  // Module slots joined across every stop, then with the normal end by the publish rule.
  moduleEnd: SharedState | null
}

type EvaluationSeed = {
  boundsAssumptions?: BoundsAssumption[]
  valueFacts?: ValueFact[]
  parameterIdentities?: ValueIdentity[]
  identityOwner?: ValueIdentityOwner
}

function runEvaluation(
  fn: FunctionIR,
  functionID: FunctionID | null,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  program: ProgramIR,
  callStack: FunctionID[],
  staticRelations: StaticRelationCounters | null,
  seed: EvaluationSeed = {},
): {evaluation: FunctionEvaluation; run: EvaluationRun} {
  if (arguments_.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} arguments for ${fn.name}`)
  if (argumentExpressions.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} argument expressions for ${fn.name}`)
  const initial: ExecutionState = {
    values: [],
    shared: cloneSharedState(sharedState),
    valueFacts: seed.valueFacts?.slice() ?? [],
    // Join facts name this evaluation's own block parameters, so a callee starts with none
    // and publishes none.
    joinFacts: [],
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    initial.values[fn.parameters[index]!.value] = arguments_[index]!
  }
  const expressionContext = createExpressionContext(
    fn,
    argumentExpressions,
    seed.parameterIdentities,
    seed.identityOwner,
  )
  const preconditions: InferredPrecondition[] = []
  const boundsAssumptions: BoundsAssumption[] = [...(seed.boundsAssumptions ?? [])]
  const successors = blockSuccessors(fn)
  const run: EvaluationRun = {
    fn,
    blocks: fn.blocks.map(() => ({incoming: null, stopped: false, failedHeader: false, pendingReturn: null})),
    queue: [fn.entry],
    stops: [],
    assertionObservations: [],
    moduleEnd: null,
  }
  run.blocks[fn.entry]!.incoming = {state: initial, updateCount: 0}
  // Invariant for the whole evaluation (engineering.md's loop-invariant rule): built once
  // instead of allocating a context object and closure per instruction per fixed-point
  // round. preconditions is shared by reference and accumulates.
  const transferContext: TransferContext = {
    program,
    callStack: functionID == null ? callStack : [...callStack, functionID],
    expressionContext,
    preconditions,
    boundsAssumptions,
    staticRelations: staticRelations == null
      ? null
      : createStaticRelations(expressionContext, createJoinFlow(fn, successors), staticRelations),
    evaluateFunction: (
      callee: FunctionID,
      values: AbstractValue[],
      expressions: Array<NumericExpression | null>,
      calleeState: SharedState,
      stack: FunctionID[],
      valueFacts: ValueFact[],
      parameterIdentities: ValueIdentity[],
      identityOwner: ValueIdentityOwner,
    ) => {
      const calleeFn = program.functions[callee]
      if (calleeFn == null) throw new Error(`Unknown function ${callee}`)
      // Callers turn calls to unlowered functions into calleeStopped records first.
      if (calleeFn.kind !== 'lowered') throw new Error(`Analysis reached unlowered function ${calleeFn.name}`)
      return runEvaluation(
        calleeFn,
        callee,
        values,
        expressions,
        calleeState,
        program,
        stack,
        staticRelations,
        {valueFacts, parameterIdentities, identityOwner},
      ).evaluation
    },
  }
  let queueIndex = 0
  while (queueIndex < run.queue.length) {
    const blockID = run.queue[queueIndex++]!
    const block = fn.blocks[blockID]
    const entry = run.blocks[blockID]?.incoming
    if (block == null || entry == null) throw new Error(`Missing block ${blockID} in ${fn.name}`)
    const state = cloneState(entry.state)
    let stopped = false
    instructionLoop:
    for (let index = 0; index < block.instructions.length; index++) {
      const instruction = block.instructions[index]!
      const result = evaluateInstruction(instruction, state, transferContext)
      switch (result.kind) {
        case 'ends':
          // The path terminates like an inline throw: nothing recorded, nothing returned.
          run.blocks[blockID]!.pendingReturn = null
          stopped = true
          break instructionLoop
        case 'stop':
          addStop(
            run,
            blockID,
            result.stop,
            state.shared.slice(),
          )
          // A return recorded by an earlier visit of this block described a smaller incoming
          // state; the stop supersedes it.
          run.blocks[blockID]!.pendingReturn = null
          stopped = true
          break instructionLoop
        case 'assertion':
          addAssertionObservation(run, result.assertion, result.observation)
          state.values[instruction.result] = result.value
          break
        case 'value':
          state.values[instruction.result] = result.value
          break
      }
    }
    if (stopped) continue
    switch (block.terminator.kind) {
      case 'return': {
        const value = block.terminator.value == null
          ? {kind: 'void'} as const
          : requiredValue(state, block.terminator.value)
        run.blocks[blockID]!.pendingReturn = {
          value,
          shared: cloneSharedState(state.shared),
          valueFacts: state.valueFacts.slice(),
        }
        break
      }
      // A thrown path ends without contributing: no return value, no stop record. The
      // exception would propagate past every analyzed caller (no catch in the subset),
      // so no analyzed continuation observes anything from this path.
      case 'thrown':
        break
      case 'stop': {
        addStop(
          run,
          blockID,
          {site: block.terminator.site, reason: {kind: 'unsupportedCode', reason: block.terminator.reason}},
          state.shared.slice(),
        )
        break
      }
      case 'jump': {
        propagate(state, blockID, block.terminator.target, run, transferContext)
        break
      }
      case 'branch': {
        const conditionOutcome = branchConditionOutcome(
          state,
          block.terminator.condition,
          block.terminator.site,
          expressionContext,
        )
        if (conditionOutcome.kind === 'stop') {
          addStop(
            run,
            blockID,
            conditionOutcome.stop,
            state.shared.slice(),
          )
          run.blocks[blockID]!.pendingReturn = null
          break
        }
        const condition = conditionOutcome.value
        // expressionContext.instructionByValue is the one which-instruction-produced-this
        // table; a condition refines only when that instruction is a check (refineCheck
        // dispatches over the check kinds in one place).
        const check = asRefinableCheck(expressionContext.instructionByValue[block.terminator.condition])
        if (condition.canBeTrue) {
          // refineCheck clones internally; the bare-condition arm clones only when the
          // other arm still needs the working state.
          const branch = check != null
            ? refineCheck(state, check, true, expressionContext)
            : condition.canBeFalse ? cloneState(state) : state
          if (branch != null) propagate(branch, blockID, block.terminator.whenTrue, run, transferContext)
        }
        if (condition.canBeFalse) {
          const branch = check != null
            ? refineCheck(state, check, false, expressionContext)
            : state
          if (branch != null) propagate(branch, blockID, block.terminator.whenFalse, run, transferContext)
        }
        break
      }
    }
  }
  const relations = transferContext.staticRelations
  if (relations != null) {
    const workPerInstruction = (relations.budget - relations.remainingWork) / Math.max(1, expressionContext.instructionCount)
    relations.counters.peakWorkPerInstruction = Math.max(relations.counters.peakWorkPerInstruction, workPerInstruction)
  }

  // A stop inside a loop cuts the back edge, freezing the header short of its fixed point —
  // and the stop may first appear on a late widening round, after earlier rounds already
  // propagated returns downstream. Any header on a cycle through a stopping block is
  // therefore failed too. Slightly conservative: evidence from the path where the loop body
  // runs zero times is also suppressed when the stop existed from the first round.
  // Reverse edges answer whether a stopping block can return to each header without a
  // separate traversal from every stop. The whole pass is skipped when nothing stopped.
  const suppressed: boolean[] = []
  if (run.stops.length > 0) {
    const predecessors = reverseEdges(successors)
    for (let headerID = 0; headerID < fn.blocks.length; headerID++) {
      if (fn.blocks[headerID]!.loopHeader == null) continue
      const header = run.blocks[headerID]!
      const reachedFromHeader = header.failedHeader ? undefined : reachableFrom(successors, headerID)
      if (reachedFromHeader != null) {
        const returnsToHeader = reachableFrom(predecessors, headerID)
        for (let stopBlock = 0; stopBlock < run.blocks.length; stopBlock++) {
          if (!run.blocks[stopBlock]!.stopped || reachedFromHeader[stopBlock] !== true) continue
          if (returnsToHeader[stopBlock] === true) {
            header.failedHeader = true
            break
          }
        }
      }
      if (!header.failedHeader) continue
      const reached = reachedFromHeader ?? reachableFrom(successors, headerID)
      for (let block = 0; block < fn.blocks.length; block++) {
        if (reached[block] === true) suppressed[block] = true
      }
    }
  }

  let normal: FunctionEvaluation['normal'] = null
  for (let blockID = 0; blockID < fn.blocks.length; blockID++) {
    const pending = run.blocks[blockID]!.pendingReturn
    if (pending == null || suppressed[blockID] === true) continue
    if (normal == null) {
      normal = {returnValue: pending.value, sharedState: pending.shared, valueFacts: pending.valueFacts}
      continue
    }
    normal = {
      returnValue: joinValues(normal.returnValue, pending.value),
      sharedState: joinModuleSlots(normal.sharedState, pending.shared),
      valueFacts: intersectValueFacts(normal.valueFacts, pending.valueFacts),
    }
  }

  // A loop whose exit is abstractly never taken — e.g. `for (let index = 0; true;
  // index += 1) {}` — converges with every path still inside the loop: no return, no stop.
  // Record a stop on each such header so the result is a partial entry, not a crash on the
  // missing return. A header belongs to a non-exiting loop when every reached block it can
  // reach can also reach it back: the analysis went around the cycle and never left.
  // Checking the header's own branch would not be enough — a ternary in the loop condition
  // (e.g. `for (; index < 10 ? true : index >= 0; )`) puts the body/exit branch in a
  // continuation block, not on the tagged header.
  if (normal == null && run.stops.length === 0) {
    const predecessors = reverseEdges(successors)
    for (let headerID = 0; headerID < fn.blocks.length; headerID++) {
      const header = fn.blocks[headerID]!
      const entry_ = run.blocks[headerID]!.incoming
      if (header.loopHeader == null || entry_ == null) continue
      const downstream = reachableFrom(successors, headerID)
      const returnsToHeader = reachableFrom(predecessors, headerID)
      let visitedDownstream = false
      let stuckInCycle = true
      for (let block = 0; block < fn.blocks.length; block++) {
        if (downstream[block] !== true || run.blocks[block]!.incoming == null) continue
        visitedDownstream = true
        if (returnsToHeader[block] !== true) {
          stuckInCycle = false
          break
        }
      }
      if (visitedDownstream && stuckInCycle) {
        addStop(
          run,
          headerID,
          {site: header.loopHeader, reason: {kind: 'nonExitingLoop'}},
          entry_.state.shared.slice(),
        )
      }
    }
  }

  return {
    evaluation: {
      normal,
      preconditions,
      boundsAssumptions,
      assertions: classifyAssertions(run, run.stops.length === 0 && boundsAssumptions.length === 0),
      stops: run.stops,
    },
    run,
  }
}

function requiredAssertion(run: EvaluationRun, assertionIndex: number): {site: SiteID; text: string} {
  const assertion = run.fn.assertions[assertionIndex]
  if (assertion == null) {
    throw new Error(`Unknown assertion ${assertionIndex} in ${run.fn.name}`)
  }
  return assertion
}

function addAssertionObservation(
  run: EvaluationRun,
  assertionIndex: number,
  observation: {canBeTrue: boolean; canBeFalse: boolean},
): void {
  requiredAssertion(run, assertionIndex)
  if (!observation.canBeTrue && !observation.canBeFalse) {
    throw new Error(`Assertion ${assertionIndex} in ${run.fn.name} has no possible boolean value`)
  }
  const aggregate = run.assertionObservations[assertionIndex] ?? {
    sawDefinitelyTrue: false,
    sawDefinitelyFalse: false,
    sawMaybeFalse: false,
  }
  if (!observation.canBeTrue) aggregate.sawDefinitelyFalse = true
  else if (observation.canBeFalse) aggregate.sawMaybeFalse = true
  else aggregate.sawDefinitelyTrue = true
  run.assertionObservations[assertionIndex] = aggregate
}

function classifyAssertions(run: EvaluationRun, proofComplete: boolean): AssertionVerdict[] {
  return run.fn.assertions.map((assertion, assertionIndex) => {
    const observation = run.assertionObservations[assertionIndex]
    const verdict: AssertionVerdict['verdict'] = observation?.sawDefinitelyFalse === true
      ? 'refuted'
      : observation?.sawMaybeFalse === true
        ? 'unproven'
        : !proofComplete
          ? 'blocked'
          : observation?.sawDefinitelyTrue === true
            ? 'proven'
            : 'dead'
    return {site: assertion.site, text: assertion.text, verdict}
  })
}

function addStop(
  run: EvaluationRun,
  blockID: BlockID,
  stop: Stop,
  moduleCapture: SharedState,
): void {
  run.blocks[blockID]!.stopped = true
  run.moduleEnd = run.moduleEnd == null ? moduleCapture : joinModuleSlots(run.moduleEnd, moduleCapture)
  // The first stop at a site wins, so re-visits (loop rounds, both arms of a branch
  // reaching one call) cannot grow the list past the function's site count. A linear scan,
  // like the precondition and bounds-assumption dedups: the list is small by the same bound.
  if (run.stops.some(existing => existing.site === stop.site)) return
  run.stops.push(stop)
}

// Takes ownership of `state`: callers pass the working state (dead after its terminator)
// or an already-fresh clone from a branch arm, so no defensive copy is needed here.
function propagate(
  state: ExecutionState,
  sourceBlock: BlockID,
  edge: EdgeIR,
  run: EvaluationRun,
  context: TransferContext,
): void {
  const target = run.fn.blocks[edge.block]
  if (target == null) throw new Error(`Missing block ${edge.block} in ${run.fn.name}`)
  if (edge.arguments.length !== target.parameters.length) {
    throw new Error(`Expected ${target.parameters.length} arguments for block ${edge.block} in ${run.fn.name}`)
  }
  // Read every edge argument before writing any parameter: on a loop back edge an argument
  // can be one of the target's own parameter IDs (an unchanged carried binding), so the
  // reads and writes share one value array.
  const argumentValues = edge.arguments.map(argument => requiredValue(state, argument))
  const previous = run.blocks[edge.block]!.incoming
  if (context.staticRelations != null) {
    // Static relations: loop headers keep no join facts, so loop convergence and the
    // 16-update backstop see origin/main's states. Verification reads the edge state before
    // the parameter writes below.
    if (target.loopHeader != null) {
      state.joinFacts = []
    } else if (target.parameters.length > 0) {
      state.joinFacts = maintainedJoinFacts(
        state,
        edge,
        target,
        previous?.state.joinFacts ?? null,
        context.expressionContext,
        context.staticRelations,
      )
    }
  }
  const candidate = state
  for (let index = 0; index < target.parameters.length; index++) {
    candidate.values[target.parameters[index]!] = argumentValues[index]!
  }
  if (previous == null) {
    run.blocks[edge.block]!.incoming = {state: candidate, updateCount: 0}
    run.queue.push(edge.block)
    return
  }
  const update = mergeStates(previous.state, candidate, target.loopHeader != null && previous.updateCount >= 1)
  if (update.changed) {
    if (target.loopHeader != null && previous.updateCount >= maximumLoopHeaderUpdates) {
      addStop(
        run,
        sourceBlock,
        {site: target.loopHeader, reason: {kind: 'loopLimit', updates: maximumLoopHeaderUpdates}},
        state.shared.slice(),
      )
      run.blocks[edge.block]!.failedHeader = true
      return
    }
    run.blocks[edge.block]!.incoming = {state: update.state, updateCount: previous.updateCount + 1}
    run.queue.push(edge.block)
  }
}

const maximumJoinCandidates = 32

// Join facts kept per state, carried and new together. Without it, facts about every earlier
// join ride along through a run of sequential joins, and each proof and merge reads them all.
// Past the cap the oldest facts are dropped (failing closed) and counted, so the facts the
// newest join verified stay.
const maximumJoinFacts = 64

// Join facts on a block's parameters (static-relations mode, blocks that are not loop
// headers). The first arrival proposes candidates and keeps those that hold for the values
// flowing in on that edge; every later arrival only re-verifies the stored facts against its
// own edge. After the first arrival facts are therefore only ever dropped, and mergeStates
// turns a drop into a change, so the block re-runs. A fact survives the worklist only when
// the final visit of every incoming edge verified it from that edge's own state, and on each
// edge the parameter's new value is exactly the edge argument the fact was verified for.
// The bound is a function parameter or a value produced in a block that dominates the target,
// so every path into the block computed it before the edge; and a block on a cycle proposes
// nothing, so no bound or parameter can be recomputed while a fact names it.
// Candidate order is stable: parameters in order, each with `nonnegative` first, then bounds
// in ascending IR value order, `atMost` before `atLeast`. At most 32 verified candidates per
// block; later ones are dropped (failing closed) and counted.
// Carried facts never name the target's parameters, as parameter or bound: facts about a
// block's parameters are minted only on arrival at that block, a block on a cycle mints
// none, and a bound is never produced in the target itself.
function maintainedJoinFacts(
  state: ExecutionState,
  edge: EdgeIR,
  target: BlockIR,
  stored: JoinFact[] | null,
  context: TransferContext['expressionContext'],
  relations: StaticRelations,
): JoinFact[] {
  const parameters = target.parameters
  const facts = state.joinFacts.slice()
  const holds = (fact: JoinFact): boolean => {
    const argument = edge.arguments[parameters.indexOf(fact.parameter)]!
    switch (fact.kind) {
      case 'nonnegative': return relationalNonnegative(state, context, relations, argument)
      case 'atMost': return relationalAtMost(state, context, relations, argument, fact.bound)
      case 'atLeast': return relationalAtMost(state, context, relations, fact.bound, argument)
    }
  }
  if (stored != null) {
    for (const fact of stored) {
      if (parameters.includes(fact.parameter) && holds(fact)) facts.push(fact)
    }
    return cappedJoinFacts(facts, relations)
  }
  if (relations.joinFlow.cyclic[edge.block] === true) return facts
  const bounds = joinBounds(state, edge.block, context, relations)
  let verified = 0
  for (let index = 0; index < parameters.length; index++) {
    if (state.values[edge.arguments[index]!]?.kind !== 'number') continue
    const parameter = parameters[index]!
    const candidates: JoinFact[] = [{kind: 'nonnegative', parameter}]
    for (const bound of bounds) {
      candidates.push({kind: 'atMost', parameter, bound}, {kind: 'atLeast', parameter, bound})
    }
    for (const candidate of candidates) {
      if (relations.workExhausted) return cappedJoinFacts(facts, relations)
      if (!holds(candidate)) continue
      if (verified === maximumJoinCandidates) {
        relations.counters.joinCandidates += 1
        return cappedJoinFacts(facts, relations)
      }
      facts.push(candidate)
      verified += 1
    }
  }
  return cappedJoinFacts(facts, relations)
}

function cappedJoinFacts(facts: JoinFact[], relations: StaticRelations): JoinFact[] {
  if (facts.length <= maximumJoinFacts) return facts
  relations.counters.joinFacts += 1
  return facts.slice(facts.length - maximumJoinFacts)
}

// The values a join fact may name as its bound: numeric, non-NaN values held on the edge
// that are function parameters or produced in a block dominating the target, and that are a
// function parameter, an argument of some edge into the target, or named by an order fact on
// this edge. One value per value number, the lowest IR value first. Only those three sources
// are enumerated, not every value in the state, and the enumeration charges the evaluation's
// work budget.
function joinBounds(
  state: ExecutionState,
  target: BlockID,
  context: TransferContext['expressionContext'],
  relations: StaticRelations,
): ValueID[] {
  const flow = relations.joinFlow
  const numbering = relations.numbering
  if (!chargeRelationalWork(relations, state.valueFacts.length + state.joinFacts.length)) return []
  const factNumbers = new Set<number>()
  for (const fact of state.valueFacts) {
    if (fact.kind !== 'order') continue
    factNumbers.add(numbering.ofIdentity(fact.left))
    factNumbers.add(numbering.ofIdentity(fact.right))
  }
  for (const fact of state.joinFacts) {
    factNumbers.add(numbering.ofValue(fact.parameter))
    if (fact.kind !== 'nonnegative') factNumbers.add(numbering.ofValue(fact.bound))
  }
  if (relations.functionValuesByNumber == null) {
    if (!chargeRelationalWork(relations, flow.values.length)) return []
    const valuesByNumber = new Map<number, ValueID[]>()
    for (const value of flow.values) {
      const number = numbering.ofValue(value)
      const listed = valuesByNumber.get(number)
      if (listed == null) valuesByNumber.set(number, [value])
      else listed.push(value)
    }
    relations.functionValuesByNumber = valuesByNumber
  }
  const candidates = new Set<ValueID>(flow.functionParameters)
  for (const argument of flow.incomingArguments[target]!) candidates.add(argument)
  for (const number of factNumbers) {
    for (const value of relations.functionValuesByNumber.get(number) ?? []) candidates.add(value)
  }
  if (!chargeRelationalWork(relations, candidates.size)) return []
  const bounds: ValueID[] = []
  const boundNumbers = new Set<number>()
  for (const value of [...candidates].sort((left, right) => left - right)) {
    const held = state.values[value]
    if (held?.kind !== 'number' || held.mayBeNaN) continue
    const block = flow.blockOfValue[value]
    if (context.parameterIndexByValue[value] == null
      && (block == null || block === target || !flow.dominance.dominates(block, target))) continue
    const number = numbering.ofValue(value)
    if (boundNumbers.has(number)) continue
    boundNumbers.add(number)
    bounds.push(value)
  }
  return bounds
}

function blockSuccessors(fn: FunctionIR): BlockID[][] {
  return fn.blocks.map(block => {
    switch (block.terminator.kind) {
      case 'return': return []
      case 'stop': return []
      case 'thrown': return []
      case 'jump': return [block.terminator.target.block]
      case 'branch': return [block.terminator.whenTrue.block, block.terminator.whenFalse.block]
    }
  })
}

function reverseEdges(successors: BlockID[][]): BlockID[][] {
  const predecessors: BlockID[][] = successors.map(() => [])
  for (let source = 0; source < successors.length; source++) {
    for (const target of successors[source]!) predecessors[target]!.push(source)
  }
  return predecessors
}

function reachableAfter(successors: BlockID[][], starts: BlockID[]): boolean[] {
  const reached: boolean[] = []
  const queue: BlockID[] = []
  for (const start of starts) queue.push(...successors[start]!)
  let index = 0
  while (index < queue.length) {
    const block = queue[index++]!
    if (reached[block] === true) continue
    reached[block] = true
    queue.push(...successors[block]!)
  }
  return reached
}

// Every block reachable from `start` through one or more static CFG edges. Static rather
// than visited-during-analysis edges: a body whose back edge never fired because the body
// stopped must still count as inside its loop.
function reachableFrom(successors: BlockID[][], start: BlockID): boolean[] {
  return reachableAfter(successors, [start])
}
