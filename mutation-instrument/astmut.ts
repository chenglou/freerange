// astmut@v1 (plan-a/registered/m7-mj-gallery.json `operators`): the operator mutants of each in-scope mj-gallery file,
// generated from the file's TypeScript AST at the pinned commit. It never reads an assert expression: console.assert calls
// only mark the lines no mutant may touch, and pick which functions are in the mutation scope. No function under test runs.
//   scope  the bodies of top-level functions that hold a console.assert call and are entries (exported or an export@v1 name,
//          minus excluded entries), the same-file top-level functions they call directly or transitively, and the
//          initializers of the top-level consts those bodies reference by name, e.g. `masonryMinHeightRatio = 9 / 16`
//   O1 < to <=, <= to <, > to >=, >= to >            O2 < to >, > to <, <= to >=, >= to <=
//   O3 a number n to n + 1, n - 1 and n * 2, as the shortest JavaScript text, e.g. 16 to 17, 15, 32; 0 * 2 is dropped
//   O4 Math.min to Math.max and back                 O5 Math.floor, Math.ceil, Math.round, each to the other two
//   O6 + to -, - to +, += to -=, -= to +=, when the checker types both operands as number
//   O7 * to /, / to *, *= to /=, /= to *=
//   O8 a Math.min or Math.max call without one of its n >= 2 arguments, e.g. Math.max(0, width) gives (width) and (0)
//   O9 the condition c of if, while, do...while, for and c ? a : b becomes !(c)
// Never mutated: a line holding any part of a console.assert call, type positions, property names, code outside the scope.
// Mutants are ordered by the changed node's start, then operator, then variant, and numbered m7-<copy>-<ordinal> in that order.
// E1: a mutated file identical to the original or to an earlier mutant of the copy is a duplicate. E2: a mutated file with
// TypeScript syntax diagnostics is invalid. Each mutant is a change rule {file, from, to} whose `from` is the smallest text
// containing the changed node that occurs exactly once in the file, searched on the node's own lines first.
// usage: bun mutation-instrument/astmut.ts --rules <registered/m7-mj-gallery.json>
//   writes table.json and table.tsv into plan-a/m7-prep/astmut/, which must not exist yet
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {basename, dirname, extname, join} from 'node:path'
import * as ts from 'typescript'
import {hasExport, isConsoleAssertCall, loadProgram} from './analyze.ts'
import {decodeJson} from './encode.ts'
import {instrumentSource} from './instrument.ts'
import {ASTMUT_DIR, checkedFile, worktreeOf, type AstmutCopy, type AstmutOperator, type AstmutRow, type AstmutTable, type MjGalleryRegistration} from './mj-gallery.ts'

const INSTRUMENT_DIR = dirname(realpathSync(new URL(import.meta.url).pathname))
const OPERATORS: AstmutOperator[] = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9']

function sha1(text: string | Buffer) {
  return createHash('sha1').update(text).digest('hex')
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] ?? null
}

// -- Operator tables -------------------------------------------------------------

/** O1's and O2's replacement of a relational operator, e.g. `<` gives `<=` and `>`; null for any other operator. */
function relationalVariants(kind: ts.SyntaxKind): [string, string] | null {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken: return ['<=', '>']
    case ts.SyntaxKind.LessThanEqualsToken: return ['<', '>=']
    case ts.SyntaxKind.GreaterThanToken: return ['>=', '<']
    case ts.SyntaxKind.GreaterThanEqualsToken: return ['>', '<=']
    default: return null
  }
}

function additiveVariant(kind: ts.SyntaxKind): string | null {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return '-'
    case ts.SyntaxKind.MinusToken: return '+'
    case ts.SyntaxKind.PlusEqualsToken: return '-='
    case ts.SyntaxKind.MinusEqualsToken: return '+='
    default: return null
  }
}

function multiplicativeVariant(kind: ts.SyntaxKind): string | null {
  switch (kind) {
    case ts.SyntaxKind.AsteriskToken: return '/'
    case ts.SyntaxKind.SlashToken: return '*'
    case ts.SyntaxKind.AsteriskEqualsToken: return '/='
    case ts.SyntaxKind.SlashEqualsToken: return '*='
    default: return null
  }
}

