import type {ImportedBinding, Program} from './check-types.ts'
import {type Value} from './domain.ts'
import {localizeValue} from './value-localize.ts'

export function programGlobalEnv(program: Program): Map<string, Value> {
  const env = new Map<string, Value>()
  for (const [name, value] of program.globals) env.set(name, value)
  for (const [localName, binding] of program.imports) {
    const imported = importedGlobalValue(localName, binding)
    if (imported != null) env.set(localName, imported)
  }
  return env
}

function importedGlobalValue(localName: string, binding: ImportedBinding): Value | null {
  if (binding.kind !== 'resolved') return null
  const value = binding.file.globals.get(binding.sourceName)
  if (value == null) return null
  return localizeValue(value, localName, {preserveLinear: true})
}
