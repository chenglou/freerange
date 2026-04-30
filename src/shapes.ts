import * as ts from 'typescript'
import {
  joinValues,
  linearNameForExpression,
  literalValue,
  mergeNullishKind,
  nullableValue,
  finiteNumberValue,
  isDefinitelyEmptyArray,
  numberValue,
  tupleArray,
  unknown,
  unknownArray,
  unknownArrayLength,
  unknownNumber,
  unknownObject,
  type ArrayValue,
  type NullishKind,
  type Value,
} from './domain.ts'
import {linearVariable} from './linear.ts'

export type ShapeProgram = {
  sourceId: string
  sourceFile: ts.SourceFile
  typeChecker: ts.TypeChecker | null
}

const maxTsShapeDepth = 8
const maxTsShapeUnionMembers = 8
const maxTsShapeProperties = 80

export function valueFromNodeShape(expr: string, node: ts.Node, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  return valueFromTsType(expr, checker.getTypeAtLocation(node), checker, node, new Set(), 0)
}

export function valueFromTypeNodeShape(expr: string, node: ts.TypeNode | undefined, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null || node == null) return null
  return valueFromTsType(expr, checker.getTypeFromTypeNode(node), checker, node, new Set(), 0)
}

export function valueFromFunctionReturnShape(expr: string, fn: ts.SignatureDeclaration, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  const signature = checker?.getSignatureFromDeclaration(fn)
  if (checker == null || signature == null) return null
  return valueFromTsType(expr, checker.getReturnTypeOfSignature(signature), checker, fn, new Set(), 0)
}

export function valueFromCallReturnShape(expr: string, call: ts.CallExpression, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  const signature = checker?.getResolvedSignature(call)
  if (checker == null || signature == null) return null
  return valueFromTsType(expr, checker.getReturnTypeOfSignature(signature), checker, call, new Set(), 0)
}

export function structuralShape(value: Value | null): Value | null {
  return value?.kind === 'object' || value?.kind === 'array' ? value : null
}

export function valueWithStructuralFallback(value: Value, fallbackValue: Value | null): Value {
  const fallback = structuralShape(fallbackValue)
  if (fallback == null) return value
  if (value.kind === 'unknown' || isBroadUnknownNumber(value)) return fallback
  if (value.kind === 'object' && fallback.kind === 'object') return objectWithStructuralFallback(value, fallback)
  if (value.kind === 'array' && fallback.kind === 'array') return arrayWithStructuralFallback(value, fallback)
  return value
}

function objectWithStructuralFallback(value: Extract<Value, {kind: 'object'}>, fallback: Extract<Value, {kind: 'object'}>): Value {
  const props = new Map<string, Value>()
  for (const [name, prop] of fallback.props) props.set(name, prop)
  for (const [name, prop] of value.props) props.set(name, valueWithStructuralFallback(prop, fallback.props.get(name) ?? null))
  return {...value, props, expr: value.expr ?? fallback.expr}
}

function arrayWithStructuralFallback(value: Extract<Value, {kind: 'array'}>, fallback: Extract<Value, {kind: 'array'}>): Value {
  const fallbackElement = fallback.element
  const layout = value.layout === 'tuple' || fallback.layout === 'tuple' ? 'tuple' : 'collection'
  const fallbackElements = fallback.elements
  const elements = layout === 'tuple'
    ? arrayElementsWithStructuralFallback(value.elements, fallbackElements, fallbackElement)
    : null
  const element = arrayElementWithStructuralFallback(value, fallbackElement)
  return {
    ...value,
    layout,
    elements,
    element,
    expr: value.expr ?? fallback.expr,
  }
}

function arrayElementWithStructuralFallback(value: Extract<Value, {kind: 'array'}>, fallbackElement: Value | null): Value | null {
  if (value.element != null) return valueWithStructuralFallback(value.element, fallbackElement)
  return isDefinitelyEmptyArray(value) ? null : fallbackElement
}

