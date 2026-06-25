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
  type AbstractNumber,
  type AbstractObject,
  type AbstractValue,
} from './domain.ts'
import type {
  BlockID,
  ComparisonOperator,
  FunctionID,
  FunctionIR,
  InstructionIR,
  ProgramIR,
  SourceSpan,
  ValueID,
} from './ir.ts'

type State = Array<AbstractValue | undefined>

export type Obligation = {
  kind: 'nonzero-divisor' | 'finite-result' | 'finite-argument'
  status: 'proved' | 'unknown'
  span: SourceSpan
  description: string
}

export type FunctionAnalysis = {
  name: string
  parameters: string[]
  returnValue: AbstractValue
  obligations: Obligation[]
}

export type ProgramAnalysis = {
  file: string
  functions: FunctionAnalysis[]
}

type FunctionEvaluation = {
  returnValue: AbstractValue
  obligations: Obligation[]
}

export function analyzeProgram(program: ProgramIR): ProgramAnalysis {
  const functions: FunctionAnalysis[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const fn = program.functions[functionID]!
    const arguments_: AbstractNumber[] = []
    const parameters: string[] = []
    for (const parameter of fn.parameters) {
      arguments_.push(finiteInputNumber())
      parameters.push(parameter.name)
    }
    const evaluation = evaluateFunction(functionID, arguments_, program.functions, [])
    functions.push({name: fn.name, parameters, returnValue: evaluation.returnValue, obligations: evaluation.obligations})
  }
  return {file: program.file, functions}
}

function evaluateFunction(
  functionID: FunctionID,
  arguments_: AbstractNumber[],
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
  const initial: State = []
  for (let index = 0; index < fn.parameters.length; index++) {
    initial[fn.parameters[index]!.value] = arguments_[index]!
  }
  const comparisons: Array<Extract<InstructionIR, {kind: 'compare'}> | undefined> = []
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind === 'compare') comparisons[instruction.result] = instruction
    }
  }
  const incoming: Array<State | undefined> = []
  incoming[fn.entry] = initial
  const queue: BlockID[] = [fn.entry]
  let queueIndex = 0
  const obligationMap = new Map<string, Obligation>()
  let returnValue: AbstractValue | null = null
  while (queueIndex < queue.length) {
    const blockID = queue[queueIndex++]!
    const block = fn.blocks[blockID]
    const entry = incoming[blockID]
    if (block == null || entry == null) throw new Error(`Missing block ${blockID} in ${fn.name}`)
    const state = entry.slice()
    for (const instruction of block.instructions) {
      state[instruction.result] = evaluateInstruction(
        instruction,
        state,
        obligationMap,
        functions,
        [...callStack, functionID],
      )
    }
    switch (block.terminator.kind) {
      case 'return': {
        const value = requiredValue(state, block.terminator.value)
        returnValue = returnValue == null ? value : joinValues(returnValue, value)
        break
      }
      case 'branch': {
        const condition = requiredBoolean(state, block.terminator.condition)
        const comparison = comparisons[block.terminator.condition]
        if (condition.canBeTrue) {
          const branch = comparison == null ? state.slice() : refineComparison(state, comparison, true)
          if (branch != null) propagate(branch, block.terminator.whenTrue, incoming, queue)
        }
        if (condition.canBeFalse) {
          const branch = comparison == null ? state.slice() : refineComparison(state, comparison, false)
          if (branch != null) propagate(branch, block.terminator.whenFalse, incoming, queue)
        }
        break
      }
    }
  }
  if (returnValue == null) throw new Error(`Function ${fn.name} has no reachable return`)
  return {returnValue, obligations: [...obligationMap.values()]}
}

