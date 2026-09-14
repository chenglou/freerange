// Finds every `console.assert` in a source file and classifies it the way Freerange's lowering does: a named top-level
// function is a function declaration or a top-level `const name = (...) => ...` / `function (...)` initializer
// (src/lower/function-unit.ts), the maximal consecutive prefix of assert statements in its body is its caller
// requirements, and every later assert is an interior assertion. An assert whose nearest enclosing function is anything
// else is outside Freerange's static assertion scope.
//
// Keys match the ground truth keys the corpus builder writes: `<path>|<owner>|<condition text>|<occurrence>`, with the
// condition's whitespace runs collapsed to one space and the occurrence counted among asserts with the same path, owner
// and text in source order. The owner is the named top-level function, `Class.method` for class members, or empty.
import * as ts from 'typescript'

export type AssertRole = 'requirement' | 'assertion' | 'outside'

export type AssertSite = {
  file: string
  line: number
  column: number
  owner: string
  topLevelFunction: string | null
  role: AssertRole
  text: string
  occurrence: number
  key: string
}

export type TopLevelUnit = {
  name: string
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
  exported: boolean
}

export function normalizeConditionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function parseSource(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

export function topLevelUnits(sourceFile: ts.SourceFile): TopLevelUnit[] {
  const units: TopLevelUnit[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) {
      units.push({name: statement.name.text, node: statement, exported: hasExportModifier(statement)})
      continue
    }
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (!ts.isIdentifier(declaration.name) || initializer == null) continue
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        units.push({name: declaration.name.text, node: initializer, exported: hasExportModifier(statement)})
      }
    }
  }
  return units
}

export function isConsoleAssertCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'console'
    && node.expression.name.text === 'assert'
}

// How many enclosing functions the owner walk looks through before it gives up and leaves the owner empty.
export const maxOwnerDepth = 64

// The nearest function-like ancestor decides the role; the owner name walks further out through nested callbacks so an
// assert inside `items.every(item => ...)` in a method still carries the method's name.
function ownerOf(call: ts.CallExpression, unitsByNode: Map<ts.Node, TopLevelUnit>, depthCap: number): {owner: string; unit: TopLevelUnit | null} {
  const nearest = ts.findAncestor(call.parent, ts.isFunctionLike)
  const nearestUnit = nearest == null ? undefined : unitsByNode.get(nearest)
  if (nearestUnit != null) return {owner: nearestUnit.name, unit: nearestUnit}
  let current: ts.Node | undefined = nearest
  for (let depth = 0; current != null && depth < depthCap; depth++) {
    const unit = unitsByNode.get(current)
    if (unit != null) return {owner: unit.name, unit: null}
    if ((ts.isMethodDeclaration(current) || ts.isGetAccessor(current) || ts.isSetAccessor(current) || ts.isConstructorDeclaration(current))
      && ts.isClassLike(current.parent)) {
      const className = current.parent.name?.text ?? ''
      const memberName = ts.isConstructorDeclaration(current) ? 'constructor' : current.name.getText()
      return {owner: `${className}.${memberName}`, unit: null}
    }
    current = ts.findAncestor(current.parent, ts.isFunctionLike)
  }
  return {owner: '', unit: null}
}

export function extractAssertSites(file: string, text: string, depthCap = maxOwnerDepth): AssertSite[] {
  const sourceFile = parseSource(file, text)
  const units = topLevelUnits(sourceFile)
  const unitsByNode = new Map<ts.Node, TopLevelUnit>(units.map(unit => [unit.node, unit]))
  const leading = new Set<ts.CallExpression>()
  for (const unit of units) {
    const body = unit.node.body
    if (body == null || !ts.isBlock(body)) continue
    for (const statement of body.statements) {
      if (!ts.isExpressionStatement(statement) || !isConsoleAssertCall(statement.expression)) break
      leading.add(statement.expression)
    }
  }

  const found: Array<Omit<AssertSite, 'occurrence' | 'key'>> = []
  const visit = (node: ts.Node): void => {
    if (isConsoleAssertCall(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      const {owner, unit} = ownerOf(node, unitsByNode, depthCap)
      const condition = node.arguments[0]
      found.push({
        file,
        line: position.line + 1,
        column: position.character + 1,
        owner,
        topLevelFunction: unit?.name ?? null,
        role: unit == null ? 'outside' : leading.has(node) ? 'requirement' : 'assertion',
        text: condition == null ? '' : normalizeConditionText(condition.getText(sourceFile)),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const occurrences = new Map<string, number>()
  return found.map(site => {
    const base = `${site.file}|${site.owner}|${site.text}`
    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    return {...site, occurrence, key: `${base}|${occurrence}`}
  })
}

export function runtimeSiteID(site: {file: string; line: number; column: number}): string {
  return `${site.file}:${site.line}:${site.column}`
}

// Rewrites a source file for the runtime check. Every `console.assert(condition, ...)` becomes
// `__evalAssert("<file>:<line>:<column>", condition, ...)`, which evaluates the condition exactly once like the original
// call. Every named top-level function with a block body starts with `__evalEnter("<name>", [<parameters>])`, where a
// destructured parameter is passed as `__evalOpaque`. Functions that aren't exported get an export list at the end, so
// the checker can call them. Sites are named by their position in the original text.
export function instrumentForRuntime(file: string, text: string): string {
  const sourceFile = parseSource(file, text)
  const edits: Array<{position: number; remove: number; insert: string}> = []
  const visit = (node: ts.Node): void => {
    if (isConsoleAssertCall(node) && node.arguments.length > 0) {
      const start = node.getStart(sourceFile)
      const position = sourceFile.getLineAndCharacterOfPosition(start)
      const id = runtimeSiteID({file, line: position.line + 1, column: position.character + 1})
      const firstArgument = node.arguments[0]!.getStart(sourceFile)
      edits.push({position: start, remove: firstArgument - start, insert: `__evalAssert(${JSON.stringify(id)}, `})
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const units = topLevelUnits(sourceFile)
  for (const unit of units) {
    const body = unit.node.body
    if (body == null || !ts.isBlock(body)) continue
    const parameters = unit.node.parameters.map(parameter =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : '__evalOpaque')
    edits.push({
      position: body.getStart(sourceFile) + 1,
      remove: 0,
      insert: ` __evalEnter(${JSON.stringify(unit.name)}, [${parameters.join(', ')}]);`,
    })
  }

  const alreadyExported = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier == null
      && statement.exportClause != null && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) alreadyExported.add(element.name.text)
    }
  }
  const shim = units
    .filter(unit => !unit.exported && !alreadyExported.has(unit.name))
    .map(unit => unit.name)

  edits.sort((left, right) => right.position - left.position)
  let rewritten = text
  for (const edit of edits) {
    rewritten = rewritten.slice(0, edit.position) + edit.insert + rewritten.slice(edit.position + edit.remove)
  }
  return shim.length === 0 ? rewritten : `${rewritten}\nexport {${shim.join(', ')}}\n`
}
