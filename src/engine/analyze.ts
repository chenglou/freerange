import {finiteInputNumber} from '../domain/number.ts'
import {joinValues, type AbstractValue} from '../domain/value.ts'
import {allocateObject, joinHeaps} from '../heap/operations.ts'
import type {BlockID, FunctionID, SiteID} from '../ir/ids.ts'
import type {EdgeIR} from '../ir/instructions.ts'
import {siteLocation, type FunctionIR, type ProgramIR} from '../ir/program.ts'
import {createExpressionContext} from '../requirements/infer.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import type {CompleteFunctionEvaluation, FunctionAnalysis, ProgramAnalysis} from './outcome.ts'
import {
  cloneSharedState,
  cloneState,
  emptySharedState,
  joinStates,
  sameState,
  widenState,
  type ExecutionState,
  type SharedState,
} from './state.ts'
import {
  collectComparisons,
  evaluateInstruction,
  refineComparison,
  requiredBoolean,
  requiredValue,
} from './transfer.ts'

const maximumLoopHeaderUpdates = 16

export function analyzeProgram(program: ProgramIR): ProgramAnalysis {
  const blocked = blockedCallers(program)
  const functions: FunctionAnalysis[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const fn = program.functions[functionID]!
    if (fn.kind === 'unsupported') {
      functions.push({kind: 'notLowered'})
      continue
    }
    const blocking = blocked[functionID]
    if (blocking != null) {
      functions.push({kind: 'blockedByCallee', site: blocking.site, callee: blocking.callee})
      continue
    }
    const arguments_: AbstractValue[] = []
    const argumentExpressions: Array<NumericExpression | null> = []
    const sharedState = emptySharedState()
    const parameters: Extract<FunctionAnalysis, {kind: 'analyzed'}>['parameters'] = []
    for (const parameter of fn.parameters) {
      parameters.push({name: parameter.name, type: parameter.type})
      switch (parameter.type.kind) {
        case 'number': {
          arguments_.push(finiteInputNumber())
          argumentExpressions.push({kind: 'parameter', index: parameters.length - 1})
          break
        }
        case 'object': {
          arguments_.push(allocateObject(
            sharedState.heap,
            parameter.type.properties.map(name => ({name, value: finiteInputNumber()})),
          ))
          argumentExpressions.push(null)
          break
        }
      }
    }
    const evaluation = evaluateFunction(
      functionID,
      arguments_,
      argumentExpressions,
      sharedState,
      program,
      [],
    )
    functions.push({
      kind: 'analyzed',
      name: fn.name,
      parameters,
      preconditions: evaluation.preconditions,
      returnValue: evaluation.returnValue,
      sharedState: evaluation.sharedState,
    })
  }
  return {functions}
}

type BlockingCall = {
  site: SiteID
  callee: FunctionID
}

// A lowered function is blocked when any call instruction in its body targets an unsupported
// or already-blocked function, transitively. Records one such call per function. Deliberately
// whole-function and branch-insensitive: partial evaluation up to the blocking call will
// replace this pass entirely.
function blockedCallers(program: ProgramIR): Array<BlockingCall | undefined> {
  const blocked: Array<BlockingCall | undefined> = []
  let changed = true
  while (changed) {
    changed = false
    for (let functionID = 0; functionID < program.functions.length; functionID++) {
      const fn = program.functions[functionID]!
      if (fn.kind !== 'lowered' || blocked[functionID] != null) continue
      const blocking = firstBlockingCall(fn, program, blocked)
      if (blocking != null) {
        blocked[functionID] = blocking
        changed = true
      }
    }
  }
  return blocked
}

function firstBlockingCall(
  fn: FunctionIR,
  program: ProgramIR,
  blocked: Array<BlockingCall | undefined>,
): BlockingCall | null {
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind !== 'call') continue
      const callee = program.functions[instruction.function]
      if (callee == null) throw new Error(`Unknown function ${instruction.function}`)
      if (callee.kind === 'unsupported' || blocked[instruction.function] != null) {
        return {site: instruction.site, callee: instruction.function}
      }
    }
  }
  return null
}

