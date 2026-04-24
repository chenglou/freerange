import * as ts from 'typescript'
import {
  joinValues,
  numberValue,
  unknown,
  unknownArray,
  unknownArrayLength,
  unknownNumber,
  unknownObject,
  type Value,
} from './domain.ts'
import {linearConstant, numericLiteralValue} from './linear.ts'

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
  return {
    ...value,
    elements: value.elements == null
      ? null
      : value.elements.map((element, index) => valueWithStructuralFallback(element, fallback.elements?.[index] ?? fallbackElement)),
    element: value.element == null ? fallbackElement : valueWithStructuralFallback(value.element, fallbackElement),
    expr: value.expr ?? fallback.expr,
  }
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
  if (isNullishTsType(type)) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
  const literal = tsNumberLiteralValue(type)
  if (literal != null) return numberLiteralValue(expr, literal)
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return unknownNumber(expr)
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return unknown(`Boolean values are not in the static layout subset: ${expr}`)
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return unknown(`String values are not in the static layout subset: ${expr}`)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return null

  if (type.isUnion()) {
    if (type.types.some(isNullishTsType)) return unknown(`Optional or nullable value is not in the static layout subset: ${expr}`)
    if (type.types.length > maxTsShapeUnionMembers) return null
    let value: Value | null = null
    for (const member of type.types) {
      const next = valueFromTsType(expr, member, checker, location, seen, depth + 1)
      if (next == null) return null
      value = value == null ? next : joinValues(value, next)
    }
    return value
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
    if ((property.flags & ts.SymbolFlags.Optional) !== 0) {
      props.set(name, unknown(`Optional property ${propExpr} is not in the static layout subset`))
      continue
    }
    const propType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? location)
    const value = valueFromTsType(propExpr, propType, checker, property.valueDeclaration ?? location, seen, depth + 1)
    props.set(name, value ?? unknown(`Unsupported TypeScript property shape: ${propExpr}`))
  }
  seen.delete(type)
  return {kind: 'object', props, expr}
}

function tsNumberLiteralValue(type: ts.Type): number | null {
  if ((type.flags & ts.TypeFlags.NumberLiteral) === 0) return null
  const value = (type as ts.LiteralType).value
  return typeof value === 'number' ? value : null
}

function numberLiteralValue(expr: string, value: number) {
  return numberValue(value, value, Number.isInteger(value), expr, linearConstant(value))
}

function isNullishTsType(type: ts.Type) {
  return (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
}

function arrayElementTsValue(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, seen: Set<ts.Type>, depth: number): Value | null {
  if (checker.isArrayType(type)) {
    const elementType = checker.getTypeArguments(type as ts.TypeReference)[0]
    return elementType == null ? null : valueFromTsType(expr, elementType, checker, location, seen, depth)
  }
  if (checker.isTupleType(type)) {
    let element: Value | null = null
    for (const member of checker.getTypeArguments(type as ts.TypeReference)) {
      const memberValue = valueFromTsType(expr, member, checker, location, seen, depth)
      if (memberValue == null) return null
      element = element == null ? memberValue : joinValues(element, memberValue)
    }
    return element
  }
  const elementType = type.getNumberIndexType()
  return elementType == null ? null : valueFromTsType(expr, elementType, checker, location, seen, depth)
}

export function valueFromSyntaxTypeShape(expr: string, type: ts.TypeNode | undefined, program: ShapeProgram, seen: Set<string>): Value | null {
  if (type == null) return null

  if (ts.isParenthesizedTypeNode(type)) return valueFromSyntaxTypeShape(expr, type.type, program, seen)
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return valueFromSyntaxTypeShape(expr, type.type, program, seen)
  if (type.kind === ts.SyntaxKind.NumberKeyword) return unknownNumber(expr)
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return unknown(`Boolean values are not in the static layout subset: ${expr}`)
  if (type.kind === ts.SyntaxKind.StringKeyword) return unknown(`String values are not in the static layout subset: ${expr}`)
  if (type.kind === ts.SyntaxKind.ObjectKeyword) return unknownObject(expr)
  if (ts.isArrayTypeNode(type)) {
    return unknownArray(expr, unknownArrayLength(expr), valueFromSyntaxTypeShape(`${expr}[]`, type.elementType, program, seen))
  }
  if (ts.isUnionTypeNode(type)) return valueFromUnionSyntaxType(expr, type, program, seen)
  if (ts.isIntersectionTypeNode(type)) return valueFromIntersectionSyntaxType(expr, type, program, seen)
  if (ts.isLiteralTypeNode(type)) {
    const literal = numericLiteralValue(type.literal)
    return literal == null ? unknown(`Literal values are not in the static layout subset: ${expr}`) : numberLiteralValue(expr, literal)
  }
  if (ts.isTypeLiteralNode(type)) return objectValueFromTypeMembers(expr, type.members, program, seen)
  if (ts.isTypeReferenceNode(type)) return valueFromTypeReference(expr, type, program, seen)
  return valueFromTypeNodeShape(expr, type, program)
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
  let value: Value | null = null
  for (const member of type.types) {
    const next = valueFromSyntaxTypeShape(expr, member, program, seen)
    if (next == null) return null
    value = value == null ? next : joinValues(value, next)
  }
  return value
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
    const value = member.questionToken == null
      ? valueFromSyntaxTypeShape(propExpr, member.type, program, seen) ?? valueFromTypeNodeShape(propExpr, member.type, program) ?? unknownNumber(propExpr)
      : unknown(`Optional property ${propExpr} is not in the static layout subset`)
    props.set(name, value)
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
