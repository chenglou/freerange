import type {ArithmeticOperator} from '../ir/instructions.ts'
import {formatSite, type ProgramIR} from '../ir/program.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'

export type PreconditionOperation = 'division' | 'remainder' | 'element read'

export function formatPrecondition(precondition: InferredPrecondition, parameterNames: string[], program: ProgramIR): string {
  const description = describePrecondition(precondition, parameterNames)
  return `${description.condition} (${description.operation} at ${formatSite(program, precondition.site)})`
}

// Project reports group propagated requirements at the operation that created them, so
// they need the condition and operation as separate fields instead of parsing prose.
export function describePrecondition(
  precondition: InferredPrecondition,
  parameterNames: string[],
): {condition: string; operation: PreconditionOperation} {
  return {
    condition: conditionWords(precondition, parameterNames),
    operation: precondition.kind === 'inBounds' ? 'element read' : precondition.operation,
  }
}

// The evidence wording for a requirement inferred before a stop — deliberately a different
// sentence shape from the requires line above, and it names the guarantee it enables.
export function formatObservedNeed(precondition: InferredPrecondition, parameterNames: string[], program: ProgramIR): string {
  if (precondition.kind === 'inBounds') {
    return `the element read at ${formatSite(program, precondition.site)} hits an element only when ${conditionWords(precondition, parameterNames)}`
  }
  return `the ${precondition.operation} at ${formatSite(program, precondition.site)} gives a finite result only when ${conditionWords(precondition, parameterNames)}`
}

function conditionWords(precondition: InferredPrecondition, parameterNames: string[]): string {
  switch (precondition.kind) {
    case 'nonzero':
      return `${formatExpression(precondition.expression, parameterNames)} is nonzero`
    // E.g. `width is not 4`: dividing by width - 4 is exactly a division by zero when
    // width is 4.
    case 'notEqualConstant':
      return `${formatExpression(precondition.expression, parameterNames)} is not ${precondition.value}`
    // E.g. `slot is a valid sizes index`: an integer from 0 through sizes.length - 1.
    case 'inBounds':
      return `${formatExpression(precondition.index, parameterNames)} is a valid ${formatExpression(precondition.sequence, parameterNames)} index`
  }
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
    case 'remainder': return '%'
  }
}
