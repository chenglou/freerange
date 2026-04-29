import {
  type ArrayValue,
  type ObjectValue,
  type Value,
} from '../domain.ts'
import {formatExpectedRange} from '../reporting.ts'
import type {InterpreterIssue} from './context.ts'

export function formatInterpreterValue(value: Value, root = 'return'): string[] {
  return formatValue(value, root)
}

export function formatInterpreterIssues(issues: InterpreterIssue[]): string[] {
  return issues.map(issue => {
    const stack = issue.stack.length === 0 ? '<top-level>' : issue.stack.join(' > ')
    return `unsupported ${stack}: ${issue.message}`
  })
}

function formatValue(value: Value, path: string): string[] {
  switch (value.kind) {
    case 'number':
      return [`${path}: ${formatExpectedRange(value.min, value.max, value.isInteger)}`]
    case 'literal':
      return [`${path}: ${value.values.map(value => JSON.stringify(value)).join(' | ')}`]
    case 'null':
      return [`${path}: null`]
    case 'nullable':
      return [
        `${path}: nullable ${value.absent}`,
        ...formatValue(value.present, `${path}!`),
      ]
    case 'unknown':
      return [`${path}: unknown (${value.reason})`]
    case 'object':
      return formatObject(value, path)
    case 'array':
      return formatArray(value, path)
  }
}

function formatObject(value: ObjectValue, path: string): string[] {
  if (value.props.size === 0) return [`${path}: object`]
  return [...value.props.entries()].flatMap(([name, prop]) => formatValue(prop, `${path}.${name}`))
}

function formatArray(value: ArrayValue, path: string): string[] {
  const lines = formatValue(value.length, `${path}.length`)
  if (value.elements != null) {
    for (let index = 0; index < value.elements.length; index++) {
      lines.push(...formatValue(value.elements[index]!, `${path}[${index}]`))
    }
  }
  if (value.element != null) lines.push(...formatValue(value.element, `${path}[]`))
  return lines
}
