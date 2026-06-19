import * as ts from 'typescript'
import {bindingNames} from '../binding-patterns.ts'
import type {Value} from '../domain.ts'

export function forOfItemName(initializer: ts.ForInitializer): string | null {
  if (!ts.isVariableDeclarationList(initializer)) return null
  const declaration = initializer.declarations[0]
  return declaration != null && ts.isIdentifier(declaration.name) ? declaration.name.text : null
}

export function forOfScopedNames(initializer: ts.ForInitializer): string[] {
  if (!ts.isVariableDeclarationList(initializer)) return []
  return initializer.declarations.flatMap(declaration => bindingNames(declaration.name))
}

export function forOfBodyScopedNames(statement: ts.Statement): string[] {
  return ts.isBlock(statement) ? blockScopedNames(statement) : []
}

export function blockScopedNames(block: ts.Block): string[] {
  return block.statements.flatMap(statement => {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) return []
    return statement.declarationList.declarations.flatMap(declaration => bindingNames(declaration.name))
  })
}

export function saveScopedValues(env: Map<string, Value>, names: string[]): Map<string, Value | null> {
  const values = new Map<string, Value | null>()
  for (const name of names) values.set(name, env.get(name) ?? null)
  return values
}

export function restoreScopedValues(env: Map<string, Value>, values: Map<string, Value | null>) {
  for (const [name, value] of values) {
    if (value == null) env.delete(name)
    else env.set(name, value)
  }
}