function evaluateFunction(
  functionID: FunctionID,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  program: ProgramIR,
  callStack: FunctionID[],
): CompleteFunctionEvaluation {
  const fn = program.functions[functionID]
  if (fn == null) throw new Error(`Unknown function ${functionID}`)
  // Unreachable while blockedCallers keeps callers of unsupported functions out of the
  // engine; the blocked pass and this invariant must move together.
  if (fn.kind !== 'lowered') throw new Error(`Analysis reached unlowered function ${fn.name}`)
  if (callStack.includes(functionID)) {
    const names = [...callStack, functionID].map(id => program.functions[id]!.name)
    throw new Error(`Recursive function analysis is unsupported: ${names.join(' → ')}`)
  }
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
  const incoming: Array<IncomingState | undefined> = []
  incoming[fn.entry] = {state: initial, updateCount: 0}
  const queue: BlockID[] = [fn.entry]
  let queueIndex = 0
  const preconditions: InferredPrecondition[] = []
  let returnValue: AbstractValue | null = null
  let returnSharedState: SharedState | null = null
  while (queueIndex < queue.length) {
    const blockID = queue[queueIndex++]!
    const block = fn.blocks[blockID]
    const entry = incoming[blockID]
    if (block == null || entry == null) throw new Error(`Missing block ${blockID} in ${fn.name}`)
    const state = cloneState(entry.state)
    for (const instruction of block.instructions) {
      state.frame.values[instruction.result] = evaluateInstruction(instruction, state, {
        program,
        callStack: [...callStack, functionID],
        expressionContext,
        preconditions,
        evaluateFunction: (callee, values, expressions, calleeState, stack) => evaluateFunction(
          callee,
          values,
          expressions,
          calleeState,
          program,
          stack,
        ),
      })
    }
    switch (block.terminator.kind) {
      case 'return': {
        const value = block.terminator.value == null
          ? {kind: 'void'} as const
          : requiredValue(state, block.terminator.value)
        returnValue = returnValue == null ? value : joinValues(returnValue, value)
        returnSharedState = returnSharedState == null
          ? cloneSharedState(state.shared)
          : {heap: joinHeaps(returnSharedState.heap, state.shared.heap)}
        break
      }
      case 'jump': {
        propagate(state, block.terminator.target, fn, program, incoming, queue)
        break
      }
      case 'branch': {
        const condition = requiredBoolean(state, block.terminator.condition)
        const comparison = comparisons[block.terminator.condition]
        if (condition.canBeTrue) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, true)
          if (branch != null) propagate(branch, block.terminator.whenTrue, fn, program, incoming, queue)
        }
        if (condition.canBeFalse) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, false)
          if (branch != null) propagate(branch, block.terminator.whenFalse, fn, program, incoming, queue)
        }
        break
      }
    }
  }
  if (returnValue == null || returnSharedState == null) throw new Error(`Function ${fn.name} has no reachable return`)
  return {
    returnValue,
    sharedState: returnSharedState,
    preconditions,
  }
}

// One entry per reachable block: the joined state flowing into the block, and how many
// times that state has been updated (loop headers widen from the second update on).
type IncomingState = {
  state: ExecutionState
  updateCount: number
}

function propagate(
  state: ExecutionState,
  edge: EdgeIR,
  fn: FunctionIR,
  program: ProgramIR,
  incoming: Array<IncomingState | undefined>,
  queue: BlockID[],
): void {
  const target = fn.blocks[edge.block]
  if (target == null) throw new Error(`Missing block ${edge.block} in ${fn.name}`)
  if (edge.arguments.length !== target.parameters.length) {
    throw new Error(`Expected ${target.parameters.length} arguments for block ${edge.block} in ${fn.name}`)
  }
  const candidate = cloneState(state)
  for (let index = 0; index < target.parameters.length; index++) {
    candidate.frame.values[target.parameters[index]!] = requiredValue(state, edge.arguments[index]!)
  }
  const previous = incoming[edge.block]
  if (previous == null) {
    incoming[edge.block] = {state: candidate, updateCount: 0}
    queue.push(edge.block)
    return
  }
  const joined = target.loopHeader != null && previous.updateCount >= 1
    ? widenState(previous.state, candidate)
    : joinStates(previous.state, candidate)
  if (!sameState(previous.state, joined)) {
    if (target.loopHeader != null && previous.updateCount >= maximumLoopHeaderUpdates) {
      const {line, column} = siteLocation(program, target.loopHeader)
      throw new Error(`Loop in ${fn.name} at ${program.file}:${line}:${column} did not converge after ${maximumLoopHeaderUpdates} updates`)
    }
    incoming[edge.block] = {state: joined, updateCount: previous.updateCount + 1}
    queue.push(edge.block)
  }
}