function arrayElementsWithStructuralFallback(elements: Value[] | null, fallbackElements: Value[] | null, fallbackElement: Value | null): Value[] | null {
  const count = Math.max(elements?.length ?? 0, fallbackElements?.length ?? 0)
  if (count === 0) return null
  const slots: Value[] = []
  for (let index = 0; index < count; index++) {
    const fallback = fallbackElements?.[index] ?? fallbackElement
    const value = elements?.[index] ?? fallback
    if (value == null) return null
    slots.push(valueWithStructuralFallback(value, fallback))
  }
  return slots
}

function isBroadUnknownNumber(value: Value) {
  return value.kind === 'number'
    && value.min === Number.NEGATIVE_INFINITY
    && value.max === Number.POSITIVE_INFINITY
    && !value.isInteger
    && value.cases == null
    && value.provenance.length === 0
}

function valueFromTsType(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, seen: Set<ts.Type>, depth: number): Value | null {
  if (depth > maxTsShapeDepth) return null
  if (seen.has(type)) return unknownObject(expr)
  if (tsNullishKind(type) != null) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
  const literal = literalValueFromTsType(expr, type)
  if (literal != null) return literal
  if (type.isUnion()) {
    if (type.types.length > maxTsShapeUnionMembers) return null
    const nullish = unionNullishKind(type.types)
    const members = type.types.filter(member => tsNullishKind(member) == null)
    if (nullish != null) {
      if (members.length === 0) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
      const present = joinedTsUnionValue(expr, members, checker, location, seen, depth)
      return present == null ? null : nullableValue(present, expr, nullish)
    }
    return joinedTsUnionValue(expr, members, checker, location, seen, depth)
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return unknownNumber(expr)
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return literalValue([false, true], expr)
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return unknown(`String values are not in the static layout subset: ${expr}`)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return null

  if (checker.isTupleType(type)) {
    return tupleArrayTsValue(expr, type, checker, location, seen, depth + 1)
  }

  if (checker.isArrayLikeType(type)) {
    const element = arrayElementTsValue(`${expr}[]`, type, checker, location, seen, depth + 1)
    return unknownArray(expr, unknownArrayLength(expr), element)
  }

  const properties = type.getProperties()
  if (properties.length === 0) return null
  if (properties.length > maxTsShapeProperties) return null

  seen.add(type)
  const props = new Map<string, Value>()
  for (const property of properties) {
    const name = property.getName()
    if (name === 'prototype' || name.startsWith('__@')) continue
    const propExpr = `${expr}.${name}`
    const propType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? location)
    const value = valueFromTsType(propExpr, propType, checker, property.valueDeclaration ?? location, seen, depth + 1)
      ?? unknown(`Unsupported TypeScript property shape: ${propExpr}`)
    props.set(name, (property.flags & ts.SymbolFlags.Optional) !== 0 && value.kind !== 'nullable'
      ? nullableValue(value, propExpr, 'undefined')
      : value)
  }
  seen.delete(type)
  return {kind: 'object', props, expr}
}

function literalValueFromTsType(expr: string, type: ts.Type): Value | null {
  if (type.isNumberLiteral()) return finiteNumberValue([type.value], expr)
  if (type.isStringLiteral()) return literalValue([type.value], expr)
  const booleanLiteral = booleanLiteralFromTsType(type)
  return booleanLiteral == null ? null : literalValue([booleanLiteral], expr)
}

function booleanLiteralFromTsType(type: ts.Type): boolean | null {
  if ((type.flags & ts.TypeFlags.BooleanLiteral) === 0) return null
  const intrinsicName = (type as {intrinsicName?: string}).intrinsicName
  if (intrinsicName === 'true') return true
  if (intrinsicName === 'false') return false
  return null
}