/** O5's replacements, in registered order, e.g. floor gives ceil and round. */
function roundingVariants(name: string): string[] {
  switch (name) {
    case 'floor': return ['ceil', 'round']
    case 'ceil': return ['floor', 'round']
    case 'round': return ['floor', 'ceil']
    default: return []
  }
}

/** `min` for a `Math.min(…)` call, and likewise for every other `Math.<name>(…)` call; null for any other call. */
function mathName(call: ts.CallExpression): string | null {
  const callee = call.expression
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Math' ? callee.name.text : null
}

function isNumberType(checker: ts.TypeChecker, node: ts.Expression) {
  const type = checker.getTypeAtLocation(node)
  const members = type.isUnion() ? type.types : [type]
  return members.every((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0)
}

function isPropertyName(node: ts.Node) {
  const parent = node.parent
  return ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) || ts.isEnumMember(parent)) && parent.name === node)
    || ts.isComputedPropertyName(parent)
}

// -- Scope -------------------------------------------------------------------------

// A top-level function with its body, or a top-level const with its initializer.
type Declaration = {name: string; kind: 'function' | 'const'; body: ts.Node; exported: boolean}

function topLevelDeclarations(sourceFile: ts.SourceFile): Map<ts.Node, Declaration> {
  const result = new Map<ts.Node, Declaration>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null && statement.body != null) {
      result.set(statement, {name: statement.name.text, kind: 'function', body: statement.body, exported: hasExport(statement)})
    }
    if (!ts.isVariableStatement(statement)) continue
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (!ts.isIdentifier(declaration.name) || initializer == null) continue
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) result.set(declaration, {name: declaration.name.text, kind: 'function', body: initializer.body, exported: hasExport(statement)})
      else if (isConst) result.set(declaration, {name: declaration.name.text, kind: 'const', body: initializer, exported: hasExport(statement)})
    }
  }
  return result
}

function containsAssert(node: ts.Node): boolean {
  return isConsoleAssertCall(node) || ts.forEachChild(node, containsAssert) === true
}

/** The scope functions, then the consts they reference, each with the node its mutants live in. */
function mutationScope(checker: ts.TypeChecker, sourceFile: ts.SourceFile, exportShim: string[], excluded: string[]): Declaration[] {
  const declarations = topLevelDeclarations(sourceFile)
  const declarationOf = (identifier: ts.Identifier) => {
    const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration
    return declaration == null ? null : declarations.get(declaration) ?? null
  }
  const scope: Declaration[] = []
  for (const declaration of declarations.values()) {
    if (declaration.kind !== 'function' || excluded.includes(declaration.name)) continue
    if ((declaration.exported || exportShim.includes(declaration.name)) && containsAssert(declaration.body)) scope.push(declaration)
  }
  for (let index = 0; index < scope.length; index++) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = declarationOf(node.expression)
        if (callee?.kind === 'function' && !scope.includes(callee)) scope.push(callee)
      }
      ts.forEachChild(node, visit)
    }
    visit(scope[index]!.body)
  }
  const functions = scope.length
  for (let index = 0; index < functions; index++) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const constant = declarationOf(node)
        if (constant?.kind === 'const' && !scope.includes(constant)) scope.push(constant)
      }
      ts.forEachChild(node, visit)
    }
    visit(scope[index]!.body)
  }
  return scope
}

// -- Candidates ----------------------------------------------------------------------

type Candidate = {start: number; end: number; operator: AstmutOperator; variant: number; before: string; after: string; functionName: string}

function lineOf(sourceFile: ts.SourceFile, position: number) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1
}

