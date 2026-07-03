import {finiteInputNumber} from '../domain/number.ts'
import {joinValues, type AbstractValue} from '../domain/value.ts'
import type {AllocationContext} from '../heap/model.ts'
import {allocateParameter, joinHeaps} from '../heap/operations.ts'
import type {BlockID, FunctionID, ModuleBindingID} from '../ir/ids.ts'
import type {EdgeIR} from '../ir/instructions.ts'
import type {FunctionIR, ProgramIR} from '../ir/program.ts'
import {createExpressionContext} from '../requirements/infer.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import {
  completedEvaluation,
  type FunctionAnalysis,
  type FunctionEvaluation,
  type ProgramAnalysis,
  type Stop,
} from './outcome.ts'
import {
  cloneSharedState,
  cloneState,
  emptySharedState,
  joinStates,
  sameState,
  widenState,
  type ExecutionState,
  type ModuleSlot,
  type SharedState,
} from './state.ts'
import {
  collectComparisons,
  evaluateInstruction,
  refineComparison,
  requiredBoolean,
  requiredValue,
} from './transfer.ts'

// A termination backstop, not an iteration budget: the count is fixed-point rounds of one
// loop header's abstract state, unrelated to runtime iteration counts. Widening makes
// ordinary counting loops converge in two or three rounds.
const maximumLoopHeaderUpdates = 16

export function analyzeProgram(program: ProgramIR): ProgramAnalysis {
  // The initializer runs first, so top-level calls into declared functions see the module
  // state built so far, and its results decide what later function analysis may trust.
  const initializer = runEvaluation(
    program.initializer,
    null,
    [],
    [],
    emptySharedState(program.moduleBindings.length),
    program,
    [],
    null,
  )
  const moduleValues = publishedModuleValues(program, initializer.run, initializer.evaluation)
  const functions: FunctionAnalysis[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const fn = program.functions[functionID]!
    if (fn.kind === 'unsupported') {
      functions.push({kind: 'notLowered'})
      continue
    }
    const arguments_: AbstractValue[] = []
    const argumentExpressions: Array<NumericExpression | null> = []
    const sharedState: SharedState = {
      heap: [],
      modules: seedModuleSlots(program, moduleValues),
    }
    for (let index = 0; index < fn.parameters.length; index++) {
      const parameter = fn.parameters[index]!
      switch (parameter.type.kind) {
        case 'number': {
          arguments_.push(finiteInputNumber())
          argumentExpressions.push({kind: 'parameter', index})
          break
        }
        case 'object': {
          arguments_.push(allocateParameter(
            sharedState.heap,
            index,
            parameter.type.properties.map(name => ({name, value: finiteInputNumber()})),
          ))
          argumentExpressions.push(null)
          break
        }
      }
    }
    const {evaluation} = runEvaluation(fn, functionID, arguments_, argumentExpressions, sharedState, program, [], null)
    functions.push(publishedAnalysis(fn, evaluation))
  }
  return {
    functions,
    initializer: publishedAnalysis(program.initializer, initializer.evaluation),
    moduleValues,
  }
}

function publishedAnalysis(fn: FunctionIR, evaluation: FunctionEvaluation): FunctionAnalysis {
  const completed = completedEvaluation(evaluation)
  if (completed != null) {
    return {
      kind: 'analyzed',
      preconditions: completed.preconditions,
      returnValue: completed.returnValue,
      sharedState: completed.sharedState,
    }
  }
  const [firstStop, ...laterStops] = evaluation.stops
  if (firstStop == null) throw new Error(`Function ${fn.name} has no reachable return`)
  return {
    kind: 'partial',
    stops: [firstStop, ...laterStops],
    observedReturn: evaluation.normal == null
      ? null
      : {value: evaluation.normal.returnValue, heap: evaluation.normal.sharedState.heap},
    observedNeeds: evaluation.preconditions,
  }
}

