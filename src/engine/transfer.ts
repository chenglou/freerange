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
import {allocateObject, readProperty, writeProperty} from '../heap/operations.ts'
import type {FunctionID, ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import {siteLocation, type FunctionIR, type ProgramIR} from '../ir/program.ts'
import {
  addPrecondition,
  numericExpression,
  type ExpressionContext,
} from '../requirements/infer.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import type {CompleteFunctionEvaluation} from './outcome.ts'
import {cloneState, type ExecutionState, type SharedState} from './state.ts'

type EvaluateFunction = (
  functionID: FunctionID,
  arguments_: AbstractValue[],
  argumentExpressions: Array<NumericExpression | null>,
  sharedState: SharedState,
  callStack: FunctionID[],
) => CompleteFunctionEvaluation

export type TransferContext = {
  program: ProgramIR
  callStack: FunctionID[]
  expressionContext: ExpressionContext
  preconditions: InferredPrecondition[]
  evaluateFunction: EvaluateFunction
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
): AbstractValue {
  switch (instruction.kind) {
    case 'constant': return constantNumber(instruction.value)
    case 'object': return allocateObject(
      state.shared.heap,
      instruction.properties.map(property => ({
        name: property.name,
        value: requiredValue(state, property.value),
      })),
    )
    case 'property': return readProperty(
      state.shared.heap,
      requiredReference(state, instruction.object),
      instruction.property,
    )
    case 'store': {
      const assigned = requiredValue(state, instruction.value)
      writeProperty(
        state.shared.heap,
        requiredReference(state, instruction.object),
        instruction.property,
        assigned,
      )
      return assigned
    }
    case 'compare': return compareNumbers(
      requiredNumber(state, instruction.left),
      requiredNumber(state, instruction.right),
      instruction.operator,
    )
    case 'floor': return floorNumber(requiredNumber(state, instruction.value))
    case 'minimum': return minimumNumbers(instruction.values.map(value => requiredNumber(state, value)))
    case 'maximum': return maximumNumbers(instruction.values.map(value => requiredNumber(state, value)))
    case 'call': {
      const callee = context.program.functions[instruction.function]
      if (callee == null) throw new Error(`Unknown function ${instruction.function}`)
      const arguments_ = instruction.arguments.map(value => requiredValue(state, value))
      const argumentExpressions = instruction.arguments.map(value => numericExpression(value, context.expressionContext))
      const evaluation = context.evaluateFunction(
        instruction.function,
        arguments_,
        argumentExpressions,
        state.shared,
        context.callStack,
      )
      state.shared = evaluation.sharedState
      for (const precondition of evaluation.preconditions) addPrecondition(context.preconditions, precondition)
      return evaluation.returnValue
    }
    case 'binary': {
      const left = requiredNumber(state, instruction.left)
      const right = requiredNumber(state, instruction.right)
      if (instruction.operator === 'divide' && includesZero(right)) {
        const expression = numericExpression(instruction.right, context.expressionContext)
        if (expression == null) {
          const {line, column} = siteLocation(context.program, instruction.site)
          throw new Error(`Cannot infer a nonzero precondition for the division at ${context.program.file}:${line}:${column}`)
        }
        addPrecondition(context.preconditions, {kind: 'nonzero', expression, site: instruction.site})
      }
      return evaluateBinary(instruction.operator, left, right)
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
