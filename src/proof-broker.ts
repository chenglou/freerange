import type {FitCheck} from './check-types.ts'
import {
  proofTraceForStatus,
  type FitObligation,
  type FitProofStep,
} from './obligations.ts'

export type ProveObligationOptions = {
  obligation: FitObligation
  step: FitProofStep
  usedFacts?: string[]
  prove: () => FitCheck
}

export function proveObligation(options: ProveObligationOptions): FitCheck {
  const check = options.prove()
  return {
    ...check,
    obligation: options.obligation,
    trace: proofTraceForStatus(options.obligation, check.status, [options.step], options.usedFacts),
  }
}