// What each function's module slots start from. A published value is trusted exactly;
// otherwise a number or boolean binding contributes only its declared kind, and every other
// binding stays uninitialized so reads stop. With a direct eval call in the file, the
// declared-kind fallback is off entirely: the eval string can put a value of any type into
// any non-const binding, so an unpublished binding is untracked, not "some number".
function seedModuleSlots(program: ProgramIR, moduleValues: Array<AbstractValue | null>): ModuleSlot[] {
  return program.moduleBindings.map((binding, index) => {
    const published = moduleValues[index]
    if (published != null) return {kind: 'value', value: published}
    if (program.directEval) return {kind: 'uninitialized'}
    const category = binding.category
    if (category.kind !== 'value' && category.kind !== 'kind') return {kind: 'uninitialized'}
    return {
      kind: 'value',
      value: category.declaredKind === 'number'
        ? finiteInputNumber()
        : {kind: 'boolean', canBeTrue: true, canBeFalse: true},
    }
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
  const ends: ModuleSlot[][] = [...run.moduleEnds]
  if (evaluation.normal != null) ends.push(evaluation.normal.sharedState.modules)

  const demoted = new Set<ModuleBindingID>()
  const successors = blockSuccessors(fn)
  for (let blockID = 0; blockID < fn.blocks.length; blockID++) {
    const stopIndex = run.stopIndexByBlock[blockID]
    if (stopIndex == null) continue
    for (const instruction of fn.blocks[blockID]!.instructions.slice(stopIndex)) {
      if (instruction.kind === 'moduleWrite') demoted.add(instruction.binding)
    }
    const reached = reachableFrom(successors, blockID)
    for (let target = 0; target < fn.blocks.length; target++) {
      if (reached[target] !== true) continue
      for (const instruction of fn.blocks[target]!.instructions) {
        if (instruction.kind === 'moduleWrite') demoted.add(instruction.binding)
      }
    }
  }

  return program.moduleBindings.map((binding, index) => {
    if (binding.category.kind !== 'value' || demoted.has(index)) return null
    let joined: AbstractValue | null = null
    for (const end of ends) {
      const slot = end[index]!
      if (slot.kind === 'uninitialized') return null
      joined = joined == null ? slot.value : joinValues(joined, slot.value)
    }
    return joined
  })
}

// One entry per reachable block: the joined state flowing into the block, and how many
// times that state has been updated (loop headers widen from the second update on).
type IncomingState = {
  state: ExecutionState
  updateCount: number
}

// Everything one evaluation accumulates; created and discarded together.
type EvaluationRun = {
  fn: FunctionIR
  incoming: Array<IncomingState | undefined>
  queue: BlockID[]
  stops: Stop[]
  // By SiteID: the first stop at a site wins, so re-visits (loop rounds, both arms of a
  // branch reaching one call) cannot grow the list past the function's site count.
  stopRecordedBySite: boolean[]
  // By BlockID: blocks whose visit recorded a stop, for the failed-header closure below.
  stopBlocks: boolean[]
  // By BlockID: the instruction index where the block first stopped (instructions.length
  // for a stop terminator). The module publish rule demotes writes from here onward.
  stopIndexByBlock: Array<number | undefined>
  // By BlockID: loop headers whose state never stabilized. Returns reachable from a failed
  // header are not evidence — they were computed from a state short of its fixed point.
  failedHeaders: boolean[]
  // By BlockID: the latest return recorded from each block; overwritten on re-visits
  // (incoming states grow monotonically, so the last visit supersedes earlier ones) and
  // joined only after the worklist drains.
  pendingReturns: Array<{value: AbstractValue; shared: SharedState} | undefined>
  // The module slots at every stop, joined with the normal end by the publish rule.
  moduleEnds: ModuleSlot[][]
}

function runEvaluation(
  fn: FunctionIR,
  functionID: FunctionID | null,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  program: ProgramIR,
  callStack: FunctionID[],
  context: AllocationContext,
): {evaluation: FunctionEvaluation; run: EvaluationRun} {
  if (arguments_.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} arguments for ${fn.name}`)
  if (argumentExpressions.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} argument expressions for ${fn.name}`)
  const initial: ExecutionState = {
    frame: {values: []},
    shared: cloneSharedState(sharedState),
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    initial.frame.values[fn.parameters[index]!.value] = arguments_[index]!
  }
  const comparisons = collectComparisons(fn)
  const expressionContext = createExpressionContext(fn, argumentExpressions)
  const preconditions: InferredPrecondition[] = []
  const run: EvaluationRun = {
    fn,
    incoming: [],
    queue: [fn.entry],
    stops: [],
    stopRecordedBySite: [],
    stopBlocks: [],
    stopIndexByBlock: [],
    failedHeaders: [],
    pendingReturns: [],
    moduleEnds: [],
  }
  run.incoming[fn.entry] = {state: initial, updateCount: 0}
  let queueIndex = 0
  while (queueIndex < run.queue.length) {
    const blockID = run.queue[queueIndex++]!
    const block = fn.blocks[blockID]
    const entry = run.incoming[blockID]
    if (block == null || entry == null) throw new Error(`Missing block ${blockID} in ${fn.name}`)
    const state = cloneState(entry.state)
    let stopped = false
    for (let index = 0; index < block.instructions.length; index++) {
      const instruction = block.instructions[index]!
      const result = evaluateInstruction(instruction, state, {
        program,
        callStack: functionID == null ? callStack : [...callStack, functionID],
        expressionContext,
        preconditions,
        allocationContext: context,
        evaluateFunction: (callee, values, expressions, calleeState, stack, calleeContext) => {
          const calleeFn = program.functions[callee]
          if (calleeFn == null) throw new Error(`Unknown function ${callee}`)
          // Callers turn calls to unlowered functions into calleeStopped records first.
          if (calleeFn.kind !== 'lowered') throw new Error(`Analysis reached unlowered function ${calleeFn.name}`)
          return runEvaluation(calleeFn, callee, values, expressions, calleeState, program, stack, calleeContext).evaluation
        },
      })
      if (result.kind === 'stop') {
        addStop(run, blockID, result.stop, state.shared.modules.slice(), index)
        // A return recorded by an earlier visit of this block described a smaller incoming
        // state; the stop supersedes it.
        run.pendingReturns[blockID] = undefined
        stopped = true
        break
      }
      state.frame.values[instruction.result] = result.value
    }
    if (stopped) continue
    switch (block.terminator.kind) {
      case 'return': {
        const value = block.terminator.value == null
          ? {kind: 'void'} as const
          : requiredValue(state, block.terminator.value)
        run.pendingReturns[blockID] = {value, shared: cloneSharedState(state.shared)}
        break
      }
      case 'stop': {
        addStop(
          run,
          blockID,
          {site: block.terminator.site, reason: {kind: 'unsupportedCode', reason: block.terminator.reason}},
          state.shared.modules.slice(),
          block.instructions.length,
        )
        break
      }
      case 'jump': {
        propagate(state, blockID, block.terminator.target, run)
        break
      }
      case 'branch': {
        const condition = requiredBoolean(state, block.terminator.condition)
        const comparison = comparisons[block.terminator.condition]
        if (condition.canBeTrue) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, true)
          if (branch != null) propagate(branch, blockID, block.terminator.whenTrue, run)
        }
        if (condition.canBeFalse) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, false)
          if (branch != null) propagate(branch, blockID, block.terminator.whenFalse, run)
        }
        break
      }
    }
  }

  const successors = blockSuccessors(fn)
  // A stop inside a loop cuts the back edge, freezing the header short of its fixed point —
  // and the stop may first appear on a late widening round, after earlier rounds already
  // propagated returns downstream. Any header on a cycle through a stopping block is
  // therefore failed too. Slightly conservative: evidence from the path where the loop body
  // runs zero times is also suppressed when the stop existed from the first round.
  for (let headerID = 0; headerID < fn.blocks.length; headerID++) {
    if (fn.blocks[headerID]!.loopHeader == null || run.failedHeaders[headerID] === true) continue
    const reachedFromHeader = reachableFrom(successors, headerID)
    for (let stopBlock = 0; stopBlock < run.stopBlocks.length; stopBlock++) {
      if (run.stopBlocks[stopBlock] !== true || reachedFromHeader[stopBlock] !== true) continue
      if (reachableFrom(successors, stopBlock)[headerID] === true) {
        run.failedHeaders[headerID] = true
        break
      }
    }
  }
  const suppressed: boolean[] = []
  for (let headerID = 0; headerID < fn.blocks.length; headerID++) {
    if (run.failedHeaders[headerID] !== true) continue
    const reached = reachableFrom(successors, headerID)
    for (let block = 0; block < fn.blocks.length; block++) {
      if (reached[block] === true) suppressed[block] = true
    }
  }

  let normal: FunctionEvaluation['normal'] = null
  for (let blockID = 0; blockID < fn.blocks.length; blockID++) {
    const pending = run.pendingReturns[blockID]
    if (pending == null || suppressed[blockID] === true) continue
    if (normal == null) {
      normal = {returnValue: pending.value, sharedState: pending.shared}
      continue
    }
    normal = {
      returnValue: joinValues(normal.returnValue, pending.value),
      sharedState: {
        heap: joinHeaps(normal.sharedState.heap, pending.shared.heap),
        modules: joinModuleEnds(normal.sharedState.modules, pending.shared.modules),
      },
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
    for (let headerID = 0; headerID < fn.blocks.length; headerID++) {
      const header = fn.blocks[headerID]!
      const entry_ = run.incoming[headerID]
      if (header.loopHeader == null || entry_ == null) continue
      const downstream = reachableFrom(successors, headerID)
      let visitedDownstream = false
      let stuckInCycle = true
      for (let block = 0; block < fn.blocks.length; block++) {
        if (downstream[block] !== true || run.incoming[block] == null) continue
        visitedDownstream = true
        if (reachableFrom(successors, block)[headerID] !== true) {
          stuckInCycle = false
          break
        }
      }
      if (visitedDownstream && stuckInCycle) {
        addStop(
          run,
          headerID,
          {site: header.loopHeader, reason: {kind: 'nonExitingLoop'}},
          entry_.state.shared.modules.slice(),
          0,
        )
      }
    }
  }

  return {evaluation: {normal, preconditions, stops: run.stops}, run}
}

