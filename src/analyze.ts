import {
  addNumbers,
  constantNumber,
  divideNumbers,
  finiteInputNumber,
  floorNumber,
  includesZero,
  maximumNumbers,
  minimumNumbers,
  multiplyNumbers,
  subtractNumbers,
  type AbstractBoolean,
  type AbstractHeap,
  type AbstractNumber,
  type AbstractReference,
  type AbstractValue,
} from './domain.ts'
import type {
  BlockID,
  ComparisonOperator,
  EdgeIR,
  FunctionID,
  FunctionIR,
  InstructionIR,
  ProgramIR,
  ValueID,
  ValueTypeIR,
} from './ir.ts'
import {
  addPrecondition,
  createExpressionContext,
  numericExpression,
  type ExpressionContext,
  type InferredPrecondition,
  type NumericExpression,
} from './preconditions.ts'
import {cloneHeap, cloneState, joinHeaps, joinStates, joinValues, sameState, widenState, type State} from './state.ts'

type FunctionAnalysis = {
  name: string
  parameters: Array<{name: string; type: ValueTypeIR}>
  preconditions: InferredPrecondition[]
  returnValue: AbstractValue
  heap: AbstractHeap
}

export type ProgramAnalysis = {
  file: string
  functions: FunctionAnalysis[]
}

type FunctionEvaluation = {
  returnValue: AbstractValue
  heap: AbstractHeap
  preconditions: InferredPrecondition[]
}

const maximumLoopHeaderUpdates = 16

export function analyzeProgram(program: ProgramIR): ProgramAnalysis {
  const functions: FunctionAnalysis[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const fn = program.functions[functionID]!
    const arguments_: AbstractValue[] = []
    const argumentExpressions: Array<NumericExpression | null> = []
    const heap: AbstractHeap = []
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
          const allocation = heap.length
          heap.push({
            properties: parameter.type.properties.map(name => ({name, value: finiteInputNumber()})),
          })
          arguments_.push({kind: 'reference', allocation})
          argumentExpressions.push(null)
          break
        }
      }
    }
    const evaluation = evaluateFunction(functionID, arguments_, argumentExpressions, heap, program.functions, [])
    functions.push({
      name: fn.name,
      parameters,
      preconditions: evaluation.preconditions,
      returnValue: evaluation.returnValue,
      heap: evaluation.heap,
    })
  }
  return {file: program.file, functions}
}

