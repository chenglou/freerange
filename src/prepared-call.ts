import type {Value} from './domain.ts'

export type EvaluatedOperand = Readonly<{
  value: Value
  sourceText: string | null
}>

export type PreparedCallSite = Readonly<{
  parameterSourceTexts: readonly (string | null)[]
  boundValues: ReadonlyMap<string, Value>
}>

export type PreparedCall = Readonly<{
  entryEnv: ReadonlyMap<string, Value>
  callSite: PreparedCallSite
}>
