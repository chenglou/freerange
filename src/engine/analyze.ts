import {constantNumber} from '../domain/number.ts'
import {joinValues, type AbstractValue} from '../domain/value.ts'
import type {BlockID, FunctionID, ModuleBindingID, SiteID} from '../ir/ids.ts'
import {functionUsage, transitiveModuleBindings} from '../ir/function-usage.ts'
import {finiteInputExpression, finiteInputs} from '../ir/finite-inputs.ts'
import type {EdgeIR} from '../ir/instructions.ts'
import {declaredKindOf, declaredKindValue, holdsMutableStructure, type FunctionIR, type ProgramIR} from '../ir/program.ts'
import {addPrecondition, constantRequirementStatus, createExpressionContext, staticRequirement} from '../requirements/infer.ts'
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
  type SharedState,
  type ValueFact,
} from './state.ts'
import {
  asRefinableCheck,
  branchConditionOutcome,
  evaluateInstruction,
  refineCheck,
  requiredValue,
} from './transfer.ts'

// A termination backstop, not an iteration budget: the count is fixed-point rounds of one
// loop header's abstract state, unrelated to runtime iteration counts. Widening makes
// ordinary counting loops converge in two or three rounds.
const maximumLoopHeaderUpdates = 16

export function analyzeProgram(program: ProgramIR): ProgramAnalysis {
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
    {identityNamespace: 'module/'},
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
      {
        boundsAssumptions: moduleReads[functionID]!.size > 0 ? initializerBounds : [],
        identityNamespace: `function:${functionID}/`,
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
// the slot must be initialized at every path end of the initializer (stops included), and
// no write to the binding may sit where the analysis stopped following — inside the
// stopping block past the stop, or in any block still reachable from it (loops included,
// since a stop can first appear on a late widening round).
function publishedModuleValues(
  program: ProgramIR,
  run: EvaluationRun,
  evaluation: FunctionEvaluation,
): Array<AbstractValue | null> {
  const fn = program.initializer
  const end = evaluation.normal == null
    ? run.moduleEnd
    : run.moduleEnd == null
      ? evaluation.normal.sharedState
      : joinModuleSlots(run.moduleEnd, evaluation.normal.sharedState)

  const demoted = new Set<ModuleBindingID>()
  const successors = blockSuccessors(fn)
  const stoppingBlocks: BlockID[] = []
  for (let blockID = 0; blockID < fn.blocks.length; blockID++) {
    const stopIndex = run.blocks[blockID]!.stopIndex
    if (stopIndex == null) continue
    stoppingBlocks.push(blockID)
    const instructions = fn.blocks[blockID]!.instructions
    for (let index = stopIndex; index < instructions.length; index++) {
      const instruction = instructions[index]!
      if (instruction.kind === 'moduleWrite') demoted.add(instruction.binding)
    }
  }
  const reachedAfterStops = reachableAfter(successors, stoppingBlocks)
  for (let target = 0; target < fn.blocks.length; target++) {
    if (reachedAfterStops[target] !== true) continue
    for (const instruction of fn.blocks[target]!.instructions) {
      if (instruction.kind === 'moduleWrite') demoted.add(instruction.binding)
    }
  }

  // Exact structural publishing (records, tuples, arrays — nullish-wrapped included)
  // additionally requires the whole file to be fully analyzed. Analyzed code cannot write
  // into an object, but rejected function bodies and skipped statements run at runtime
  // too, and they can mutate a structure through any alias — `Object.assign(config, ...)`
  // or `queue?.push(x)` inside a function that never lowered, invisible to the whole-file
  // write scan because the binding sits in argument or receiver position, not write
  // position. Scalars are unaffected: a number is copied on read, so only a write-position
  // form on the binding itself can change it, and the scan sees those even in rejected
  // bodies. When the file is not fully analyzed, structural bindings fall back to their
  // declared-shape hedge with per-leaf assumes lines.
  const fullyAnalyzed = evaluation.stops.length === 0
    && program.initializerSkips.length === 0
    && program.functions.every(lowered => lowered.kind === 'lowered')

  return program.moduleBindings.map((binding, index) => {
    if (binding.category.kind !== 'value' || demoted.has(index)) return null
    // holdsMutableStructure, not a top-level tag check: a `number[] | null` binding is
    // nullish at the top level yet the array inside is exactly as alias-mutable.
    if (holdsMutableStructure(binding.category.declaredKind) && !fullyAnalyzed) return null
    const slot = end?.[index]
    return slot ?? null
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
  // The instruction index where the block first stopped (instructions.length for a stop
  // terminator); null when no visit stopped. The module publish rule demotes writes from
  // here onward, and the failed-header closure treats the block as cut.
  stopIndex: number | null
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
  parameterIdentityKeys?: string[]
  identityNamespace?: string
}

function runEvaluation(
  fn: FunctionIR,
  functionID: FunctionID | null,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  program: ProgramIR,
  callStack: FunctionID[],
  seed: EvaluationSeed = {},
): {evaluation: FunctionEvaluation; run: EvaluationRun} {
  if (arguments_.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} arguments for ${fn.name}`)
  if (argumentExpressions.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} argument expressions for ${fn.name}`)
  const initial: ExecutionState = {
    values: [],
    shared: cloneSharedState(sharedState),
    valueFacts: seed.valueFacts?.slice() ?? [],
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    initial.values[fn.parameters[index]!.value] = arguments_[index]!
  }
  const expressionContext = createExpressionContext(
    fn,
    argumentExpressions,
    seed.parameterIdentityKeys,
    seed.identityNamespace ?? fn.name,
  )
  const preconditions: InferredPrecondition[] = []
  const boundsAssumptions: BoundsAssumption[] = [...(seed.boundsAssumptions ?? [])]
  const successors = blockSuccessors(fn)
  const run: EvaluationRun = {
    fn,
    blocks: fn.blocks.map(() => ({incoming: null, stopIndex: null, failedHeader: false, pendingReturn: null})),
    queue: [fn.entry],
    stops: [],
    assertionObservations: [],
    moduleEnd: null,
  }
  run.blocks[fn.entry]!.incoming = {state: initial, updateCount: 0}
  // Invariant for the whole evaluation (engineering.md's loop-invariant rule): built once
  // instead of allocating a context object and closure per instruction per fixed-point
  // round. preconditions is shared by reference and accumulates.
  const transferContext = {
    program,
    callStack: functionID == null ? callStack : [...callStack, functionID],
    expressionContext,
    preconditions,
    boundsAssumptions,
    evaluateFunction: (
      callee: FunctionID,
      values: AbstractValue[],
      expressions: Array<NumericExpression | null>,
      calleeState: SharedState,
      stack: FunctionID[],
      valueFacts: ValueFact[],
      parameterIdentityKeys: string[],
      identityNamespace: string,
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
        {valueFacts, parameterIdentityKeys, identityNamespace},
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
            index,
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
          block.instructions.length,
        )
        break
      }
      case 'jump': {
        propagate(state, blockID, block.terminator.target, run)
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
            block.instructions.length,
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
          if (branch != null) propagate(branch, blockID, block.terminator.whenTrue, run)
        }
        if (condition.canBeFalse) {
          const branch = check != null
            ? refineCheck(state, check, false, expressionContext)
            : state
          if (branch != null) propagate(branch, blockID, block.terminator.whenFalse, run)
        }
        break
      }
    }
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
          if (run.blocks[stopBlock]!.stopIndex == null || reachedFromHeader[stopBlock] !== true) continue
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
          0,
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
  instructionIndex: number,
): void {
  const block = run.blocks[blockID]!
  if (block.stopIndex == null || instructionIndex < block.stopIndex) {
    block.stopIndex = instructionIndex
  }
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
  const candidate = state
  for (let index = 0; index < target.parameters.length; index++) {
    candidate.values[target.parameters[index]!] = argumentValues[index]!
  }
  const previous = run.blocks[edge.block]!.incoming
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
        0,
      )
      run.blocks[edge.block]!.failedHeader = true
      return
    }
    run.blocks[edge.block]!.incoming = {state: update.state, updateCount: previous.updateCount + 1}
    run.queue.push(edge.block)
  }
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
