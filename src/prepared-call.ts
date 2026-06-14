import type {Value} from './domain.ts'

export type PreparedParameter = {
  value: Value
  sourceText: string | null
}

export type PreparedCall = {
  analysisEnv: Map<string, Value>
  parameters: PreparedParameter[]
}
