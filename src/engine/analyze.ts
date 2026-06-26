import {finiteInputNumber} from '../domain/number.ts'
import {joinValues, type AbstractValue} from '../domain/value.ts'
import {allocateObject, joinHeaps} from '../heap/operations.ts'
import type {BlockID, FunctionID} from '../ir/ids.ts'
import type {EdgeIR} from '../ir/instructions.ts'
import type {FunctionIR, ProgramIR} from '../ir/program.ts'
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
  const functions: FunctionAnalysis[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const fn = program.functions[functionID]!
    const arguments_: AbstractValue[] = []
    const argumentExpressions: Array<NumericExpression | null> = []
    const sharedState = emptySharedState()
    const parameters: FunctionAnalysis['parameters'] = []
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
      program.functions,
      [],
    )
    functions.push({
      name: fn.name,
      parameters,
      preconditions: evaluation.preconditions,
      returnValue: evaluation.returnValue,
      sharedState: evaluation.sharedState,
    })
  }
  return {file: program.file, functions}
}

function evaluateFunction(
  functionID: FunctionID,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  functions: FunctionIR[],
  callStack: FunctionID[],
): CompleteFunctionEvaluation {
  const fn = functions[functionID]
  if (fn == null) throw new Error(`Unknown function ${functionID}`)
  if (callStack.includes(functionID)) {
    const names = [...callStack, functionID].map(id => functions[id]!.name)
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
  const incoming: Array<ExecutionState | undefined> = []
  const updateCounts: number[] = []
  incoming[fn.entry] = initial
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
    const state = cloneState(entry)
    for (const instruction of block.instructions) {
      state.frame.values[instruction.result] = evaluateInstruction(instruction, state, {
        functions,
        callStack: [...callStack, functionID],
        expressionContext,
        preconditions,
        evaluateFunction: (callee, values, expressions, calleeState, stack) => evaluateFunction(
          callee,
          values,
          expressions,
          calleeState,
          functions,
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
        propagate(state, block.terminator.target, fn, incoming, updateCounts, queue)
        break
      }
      case 'branch': {
        const condition = requiredBoolean(state, block.terminator.condition)
        const comparison = comparisons[block.terminator.condition]
        if (condition.canBeTrue) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, true)
          if (branch != null) propagate(branch, block.terminator.whenTrue, fn, incoming, updateCounts, queue)
        }
        if (condition.canBeFalse) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, false)
          if (branch != null) propagate(branch, block.terminator.whenFalse, fn, incoming, updateCounts, queue)
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

function propagate(
  state: ExecutionState,
  edge: EdgeIR,
  fn: FunctionIR,
  incoming: Array<ExecutionState | undefined>,
  updateCounts: number[],
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
    incoming[edge.block] = candidate
    queue.push(edge.block)
    return
  }
  const updateCount = updateCounts[edge.block] ?? 0
  const joined = target.loopHeader && updateCount >= 1
    ? widenState(previous, candidate)
    : joinStates(previous, candidate)
  if (!sameState(previous, joined)) {
    if (target.loopHeader && updateCount >= maximumLoopHeaderUpdates) {
      throw new Error(`Loop header ${edge.block} in ${fn.name} did not converge after ${maximumLoopHeaderUpdates} updates`)
    }
    incoming[edge.block] = joined
    updateCounts[edge.block] = updateCount + 1
    queue.push(edge.block)
  }
}
