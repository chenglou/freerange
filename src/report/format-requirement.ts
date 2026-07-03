import type {ArithmeticOperator} from '../ir/instructions.ts'
import {siteLocation, type ProgramIR} from '../ir/program.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'

export function formatPrecondition(precondition: InferredPrecondition, parameterNames: string[], program: ProgramIR): string {
  const {line, column} = siteLocation(program, precondition.site)
  return `${formatExpression(precondition.expression, parameterNames)} is nonzero (division at ${program.file}:${line}:${column})`
}

// The evidence wording for a requirement inferred before a stop — deliberately a different
// sentence shape from the requires line above, and it names the guarantee it enables.
export function formatObservedNeed(precondition: InferredPrecondition, parameterNames: string[], program: ProgramIR): string {
  const {line, column} = siteLocation(program, precondition.site)
  return `the division at ${program.file}:${line}:${column} gives a finite result only when ${formatExpression(precondition.expression, parameterNames)} is nonzero`
}

function formatExpression(expression: NumericExpression, parameterNames: string[]): string {
  switch (expression.kind) {
    case 'parameter': {
      const name = parameterNames[expression.index]
      if (name == null) throw new Error(`Missing parameter ${expression.index}`)
      return name
    }
    case 'constant': return String(expression.value)
    case 'floor': return `Math.floor(${formatExpression(expression.operand, parameterNames)})`
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