/** Every line that holds part of a console.assert call, from the `console` token to the closing parenthesis. */
function assertLines(sourceFile: ts.SourceFile): Set<number> {
  const lines = new Set<number>()
  const visit = (node: ts.Node): void => {
    if (isConsoleAssertCall(node)) {
      for (let line = lineOf(sourceFile, node.getStart(sourceFile)); line <= lineOf(sourceFile, node.end - 1); line++) lines.add(line)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return lines
}

function candidatesOf(checker: ts.TypeChecker, sourceFile: ts.SourceFile, declaration: Declaration, blocked: Set<number>, counts: {droppedUnchangedText: number}): Candidate[] {
  const result: Candidate[] = []
  const push = (node: ts.Node, operator: AstmutOperator, variant: number, after: string) => {
    const start = node.getStart(sourceFile)
    for (let line = lineOf(sourceFile, start); line <= lineOf(sourceFile, node.end - 1); line++) if (blocked.has(line)) return
    result.push({start, end: node.end, operator, variant, before: node.getText(sourceFile), after, functionName: declaration.name})
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind
      const relational = relationalVariants(kind)
      if (relational != null) {
        push(node.operatorToken, 'O1', 0, relational[0])
        push(node.operatorToken, 'O2', 0, relational[1])
      }
      const additive = additiveVariant(kind)
      if (additive != null && isNumberType(checker, node.left) && isNumberType(checker, node.right)) push(node.operatorToken, 'O6', 0, additive)
      const multiplicative = multiplicativeVariant(kind)
      if (multiplicative != null) push(node.operatorToken, 'O7', 0, multiplicative)
    }
    if (ts.isNumericLiteral(node) && !isPropertyName(node)) {
      const text = node.getText(sourceFile)
      const value = Number(text)
      ;[value + 1, value - 1, value * 2].forEach((next, variant) => {
        if (String(next) === text) counts.droppedUnchangedText += 1
        else push(node, 'O3', variant, String(next))
      })
    }
    if (ts.isCallExpression(node)) {
      const name = mathName(node)
      if (name === 'min' || name === 'max') {
        push(node.expression, 'O4', 0, `Math.${name === 'min' ? 'max' : 'min'}`)
        if (node.arguments.length >= 2 && !node.arguments.some(ts.isSpreadElement)) {
          node.arguments.forEach((_argument, index) => {
            const rest = node.arguments.filter((_other, otherIndex) => otherIndex !== index).map((other) => other.getText(sourceFile))
            push(node, 'O8', index, rest.length === 1 ? `(${rest[0]!})` : `Math.${name}(${rest.join(', ')})`)
          })
        }
      }
      if (name != null) roundingVariants(name).forEach((replacement, variant) => push(node.expression, 'O5', variant, `Math.${replacement}`))
    }
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) push(node.expression, 'O9', 0, `!(${node.expression.getText(sourceFile)})`)
    if (ts.isForStatement(node) && node.condition != null) push(node.condition, 'O9', 0, `!(${node.condition.getText(sourceFile)})`)
    if (ts.isConditionalExpression(node)) push(node.condition, 'O9', 0, `!(${node.condition.getText(sourceFile)})`)
    ts.forEachChild(node, visit)
  }
  visit(declaration.body)
  return result
}

// -- Change rules ------------------------------------------------------------------------

function occursOnce(text: string, candidate: string) {
  const first = text.indexOf(candidate)
  return first >= 0 && text.indexOf(candidate, first + 1) < 0
}

/**
 * The smallest span containing [start, end) whose text occurs exactly once in `text`, leftmost first, searched within the
 * node's own lines and then with one more line on each side at a time, e.g. `Math.abs(a - b) <= 1e-9` on a line that
 * tooltipPosition and tooltipInPlacePosition both hold is widened to the line above.
 */
function uniqueSpan(text: string, start: number, end: number): {from: number; to: number; widened: boolean} {
  let low = text.lastIndexOf('\n', start - 1) + 1
  let high = text.indexOf('\n', end - 1)
  if (high < 0) high = text.length
  for (let widening = 0; ; widening++) {
    for (let length = end - start; length <= high - low; length++) {
      for (let from = Math.max(low, end - length); from <= Math.min(start, high - length); from++) {
        if (occursOnce(text, text.slice(from, from + length))) return {from, to: from + length, widened: widening > 0}
      }
    }
    if (low === 0 && high === text.length) throw new Error(`no unique text around offset ${start}`)
    if (low > 0) low = text.lastIndexOf('\n', low - 2) + 1
    if (high < text.length) {
      const next = text.indexOf('\n', high + 1)
      high = next < 0 ? text.length : next
    }
  }
}

