import * as ts from 'typescript'
import {transparentExpressionOperand} from './expression.ts'
import {callableSignature, topLevelFunctionUnits} from './function-unit.ts'

export type AccessedProperties = WeakMap<ts.Type, ReadonlySet<ts.Symbol>>

// Gather the fields read in analyzed code and carry those fields backward through
// TypeScript's contextual assignments. The work is bounded by property reads and typed
// expression boundaries written in this file; it does not search for arbitrary paths.
export function scanAccessedProperties(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): AccessedProperties {
  const functionUnits = topLevelFunctionUnits(sourceFile)
  const functionUnitsByDeclaration = new Map<ts.Node, (typeof functionUnits)[number]>(
    functionUnits.map(unit => [unit.declaration, unit]),
  )
  const topLevelFunctionSymbols = new Set(functionUnits.flatMap(unit => {
    const symbol = checker.getSymbolAtLocation(unit.name)
    return symbol == null ? [] : [symbol]
  }))
  const demands = new WeakMap<ts.Type, Set<ts.Symbol>>()
  // Each edge remembers its shallowest structural depth. Reaching the same pair through a
  // shallower path may expose more nested fields or elements; an equal or deeper repeat adds none.
  const flows = new WeakMap<ts.Type, Map<ts.Type, number>>()
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

  function addFlow(target: ts.Type, source: ts.Type, depth = 0): void {
    if (!mayHaveProperties(target) || !mayHaveProperties(source)) return
    for (const targetMember of nonMissingTypes(target)) {
      if (!addFlowPair(targetMember, source, depth)) continue
      if (depth < 8) addContainerFlows(targetMember, source, depth + 1)
    }
  }

  const transfer = (source: ts.Type, property: ts.Symbol, depth: number): void => {
    for (const sourceMember of nonMissingTypes(source)) {
      const sourceProperty = checker.getPropertyOfType(sourceMember, property.name)
      if (sourceProperty == null) continue
      addDemand(sourceMember, sourceProperty)
      if (depth < 8) {
        addFlow(
          checker.getTypeOfSymbol(property),
          checker.getTypeOfSymbol(sourceProperty),
          depth + 1,
        )
      }
    }
  }

  const addFlowPair = (target: ts.Type, source: ts.Type, depth: number): boolean => {
    if (target === source) return false
    let sources = flows.get(target)
    if (sources == null) {
      sources = new Map()
      flows.set(target, sources)
    }
    const previousDepth = sources.get(source)
    if (previousDepth != null && previousDepth <= depth) return false
    sources.set(source, depth)
    for (const property of demands.get(target) ?? []) transfer(source, property, depth)
    return true
  }

  const containerElements = (type: ts.Type): readonly ts.Type[] | null => {
    if (checker.isTupleType(type)) return checker.getTypeArguments(type as ts.TypeReference)
    if (!checker.isArrayType(type)) return null
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    return element == null ? null : [element]
  }

  const addContainerFlows = (target: ts.Type, source: ts.Type, depth: number): void => {
    const targetElements = containerElements(target)
    if (targetElements == null) return
    for (const sourceMember of nonMissingTypes(source)) {
      const sourceElements = containerElements(sourceMember)
      if (sourceElements == null || sourceElements.length === 0) continue
      if (checker.isTupleType(target) && checker.isTupleType(sourceMember)) {
        for (let index = 0; index < targetElements.length && index < sourceElements.length; index++) {
          addFlow(targetElements[index]!, sourceElements[index]!, depth)
        }
        continue
      }
      for (const targetElement of targetElements) {
        for (const sourceElement of sourceElements) addFlow(targetElement, sourceElement, depth)
      }
    }
  }

  const addExpressionFlow = (target: ts.Type, expression: ts.Expression): void => {
    let source = expression
    let operand: ts.Expression | null
    while ((operand = transparentExpressionOperand(source, checker)) != null) source = operand
    if (ts.isConditionalExpression(source)) {
      addExpressionFlow(target, source.whenTrue)
      addExpressionFlow(target, source.whenFalse)
      return
    }
    if (ts.isBinaryExpression(source)) {
      const operator = source.operatorToken.kind
      if (operator === ts.SyntaxKind.QuestionQuestionToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        addExpressionFlow(target, source.left)
        addExpressionFlow(target, source.right)
        return
      }
    }
    if (ts.isObjectLiteralExpression(source)) {
      for (const member of source.properties) {
        let name: string | null = null
        let value: ts.Expression | null = null
        if (ts.isPropertyAssignment(member)) {
          if (ts.isIdentifier(member.name)
            || ts.isStringLiteral(member.name)
            || ts.isNumericLiteral(member.name)) name = member.name.text
          value = member.initializer
        } else if (ts.isShorthandPropertyAssignment(member)) {
          name = member.name.text
          value = member.name
        }
        if (name == null || value == null) continue
        for (const targetMember of nonMissingTypes(target)) {
          const property = checker.getPropertyOfType(targetMember, name)
          if (property != null) addExpressionFlow(checker.getTypeOfSymbol(property), value)
        }
      }
    }
    if (ts.isArrayLiteralExpression(source)) {
      for (const targetMember of nonMissingTypes(target)) {
        const targetElements = containerElements(targetMember)
        if (targetElements == null || targetElements.length === 0) continue
        for (let index = 0; index < source.elements.length; index++) {
          const element = source.elements[index]!
          if (ts.isSpreadElement(element)) continue
          const targetElement = checker.isTupleType(targetMember)
            ? targetElements[index]
            : targetElements[0]
          if (targetElement != null) addExpressionFlow(targetElement, element)
        }
      }
    }
    addFlow(target, checker.getTypeAtLocation(source))
  }

  const visit = (node: ts.Node, returnType: ts.Type | null): void => {
    if (ts.isFunctionLike(node)) {
      const unit = functionUnitsByDeclaration.get(node)
      if (unit == null) return
      const signature = callableSignature(unit, checker)
      const nextReturnType = signature == null ? null : checker.getReturnTypeOfSignature(signature)
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && nextReturnType != null) {
        addExpressionFlow(nextReturnType, node.body)
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
    if (ts.isVariableDeclaration(node) && node.initializer != null
      && (node.type != null || ts.isIdentifier(node.name))) {
      addExpressionFlow(checker.getTypeAtLocation(node.name), node.initializer)
    }
    if (ts.isReturnStatement(node) && node.expression != null && returnType != null) {
      addExpressionFlow(returnType, node.expression)
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
          addExpressionFlow(
            checker.getTypeOfSymbolAtLocation(parameters[index]!, location),
            node.arguments[index]!,
          )
        }
      }
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.EqualsToken
        || operator === ts.SyntaxKind.QuestionQuestionEqualsToken
        || operator === ts.SyntaxKind.BarBarEqualsToken
        || operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        addExpressionFlow(checker.getTypeAtLocation(node.left), node.right)
      }
    }
    ts.forEachChild(node, child => { visit(child, returnType) })
  }
  visit(sourceFile, null)

  for (let index = 0; index < pending.length; index++) {
    const {type, property} = pending[index]!
    for (const [source, depth] of flows.get(type) ?? []) transfer(source, property, depth)
  }
  return demands
}
