import type {ArithmeticOperator, ComparisonOperator} from '../ir/instructions.ts'
import {formatSite, type ParameterIR, type ProgramIR} from '../ir/program.ts'
import {numericParameterPath} from '../requirements/infer.ts'
import type {InferredPrecondition, NumericExpression} from '../requirements/model.ts'

export type PreconditionOperation = 'division' | 'remainder' | 'element read' | 'declared requirement'

export function formatPrecondition(precondition: InferredPrecondition, parameters: ParameterIR[], program: ProgramIR): string {
  const description = describePrecondition(precondition, parameters)
  const source = description.operation === 'declared requirement'
    ? 'declared at'
    : `${description.operation} at`
  return `${description.condition} (${source} ${formatSite(program, precondition.site)})`
}

// Project reports group propagated requirements at the operation that created them, so
// they need the condition and operation as separate fields instead of parsing prose.
export function describePrecondition(
  precondition: InferredPrecondition,
  parameters: ParameterIR[],
): {condition: string; operation: PreconditionOperation} {
  return {
    condition: conditionWords(precondition, parameters),
    operation: precondition.kind === 'inBounds'
      ? 'element read'
      : precondition.kind === 'declaredComparison' || precondition.kind === 'declaredNumberCheck'
        ? 'declared requirement'
        : precondition.operation,
  }
}

// The evidence wording for a requirement inferred before a stop — deliberately a different
// sentence shape from the requires line above, and it names the guarantee it enables.
export function formatObservedNeed(precondition: InferredPrecondition, parameters: ParameterIR[], program: ProgramIR): string {
  if (precondition.kind === 'declaredComparison' || precondition.kind === 'declaredNumberCheck') {
    return `the requirement declared at ${formatSite(program, precondition.site)} is ${conditionWords(precondition, parameters)}`
  }
  if (precondition.kind === 'inBounds') {
    return `the element read at ${formatSite(program, precondition.site)} hits an element only when ${conditionWords(precondition, parameters)}`
  }
  return `the ${precondition.operation} at ${formatSite(program, precondition.site)} gives a finite result only when ${conditionWords(precondition, parameters)}`
}

function conditionWords(precondition: InferredPrecondition, parameters: ParameterIR[]): string {
  switch (precondition.kind) {
    case 'nonzero':
      return `${formatExpression(precondition.expression, parameters)} is nonzero`
    // E.g. `width is not 4`: dividing by width - 4 is exactly a division by zero when
    // width is 4.
    case 'notEqualConstant':
      return `${formatExpression(precondition.expression, parameters)} is not ${precondition.value}`
    // E.g. `slot is a valid sizes index`: an integer from 0 through sizes.length - 1.
    case 'inBounds':
      return `${formatExpression(precondition.index, parameters)} is a valid ${formatExpression(precondition.sequence, parameters)} index`
    case 'declaredComparison':
      return `${formatExpression(precondition.left, parameters)} ${comparisonOperatorText(precondition.operator)} ${formatExpression(precondition.right, parameters)}`
    case 'declaredNumberCheck': {
      const predicate = precondition.predicate === 'integer'
        ? 'isInteger'
        : precondition.predicate === 'finite' ? 'isFinite' : 'isNaN'
      return `Number.${predicate}(${formatExpression(precondition.expression, parameters)})`
    }
  }
}

function formatExpression(expression: NumericExpression, parameters: ParameterIR[]): string {
  const path = numericParameterPath(expression)
  if (path != null) return formatParameterPath(parameters, path.parameter, path.properties)
  switch (expression.kind) {
    case 'parameter': throw new Error(`Missing parameter ${expression.index}`)
    case 'constant': return String(expression.value)
    case 'floor': return `Math.floor(${formatExpression(expression.operand, parameters)})`
    case 'property': return `${formatExpression(expression.base, parameters)}.${expression.name}`
    case 'binary': {
      return `(${formatExpression(expression.left, parameters)} ${operatorText(expression.operator)} ${formatExpression(expression.right, parameters)})`
    }
  }
}

function formatParameterPath(parameters: ParameterIR[], index: number, properties: string[]): string {
  const parameter = parameters[index]
  if (parameter == null) throw new Error(`Missing parameter ${index}`)
  const [first, ...rest] = properties
  if (first == null) return parameter.name
  const binding = parameter.bindings?.find(candidate => candidate.property === first)
  return binding == null
    ? `${parameter.name}.${properties.join('.')}`
    : [binding.local, ...rest].join('.')
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

function comparisonOperatorText(operator: ComparisonOperator): string {
  switch (operator) {
    case 'lessThan': return '<'
    case 'lessThanOrEqual': return '<='
    case 'greaterThan': return '>'
    case 'greaterThanOrEqual': return '>='
    case 'equal': return '==='
    case 'notEqual': return '!=='
  }
}
