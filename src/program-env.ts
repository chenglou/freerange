import * as ts from 'typescript'
import type {ImportedBinding, Program} from './check-types.ts'
import {
  unknown,
  unknownArray,
  unknownObject,
  type Value,
} from './domain.ts'
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

export function programFunctionEnv(program: Program): Map<string, Value> {
  const env = new Map<string, Value>()
  for (const [name, value] of program.globals) {
    env.set(name, outsideStateValue(value, name, topLevelBindingIsConst(program, name)))
  }
  for (const [localName, binding] of program.imports) {
    const imported = importedFunctionGlobalValue(localName, binding)
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

function importedFunctionGlobalValue(localName: string, binding: ImportedBinding): Value | null {
  const value = importedGlobalValue(localName, binding)
  if (value == null || binding.kind !== 'resolved') return null
  return outsideStateValue(
    value,
    localName,
    topLevelBindingIsConst(binding.file, binding.sourceName),
  )
}

function outsideStateValue(value: Value, name: string, immutableBinding: boolean): Value {
  if (!immutableBinding) return unknown(`Mutable outside binding ${name} is not tracked exactly`)
  switch (value.kind) {
    case 'number':
    case 'literal':
    case 'null':
      return value
    case 'object':
      return unknownObject(name)
    case 'array':
      return unknownArray(name)
    case 'nullable':
      return unknown(`Mutable outside value ${name} is not tracked exactly`)
    case 'unknown':
      return value
  }
}

function topLevelBindingIsConst(program: Program, name: string): boolean {
  for (const statement of program.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return true
    }
  }
  return false
}