function joinedTsUnionValue(
  expr: string,
  members: readonly ts.Type[],
  checker: ts.TypeChecker,
  location: ts.Node,
  seen: Set<ts.Type>,
  depth: number,
): Value | null {
  let value: Value | null = null
  for (const member of members) {
    const next = valueFromTsType(expr, member, checker, location, seen, depth + 1)
    if (next == null) return null
    value = value == null ? next : joinValues(value, next)
  }
  return value
}

function unionNullishKind(types: readonly ts.Type[]): NullishKind | null {
  let result: NullishKind | null = null
  for (const type of types) {
    const kind = tsNullishKind(type)
    if (kind == null) continue
    result = result == null ? kind : mergeNullishKind(result, kind)
  }
  return result
}

function tsNullishKind(type: ts.Type): NullishKind | null {
  if ((type.flags & ts.TypeFlags.Null) !== 0) return 'null'
  if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return 'undefined'
  return null
}

function arrayElementTsValue(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, seen: Set<ts.Type>, depth: number): Value | null {
  if (checker.isArrayType(type)) {
    const elementType = checker.getTypeArguments(type as ts.TypeReference)[0]
    return elementType == null ? null : valueFromTsType(expr, elementType, checker, location, seen, depth)
  }
  if (checker.isTupleType(type)) {
    return joinedTupleElementTsValue(expr, checker.getTypeArguments(type as ts.TypeReference), checker, location, seen, depth)
  }
  const elementType = type.getNumberIndexType()
  return elementType == null ? null : valueFromTsType(expr, elementType, checker, location, seen, depth)
}

function tupleArrayTsValue(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, seen: Set<ts.Type>, depth: number): ArrayValue | null {
  const members = checker.getTypeArguments(type as ts.TypeReference)
  if (!isRequiredFixedTuple(type)) {
    return unknownArray(expr, tupleLengthRangeValue(expr, type), joinedTupleElementTsValue(`${expr}[]`, members, checker, location, seen, depth))
  }

  const elements: Value[] = []
  let element: Value | null = null
  for (const [index, member] of members.entries()) {
    const memberValue = valueFromTsType(`${expr}[${index}]`, member, checker, location, seen, depth)
    if (memberValue == null) return null
    elements.push(memberValue)
    element = element == null ? memberValue : joinValues(element, memberValue)
  }
  return tupleArray(expr, tupleLengthRangeValue(expr, type), elements, element)
}

function isRequiredFixedTuple(type: ts.Type) {
  const target = (type as ts.TupleTypeReference).target
  return target.minLength === target.fixedLength
    && (target.combinedFlags & ts.ElementFlags.Variable) === 0
    && target.elementFlags.every(flag => flag === ts.ElementFlags.Required)
}

function joinedTupleElementTsValue(expr: string, members: readonly ts.Type[], checker: ts.TypeChecker, location: ts.Node, seen: Set<ts.Type>, depth: number): Value | null {
  let element: Value | null = null
  for (const member of members) {
    const memberValue = valueFromTsType(expr, member, checker, location, seen, depth)
    if (memberValue == null) return null
    element = element == null ? memberValue : joinValues(element, memberValue)
  }
  return element
}

function tupleLengthRangeValue(expr: string, type: ts.Type) {
  const target = (type as ts.TupleTypeReference).target
  const maxLength = (target.combinedFlags & ts.ElementFlags.Variable) === 0 ? target.fixedLength : Number.POSITIVE_INFINITY
  return tupleLengthValue(expr, target.minLength, maxLength)
}

function tupleLengthValue(expr: string, minLength: number, maxLength: number) {
  const lengthExpr = `${expr}.length`
  return numberValue(minLength, maxLength, true, lengthExpr, linearVariable(linearNameForExpression(lengthExpr)))
}

