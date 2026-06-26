import type {ArithmeticOperator} from '../ir/instructions.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'

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
