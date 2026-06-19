import type {Value} from './domain.ts'

export type EvaluatedOperand = Readonly<{
  value: Value
  sourceText: string | null
}>

export type PreparedParameterSource = Readonly<{
  text: string
  scope: 'caller' | 'callee'
}>

export type PreparedCallSite = Readonly<{
  parameterSources: readonly (PreparedParameterSource | null)[]
  boundValues: ReadonlyMap<string, Value>
}>

export type PreparedCall = Readonly<{
  entryEnv: ReadonlyMap<string, Value>
  callSite: PreparedCallSite
}>
