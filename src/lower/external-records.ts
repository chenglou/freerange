import * as ts from 'typescript'
import {topLevelFunctionUnits} from './function-unit.ts'
import {declaredOnlyInDeclarationFiles} from './platform.ts'

export type AccessedProperties = WeakMap<ts.Type, ReadonlySet<ts.Symbol>>

// Gather the fields read in analyzed code and carry those fields backward through
// TypeScript's contextual assignments. The work is bounded by property reads and typed
// expression boundaries written in this file; it does not search for arbitrary paths.
export function scanAccessedProperties(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): AccessedProperties {
  const functionUnits = topLevelFunctionUnits(sourceFile)
  const topLevelFunctions = new Set<ts.Node>(functionUnits.map(unit => unit.declaration))
  const topLevelFunctionSymbols = new Set(functionUnits.flatMap(unit => {
    const symbol = checker.getSymbolAtLocation(unit.name)
    return symbol == null ? [] : [symbol]
  }))
  const demands = new WeakMap<ts.Type, Set<ts.Symbol>>()
  const flows = new WeakMap<ts.Type, Set<ts.Type>>()
  const pending: Array<{type: ts.Type; property: ts.Symbol}> = []

  const addDemand = (type: ts.Type, property: ts.Symbol): void => {
    let properties = demands.get(type)
    if (properties == null) {
      properties = new Set()
      demands.set(type, properties)
    }
    if (properties.has(property)) return
    properties.add(property)
    pending.push({type, property})
  }

  const nonMissingTypes = (type: ts.Type): ts.Type[] => {
    if (!type.isUnion()) return [type]
    const missing = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    return type.types.filter(member => (member.flags & missing) === 0)
  }

  const demandName = (input: ts.Type, name: string): void => {
    for (const type of nonMissingTypes(input)) {
      const property = checker.getPropertyOfType(type, name)
      if (property != null) addDemand(type, property)
    }
  }

  const mayHaveProperties = (type: ts.Type): boolean => nonMissingTypes(type).some(member =>
    (member.flags & ts.TypeFlags.Object) !== 0 || member.isIntersection())

  function addFlow(target: ts.Type, source: ts.Type): void {
    if (!mayHaveProperties(target) || !mayHaveProperties(source)) return
    for (const targetMember of nonMissingTypes(target)) addFlowPair(targetMember, source)
  }

  const transfer = (source: ts.Type, property: ts.Symbol): void => {
    for (const sourceMember of nonMissingTypes(source)) {
      const sourceProperty = checker.getPropertyOfType(sourceMember, property.name)
      if (sourceProperty == null) continue
      addDemand(sourceMember, sourceProperty)
      addFlow(checker.getTypeOfSymbol(property), checker.getTypeOfSymbol(sourceProperty))
    }
  }

  const addFlowPair = (target: ts.Type, source: ts.Type): void => {
    if (target === source) return
    let sources = flows.get(target)
    if (sources == null) {
      sources = new Set()
      flows.set(target, sources)
    }
    if (sources.has(source)) return
    sources.add(source)
    for (const property of demands.get(target) ?? []) transfer(source, property)
  }

  const visit = (node: ts.Node, returnType: ts.Type | null): void => {
    if (ts.isFunctionLike(node)) {
      if (!topLevelFunctions.has(node)) return
      const signature = checker.getSignatureFromDeclaration(node)
      const nextReturnType = signature == null ? null : checker.getReturnTypeOfSignature(signature)
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && nextReturnType != null) {
        addFlow(nextReturnType, checker.getTypeAtLocation(node.body))
      }
      ts.forEachChild(node, child => { visit(child, nextReturnType) })
      return
    }
    if (ts.isPropertyAccessExpression(node)) {
      demandName(checker.getTypeAtLocation(node.expression), node.name.text)
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const property = node.propertyName ?? node.name
      if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) {
        demandName(checker.getTypeAtLocation(node.parent), property.text)
      }
    }
    if (ts.isVariableDeclaration(node) && node.type != null && node.initializer != null) {
      addFlow(checker.getTypeAtLocation(node.name), checker.getTypeAtLocation(node.initializer))
    }
    if (ts.isReturnStatement(node) && node.expression != null && returnType != null) {
      addFlow(returnType, checker.getTypeAtLocation(node.expression))
    }
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression
      const symbol = checker.getSymbolAtLocation(callee)
      if (symbol != null && topLevelFunctionSymbols.has(symbol)) {
        const signature = checker.getResolvedSignature(node)
        const parameters = signature?.getParameters() ?? []
        const location = signature?.declaration ?? node
        for (let index = 0; index < node.arguments.length && index < parameters.length; index++) {
          addFlow(
            checker.getTypeOfSymbolAtLocation(parameters[index]!, location),
            checker.getTypeAtLocation(node.arguments[index]!),
          )
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      addFlow(checker.getTypeAtLocation(node.left), checker.getTypeAtLocation(node.right))
    }
    ts.forEachChild(node, child => { visit(child, returnType) })
  }
  visit(sourceFile, null)

  for (let index = 0; index < pending.length; index++) {
    const {type, property} = pending[index]!
    for (const source of flows.get(type) ?? []) transfer(source, property)
  }
  return demands
}

export function isExternalRecordType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  if (checker.isArrayType(type) || checker.isTupleType(type)) return false
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false
  if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0) return false
  return declaredOnlyInDeclarationFiles(type.getSymbol())
}
