import {
  addNumbers,
  constantNumber,
  divideNumbers,
  floorNumber,
  includesZero,
  maximumNumbers,
  minimumNumbers,
  multiplyNumbers,
  subtractNumbers,
  type AbstractNumber,
} from '../domain/number.ts'
import type {AbstractBoolean, AbstractReference, AbstractValue} from '../domain/value.ts'
import type {AllocationContext} from '../heap/model.ts'
import {adoptCalleeHeap, allocateAtSite, readProperty, writeProperty} from '../heap/operations.ts'
import type {FunctionID, ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import type {FunctionIR, ProgramIR} from '../ir/program.ts'
import {
  addPrecondition,
  numericExpression,
  type ExpressionContext,
} from '../requirements/infer.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import {completedEvaluation, type FunctionEvaluation, type Stop} from './outcome.ts'
import {cloneState, type ExecutionState, type SharedState} from './state.ts'

type EvaluateFunction = (
  functionID: FunctionID,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  callStack: FunctionID[],
  context: AllocationContext,
) => FunctionEvaluation

export type TransferContext = {
  program: ProgramIR
  callStack: FunctionID[]
  expressionContext: ExpressionContext
  preconditions: InferredPrecondition[]
  // The call site that entered the function being evaluated; allocations inside it are
  // distinguished by this context.
  allocationContext: AllocationContext
  evaluateFunction: EvaluateFunction
}

// One instruction either produces a value or stops the current path.
export type StepResult =
  | {kind: 'value'; value: AbstractValue}
  | {kind: 'stop'; stop: Stop}

function value(result: AbstractValue): StepResult {
  return {kind: 'value', value: result}
}

export function collectComparisons(
  fn: FunctionIR,
): Array<Extract<InstructionIR, {kind: 'compare'}> | undefined> {
  const comparisons: Array<Extract<InstructionIR, {kind: 'compare'}> | undefined> = []
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind === 'compare') comparisons[instruction.result] = instruction
    }
  }
  return comparisons
}

export function evaluateInstruction(
  instruction: InstructionIR,
  state: ExecutionState,
  context: TransferContext,
): StepResult {
  switch (instruction.kind) {
    case 'constant': return value(constantNumber(instruction.value))
    case 'object': return value(allocateAtSite(
      state.frame.values,
      state.shared.heap,
      instruction.site,
      context.allocationContext,
      instruction.properties.map(property => ({
        name: property.name,
        value: requiredValue(state, property.value),
      })),
    ))
    case 'property': return value(readProperty(
      state.shared.heap,
      requiredReference(state, instruction.object),
      instruction.property,
    ))
    case 'store': {
      const assigned = requiredValue(state, instruction.value)
      writeProperty(
        state.shared.heap,
        requiredReference(state, instruction.object),
        instruction.property,
        assigned,
      )
      return value(assigned)
    }
    case 'compare': return value(compareNumbers(
      requiredNumber(state, instruction.left),
      requiredNumber(state, instruction.right),
      instruction.operator,
    ))
    case 'floor': return value(floorNumber(requiredNumber(state, instruction.value)))
    case 'minimum': return value(minimumNumbers(instruction.values.map(id => requiredNumber(state, id))))
    case 'maximum': return value(maximumNumbers(instruction.values.map(id => requiredNumber(state, id))))
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
        instruction.site,
      )
      // A partial callee's result is discarded wholesale: the callee ran on a clone, and
      // state.shared is assigned only on the complete path below, so a partial callee's
      // prefix mutations cannot become this caller's state.
      const completed = completedEvaluation(evaluation)
      if (completed == null) {
        return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'calleeStopped', callee: instruction.function}}}
      }
      state.shared = completed.sharedState
      adoptCalleeHeap(state.frame.values, state.shared.heap)
      for (const precondition of completed.preconditions) addPrecondition(context.preconditions, precondition)
      return value(completed.returnValue)
    }
    case 'binary': {
      const left = requiredNumber(state, instruction.left)
      const right = requiredNumber(state, instruction.right)
      if (instruction.operator === 'divide' && includesZero(right)) {
        const expression = numericExpression(instruction.right, context.expressionContext)
        if (expression == null) {
          return {kind: 'stop', stop: {site: instruction.site, reason: {kind: 'divisorUnknown'}}}
        }
        addPrecondition(context.preconditions, {kind: 'nonzero', expression, site: instruction.site})
      }
      return value(evaluateBinary(instruction.operator, left, right))
    }
  }
}

export function refineComparison(
  state: ExecutionState,
  comparison: Extract<InstructionIR, {kind: 'compare'}>,
  truth: boolean,
): ExecutionState | null {
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
  result.frame.values[comparison.left] = refinedLeft
  result.frame.values[comparison.right] = refinedRight
  return result
}

export function requiredNumber(state: ExecutionState, id: ValueID): AbstractNumber {
  const value = requiredValue(state, id)
  if (value.kind !== 'number') throw new Error(`IR value ${id} is not a number`)
  return value
}

export function requiredBoolean(state: ExecutionState, id: ValueID): AbstractBoolean {
  const value = requiredValue(state, id)
  if (value.kind !== 'boolean') throw new Error(`IR value ${id} is not a boolean`)
  return value
}

export function requiredReference(state: ExecutionState, id: ValueID): AbstractReference {
  const value = requiredValue(state, id)
  if (value.kind !== 'reference') throw new Error(`IR value ${id} is not an object reference`)
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
