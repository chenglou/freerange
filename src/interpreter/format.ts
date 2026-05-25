import {
  tupleElements,
  type ArrayValue,
  type ObjectValue,
  type Value,
} from '../domain.ts'
import {factsFromValue, type FitInferFact} from '../facts.ts'
import {formatRange} from '../reporting.ts'
import type {InterpreterEffect, InterpreterIssue} from './context.ts'

export function formatInterpreterValue(value: Value, root = 'return'): string[] {
  return formatValue(value, root)
}

export function formatInterpreterFacts(value: Value, root = 'return'): string[] {
  return factsFromValue(root, value)
    .filter(interpreterSnapshotFact)
    .map(fact => `fact ${fact.text}`)
}

export function formatInterpreterIssues(issues: InterpreterIssue[]): string[] {
  return issues.map(issue => {
    const stack = issue.stack.length === 0 ? '<top-level>' : issue.stack.join(' > ')
    const location = issue.line == null ? '' : ` line ${issue.line}`
    return `unsupported ${stack}${location}: ${issue.message}`
  })
}

export function formatInterpreterEffects(effects: InterpreterEffect[]): string[] {
  return effects.map(effect => {
    const stack = effect.stack.length === 0 ? '<top-level>' : effect.stack.join(' > ')
    const location = effect.line == null ? '' : ` line ${effect.line}`
    return `effect ${stack}${location}: ${effect.message}`
  })
}

function formatValue(value: Value, path: string): string[] {
  switch (value.kind) {
    case 'number':
      return [`${path}: ${formatRange({...value, expr: null})}`]
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
  const elements = tupleElements(value)
  if (elements != null) {
    for (let index = 0; index < elements.length; index++) {
      lines.push(...formatValue(elements[index]!, `${path}[${index}]`))
    }
  }
  if (value.element != null) lines.push(...formatValue(value.element, `${path}[]`))
  return lines
}

function interpreterSnapshotFact(fact: FitInferFact): boolean {
  return fact.kind === 'origin'
}