function evaluateFunction(
  functionID: FunctionID,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  heap: AbstractHeap,
  functions: FunctionIR[],
  callStack: FunctionID[],
): FunctionEvaluation {
  const fn = functions[functionID]
  if (fn == null) throw new Error(`Unknown function ${functionID}`)
  if (callStack.includes(functionID)) {
    const names = [...callStack, functionID].map(id => functions[id]!.name)
    throw new Error(`Recursive function analysis is unsupported: ${names.join(' → ')}`)
  }
  if (arguments_.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} arguments for ${fn.name}`)
  if (argumentExpressions.length !== fn.parameters.length) throw new Error(`Expected ${fn.parameters.length} argument expressions for ${fn.name}`)
  const initial: State = {values: [], heap: cloneHeap(heap)}
  for (let index = 0; index < fn.parameters.length; index++) {
    initial.values[fn.parameters[index]!.value] = arguments_[index]!
  }
  const comparisons: Array<Extract<InstructionIR, {kind: 'compare'}> | undefined> = []
  const expressionContext = createExpressionContext(fn, argumentExpressions)
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind === 'compare') comparisons[instruction.result] = instruction
    }
  }
  const incoming: Array<State | undefined> = []
  const updateCounts: number[] = []
  incoming[fn.entry] = initial
  const queue: BlockID[] = [fn.entry]
  let queueIndex = 0
  const preconditions: InferredPrecondition[] = []
  let returnValue: AbstractValue | null = null
  let returnHeap: AbstractHeap | null = null
  while (queueIndex < queue.length) {
    const blockID = queue[queueIndex++]!
    const block = fn.blocks[blockID]
    const entry = incoming[blockID]
    if (block == null || entry == null) throw new Error(`Missing block ${blockID} in ${fn.name}`)
    const state = cloneState(entry)
    for (const instruction of block.instructions) {
      state.values[instruction.result] = evaluateInstruction(
        instruction,
        state,
        expressionContext,
        preconditions,
        functions,
        [...callStack, functionID],
      )
    }
    switch (block.terminator.kind) {
      case 'return': {
        const value = block.terminator.value == null
          ? {kind: 'void'} as const
          : requiredValue(state, block.terminator.value)
        returnValue = returnValue == null ? value : joinValues(returnValue, value)
        returnHeap = returnHeap == null ? cloneHeap(state.heap) : joinHeaps(returnHeap, state.heap)
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
  if (returnValue == null || returnHeap == null) throw new Error(`Function ${fn.name} has no reachable return`)
  return {returnValue, heap: returnHeap, preconditions}
}

function evaluateInstruction(
  instruction: InstructionIR,
  state: State,
  expressionContext: ExpressionContext,
  preconditions: InferredPrecondition[],
  functions: FunctionIR[],
  callStack: FunctionID[],
): AbstractValue {
  switch (instruction.kind) {
    case 'constant': return constantNumber(instruction.value)
    case 'object': {
      const allocation = state.heap.length
      state.heap.push({
        properties: instruction.properties.map(property => ({
          name: property.name,
          value: requiredValue(state, property.value),
        })),
      })
      return {kind: 'reference', allocation}
    }
    case 'property': return readProperty(
      state.heap,
      requiredReference(state, instruction.object),
      instruction.property,
    )
    case 'store': {
      const reference = requiredReference(state, instruction.object)
      const assigned = requiredValue(state, instruction.value)
      const object = state.heap[reference.allocation]
      if (object == null) throw new Error(`Missing heap allocation ${reference.allocation}`)
      const property = object.properties.find(candidate => candidate.name === instruction.property)
      if (property == null) throw new Error(`Abstract object has no property ${instruction.property}`)
      property.value = assigned
      return assigned
    }
    case 'compare': return compareNumbers(
      requiredNumber(state, instruction.left),
      requiredNumber(state, instruction.right),
      instruction.operator,
    )
    case 'floor': {
      return floorNumber(requiredNumber(state, instruction.value))
    }
    case 'minimum': return minimumNumbers(instruction.values.map(value => requiredNumber(state, value)))
    case 'maximum': return maximumNumbers(instruction.values.map(value => requiredNumber(state, value)))
    case 'call': {
      const callee = functions[instruction.function]
      if (callee == null) throw new Error(`Unknown function ${instruction.function}`)
      const arguments_ = instruction.arguments.map(value => requiredValue(state, value))
      const argumentExpressions = instruction.arguments.map(value => numericExpression(value, expressionContext))
      const evaluation = evaluateFunction(
        instruction.function,
        arguments_,
        argumentExpressions,
        state.heap,
        functions,
        callStack,
      )
      state.heap = evaluation.heap
      for (const precondition of evaluation.preconditions) addPrecondition(preconditions, precondition)
      return evaluation.returnValue
    }
    case 'binary': {
      const left = requiredNumber(state, instruction.left)
      const right = requiredNumber(state, instruction.right)
      if (instruction.operator === 'divide' && includesZero(right)) {
        const expression = numericExpression(instruction.right, expressionContext)
        if (expression == null) throw new Error(`Cannot infer a nonzero precondition for IR value ${instruction.right}`)
        addPrecondition(preconditions, {kind: 'nonzero', expression})
      }
      return evaluateBinary(instruction.operator, left, right)
    }
  }
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
  if (left.mayBeNaN || right.mayBeNaN) return {kind: 'boolean', canBeTrue: true, canBeFalse: true}
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

function refineComparison(
  state: State,
  comparison: Extract<InstructionIR, {kind: 'compare'}>,
  truth: boolean,
): State | null {
  if (!truth && comparison.operator === 'equal') return cloneState(state)
  const result = cloneState(state)
  const left = requiredNumber(result, comparison.left)
  const right = requiredNumber(result, comparison.right)
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
  if (refinedLeft.lower > refinedLeft.upper || refinedRight.lower > refinedRight.upper) return null
  result.values[comparison.left] = refinedLeft
  result.values[comparison.right] = refinedRight
  return result
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
  return {...value, lower: Math.max(value.lower, lower), upper: Math.min(value.upper, upper)}
}

function strictLower(value: number, integer: boolean): number {
  return integer ? Math.floor(value) + 1 : value
}

function strictUpper(value: number, integer: boolean): number {
  return integer ? Math.ceil(value) - 1 : value
}

function propagate(
  state: State,
  edge: EdgeIR,
  fn: FunctionIR,
  incoming: Array<State | undefined>,
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
    candidate.values[target.parameters[index]!] = requiredValue(state, edge.arguments[index]!)
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

function requiredNumber(state: State, id: ValueID): AbstractNumber {
  const value = requiredValue(state, id)
  if (value.kind !== 'number') throw new Error(`IR value ${id} is not a number`)
  return value
}

function requiredBoolean(state: State, id: ValueID): AbstractBoolean {
  const value = requiredValue(state, id)
  if (value.kind !== 'boolean') throw new Error(`IR value ${id} is not a boolean`)
  return value
}

function requiredReference(state: State, id: ValueID): AbstractReference {
  const value = requiredValue(state, id)
  if (value.kind !== 'reference') throw new Error(`IR value ${id} is not an object reference`)
  return value
}

function requiredValue(state: State, id: ValueID): AbstractValue {
  const value = state.values[id]
  if (value == null) throw new Error(`Missing IR value ${id}`)
  return value
}

function readProperty(heap: AbstractHeap, reference: AbstractReference, name: string): AbstractValue {
  const object = heap[reference.allocation]
  if (object == null) throw new Error(`Missing heap allocation ${reference.allocation}`)
  const property = object.properties.find(candidate => candidate.name === name)
  if (property == null) throw new Error(`Abstract object has no property ${name}`)
  return property.value
}