function newlines(text: string) {
  return text.split('\n').length - 1
}

// -- Main ------------------------------------------------------------------------------------

const rulesPath = option('--rules')
if (rulesPath == null) throw new Error('usage: bun mutation-instrument/astmut.ts --rules <registered/m7-mj-gallery.json>')
const registrationText = readFileSync(rulesPath, 'utf8')
const registration = decodeJson(registrationText) as MjGalleryRegistration
const scratch = registration.data.scratch
const outDir = join(scratch, ASTMUT_DIR)
if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`)
const worktreeDir = join(scratch, worktreeOf(registration))
const transpiler = new Bun.Transpiler({loader: 'ts'})

const rows: AstmutRow[] = []
const copies: AstmutCopy[] = []
const checks: string[] = []
for (const copy of registration.copies.list) {
  for (const file of copy.files.filter((candidate) => candidate.entries)) {
    const text = checkedFile(registration, file.path)
    const path = join(worktreeDir, file.path)
    const logicalName = basename(file.path, extname(file.path))
    const program = loadProgram([path])
    const sourceFile = program.getSourceFile(path)
    if (sourceFile == null) throw new Error(`TypeScript did not load ${path}`)
    const checker = program.getTypeChecker()
    const blocked = assertLines(sourceFile)
    const scope = mutationScope(checker, sourceFile, copy.exportShim ?? [], copy.excludedEntries ?? [])
    const counts = {droppedUnchangedText: 0}
    const candidates = scope.flatMap((declaration) => candidatesOf(checker, sourceFile, declaration, blocked, counts))
    candidates.sort((left, right) => left.start - right.start || OPERATORS.indexOf(left.operator) - OPERATORS.indexOf(right.operator) || left.variant - right.variant)
    if (ts.transpileModule(text, {reportDiagnostics: true, fileName: path}).diagnostics?.length !== 0) throw new Error(`${file.path}: the pinned file has syntax diagnostics`)
    const originalSites = instrumentSource(text, path, logicalName, 0).sites
    const seen = new Map<string, string>([[sha1(text), 'original']])
    const lines = text.split('\n')
    let duplicates = 0
    let invalid = 0
    candidates.forEach((candidate, index) => {
      const id = `m7-${copy.id}-${String(index + 1).padStart(3, '0')}`
      const mutated = text.slice(0, candidate.start) + candidate.after + text.slice(candidate.end)
      const mutatedSha1 = sha1(mutated)
      const span = uniqueSpan(text, candidate.start, candidate.end)
      const change = {file: file.path, from: text.slice(span.from, span.to), to: text.slice(span.from, candidate.start) + candidate.after + text.slice(candidate.end, span.to)}
      // run.ts applies a change with String.replace and a string replacement, so the rule must give this exact text that way.
      if (text.replace(change.from, change.to) !== mutated) throw new Error(`${id}: the change rule doesn't reproduce the mutated file`)
      const position = sourceFile.getLineAndCharacterOfPosition(candidate.start)
      for (let line = position.line; line <= lineOf(sourceFile, candidate.end - 1) - 1; line++) {
        if (/console\s*\.\s*assert/.test(lines[line] ?? '')) throw new Error(`${id}: line ${line + 1} holds a console.assert token`)
      }
      const duplicateOf = seen.get(mutatedSha1) ?? null
      const diagnostics = duplicateOf != null ? [] : (ts.transpileModule(mutated, {reportDiagnostics: true, fileName: path}).diagnostics ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
      const status = duplicateOf != null ? 'duplicate' : diagnostics.length > 0 ? 'invalid' : 'valid'
      if (duplicateOf == null) seen.set(mutatedSha1, id)
      if (status === 'duplicate') duplicates += 1
      if (status === 'invalid') invalid += 1
      if (status === 'valid') {
        if (newlines(mutated) !== newlines(text)) throw new Error(`${id}: the mutant changes the file's line count`)
        try {
          transpiler.transformSync(mutated)
        } catch (error) {
          throw new Error(`${id}: TypeScript parses the mutated file but Bun doesn't: ${String(error)}`)
        }
        const sites = instrumentSource(mutated, path, logicalName, 0).sites
        if (sites.length !== originalSites.length || sites.some((site, siteIndex) => site.key !== originalSites[siteIndex]!.key || site.line !== originalSites[siteIndex]!.line)) {
          throw new Error(`${id}: site check failed, the mutant's site keys or lines differ from the copy's`)
        }
      }
      rows.push({
        id, copy: copy.id, file: file.path, function: candidate.functionName, line: position.line + 1, column: position.character + 1, operator: candidate.operator,
        before: candidate.before, after: candidate.after, sha1: mutatedSha1, status, duplicateOf, diagnostics, change, widenedAcrossLines: span.widened,
      })
    })
    copies.push({
      copy: copy.id, file: file.path, scopeFunctions: scope.filter((declaration) => declaration.kind === 'function').map((declaration) => declaration.name),
      scopeConstants: scope.filter((declaration) => declaration.kind === 'const').map((declaration) => declaration.name),
      generated: candidates.length, droppedUnchangedText: counts.droppedUnchangedText, duplicates, invalid, valid: candidates.length - duplicates - invalid,
    })
  }
}
checks.push(`every row's lines hold no console.assert token in the pinned file: ${rows.length} rows`)
checks.push(`every change rule's from occurs exactly once in the pinned file and reproduces the mutated file with String.replace: ${rows.length} rows`)
checks.push(`every valid mutant keeps the file's line count, parses under Bun's transpiler, and has the copy's site keys and lines: ${rows.filter((row) => row.status === 'valid').length} mutants`)

