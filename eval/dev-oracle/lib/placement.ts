// Inserts an entry's catching check into one tree's file as a console.assert, the same text at the same site on both
// trees, and checks that the condition's names exist there.
//
// The site is one statement: among the functions named `function` (a function declaration, a const initialized with an
// arrow or function expression, a method, or a class property holding a function, at any depth), the one statement,
// directly inside a block, whose source text starts with `anchor`. The assert goes on new lines before the statement's
// first line or after its last line, indented like the statement, after a `const` line per binding.
//
// Names: every identifier the condition and the bindings read, other than a property name, a binding introduced above it,
// or a standard global (`globals`), must be a value or import in scope at the statement, declared before the insertion
// point when it is a variable. A binding's name must not already be in scope. The check uses a one-file program with no
// lib and no module resolution, so it depends only on the file.
import * as ts from 'typescript'

export type AssertSpec = {function: string; anchor: string; position: 'before' | 'after'; condition: string; bindings: Array<{name: string; expression: string}>}

export type Insertion =
  | {kind: 'inserted'; text: string; assertLine: number; firstInsertedLine: number; insertedLineCount: number}
  | {kind: 'failed'; reason: 'function-not-found' | 'anchor-not-found' | 'anchor-ambiguous' | 'names-unresolved' | 'binding-name-taken'; detail: string}

export const globals = new Set(['Math', 'Number', 'Infinity', 'NaN', 'undefined', 'console', 'globalThis', 'Array', 'Object', 'String', 'Boolean', 'JSON'])

export function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

export const scriptExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function functionName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name != null) return node.name.text
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) return ts.isIdentifier(node.name) ? node.name.text : null
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent
    if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && ts.isIdentifier(parent.name)) return parent.name.text
  }
  return null
}

function isBlockStatement(node: ts.Node): node is ts.Statement {
  const parent = node.parent as ts.Node | undefined
  if (parent == null) return false
  return (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isModuleBlock(parent))
    && (parent.statements as ts.NodeArray<ts.Node>).includes(node)
}

// Identifiers an expression reads, other than property names.
export function readNames(expression: string): string[] {
  const source = ts.createSourceFile('expression.ts', `(${expression});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)
      if (!isPropertyName && !names.includes(node.text)) names.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

function scopeChecker(path: string, text: string): {source: ts.SourceFile; checker: ts.TypeChecker} {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path))
  const options: ts.CompilerOptions = {noLib: true, noResolve: true, allowJs: true, types: [], noEmit: true}
  const host: ts.CompilerHost = {
    getSourceFile: fileName => fileName === path ? source : undefined,
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: fileName => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: fileName => fileName === path,
    readFile: fileName => fileName === path ? text : undefined,
  }
  const program = ts.createProgram({rootNames: [path], options, host})
  return {source: program.getSourceFile(path) ?? source, checker: program.getTypeChecker()}
}

export function insertAssert(path: string, text: string, spec: AssertSpec): Insertion {
  const {source, checker} = scopeChecker(path, text)
  const functions: ts.Node[] = []
  const collectFunctions = (node: ts.Node): void => {
    if (functionName(node) === spec.function) functions.push(node)
    ts.forEachChild(node, collectFunctions)
  }
  collectFunctions(source)
  if (functions.length === 0) return {kind: 'failed', reason: 'function-not-found', detail: `no function named ${spec.function}`}

  const matches: ts.Statement[] = []
  for (const fn of functions) {
    const visit = (node: ts.Node): void => {
      if (isBlockStatement(node) && node.getText(source).startsWith(spec.anchor) && !matches.includes(node)) matches.push(node)
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(fn, visit)
  }
  if (matches.length === 0) return {kind: 'failed', reason: 'anchor-not-found', detail: `no statement in ${spec.function} starts with ${JSON.stringify(spec.anchor)}`}
  if (matches.length > 1) {
    const lines = matches.map(statement => source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1)
    return {kind: 'failed', reason: 'anchor-ambiguous', detail: `${matches.length} statements in ${spec.function} start with ${JSON.stringify(spec.anchor)}, at lines ${lines.join(', ')}`}
  }
  const statement = matches[0]!
  const startLine = source.getLineAndCharacterOfPosition(statement.getStart(source)).line
  const endLine = source.getLineAndCharacterOfPosition(statement.getEnd()).line
  const lineStarts = source.getLineStarts()
  const startLineOffset = lineStarts[startLine]!
  const indent = /^[ \t]*/.exec(text.slice(startLineOffset))![0]
  const insertionOffset = spec.position === 'before'
    ? startLineOffset
    : endLine + 1 < lineStarts.length ? lineStarts[endLine + 1]! : text.length

  const inScope = new Map<string, ts.Symbol>()
  for (const symbol of checker.getSymbolsInScope(statement, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) inScope.set(symbol.name, symbol)
  const declaredBeforeInsertion = (symbol: ts.Symbol): boolean => {
    const declaration = symbol.declarations?.[0]
    if (declaration == null || declaration.getSourceFile() !== source) return true
    if (!ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration)) return true
    return declaration.getStart(source) < insertionOffset
  }
  const taken = spec.bindings.filter(binding => inScope.has(binding.name) || globals.has(binding.name)).map(binding => binding.name)
  if (taken.length > 0) return {kind: 'failed', reason: 'binding-name-taken', detail: `already in scope: ${taken.join(', ')}`}
  const bound = new Set<string>()
  const unresolved: string[] = []
  for (const expression of [...spec.bindings.map(binding => binding.expression), spec.condition]) {
    for (const name of readNames(expression)) {
      if (bound.has(name) || globals.has(name)) continue
      const symbol = inScope.get(name)
      if ((symbol == null || !declaredBeforeInsertion(symbol)) && !unresolved.includes(name)) unresolved.push(name)
    }
    const binding = spec.bindings.find(candidate => candidate.expression === expression)
    if (binding != null) bound.add(binding.name)
  }
  if (unresolved.length > 0) return {kind: 'failed', reason: 'names-unresolved', detail: `not in scope at ${path}:${startLine + 1}: ${unresolved.join(', ')}`}

  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const inserted = [...spec.bindings.map(binding => `${indent}const ${binding.name} = ${binding.expression}`), `${indent}console.assert(${spec.condition})`]
  const needsLeadingNewline = insertionOffset === text.length && !text.endsWith('\n')
  const block = `${needsLeadingNewline ? newline : ''}${inserted.join(newline)}${newline}`
  const firstInsertedLine = spec.position === 'before' ? startLine + 1 : endLine + 2
  return {
    kind: 'inserted',
    text: text.slice(0, insertionOffset) + block + text.slice(insertionOffset),
    assertLine: firstInsertedLine + spec.bindings.length,
    firstInsertedLine,
    insertedLineCount: inserted.length,
  }
}
