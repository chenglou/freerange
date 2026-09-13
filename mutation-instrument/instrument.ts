// The to-disk splice, run in the parent only. Every `console.assert(...)` becomes a recorder call tagged with its site
// index, so a child needs no TypeScript and the site check runs before any child starts. Forked from the replay
// input-range prototype (rewrite.ts), which spliced at load time through a Bun plugin.
//   console.assert(left <= right)          -> __fr.cmp(7, left, '<=', right)
//   console.assert(Number.isInteger(value)) -> __fr.int(8, value)
//   console.assert(anything else)          -> __fr.bool(9, anything else)
// Line numbers don't move: a call spanning several lines is padded with the newlines its replacement lost.
import * as ts from 'typescript'
import {isConsoleAssertCall, leadingAssertStatements} from './analyze.ts'
import type {Site, SiteKind} from './types.ts'

const COMPARISON_TOKENS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.LessThanToken, '<'], [ts.SyntaxKind.LessThanEqualsToken, '<='], [ts.SyntaxKind.GreaterThanToken, '>'],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>='], [ts.SyntaxKind.EqualsEqualsEqualsToken, '==='], [ts.SyntaxKind.ExclamationEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.EqualsEqualsToken, '=='], [ts.SyntaxKind.ExclamationEqualsToken, '!='],
])

function topLevelFunction(node: ts.Node): {name: string; body: ts.ConciseBody | undefined} | null {
  let current: ts.Node = node
  while (!ts.isSourceFile(current.parent)) current = current.parent
  if (ts.isFunctionDeclaration(current) && current.name != null) return {name: current.name.text, body: current.body}
  if (ts.isVariableStatement(current)) {
    for (const declaration of current.declarationList.declarations) {
      const initializer = declaration.initializer
      if (ts.isIdentifier(declaration.name) && initializer != null && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        && node.pos >= initializer.pos && node.end <= initializer.end) return {name: declaration.name.text, body: initializer.body}
    }
  }
  return null
}

function isLeading(call: ts.CallExpression, body: ts.ConciseBody | undefined) {
  if (body == null || !ts.isBlock(body) || !ts.isExpressionStatement(call.parent) || call.parent.parent !== body) return false
  return leadingAssertStatements(body).includes(call.parent)
}

function newlines(text: string) {
  let count = 0
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count += 1
  return count
}

/** The instrumented text and its site table. `base` names the logical file, e.g. `grid` for base_grid.ts and s042.ts. */
export function instrumentSource(text: string, path: string, base: string): {output: string; sites: Site[]} {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const sites: Site[] = []
  const edits: {start: number; end: number; replacement: string}[] = []
  const occurrences = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (!isConsoleAssertCall(node)) {
      ts.forEachChild(node, visit)
      return
    }
    const condition = node.arguments[0]
    if (condition == null) throw new Error(`${path}: console.assert without a condition`)
    const owner = topLevelFunction(node)
    const start = node.getStart(sourceFile)
    const position = sourceFile.getLineAndCharacterOfPosition(start)
    const index = sites.length
    let unwrapped: ts.Expression = condition
    while (ts.isParenthesizedExpression(unwrapped)) unwrapped = unwrapped.expression
    let kind: SiteKind = 'bool'
    let replacement = `__fr.bool(${index}, ${condition.getText(sourceFile)})`
    const op = ts.isBinaryExpression(unwrapped) ? COMPARISON_TOKENS.get(unwrapped.operatorToken.kind) : undefined
    if (ts.isBinaryExpression(unwrapped) && op != null) {
      kind = 'cmp'
      replacement = `__fr.cmp(${index}, ${unwrapped.left.getText(sourceFile)}, '${op}', ${unwrapped.right.getText(sourceFile)})`
    } else if (ts.isCallExpression(unwrapped) && unwrapped.arguments.length === 1 && unwrapped.expression.getText(sourceFile) === 'Number.isInteger') {
      kind = 'int'
      replacement = `__fr.int(${index}, ${unwrapped.arguments[0]!.getText(sourceFile)})`
    }
    const lost = newlines(text.slice(start, node.end)) - newlines(replacement)
    if (lost > 0) replacement += '\n'.repeat(lost)
    const conditionText = condition.getText(sourceFile)
    const functionName = owner?.name ?? null
    const occurrenceKey = `${functionName}|${conditionText}`
    const occurrence = occurrences.get(occurrenceKey) ?? 0
    occurrences.set(occurrenceKey, occurrence + 1)
    sites.push({
      index, line: position.line + 1, column: position.character + 1, functionName,
      leading: owner != null && isLeading(node, owner.body), text: conditionText, kind, key: `${base}|${functionName}|${conditionText}|${occurrence}`,
    })
    edits.push({start, end: node.end, replacement})
  }
  visit(sourceFile)
  let output = text
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end)
  }
  return {output: `const __fr = globalThis.__fr;${output}`, sites}
}
