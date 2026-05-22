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
  project?: {
    filesBySourceFile: Map<ts.SourceFile, unknown>
  }
}

const maxTsShapeDepth = 8
const maxTsShapeNodes = 220
const maxTsShapeUnionMembers = 8
const maxTsShapeProperties = 80

type TsShapeState = {
  seen: Set<unknown>
  remaining: number
}

export function valueFromNodeShape(expr: string, node: ts.Node, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  return safeTsShape(() => valueFromTsType(expr, checker.getTypeAtLocation(node), checker, node, tsShapeState(), 0))
}

export function valueFromTypeNodeShape(expr: string, node: ts.TypeNode | undefined, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null || node == null) return null
  return safeTsShape(() => valueFromTsType(expr, checker.getTypeFromTypeNode(node), checker, node, tsShapeState(), 0))
}

export function valueFromFunctionReturnShape(expr: string, fn: ts.SignatureDeclaration, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  return safeTsShape(() => {
    const signature = checker.getSignatureFromDeclaration(fn)
    if (signature == null) return null
    return valueFromTsType(expr, checker.getReturnTypeOfSignature(signature), checker, fn, tsShapeState(), 0)
  })
}

export function valueFromCallReturnShape(expr: string, call: ts.CallExpression, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  return safeTsShape(() => {
    const signature = checker.getResolvedSignature(call)
    if (signature == null) return null
    return valueFromTsType(expr, checker.getReturnTypeOfSignature(signature), checker, call, tsShapeState(), 0)
  })
}

export function valueFromProjectCallReturnShape(expr: string, call: ts.CallExpression, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  return safeTsShape(() => {
    const signature = checker.getResolvedSignature(call)
    if (signature == null || !signatureBelongsToProject(signature, program)) return null
    return valueFromTsType(expr, checker.getReturnTypeOfSignature(signature), checker, call, tsShapeState(), 0)
  })
}

