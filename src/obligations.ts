import type {FitCheckStatus} from './check-types.ts'
import type {FitSpec} from './parser.ts'

export type FitObligationBoundary =
  | 'function-contract'
  | 'inline-check'
  | 'type-boundary'
  | 'helper-call'
  | 'loop-contract'
  | 'audit'

export type FitObligationGoal =
  | {kind: 'range'; text: string}
  | {kind: 'comparison'; text: string}
  | {kind: 'atom'; text: string}
  | {kind: 'call-precondition'; text: string}
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
    goal: {kind: 'call-precondition', text: input.requirement},
    ...(input.callLine == null ? {} : {line: input.callLine}),
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
      return {kind: 'range', text: spec.text}
    case 'check-comparison':
      return {kind: 'comparison', text: spec.text}
    case 'check-atom':
      return {kind: 'atom', text: spec.text}
  }
}
