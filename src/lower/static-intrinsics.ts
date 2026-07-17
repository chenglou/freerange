import * as ts from 'typescript'

type StaticAnnotationRole = 'requirement' | 'assertion'

export type StaticAnnotation =
  | {kind: 'valid'; call: ts.CallExpression; role: StaticAnnotationRole; condition: ts.Expression}
  | {
      kind: 'invalid'
      call: ts.CallExpression
      role: StaticAnnotationRole
      node: ts.Node
      problem: 'argumentCount' | 'position' | 'optionalCall'
    }

type StaticAnnotationScan = {
  functions: StaticAnnotation[][]
  outsideTopLevelFunctions: ts.CallExpression[]
}

export function scanStaticAnnotations(
  sourceFile: ts.SourceFile,
  declarations: ts.FunctionDeclaration[],
  checker: ts.TypeChecker,
): StaticAnnotationScan {
  const ownerIndex = new Map<ts.FunctionDeclaration, number>(
    declarations.map((declaration, index) => [declaration, index]),
  )
  const callsByFunction = declarations.map(() => [] as ts.CallExpression[])
  const outsideTopLevelFunctions: ts.CallExpression[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isStaticIntent(node, checker)) {
      const owner = ts.findAncestor(node, ts.isFunctionLike)
      const index = owner != null && ts.isFunctionDeclaration(owner) ? ownerIndex.get(owner) : undefined
      if (index == null) outsideTopLevelFunctions.push(node)
      else callsByFunction[index]!.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return {
    functions: declarations.map((declaration, index) => {
      const calls = callsByFunction[index]!
      const callSet = new Set(calls)
      const leading = new Set<ts.CallExpression>()
      if (declaration.body != null) {
        for (const statement of declaration.body.statements) {
          if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)
            || !callSet.has(statement.expression)) break
          leading.add(statement.expression)
        }
      }
      return calls.map(call => annotationForCall(call, leading.has(call) ? 'requirement' : 'assertion'))
    }),
    outsideTopLevelFunctions,
  }
}

function annotationForCall(call: ts.CallExpression, role: StaticAnnotationRole): StaticAnnotation {
  if (call.arguments.length !== 1) {
    return {kind: 'invalid', call, role, node: call, problem: 'argumentCount'}
  }
  if (!ts.isExpressionStatement(call.parent) || call.parent.expression !== call) {
    return {kind: 'invalid', call, role, node: call, problem: 'position'}
  }
  const callee = call.expression
  if (call.questionDotToken != null
    || (ts.isPropertyAccessExpression(callee) && callee.questionDotToken != null)) {
    return {kind: 'invalid', call, role, node: call, problem: 'optionalCall'}
  }
  return {kind: 'valid', call, role, condition: call.arguments[0]!}
}

function isStaticIntent(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  const access = call.expression
  if (!ts.isIdentifier(access.expression)
    || access.expression.text !== 'console'
    || access.name.text !== 'assert') return false
  const resolved = checker.getSymbolAtLocation(access.expression)
  const globalConsole = checker.resolveName('console', undefined, ts.SymbolFlags.Value, false)
  return resolved != null && resolved === globalConsole
}