export function valueFromSyntaxTypeShape(expr: string, type: ts.TypeNode | undefined, program: ShapeProgram, seen: Set<string>): Value | null {
  if (type == null) return null

  if (ts.isParenthesizedTypeNode(type)) return valueFromSyntaxTypeShape(expr, type.type, program, seen)
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return valueFromSyntaxTypeShape(expr, type.type, program, seen)
  if (type.kind === ts.SyntaxKind.NumberKeyword) return unknownNumber(expr)
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return literalValue([false, true], expr)
  if (type.kind === ts.SyntaxKind.StringKeyword) return unknown(`String values are not in the static layout subset: ${expr}`)
  if (type.kind === ts.SyntaxKind.ObjectKeyword) return unknownObject(expr)
  if (ts.isArrayTypeNode(type)) {
    return unknownArray(expr, unknownArrayLength(expr), valueFromSyntaxTypeShape(`${expr}[]`, type.elementType, program, seen))
  }
  if (ts.isTupleTypeNode(type)) return valueFromTupleSyntaxType(expr, type, program, seen)
  if (ts.isUnionTypeNode(type)) return valueFromUnionSyntaxType(expr, type, program, seen)
  if (ts.isIntersectionTypeNode(type)) return valueFromIntersectionSyntaxType(expr, type, program, seen)
  if (ts.isLiteralTypeNode(type)) return valueFromLiteralSyntaxType(expr, type)
  if (ts.isTypeLiteralNode(type)) return objectValueFromTypeMembers(expr, type.members, program, seen)
  if (ts.isTypeReferenceNode(type)) return valueFromTypeReference(expr, type, program, seen)
  return valueFromTypeNodeShape(expr, type, program)
}

function valueFromLiteralSyntaxType(expr: string, type: ts.LiteralTypeNode): Value {
  const literal = type.literal
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) return literalValue([literal.text], expr)
  if (ts.isNumericLiteral(literal)) return finiteNumberValue([Number(literal.text)], expr)
  if (literal.kind === ts.SyntaxKind.TrueKeyword) return literalValue([true], expr)
  if (literal.kind === ts.SyntaxKind.FalseKeyword) return literalValue([false], expr)
  if (ts.isPrefixUnaryExpression(literal) && ts.isNumericLiteral(literal.operand)) {
    const value = Number(literal.operand.text)
    return finiteNumberValue([literal.operator === ts.SyntaxKind.MinusToken ? -value : value], expr)
  }
  return unknown(`Literal value is not in the static layout subset: ${expr}`)
}

function valueFromTupleSyntaxType(expr: string, type: ts.TupleTypeNode, program: ShapeProgram, seen: Set<string>): Value | null {
  const elements: Value[] = []
  let element: Value | null = null
  for (const [index, tupleElement] of type.elements.entries()) {
    const elementType = tupleElementType(tupleElement)
    if (elementType == null) return valueFromTypeNodeShape(expr, type, program)
    const value = valueFromSyntaxTypeShape(`${expr}[${index}]`, elementType, program, seen)
      ?? valueFromTypeNodeShape(`${expr}[${index}]`, elementType, program)
    if (value == null) return null
    elements.push(value)
    element = element == null ? value : joinValues(element, value)
  }
  return tupleArray(expr, tupleLengthValue(expr, elements.length, elements.length), elements, element)
}

function tupleElementType(element: ts.TypeNode | ts.NamedTupleMember): ts.TypeNode | null {
  if (ts.isNamedTupleMember(element)) return element.dotDotDotToken == null && element.questionToken == null ? element.type : null
  if (ts.isOptionalTypeNode(element) || ts.isRestTypeNode(element)) return null
  return element
}

function valueFromTypeReference(expr: string, type: ts.TypeReferenceNode, program: ShapeProgram, seen: Set<string>): Value | null {
  if (!ts.isIdentifier(type.typeName)) return null
  const name = type.typeName.text
  const typeArgument = type.typeArguments?.[0]
  if ((name === 'Array' || name === 'ReadonlyArray') && typeArgument != null) {
    return unknownArray(expr, unknownArrayLength(expr), valueFromSyntaxTypeShape(`${expr}[]`, typeArgument, program, seen))
  }

  const checked = valueFromTypeNodeShape(expr, type, program)
  if (checked != null) return checked

  const key = `${program.sourceId}#${name}`
  if (seen.has(key)) return unknownObject(expr)
  const declaration = localTypeDeclaration(program, name)
  if (declaration == null) return null
  seen.add(key)
  const value = ts.isInterfaceDeclaration(declaration)
    ? objectValueFromTypeMembers(expr, declaration.members, program, seen)
    : valueFromSyntaxTypeShape(expr, declaration.type, program, seen)
  seen.delete(key)
  return value
}

