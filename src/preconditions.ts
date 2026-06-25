import type {ArithmeticOperator, FunctionIR, InstructionIR, ValueID} from './ir.ts'

export type NumericExpression =
  | {kind: 'parameter'; index: number}
  | {kind: 'constant'; value: number}
  | {kind: 'binary'; operator: ArithmeticOperator; left: NumericExpression; right: NumericExpression}

export type InferredPrecondition = {
  kind: 'nonzero'
  expression: NumericExpression
}

export type ExpressionContext = {
  parameterExpressions: Array<NumericExpression | null>
  parameterIndexByValue: Array<number | undefined>
  instructionByValue: Array<InstructionIR | undefined>
}

export function createExpressionContext(
  fn: FunctionIR,
  parameterExpressions: Array<NumericExpression | null>,
): ExpressionContext {
  const context: ExpressionContext = {
    parameterExpressions,
    parameterIndexByValue: [],
    instructionByValue: [],
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    context.parameterIndexByValue[fn.parameters[index]!.value] = index
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) context.instructionByValue[instruction.result] = instruction
  }
  return context
}

export function numericExpression(value: ValueID, context: ExpressionContext): NumericExpression | null {
  const parameterIndex = context.parameterIndexByValue[value]
  if (parameterIndex != null) return context.parameterExpressions[parameterIndex] ?? null
  const instruction = context.instructionByValue[value]
  if (instruction == null) return null
  switch (instruction.kind) {
    case 'constant': return {kind: 'constant', value: instruction.value}
    case 'binary': {
      const left = numericExpression(instruction.left, context)
      const right = numericExpression(instruction.right, context)
      return left == null || right == null
        ? null
        : {kind: 'binary', operator: instruction.operator, left, right}
    }
    case 'store': return numericExpression(instruction.value, context)
    case 'call':
    case 'compare':
    case 'floor':
    case 'maximum':
    case 'minimum':
    case 'object':
    case 'property': return null
  }
}

export function addPrecondition(preconditions: InferredPrecondition[], candidate: InferredPrecondition): void {
  if (!preconditions.some(precondition => samePrecondition(precondition, candidate))) preconditions.push(candidate)
}

export function formatPrecondition(precondition: InferredPrecondition, parameterNames: string[]): string {
  return `${formatExpression(precondition.expression, parameterNames)} is nonzero`
}

function formatExpression(expression: NumericExpression, parameterNames: string[]): string {
  switch (expression.kind) {
    case 'parameter': {
      const name = parameterNames[expression.index]
      if (name == null) throw new Error(`Missing parameter ${expression.index}`)
      return name
    }
    case 'constant': return String(expression.value)
    case 'binary': {
      return `(${formatExpression(expression.left, parameterNames)} ${operatorText(expression.operator)} ${formatExpression(expression.right, parameterNames)})`
    }
  }
}

function operatorText(operator: ArithmeticOperator): string {
  switch (operator) {
    case 'add': return '+'
    case 'subtract': return '-'
    case 'multiply': return '*'
    case 'divide': return '/'
  }
}

function samePrecondition(left: InferredPrecondition, right: InferredPrecondition): boolean {
  return sameExpression(left.expression, right.expression)
}

function sameExpression(left: NumericExpression, right: NumericExpression): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'parameter': return left.index === (right as Extract<NumericExpression, {kind: 'parameter'}>).index
    case 'constant': return left.value === (right as Extract<NumericExpression, {kind: 'constant'}>).value
    case 'binary': {
      const other = right as Extract<NumericExpression, {kind: 'binary'}>
      return left.operator === other.operator
        && sameExpression(left.left, other.left)
        && sameExpression(left.right, other.right)
    }
  }
}
