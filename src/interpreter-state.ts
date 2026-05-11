import {
  joinValues,
  unknown,
  valueWithAssumptions,
  type LinearConstraint,
  type Value,
} from './domain.ts'
import {mergeAssumptions} from './assumptions.ts'
import type {
  EvalContext,
  EvalFlow,
} from './check-types.ts'

export function functionDidNotReturnReason(context: EvalContext) {
  return `Function ${context.stack.at(-1) ?? '<unknown>'} did not return`
}

export function contextWithEnvAndAssumptions(context: EvalContext, env: Map<string, Value>, assumptions: LinearConstraint[]): EvalContext {
  return {
    ...context,
    env,
    assumptions: assumptions.length === 0 ? context.assumptions : mergeAssumptions(context.assumptions, assumptions),
  }
}

export function contextWithAssumptions(context: EvalContext, assumptions: LinearConstraint[]): EvalContext {
  return assumptions.length === 0 ? context : {...context, assumptions: mergeAssumptions(context.assumptions, assumptions)}
}

export function envWithAssumptions(env: Map<string, Value>, assumptions: LinearConstraint[]): Map<string, Value> {
  if (assumptions.length === 0) return env
  const next = new Map<string, Value>()
  for (const [name, value] of env) next.set(name, valueWithAssumptions(value, assumptions))
  return next
}

export function joinEnvironments(left: Map<string, Value>, right: Map<string, Value>): Map<string, Value> {
  const next = new Map<string, Value>()
  const keys = new Set([...left.keys(), ...right.keys()])
  for (const key of keys) {
    const leftValue = left.get(key)
    const rightValue = right.get(key)
    next.set(key, leftValue == null || rightValue == null ? unknown(`Local ${key} only exists on one branch`) : joinValues(leftValue, rightValue))
  }
  return next
}

export function isNonFallthroughFlow(flow: EvalFlow) {
  return flow.kind !== 'fallthrough'
}

export function joinNonFallthroughFlows(
  leftFlow: EvalFlow,
  leftAssumptions: LinearConstraint[],
  rightFlow: EvalFlow,
  rightAssumptions: LinearConstraint[],
  fallthroughReason: string,
): EvalFlow {
  const left = flowReturnValue(leftFlow, leftAssumptions, fallthroughReason)
  const right = flowReturnValue(rightFlow, rightAssumptions, fallthroughReason)
  if (left == null && right == null) return {kind: 'exit'}
  if (left == null) return {kind: 'return', value: right!}
  if (right == null) return {kind: 'return', value: left}
  return {kind: 'return', value: joinValues(left, right)}
}

function flowReturnValue(flow: EvalFlow, assumptions: LinearConstraint[], fallthroughReason: string): Value | null {
  if (flow.kind === 'exit') return null
  const value = flow.kind === 'return' ? flow.value : unknown(fallthroughReason)
  return valueWithAssumptions(value, assumptions)
}
