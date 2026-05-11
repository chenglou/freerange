import type {FitCheckStatus} from './check-types.ts'
import {
  fitExpressionText,
  publicFitText,
  type ComparisonOperator,
  type FitSpec,
} from './parser.ts'

export type FitObligationBoundary =
  | 'function-contract'
  | 'inline-check'
  | 'type-boundary'
  | 'helper-call'
  | 'loop-contract'
  | 'audit'

export type FitObligationGoal =
  | {kind: 'range'; text: string; target: string; range: string}
  | {kind: 'comparison'; text: string; left: string; op: ComparisonOperator; right: string}
  | {kind: 'atom'; text: string; name: string; args: string[]}
  | {kind: 'call-precondition'; text: string; requirement: string}
  | {kind: 'audit'; text: string}

export type FitObligation = {
  id: string
  file: string
  functionName: string
  text: string
  boundary: FitObligationBoundary
  goal: FitObligationGoal
  line?: number
  boundaryLine?: number
}

export type FitProofStep = {
  domain: string
  rule: string
  message: string
}

export type FitProofTrace = {
  obligationId: string
  status: FitCheckStatus
  usedFacts: string[]
  steps: FitProofStep[]
}

export function obligationForSpec(
  file: string,
  functionName: string,
  spec: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'} | {kind: 'check-atom'}>,
  boundary: FitObligationBoundary,
  sourceBoundary?: {line?: number; boundaryLine?: number},
): FitObligation {
  const line = sourceBoundary?.line ?? spec.line
  return createObligation({
    file,
    functionName,
    text: spec.text,
    boundary,
    goal: goalForSpec(spec),
    ...(line == null ? {} : {line}),
    ...(sourceBoundary?.boundaryLine == null ? {} : {boundaryLine: sourceBoundary.boundaryLine}),
  })
}

export function callPreconditionObligation(input: {
  file: string
  functionName: string
  callLine?: number
  text: string
  requirement: string
}): FitObligation {
  return createObligation({
    file: input.file,
    functionName: input.functionName,
    text: input.text,
    boundary: 'helper-call',
    goal: {kind: 'call-precondition', text: input.requirement, requirement: input.requirement},
    ...(input.callLine == null ? {} : {line: input.callLine}),
  })
}

export function auditObligation(input: {
  file: string
  functionName: string
  line?: number
  text: string
}): FitObligation {
  return createObligation({
    file: input.file,
    functionName: input.functionName,
    text: input.text,
    boundary: 'audit',
    goal: {kind: 'audit', text: input.text},
    ...(input.line == null ? {} : {line: input.line}),
  })
}

export function proofTraceForStatus(obligation: FitObligation, status: FitCheckStatus, steps: FitProofStep[], usedFacts: string[] = []): FitProofTrace {
  return {
    obligationId: obligation.id,
    status,
    usedFacts: [...new Set(usedFacts)],
    steps,
  }
}

function createObligation(input: Omit<FitObligation, 'id'>): FitObligation {
  return {
    ...input,
    id: [
      input.file,
      input.line ?? '',
      input.functionName,
      input.boundary,
      input.text,
    ].join('\0'),
  }
}

function goalForSpec(spec: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'} | {kind: 'check-atom'}>): FitObligationGoal {
  switch (spec.kind) {
    case 'check-range':
      return {kind: 'range', text: spec.text, target: publicFitText(fitExpressionText(spec.expression)), range: publicFitText(spec.range.text)}
    case 'check-comparison':
      return {
        kind: 'comparison',
        text: spec.text,
        left: publicFitText(fitExpressionText(spec.left)),
        op: spec.op,
        right: publicFitText(fitExpressionText(spec.right)),
      }
    case 'check-atom':
      return {kind: 'atom', text: spec.text, name: spec.name, args: spec.args.map(arg => publicFitText(fitExpressionText(arg)))}
  }
}