function valueFromUnionSyntaxType(expr: string, type: ts.UnionTypeNode, program: ShapeProgram, seen: Set<string>): Value | null {
  const nullish = unionSyntaxNullishKind(type.types)
  const members = type.types.filter(member => syntaxNullishKind(member) == null)
  if (nullish != null) {
    if (members.length === 0) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
    const present = joinedUnionSyntaxValue(expr, members, program, seen)
    return present == null ? null : nullableValue(present, expr, nullish)
  }
  return joinedUnionSyntaxValue(expr, members, program, seen)
}

function joinedUnionSyntaxValue(expr: string, members: readonly ts.TypeNode[], program: ShapeProgram, seen: Set<string>): Value | null {
  let value: Value | null = null
  for (const member of members) {
    const next = valueFromSyntaxTypeShape(expr, member, program, seen)
    if (next == null) return null
    value = value == null ? next : joinValues(value, next)
  }
  return value
}

function unionSyntaxNullishKind(types: readonly ts.TypeNode[]): NullishKind | null {
  let result: NullishKind | null = null
  for (const type of types) {
    const kind = syntaxNullishKind(type)
    if (kind == null) continue
    result = result == null ? kind : mergeNullishKind(result, kind)
  }
  return result
}

function syntaxNullishKind(type: ts.TypeNode): NullishKind | null {
  if (type.kind === ts.SyntaxKind.UndefinedKeyword || type.kind === ts.SyntaxKind.VoidKeyword) return 'undefined'
  if (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword) return 'null'
  return null
}

function valueFromIntersectionSyntaxType(expr: string, type: ts.IntersectionTypeNode, program: ShapeProgram, seen: Set<string>): Value | null {
  let value: Value | null = null
  for (const member of type.types) {
    const next = valueFromSyntaxTypeShape(expr, member, program, seen)
    if (next == null) return null
    value = value == null ? next : intersectTypeValues(value, next)
  }
  return value
}

function intersectTypeValues(left: Value, right: Value): Value {
  if (left.kind === 'object' && right.kind === 'object') {
    const props = new Map(left.props)
    for (const [name, prop] of right.props) {
      const current = props.get(name)
      props.set(name, current == null ? prop : joinValues(current, prop))
    }
    return {kind: 'object', props, expr: left.expr ?? right.expr}
  }
  if (left.kind === 'array' && right.kind === 'array') return joinValues(left, right)
  return right.kind === 'unknown' ? left : right
}

function objectValueFromTypeMembers(expr: string, members: ts.NodeArray<ts.TypeElement>, program: ShapeProgram, seen: Set<string>): Value {
  const props = new Map<string, Value>()
  for (const member of members) {
    if (!ts.isPropertySignature(member)) continue
    const name = propertyNameText(member.name)
    if (name == null) continue
    const propExpr = `${expr}.${name}`
    const value = valueFromSyntaxTypeShape(propExpr, member.type, program, seen) ?? valueFromTypeNodeShape(propExpr, member.type, program) ?? unknownNumber(propExpr)
    const prop = member.questionToken == null || value.kind === 'nullable'
      ? value
      : nullableValue(value, propExpr, 'undefined')
    props.set(name, prop)
  }
  return {kind: 'object', props, expr}
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function localTypeDeclaration(program: ShapeProgram, name: string): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  for (const statement of program.sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) return statement
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) return statement
  }
  return null
}