const instrumentFiles = readdirSync(INSTRUMENT_DIR).filter((name) => name.endsWith('.ts')).sort()
const table: AstmutTable = {
  version: 'astmut@v1',
  registration: {path: rulesPath, sha1: sha1(registrationText)},
  generator: {
    commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim(),
    dirty: Bun.spawnSync(['git', 'status', '--porcelain', '--', '.'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim() !== '',
    sha1: sha1(instrumentFiles.map((name) => `${name}\n${readFileSync(join(INSTRUMENT_DIR, name), 'utf8')}`).join('\n')),
  },
  copies,
  rows,
  checks,
}
mkdirSync(outDir, {recursive: true})
const tableText = `${JSON.stringify(table, null, 1)}\n`
writeFileSync(join(outDir, 'table.json'), tableText)
const tsvCell = (value: string | number | boolean | null) => String(value).replaceAll('\t', ' ').replaceAll('\n', '\\n')
const tsv = [['id', 'copy', 'file', 'function', 'line', 'column', 'operator', 'before', 'after', 'status', 'duplicate_of', 'sha1', 'from', 'to', 'widened_across_lines'].join('\t')]
for (const row of rows) tsv.push([row.id, row.copy, row.file, row.function, row.line, row.column, row.operator, row.before, row.after, row.status, row.duplicateOf, row.sha1, row.change.from, row.change.to, row.widenedAcrossLines].map(tsvCell).join('\t'))
writeFileSync(join(outDir, 'table.tsv'), `${tsv.join('\n')}\n`)
for (const copy of copies) console.log(`${copy.copy}: generated ${copy.generated}, valid ${copy.valid}, E1 duplicates ${copy.duplicates}, E2 invalid ${copy.invalid}, O3 unchanged text dropped ${copy.droppedUnchangedText}; scope ${[...copy.scopeFunctions, ...copy.scopeConstants].join(', ')}`)
console.log(`table.json sha1 ${sha1(tableText)}: ${rows.length} rows, ${rows.filter((row) => row.status === 'valid').length} valid, ${rows.filter((row) => row.widenedAcrossLines).length} change rules widened across lines`)
