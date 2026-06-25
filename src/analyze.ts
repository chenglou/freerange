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
  type AbstractObject,
  type AbstractReference,
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
  ValueTypeIR,
} from './ir.ts'

type State = {
  values: Array<AbstractValue | undefined>
  heap: AbstractHeap
}

export type Obligation = {
  kind: 'nonzero-divisor' | 'finite-result' | 'finite-argument'
  status: 'proved' | 'unknown'
  span: SourceSpan
  description: string
}

export type FunctionAnalysis = {
  name: string
  parameters: Array<{name: string; type: ValueTypeIR}>
  returnValue: AbstractValue
  heap: AbstractHeap
  obligations: Obligation[]
}

export type ProgramAnalysis = {
  file: string
  functions: FunctionAnalysis[]
}

type FunctionEvaluation = {
  returnValue: AbstractValue
  heap: AbstractHeap
  obligations: Obligation[]
}

export function analyzeProgram(program: ProgramIR): ProgramAnalysis {
  const functions: FunctionAnalysis[] = []
  for (let functionID = 0; functionID < program.functions.length; functionID++) {
    const fn = program.functions[functionID]!
    const arguments_: AbstractValue[] = []
    const heap: AbstractHeap = []
    const parameters: FunctionAnalysis['parameters'] = []
    for (const parameter of fn.parameters) {
      parameters.push({name: parameter.name, type: parameter.type})
      switch (parameter.type.kind) {
        case 'number': arguments_.push(finiteInputNumber()); break
        case 'object': {
          const allocation = heap.length
          heap.push({
            properties: parameter.type.properties.map(name => ({name, value: finiteInputNumber()})),
          })
          arguments_.push({kind: 'reference', allocation})
          break
        }
      }
    }
    const evaluation = evaluateFunction(functionID, arguments_, heap, program.functions, [])
    functions.push({
      name: fn.name,
      parameters,
      returnValue: evaluation.returnValue,
      heap: evaluation.heap,
      obligations: evaluation.obligations,
    })
  }
  return {file: program.file, functions}
}

function evaluateFunction(
  functionID: FunctionID,
  arguments_: AbstractValue[],
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
  const initial: State = {values: [], heap: cloneHeap(heap)}
  for (let index = 0; index < fn.parameters.length; index++) {
    initial.values[fn.parameters[index]!.value] = arguments_[index]!
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
        obligationMap,
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
      case 'branch': {
        const condition = requiredBoolean(state, block.terminator.condition)
        const comparison = comparisons[block.terminator.condition]
        if (condition.canBeTrue) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, true)
          if (branch != null) propagate(branch, block.terminator.whenTrue, incoming, queue)
        }
        if (condition.canBeFalse) {
          const branch = comparison == null ? cloneState(state) : refineComparison(state, comparison, false)
          if (branch != null) propagate(branch, block.terminator.whenFalse, incoming, queue)
        }
        break
      }
    }
  }
  if (returnValue == null || returnHeap == null) throw new Error(`Function ${fn.name} has no reachable return`)
  return {returnValue, heap: returnHeap, obligations: [...obligationMap.values()]}
}

function evaluateInstruction(
  instruction: InstructionIR,
  state: State,
  obligations: Map<string, Obligation>,
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
      const result = floorNumber(requiredNumber(state, instruction.value))
      recordFiniteObligation(result, instruction.span, obligations)
      return result
    }
    case 'minimum': return minimumNumbers(instruction.values.map(value => requiredNumber(state, value)))
    case 'maximum': return maximumNumbers(instruction.values.map(value => requiredNumber(state, value)))
    case 'call': {
      const callee = functions[instruction.function]
      if (callee == null) throw new Error(`Unknown function ${instruction.function}`)
      const arguments_ = instruction.arguments.map(value => requiredValue(state, value))
      for (let index = 0; index < arguments_.length; index++) {
        const argument = arguments_[index]!
        if (argument.kind !== 'number') continue
        recordObligation(obligations, {
          kind: 'finite-argument',
          status: argument.finite && !argument.mayBeNaN ? 'proved' : 'unknown',
          span: instruction.span,
          description: argument.finite && !argument.mayBeNaN
            ? `Argument ${index + 1} to ${callee.name} is finite.`
            : `Argument ${index + 1} to ${callee.name} may be NaN or infinite.`,
        })
      }
      const evaluation = evaluateFunction(instruction.function, arguments_, state.heap, functions, callStack)
      state.heap = evaluation.heap
      for (const obligation of evaluation.obligations) recordObligation(obligations, obligation)
      return evaluation.returnValue
    }
    case 'binary': {
      const left = requiredNumber(state, instruction.left)
      const right = requiredNumber(state, instruction.right)
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
  const values: State['values'] = []
  for (let id = 0; id < left.values.length; id++) {
    const leftValue = left.values[id]
    const rightValue = right.values[id]
    if (leftValue == null) continue
    if (rightValue == null || leftValue.kind !== rightValue.kind) continue
    values[id] = joinValues(leftValue, rightValue)
  }
  return {values, heap: joinHeaps(left.heap, right.heap)}
}

function joinValues(left: AbstractValue, right: AbstractValue): AbstractValue {
  if (left.kind !== right.kind) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'reference': return joinReferences(left, right as AbstractReference)
    case 'void': return left
  }
}

function joinReferences(left: AbstractReference, right: AbstractReference): AbstractReference {
  if (left.allocation !== right.allocation) throw new Error('Joining different object allocations is unsupported')
  return left
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
  return {properties}
}

function sameState(left: State, right: State): boolean {
  const length = Math.max(left.values.length, right.values.length)
  for (let id = 0; id < length; id++) {
    const value = left.values[id]
    const other = right.values[id]
    if (value == null || other == null) {
      if (value !== other) return false
    } else if (!sameValue(value, other)) return false
  }
  return sameHeap(left.heap, right.heap)
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
    case 'reference': return left.allocation === (right as AbstractReference).allocation
    case 'void': return true
  }
}

function cloneState(state: State): State {
  return {values: state.values.slice(), heap: cloneHeap(state.heap)}
}

function cloneHeap(heap: AbstractHeap): AbstractHeap {
  return heap.map(object => ({
    properties: object.properties.map(property => ({...property})),
  }))
}

function joinHeaps(left: AbstractHeap, right: AbstractHeap): AbstractHeap {
  const heap: AbstractHeap = []
  const length = Math.max(left.length, right.length)
  for (let allocation = 0; allocation < length; allocation++) {
    const leftObject = left[allocation]
    const rightObject = right[allocation]
    if (leftObject == null) heap.push(cloneObject(rightObject!))
    else if (rightObject == null) heap.push(cloneObject(leftObject))
    else heap.push(joinObjects(leftObject, rightObject))
  }
  return heap
}

function sameHeap(left: AbstractHeap, right: AbstractHeap): boolean {
  if (left.length !== right.length) return false
  return left.every((object, index) => sameObject(object, right[index]!))
}

function sameObject(left: AbstractObject, right: AbstractObject): boolean {
  return left.properties.length === right.properties.length
    && left.properties.every((property, index) => {
      const other = right.properties[index]!
      return property.name === other.name && sameValue(property.value, other.value)
    })
}

function cloneObject(object: AbstractObject): AbstractObject {
  return {properties: object.properties.map(property => ({...property}))}
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
