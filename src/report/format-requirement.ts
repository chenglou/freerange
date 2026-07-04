import type {ArithmeticOperator} from '../ir/instructions.ts'
import {formatSite, type ProgramIR} from '../ir/program.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'

// When InferredPrecondition grows a second kind (the docs anticipate range requirements
// like columnCount >= 1), both formatters must become switches on precondition.kind so the
// new variant cannot silently borrow the nonzero wording — the lint forbids the switch
// while the union has one member.
export function formatPrecondition(precondition: InferredPrecondition, parameterNames: string[], program: ProgramIR): string {
  return `${formatExpression(precondition.expression, parameterNames)} is nonzero (division at ${formatSite(program, precondition.site)})`
}

// The evidence wording for a requirement inferred before a stop — deliberately a different
// sentence shape from the requires line above, and it names the guarantee it enables.
export function formatObservedNeed(precondition: InferredPrecondition, parameterNames: string[], program: ProgramIR): string {
  return `the division at ${formatSite(program, precondition.site)} gives a finite result only when ${formatExpression(precondition.expression, parameterNames)} is nonzero`
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
    case 'property': return `${formatExpression(expression.base, parameterNames)}.${expression.name}`
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
