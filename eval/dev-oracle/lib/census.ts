// Where Freerange stops on each eligible entry (rule dev-oracle-census@v1): on each tree, the verdict at the inserted assert
// if Freerange reached one, the run's failure if it ran into one, and otherwise the finding that left the assert
// not-analyzed. That finding names the first unsupported construct of the assert's function (Freerange src/project.ts,
// formatUnsupportedReason), or says the assert sits outside a named top-level function. Each stop is grouped from the
// finding's text, checked in this order:
// - closure: the assert is outside a named top-level function, or an unsupported expression or statement form names a
//   function or class
// - assert-form: the assert's own form (the staticAssertionForm messages)
// - object-write: a write into an object, or Object.assign
// - array-method: a call to an array method
// - import: a call, unknown identifier or wrong-arity call whose root name is an import binding of the file
// - dom-or-platform: such a name the file doesn't declare (a default-library global like document), or a value, property
//   read, operand or condition whose type names a DOM type
// - other: every other finding, including calls through a local name, which the text alone doesn't tell apart
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import * as ts from 'typescript'
import {parseFreerangeOutput, staticFormPrefixes} from '../../lib/findings.ts'
import {scriptKindFor} from './placement.ts'

export type CensusGroup = 'reached-verdict' | 'run-failed' | 'closure' | 'assert-form' | 'object-write' | 'array-method' | 'import' | 'dom-or-platform' | 'other'

export const censusGroups: CensusGroup[] = ['reached-verdict', 'run-failed', 'closure', 'assert-form', 'object-write', 'array-method', 'import', 'dom-or-platform', 'other']

export type FileNames = {imports: Set<string>; declared: Set<string>}

export type Classified = {group: CensusGroup; kind: string; subject: string | null}

export type Stop = Classified & {message: string; line: number | null; column: number | null; construct: string | null}

// Types from lib.dom that mean a browser object, not plain data.
const domType = /\b(?:HTML\w*|SVG\w*|CSS\w*|Canvas\w*|WebGL\w*|Document\w*|Window|Node\w*|Element|Text|Range|TreeWalker|Selection|DOMRect\w*|\w+Event|Storage|Location|Navigator|Performance\w*|\w+Observer\w*|FontFace\w*|MediaQueryList\w*)\b/

function fileNames(path: string, text: string): FileNames {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path))
  const names: FileNames = {imports: new Set(), declared: new Set()}
  const visit = (node: ts.Node): void => {
    if ((ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)) && node.name != null) {
      names.imports.add(node.name.text)
      names.declared.add(node.name.text)
    } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name != null && ts.isIdentifier(node.name)) {
      names.declared.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

function nameGroup(name: string, names: FileNames): CensusGroup {
  const root = name.split(/[.[(]/)[0] ?? name
  if (names.imports.has(root)) return 'import'
  return names.declared.has(root) ? 'other' : 'dom-or-platform'
}

export function classifyMessage(message: string, names: FileNames): Classified {
  if (message.startsWith('console.assert is only supported inside a named top-level function')) return {group: 'closure', kind: 'assert-outside-top-level-function', subject: null}
  const reason = /^console\.assert (?:requirements )?in [A-Za-z_$][\w$]* (?:was|were) not checked because (.*)$/.exec(message)?.[1] ?? message
  if (staticFormPrefixes.some(prefix => reason.startsWith(prefix))) return {group: 'assert-form', kind: 'assert-form', subject: null}
  if (reason.startsWith('a write into an object')) return {group: 'object-write', kind: 'property-write', subject: null}
  const call = /^function call (\S+)/.exec(reason)
  if (call != null) {
    const callee = call[1]!
    if (callee === 'Object.assign') return {group: 'object-write', kind: 'call', subject: callee}
    if (reason.includes('(array methods are outside the subset')) return {group: 'array-method', kind: 'call', subject: callee}
    return {group: nameGroup(callee, names), kind: 'call', subject: callee}
  }
  const named = /^(?:call to (\S+) with (?:fewer|more) arguments|unknown identifier (\S+))/.exec(reason)
  if (named != null) {
    const subject = named[1] ?? named[2]!
    return {group: nameGroup(subject, names), kind: named[1] != null ? 'call-arity' : 'unknown-identifier', subject}
  }
  const typed = /^(value of type|property read from|non-number operand of type|condition of type) (.+?)(?: \(compare explicitly.*)?$/.exec(reason)
  if (typed != null) {
    const typeText = typed[2]!
    return {group: domType.test(typeText) ? 'dom-or-platform' : 'other', kind: typed[1]!.replaceAll(' ', '-'), subject: typeText}
  }
  const form = /^(expression|statement) \((.+)\)$/.exec(reason)
  if (form != null) {
    const syntax = form[2]!
    return {group: /Function|Arrow|Class|Method/.test(syntax) ? 'closure' : 'other', kind: `${form[1]!}-form`, subject: syntax}
  }
  return {group: 'other', kind: 'other', subject: null}
}

export type TreeRun = {verdict: string; reason: string; finding: string | null; failure: string; findingLines: string[]; worktree: string; path: string}

export function treeStop(run: TreeRun): Stop {
  if (run.verdict !== 'not-analyzed') return {group: 'reached-verdict', kind: run.verdict, subject: null, message: run.reason, line: null, column: null, construct: null}
  if (run.failure !== '') return {group: 'run-failed', kind: /error (TS\d+)/.exec(run.failure)?.[1] ?? (run.failure.startsWith('timeout') ? 'timeout' : 'no-summary'), subject: null, message: run.failure, line: null, column: null, construct: null}
  const message = run.finding ?? run.reason
  const filePath = join(run.worktree, run.path)
  const text = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const finding = parseFreerangeOutput(run.findingLines.join('\n')).findings.find(candidate => candidate.message === message)
  const construct = finding == null ? null : text.split('\n')[finding.line - 1]?.trim() ?? null
  return {...classifyMessage(message, fileNames(run.path, text)), message, line: finding?.line ?? null, column: finding?.column ?? null, construct}
}
