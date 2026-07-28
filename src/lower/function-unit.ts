import * as ts from 'typescript'

export type TopLevelFunctionNode =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression

export type TopLevelFunctionUnit = {
  name: ts.Identifier
  declaration: TopLevelFunctionNode
  initializer: ts.VariableDeclaration | null
}

export function callableSignature(
  unit: TopLevelFunctionUnit,
  checker: ts.TypeChecker,
): ts.Signature | null {
  if (unit.initializer == null) {
    return checker.getSignatureFromDeclaration(unit.declaration) ?? null
  }
  const signatures = checker.getSignaturesOfType(
    checker.getTypeAtLocation(unit.name),
    ts.SignatureKind.Call,
  )
  if (signatures.length !== 1) return null
  const signature = signatures[0]!
  const signatureDeclaration = signature.declaration
  if (signatureDeclaration == null
    || signature.thisParameter != null
    || signature.parameters.length !== unit.declaration.parameters.length
    || signatureDeclaration.parameters.some(parameter =>
      !ts.isParameter(parameter) || parameter.dotDotDotToken != null)) {
    return null
  }
  return signature
}

export function topLevelFunctionUnits(sourceFile: ts.SourceFile): TopLevelFunctionUnit[] {
  const units: TopLevelFunctionUnit[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) {
      units.push({name: statement.name, declaration: statement, initializer: null})
      continue
    }
    if (!ts.isVariableStatement(statement)
      || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const initializer of statement.declarationList.declarations) {
      if (!ts.isIdentifier(initializer.name) || initializer.initializer == null) continue
      const declaration = directFunctionExpression(initializer.initializer)
      if (declaration != null) {
        units.push({name: initializer.name, declaration, initializer})
      }
    }
  }
  return units
}

export function directFunctionExpression(
  expression: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
    ? expression
    : null
}