function joinModuleEnds(left: ModuleSlot[], right: ModuleSlot[]): ModuleSlot[] {
  const joined: ModuleSlot[] = []
  for (let index = 0; index < left.length; index++) {
    const leftSlot = left[index]!
    const rightSlot = right[index]!
    joined.push(
      leftSlot.kind === 'uninitialized' || rightSlot.kind === 'uninitialized'
        ? {kind: 'uninitialized'}
        : {kind: 'value', value: joinValues(leftSlot.value, rightSlot.value)},
    )
  }
  return joined
}

function addStop(
  run: EvaluationRun,
  blockID: BlockID,
  stop: Stop,
  moduleCapture: ModuleSlot[],
  instructionIndex: number,
): void {
  run.stopBlocks[blockID] = true
  const existingIndex = run.stopIndexByBlock[blockID]
  if (existingIndex == null || instructionIndex < existingIndex) {
    run.stopIndexByBlock[blockID] = instructionIndex
  }
  run.moduleEnds.push(moduleCapture)
  if (run.stopRecordedBySite[stop.site] === true) return
  run.stopRecordedBySite[stop.site] = true
  run.stops.push(stop)
}

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
  const candidate = cloneState(state)
  for (let index = 0; index < target.parameters.length; index++) {
    candidate.frame.values[target.parameters[index]!] = requiredValue(state, edge.arguments[index]!)
  }
  const previous = run.incoming[edge.block]
  if (previous == null) {
    run.incoming[edge.block] = {state: candidate, updateCount: 0}
    run.queue.push(edge.block)
    return
  }
  const joined = target.loopHeader != null && previous.updateCount >= 1
    ? widenState(previous.state, candidate)
    : joinStates(previous.state, candidate)
  if (!sameState(previous.state, joined)) {
    if (target.loopHeader != null && previous.updateCount >= maximumLoopHeaderUpdates) {
      addStop(
        run,
        sourceBlock,
        {site: target.loopHeader, reason: {kind: 'loopLimit', updates: maximumLoopHeaderUpdates}},
        state.shared.modules.slice(),
        0,
      )
      run.failedHeaders[edge.block] = true
      return
    }
    run.incoming[edge.block] = {state: joined, updateCount: previous.updateCount + 1}
    run.queue.push(edge.block)
  }
}

function blockSuccessors(fn: FunctionIR): BlockID[][] {
  return fn.blocks.map(block => {
    switch (block.terminator.kind) {
      case 'return': return []
      case 'stop': return []
      case 'jump': return [block.terminator.target.block]
      case 'branch': return [block.terminator.whenTrue.block, block.terminator.whenFalse.block]
    }
  })
}

// Every block reachable from `start` through one or more static CFG edges. Static rather
// than visited-during-analysis edges: a body whose back edge never fired because the body
// stopped must still count as inside its loop.
function reachableFrom(successors: BlockID[][], start: BlockID): boolean[] {
  const reached: boolean[] = []
  const queue = [...successors[start]!]
  let index = 0
  while (index < queue.length) {
    const block = queue[index++]!
    if (reached[block] === true) continue
    reached[block] = true
    queue.push(...successors[block]!)
  }
  return reached
}
