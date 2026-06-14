import {
  deriveFrame,
  joinFrameEnvs,
  type InterpreterFrame,
  type InterpreterReturnCase,
  type InterpreterStateCase,
} from './context.ts'
import {
  unknown,
  valueWithAssumptions,
  type Assumption,
  type BranchArm,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {linearKey} from '../linear.ts'
import {sharedAssumptions} from '../assumptions.ts'
import {
  branchesConflict,
  sharedBranchArms,
} from '../branch-context.ts'
import {assumptionsAreReachable} from '../proof.ts'
import {sequenceRelationKey} from '../sequence-relation.ts'

export const maxStateCases = 8

export type StateCaseSetResult =
  | {kind: 'ok'}
  | {kind: 'overflow'; count: number; limit: number}

export function hasStateCases(frame: InterpreterFrame) {
  return frame.stateCases != null
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
  const env = new Map<string, Value>()
  for (const [name, value] of stateCase.env) {
    env.set(
      name,
      stateCase.changedRoots.has(name)
        ? valueWithAssumptions(value, stateCase.caseAssumptions, stateCase.branches)
        : value,
    )
  }
  return deriveFrame(parent, {
    env,
    stateCases: null,
    assumptions: [...stateCase.assumptions],
    branches: [...stateCase.branches],
    caseAssumptions: [...stateCase.caseAssumptions],
    changedRoots: new Set(stateCase.changedRoots),
    partitioned: true,
    separateBranches: stateCase.separateBranches,
  })
}

export function snapshotStateCase(frame: InterpreterFrame, label?: string): InterpreterStateCase {
  return {
    env: new Map(frame.env),
    assumptions: [...frame.assumptions],
    branches: [...frame.branches],
    caseAssumptions: [...frame.caseAssumptions],
    changedRoots: new Set(frame.changedRoots),
    separateBranches: frame.separateBranches,
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
  frame.branches = sharedStateCaseBranches(reachable)
  frame.caseAssumptions = sharedStateCaseCaseAssumptions(reachable)
  frame.changedRoots = sharedChangedRoots(reachable)
  frame.separateBranches = reachable.some(stateCase => stateCase.separateBranches)
  if (reachable.length === 0) {
    frame.stateCases = []
    return {kind: 'ok'}
  }
  if (reachable.length <= 1) {
    delete frame.stateCases
    if (reachable[0] != null) {
      frame.env = new Map(reachable[0].env)
      frame.assumptions = [...reachable[0].assumptions]
      frame.branches = [...reachable[0].branches]
      frame.caseAssumptions = [...reachable[0].caseAssumptions]
      frame.changedRoots = new Set(reachable[0].changedRoots)
      frame.separateBranches = reachable[0].separateBranches
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
  frame.branches = sharedStateCaseBranches(reachable)
  frame.caseAssumptions = sharedStateCaseCaseAssumptions(reachable)
  frame.changedRoots = sharedChangedRoots(reachable)
  frame.separateBranches = reachable.some(stateCase => stateCase.separateBranches)
  if (reachable.length === 0) {
    frame.stateCases = []
    return {kind: 'ok'}
  }
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
  return cases.filter(stateCaseIsReachable)
}

export function joinStateCaseEnvs(cases: InterpreterStateCase[]): Map<string, Value> {
  const first = cases[0]
  if (first == null) return new Map()
  let joined = envWithCaseContext(first)
  for (const stateCase of cases.slice(1)) {
    joined = joinFrameEnvs(joined, envWithCaseContext(stateCase))
  }
  return joined
}

export function sharedStateCaseAssumptions(cases: InterpreterStateCase[]): Assumption[] {
  return sharedAssumptions(cases.map(stateCase => stateCase.assumptions))
}

export function envWithAssumptions(
  env: Map<string, Value>,
  assumptions: Assumption[],
  branches: BranchArm[] = [],
): Map<string, Value> {
  const next = new Map<string, Value>()
  for (const [name, value] of env) next.set(name, valueWithAssumptions(value, assumptions, branches))
  return next
}

function envWithCaseContext(stateCase: InterpreterStateCase): Map<string, Value> {
  const next = new Map<string, Value>()
  for (const [name, value] of stateCase.env) {
    next.set(
      name,
      stateCase.changedRoots.has(name)
        ? valueWithAssumptions(value, stateCase.caseAssumptions, stateCase.branches)
        : value,
    )
  }
  return next
}

function sharedStateCaseBranches(cases: InterpreterStateCase[]) {
  return sharedBranchArms(cases.map(stateCase => stateCase.branches))
}

function sharedStateCaseCaseAssumptions(cases: InterpreterStateCase[]) {
  return sharedAssumptions(cases.map(stateCase => stateCase.caseAssumptions))
}

function sharedChangedRoots(cases: InterpreterStateCase[]) {
  const [first, ...rest] = cases
  if (first == null) return new Set<string>()
  return new Set([...first.changedRoots].filter(root =>
    rest.every(stateCase => stateCase.changedRoots.has(root))))
}

function applyOverBudgetStateSummary(frame: InterpreterFrame, cases: InterpreterStateCase[], reason: string) {
  const summary = overBudgetStateSummary(cases, reason)
  frame.env = summary.env
  frame.assumptions = summary.assumptions
  frame.branches = summary.branches
  frame.caseAssumptions = summary.caseAssumptions
  frame.changedRoots = summary.changedRoots
  frame.separateBranches = summary.separateBranches
  delete frame.stateCases
}

function overBudgetStateSummary(cases: InterpreterStateCase[], reason: string): InterpreterStateCase {
  const names = new Set(cases.flatMap(stateCase => [...stateCase.env.keys()]))
  const env = new Map<string, Value>()
  for (const name of names) env.set(name, stableCaseValue(cases.map(stateCase => stateCase.env.get(name)), reason, name))
  return {
    env,
    assumptions: sharedStateCaseAssumptions(cases),
    branches: sharedStateCaseBranches(cases),
    caseAssumptions: sharedStateCaseCaseAssumptions(cases),
    changedRoots: sharedChangedRoots(cases),
    separateBranches: cases.some(stateCase => stateCase.separateBranches),
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
        grid: value.grid,
        neverNaN: value.neverNaN === true,
        expr: value.expr,
        linear: value.linear == null ? null : linearKey(value.linear),
        computation: computationFingerprint(value),
        cases: value.cases?.map(stateCase => ({
          value: valueFingerprint(stateCase.value),
          assumptions: stateCase.assumptions.map(assumptionFingerprint).sort(),
          branches: stateCase.branches,
        })) ?? null,
        caseLoss: value.caseLoss ?? null,
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
        referenceIds: [...value.referenceIds].sort((left, right) => left - right),
        expr: value.expr,
        props: [...value.props.entries()]
          .map(([name, prop]) => [name, valueFingerprint(prop)])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      })
    case 'array':
      return JSON.stringify({
        kind: value.kind,
        referenceIds: [...value.referenceIds].sort((left, right) => left - right),
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

function computationFingerprint(value: NumberValue): unknown {
  const computation = value.computation
  if (computation == null) return null
  return computation.kind === 'unary'
    ? {kind: computation.kind, op: computation.op, operand: valueFingerprint(computation.operand)}
    : {
        kind: computation.kind,
        op: computation.op,
        left: valueFingerprint(computation.left),
        right: valueFingerprint(computation.right),
      }
}

function summaryFingerprint(summary: Extract<Value, {kind: 'array'}>['summary']): unknown {
  if (summary == null) return null
  return {
    ...summary,
    relations: summary.relations.map(sequenceRelationKey).sort(),
    advances: summary.advances.map(item => ({...item, value: valueFingerprint(item.value)})),
    lastEnd: summary.lastEnd == null ? null : {
      ...summary.lastEnd,
      value: valueFingerprint(summary.lastEnd.value),
    },
    extentEnds: summary.extentEnds.map(item => ({...item, value: valueFingerprint(item.value)})),
  }
}

function assumptionFingerprint(assumption: Assumption) {
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
  return !branchesConflict(stateCase.branches)
    && assumptionsAreReachable(stateCase.assumptions)
}