function signatureBelongsToProject(signature: ts.Signature, program: ShapeProgram) {
  const declaration = signature.declaration
  if (declaration == null) return false
  return program.project?.filesBySourceFile.has(declaration.getSourceFile()) === true
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

function safeTsShape(evaluate: () => Value | null): Value | null {
  try {
    return evaluate()
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

function tsShapeState(): TsShapeState {
  return {seen: new Set(), remaining: maxTsShapeNodes}
}

function valueFromTsType(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, state: TsShapeState, depth: number): Value | null {
  if (depth > maxTsShapeDepth) return null
  if (state.remaining-- <= 0) return null
  const typeKey = tsShapeTypeKey(type)
  if (state.seen.has(typeKey)) return unknownObject(expr)
  if (tsNullishKind(type) != null) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
  const literal = literalValueFromTsType(expr, type)
  if (literal != null) return literal
  state.seen.add(typeKey)
  try {
    return valueFromTsTypeUnchecked(expr, type, checker, location, state, depth)
  } finally {
    state.seen.delete(typeKey)
  }
}

function tsShapeTypeKey(type: ts.Type): unknown {
  return (type as {id?: number}).id ?? type
}

function valueFromTsTypeUnchecked(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, state: TsShapeState, depth: number): Value | null {
  if (type.isUnion()) {
    if (type.types.length > maxTsShapeUnionMembers) return null
    const nullish = unionNullishKind(type.types)
    const members = type.types.filter(member => tsNullishKind(member) == null)
    if (nullish != null) {
      if (members.length === 0) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
      if (members.length === 1) {
        const present = valueFromTsType(expr, members[0]!, checker, location, state, depth + 1)
        return present == null ? null : nullableValue(present, expr, nullish)
      }
      if (!members.every(isJoinableTsUnionMember)) return null
      const present = joinedTsUnionValue(expr, members, checker, location, state, depth)
      return present == null ? null : nullableValue(present, expr, nullish)
    }
    if (!members.every(isJoinableTsUnionMember)) return null
    return joinedTsUnionValue(expr, members, checker, location, state, depth)
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return unknownNumber(expr)
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return literalValue([false, true], expr)
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return unknown(`String values are not in the static layout subset: ${expr}`)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return null

  if (checker.isTupleType(type)) {
    return tupleArrayTsValue(expr, type, checker, location, state, depth + 1)
  }

  if (checker.isArrayLikeType(type)) {
    const element = arrayElementTsValue(`${expr}[]`, type, checker, location, state, depth + 1)
    return unknownArray(expr, unknownArrayLength(expr), element)
  }

  const properties = type.getProperties()
  if (properties.length === 0) return null
  if (properties.length > maxTsShapeProperties) return null

  const props = new Map<string, Value>()
  for (const property of properties) {
    const name = property.getName()
    if (name === 'prototype' || name.startsWith('__@')) continue
    const propExpr = `${expr}.${name}`
    const propType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? location)
    const value = valueFromTsType(propExpr, propType, checker, property.valueDeclaration ?? location, state, depth + 1)
      ?? unknown(`Unsupported TypeScript property shape: ${propExpr}`)
    props.set(name, (property.flags & ts.SymbolFlags.Optional) !== 0 && value.kind !== 'nullable'
      ? nullableValue(value, propExpr, 'undefined')
      : value)
  }
  return {kind: 'object', props, expr}
}

function isJoinableTsUnionMember(type: ts.Type) {
  return literalValueFromTsType(null, type) != null
    || (type.flags & (
      ts.TypeFlags.NumberLike
      | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.StringLike
      | ts.TypeFlags.Any
      | ts.TypeFlags.Unknown
      | ts.TypeFlags.Never
    )) !== 0
}

function literalValueFromTsType(expr: string | null, type: ts.Type): Value | null {
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
  state: TsShapeState,
  depth: number,
): Value | null {
  let value: Value | null = null
  for (const member of members) {
    const next = valueFromTsType(expr, member, checker, location, state, depth + 1)
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

function arrayElementTsValue(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, state: TsShapeState, depth: number): Value | null {
  if (checker.isArrayType(type)) {
    const elementType = checker.getTypeArguments(type as ts.TypeReference)[0]
    return elementType == null ? null : valueFromTsType(expr, elementType, checker, location, state, depth)
  }
  if (checker.isTupleType(type)) {
    return joinedTupleElementTsValue(expr, checker.getTypeArguments(type as ts.TypeReference), checker, location, state, depth)
  }
  const elementType = type.getNumberIndexType()
  return elementType == null ? null : valueFromTsType(expr, elementType, checker, location, state, depth)
}

function tupleArrayTsValue(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node, state: TsShapeState, depth: number): ArrayValue | null {
  const members = checker.getTypeArguments(type as ts.TypeReference)
  if (!isRequiredFixedTuple(type)) {
    return unknownArray(expr, tupleLengthRangeValue(expr, type), joinedTupleElementTsValue(`${expr}[]`, members, checker, location, state, depth))
  }

  const elements: Value[] = []
  let element: Value | null = null
  for (const [index, member] of members.entries()) {
    const memberValue = valueFromTsType(`${expr}[${index}]`, member, checker, location, state, depth)
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

function joinedTupleElementTsValue(expr: string, members: readonly ts.Type[], checker: ts.TypeChecker, location: ts.Node, state: TsShapeState, depth: number): Value | null {
  let element: Value | null = null
  for (const member of members) {
    const memberValue = valueFromTsType(expr, member, checker, location, state, depth)
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

export function valueFromClassInstanceShape(expr: string, classNode: ts.ClassDeclaration, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null || classNode.name == null) return null
  return safeTsShape(() => {
    const symbol = checker.getSymbolAtLocation(classNode.name!)
    if (symbol == null) return null
    return valueFromTsType(expr, checker.getDeclaredTypeOfSymbol(symbol), checker, classNode, tsShapeState(), 0)
  })
}
