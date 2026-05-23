import {
  joinFrameEnvs,
  type InterpreterFrame,
  type InterpreterReturnCase,
  type InterpreterStateCase,
} from './context.ts'
import {
  maxNumberCases,
  numberBranches,
  unknown,
  valueWithAssumptions,
  type LinearConstraint,
  type NumberCase,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {linearKey} from '../linear.ts'
import {mergeAssumptions} from '../assumptions.ts'
import {assumptionsAreReachable} from '../constraint-reachability.ts'

export const maxStateCases = 8

export function combineNumberCases(
  left: NumberValue,
  right: NumberValue,
  evaluate: (left: NumberValue, right: NumberValue) => Value,
): NumberCase[] | null {
  if (left.cases == null && right.cases == null) return null
  const cases: NumberCase[] = []
  for (const leftCase of numberBranches(left)) {
    for (const rightCase of numberBranches(right)) {
      const value = evaluate(leftCase.value, rightCase.value)
      if (value.kind !== 'number') return null
      const assumptions = mergeAssumptions(leftCase.assumptions, rightCase.assumptions)
      if (!assumptionsAreReachable(assumptions)) continue
      cases.push({
        value,
        assumptions,
      })
      if (cases.length > maxNumberCases) return null
    }
  }
  return cases
}

export type StateCaseSetResult =
  | {kind: 'ok'}
  | {kind: 'overflow'; count: number; limit: number}

export function hasStateCases(frame: InterpreterFrame) {
  return frame.stateCases != null && frame.stateCases.length > 0
}

export function consumeStateCases(frame: InterpreterFrame): InterpreterStateCase[] {
  const cases = frame.stateCases ?? [snapshotStateCase(frame)]
  delete frame.stateCases
  return cases
}

export function stateCasesFromFrame(frame: InterpreterFrame): InterpreterStateCase[] {
  return frame.stateCases ?? [snapshotStateCase(frame)]
}

export function frameForStateCase(parent: InterpreterFrame, stateCase: InterpreterStateCase): InterpreterFrame {
  return {
    program: parent.program,
    env: new Map(stateCase.env),
    issues: parent.issues,
    effects: parent.effects,
    audits: parent.audits,
    stack: parent.stack,
    activeCalls: new Set(parent.activeCalls),
    localBindings: new Set(parent.localBindings),
    loopStack: [...parent.loopStack],
    conditionalDepth: parent.conditionalDepth,
    assumptions: [...stateCase.assumptions],
    ...(parent.hooks == null ? {} : {hooks: parent.hooks}),
    ...(parent.objectPath == null ? {} : {objectPath: [...parent.objectPath]}),
  }
}

export function snapshotStateCase(frame: InterpreterFrame, label?: string): InterpreterStateCase {
  return {
    env: new Map(frame.env),
    assumptions: [...frame.assumptions],
    ...(label == null ? {} : {label}),
  }
}

export function setStateCases(frame: InterpreterFrame, cases: InterpreterStateCase[]): StateCaseSetResult {
  const reachable = reachableStateCases(cases)
  const budget = stateCaseBudget(reachable)
  if (budget.kind === 'overflow') {
    applyOverBudgetStateSummary(frame, reachable, stateCaseBudgetMessage(budget.count, budget.limit))
    return budget
  }
  frame.env = joinStateCaseEnvs(reachable)
  frame.assumptions = sharedStateCaseAssumptions(reachable)
  if (reachable.length <= 1) {
    delete frame.stateCases
    if (reachable[0] != null) {
      frame.env = new Map(reachable[0].env)
      frame.assumptions = [...reachable[0].assumptions]
    }
    return {kind: 'ok'}
  }
  frame.stateCases = reachable
  return {kind: 'ok'}
}

export function adoptJoinedState(frame: InterpreterFrame, cases: InterpreterStateCase[]): StateCaseSetResult {
  const reachable = reachableStateCases(cases)
  const budget = stateCaseBudget(reachable)
  if (budget.kind === 'overflow') {
    applyOverBudgetStateSummary(frame, reachable, stateCaseBudgetMessage(budget.count, budget.limit))
    return budget
  }
  frame.env = joinStateCaseEnvs(reachable)
  frame.assumptions = sharedStateCaseAssumptions(reachable)
  delete frame.stateCases
  return {kind: 'ok'}
}

export function stateCaseBudget(cases: InterpreterStateCase[]): StateCaseSetResult {
  return cases.length <= maxStateCases ? {kind: 'ok'} : {kind: 'overflow', count: cases.length, limit: maxStateCases}
}

export function stateCaseBudgetMessage(count: number, limit: number) {
  return `State partition budget exceeded: ${count} branch states exceed limit ${limit}; Freerange refuses to summarize branch states silently`
}

export function summarizeOverBudgetReturnCases(cases: InterpreterReturnCase[], reason: string): InterpreterReturnCase {
  const state = overBudgetStateSummary(cases, reason)
  return {
    ...state,
    value: stableCaseValue(cases.map(stateCase => stateCase.value), reason, 'return'),
  }
}

export function reachableStateCases<T extends InterpreterStateCase>(cases: T[]): T[] {
  const reachable = cases.filter(stateCaseIsReachable)
  return reachable.length === 0 ? cases : reachable
}

export function joinStateCaseEnvs(cases: InterpreterStateCase[]): Map<string, Value> {
  const first = cases[0]
  if (first == null) return new Map()
  let joined = envWithAssumptions(first.env, first.assumptions)
  for (const stateCase of cases.slice(1)) {
    joined = joinFrameEnvs(joined, envWithAssumptions(stateCase.env, stateCase.assumptions))
  }
  return joined
}

export function sharedStateCaseAssumptions(cases: InterpreterStateCase[]): LinearConstraint[] {
  const [first, ...rest] = cases
  if (first == null) return []
  return first.assumptions.filter(assumption => rest.every(stateCase => stateCase.assumptions.some(item => sameAssumptionKey(item, assumption))))
}

export function envWithAssumptions(env: Map<string, Value>, assumptions: LinearConstraint[]): Map<string, Value> {
  const next = new Map<string, Value>()
  for (const [name, value] of env) next.set(name, valueWithAssumptions(value, assumptions))
  return next
}

function applyOverBudgetStateSummary(frame: InterpreterFrame, cases: InterpreterStateCase[], reason: string) {
  const summary = overBudgetStateSummary(cases, reason)
  frame.env = summary.env
  frame.assumptions = summary.assumptions
  delete frame.stateCases
}

function overBudgetStateSummary(cases: InterpreterStateCase[], reason: string): InterpreterStateCase {
  const names = new Set(cases.flatMap(stateCase => [...stateCase.env.keys()]))
  const env = new Map<string, Value>()
  for (const name of names) env.set(name, stableCaseValue(cases.map(stateCase => stateCase.env.get(name)), reason, name))
  return {
    env,
    assumptions: sharedStateCaseAssumptions(cases),
  }
}

function stableCaseValue(values: (Value | undefined)[], reason: string, name: string): Value {
  const first = values[0]
  const fingerprint = first == null ? null : valueFingerprint(first)
  if (first != null && values.every(value => value != null && valueFingerprint(value) === fingerprint)) return first
  if (name === 'return') return unknown(reason)
  return unknown(`${name} changed across over-budget branch states: ${reason}`)
}

function valueFingerprint(value: Value): string {
  switch (value.kind) {
    case 'number':
      return JSON.stringify({
        kind: value.kind,
        min: value.min,
        max: value.max,
        isInteger: value.isInteger,
        expr: value.expr,
        linear: value.linear == null ? null : linearKey(value.linear),
        cases: value.cases?.map(stateCase => ({
          value: valueFingerprint(stateCase.value),
          assumptions: stateCase.assumptions.map(assumptionFingerprint).sort(),
        })) ?? null,
        origin: [...value.origin].sort(),
      })
    case 'literal':
      return JSON.stringify({
        kind: value.kind,
        values: value.values,
        expr: value.expr,
        origin: [...value.origin].sort(),
      })
    case 'object':
      return JSON.stringify({
        kind: value.kind,
        expr: value.expr,
        props: [...value.props.entries()]
          .map(([name, prop]) => [name, valueFingerprint(prop)])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      })
    case 'array':
      return JSON.stringify({
        kind: value.kind,
        layout: value.layout,
        length: valueFingerprint(value.length),
        elements: value.elements?.map(valueFingerprint) ?? null,
        element: value.element == null ? null : valueFingerprint(value.element),
        expr: value.expr,
        summary: summaryFingerprint(value.summary),
      })
    case 'null':
      return JSON.stringify({kind: value.kind, expr: value.expr})
    case 'nullable':
      return JSON.stringify({
        kind: value.kind,
        present: valueFingerprint(value.present),
        absent: value.absent,
        expr: value.expr,
      })
    case 'unknown':
      return JSON.stringify({kind: value.kind, reason: value.reason})
  }
}

function summaryFingerprint(summary: Extract<Value, {kind: 'array'}>['summary']): unknown {
  if (summary == null) return null
  return {
    ...summary,
    advances: summary.advances.map(item => ({...item, value: valueFingerprint(item.value)})),
    lastEnd: summary.lastEnd == null ? null : valueFingerprint(summary.lastEnd),
    extentEnds: summary.extentEnds.map(item => ({...item, value: valueFingerprint(item.value)})),
  }
}

function assumptionFingerprint(assumption: LinearConstraint) {
  return JSON.stringify({
    op: assumption.op,
    text: assumption.text ?? null,
    leftExpr: assumption.leftExpr ?? null,
    rightExpr: assumption.rightExpr ?? null,
    source: assumption.source,
    fromRange: assumption.fromRange === true,
    integerStrict: assumption.integerStrict === true,
    diff: assumption.diff == null ? null : linearKey(assumption.diff),
  })
}

function stateCaseIsReachable(stateCase: InterpreterStateCase) {
  return assumptionsAreReachable(stateCase.assumptions)
}

function sameAssumptionKey(left: LinearConstraint, right: LinearConstraint) {
  return left.op === right.op
    && (left.text ?? null) === (right.text ?? null)
    && (left.leftExpr ?? null) === (right.leftExpr ?? null)
    && (left.rightExpr ?? null) === (right.rightExpr ?? null)
    && left.source === right.source
    && left.fromRange === right.fromRange
    && left.integerStrict === right.integerStrict
    && (left.diff == null ? null : linearKey(left.diff)) === (right.diff == null ? null : linearKey(right.diff))
}