function evaluateInstruction(
  instruction: InstructionIR,
  values: State,
  obligations: Map<string, Obligation>,
  functions: FunctionIR[],
  callStack: FunctionID[],
): AbstractValue {
  switch (instruction.kind) {
    case 'constant': return constantNumber(instruction.value)
    case 'object': return {
      kind: 'object',
      properties: instruction.properties.map(property => ({
        name: property.name,
        value: requiredValue(values, property.value),
      })),
    }
    case 'property': {
      const object = requiredObject(values, instruction.object)
      const property = object.properties.find(candidate => candidate.name === instruction.property)
      if (property == null) throw new Error(`Abstract object has no property ${instruction.property}`)
      return property.value
    }
    case 'compare': return compareNumbers(
      requiredNumber(values, instruction.left),
      requiredNumber(values, instruction.right),
      instruction.operator,
    )
    case 'floor': {
      const result = floorNumber(requiredNumber(values, instruction.value))
      recordFiniteObligation(result, instruction.span, obligations)
      return result
    }
    case 'minimum': return minimumNumbers(instruction.values.map(value => requiredNumber(values, value)))
    case 'maximum': return maximumNumbers(instruction.values.map(value => requiredNumber(values, value)))
    case 'call': {
      const callee = functions[instruction.function]
      if (callee == null) throw new Error(`Unknown function ${instruction.function}`)
      const arguments_ = instruction.arguments.map(value => requiredNumber(values, value))
      for (let index = 0; index < arguments_.length; index++) {
        const argument = arguments_[index]!
        recordObligation(obligations, {
          kind: 'finite-argument',
          status: argument.finite && !argument.mayBeNaN ? 'proved' : 'unknown',
          span: instruction.span,
          description: argument.finite && !argument.mayBeNaN
            ? `Argument ${index + 1} to ${callee.name} is finite.`
            : `Argument ${index + 1} to ${callee.name} may be NaN or infinite.`,
        })
      }
      const evaluation = evaluateFunction(instruction.function, arguments_, functions, callStack)
      for (const obligation of evaluation.obligations) recordObligation(obligations, obligation)
      return evaluation.returnValue
    }
    case 'binary': {
      const left = requiredNumber(values, instruction.left)
      const right = requiredNumber(values, instruction.right)
      if (instruction.operator === 'divide') {
        recordObligation(obligations, {
          kind: 'nonzero-divisor',
          status: includesZero(right) ? 'unknown' : 'proved',
          span: instruction.span,
          description: includesZero(right) ? 'The divisor may be zero.' : 'The divisor is nonzero.',
        })
      }
      const result = evaluateBinary(instruction.operator, left, right)
      recordFiniteObligation(result, instruction.span, obligations)
      return result
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
  if (!truth && comparison.operator === 'equal') return state.slice()
  const result = state.slice()
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
  result[comparison.left] = refinedLeft
  result[comparison.right] = refinedRight
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

function propagate(state: State, block: BlockID, incoming: Array<State | undefined>, queue: BlockID[]): void {
  const previous = incoming[block]
  if (previous == null) {
    incoming[block] = state
    queue.push(block)
    return
  }
  const joined = joinStates(previous, state)
  if (!sameState(previous, joined)) {
    incoming[block] = joined
    queue.push(block)
  }
}

function joinStates(left: State, right: State): State {
  const result: State = []
  for (let id = 0; id < left.length; id++) {
    const leftValue = left[id]
    const rightValue = right[id]
    if (leftValue == null) continue
    if (rightValue == null || leftValue.kind !== rightValue.kind) continue
    result[id] = joinValues(leftValue, rightValue)
  }
  return result
}

function joinValues(left: AbstractValue, right: AbstractValue): AbstractValue {
  if (left.kind !== right.kind) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'object': return joinObjects(left, right as AbstractObject)
  }
}

function joinNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return {
    kind: 'number',
    lower: Math.min(left.lower, right.lower),
    upper: Math.max(left.upper, right.upper),
    integer: left.integer && right.integer,
    finite: left.finite && right.finite,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN,
  }
}

function joinBooleans(left: AbstractBoolean, right: AbstractBoolean): AbstractBoolean {
  return {
    kind: 'boolean',
    canBeTrue: left.canBeTrue || right.canBeTrue,
    canBeFalse: left.canBeFalse || right.canBeFalse,
  }
}

function joinObjects(left: AbstractObject, right: AbstractObject): AbstractObject {
  if (left.properties.length !== right.properties.length) throw new Error('Cannot join objects with different properties')
  const properties: AbstractObject['properties'] = []
  for (let index = 0; index < left.properties.length; index++) {
    const property = left.properties[index]!
    const other = right.properties[index]!
    if (property.name !== other.name) throw new Error('Cannot join objects with different properties')
    properties.push({
      name: property.name,
      value: joinValues(property.value, other.value),
    })
  }
  return {kind: 'object', properties}
}

function sameState(left: State, right: State): boolean {
  const length = Math.max(left.length, right.length)
  for (let id = 0; id < length; id++) {
    const value = left[id]
    const other = right[id]
    if (value == null || other == null) {
      if (value !== other) return false
    } else if (!sameValue(value, other)) return false
  }
  return true
}

function sameValue(left: AbstractValue, right: AbstractValue): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'number': {
      const number = right as AbstractNumber
      return left.lower === number.lower
        && left.upper === number.upper
        && left.integer === number.integer
        && left.finite === number.finite
        && left.mayBeNaN === number.mayBeNaN
    }
    case 'boolean': {
      const boolean = right as AbstractBoolean
      return left.canBeTrue === boolean.canBeTrue && left.canBeFalse === boolean.canBeFalse
    }
    case 'object': {
      const object = right as AbstractObject
      return left.properties.length === object.properties.length
        && left.properties.every((property, index) => {
          const other = object.properties[index]!
          return property.name === other.name && sameValue(property.value, other.value)
        })
    }
  }
}

function recordFiniteObligation(value: AbstractNumber, span: SourceSpan, obligations: Map<string, Obligation>): void {
  recordObligation(obligations, {
    kind: 'finite-result',
    status: value.finite && !value.mayBeNaN ? 'proved' : 'unknown',
    span,
    description: value.finite && !value.mayBeNaN ? 'The result is finite.' : 'The result may be NaN or infinite.',
  })
}

function recordObligation(obligations: Map<string, Obligation>, obligation: Obligation): void {
  const key = `${obligation.kind}:${obligation.span.file}:${obligation.span.start}`
  const previous = obligations.get(key)
  obligations.set(key, previous?.status === 'unknown' ? previous : obligation)
}

function requiredNumber(values: State, id: ValueID): AbstractNumber {
  const value = requiredValue(values, id)
  if (value.kind !== 'number') throw new Error(`IR value ${id} is not a number`)
  return value
}

function requiredBoolean(values: State, id: ValueID): AbstractBoolean {
  const value = requiredValue(values, id)
  if (value.kind !== 'boolean') throw new Error(`IR value ${id} is not a boolean`)
  return value
}

function requiredObject(values: State, id: ValueID): AbstractObject {
  const value = requiredValue(values, id)
  if (value.kind !== 'object') throw new Error(`IR value ${id} is not an object`)
  return value
}

function requiredValue(values: State, id: ValueID): AbstractValue {
  const value = values[id]
  if (value == null) throw new Error(`Missing IR value ${id}`)
  return value
}
