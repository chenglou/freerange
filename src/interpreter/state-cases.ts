import {
  joinFrameEnvs,
  type InterpreterFrame,
  type InterpreterStateCase,
} from './context.ts'
import {
  valueWithAssumptions,
  type LinearConstraint,
  type Value,
} from '../domain.ts'
import {linearKey} from '../linear.ts'
import {assumptionsAreReachable} from '../constraint-reachability.ts'

export const maxStateCases = 8

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
    audits: parent.audits,
    stack: parent.stack,
    activeCalls: new Set(parent.activeCalls),
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

export function setStateCases(frame: InterpreterFrame, cases: InterpreterStateCase[]) {
  const bounded = boundStateCases(cases)
  frame.env = joinStateCaseEnvs(bounded)
  frame.assumptions = sharedStateCaseAssumptions(bounded)
  if (bounded.length <= 1) {
    delete frame.stateCases
    if (bounded[0] != null) {
      frame.env = new Map(bounded[0].env)
      frame.assumptions = [...bounded[0].assumptions]
    }
    return
  }
  frame.stateCases = bounded
}

export function adoptJoinedState(frame: InterpreterFrame, cases: InterpreterStateCase[]) {
  const bounded = boundStateCases(cases)
  frame.env = joinStateCaseEnvs(bounded)
  frame.assumptions = sharedStateCaseAssumptions(bounded)
  delete frame.stateCases
}

export function boundStateCases(cases: InterpreterStateCase[]): InterpreterStateCase[] {
  const next = reachableStateCases(cases)
  if (next.length <= maxStateCases) return next
  return [{
    env: joinStateCaseEnvs(next),
    assumptions: sharedStateCaseAssumptions(next),
    label: '<merged>',
  }]
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

function stateCaseIsReachable(stateCase: InterpreterStateCase) {
  return assumptionsAreReachable(stateCase.assumptions)
}

function sameAssumptionKey(left: LinearConstraint, right: LinearConstraint) {
  return left.op === right.op
    && (left.text ?? null) === (right.text ?? null)
    && (left.leftExpr ?? null) === (right.leftExpr ?? null)
    && (left.rightExpr ?? null) === (right.rightExpr ?? null)
    && left.source === right.source
    && left.rangeFact === right.rangeFact
    && left.integerStrict === right.integerStrict
    && (left.diff == null ? null : linearKey(left.diff)) === (right.diff == null ? null : linearKey(right.diff))
}
