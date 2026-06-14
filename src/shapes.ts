import * as ts from 'typescript'
import {
  finiteNumberValue,
  fixedTupleValue,
  joinValues,
  literalValue,
  mergeNullishKind,
  nullableValue,
  numberValue,
  unknown,
  unknownArray,
  unknownArrayLength,
  unknownNumber,
  unknownObject,
  type NullishKind,
  type Value,
} from './domain.ts'
import {linearConstant} from './linear.ts'
import type {FitDomainPathSegment} from './parser.ts'

export type ShapePathSegment =
  | FitDomainPathSegment
  | {kind: 'index'; index: number}

export type ShapeProgram = {
  sourceId: string
  sourceFile: ts.SourceFile
  typeChecker: ts.TypeChecker | null
  project?: {
    filesBySourceFile: Map<ts.SourceFile, unknown>
  }
}

export function valueFromNodeType(expr: string, node: ts.Node, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  return checker == null ? null : valueFromResolvedType(expr, checker.getTypeAtLocation(node), checker, node)
}

export function valueFromTypeNode(expr: string, node: ts.TypeNode | undefined, program: ShapeProgram): Value | null {
  if (node == null) return null
  if (typeNodeContainsUnsupportedTuple(node, program.typeChecker)) {
    return unknown(`Optional and rest tuple elements are unsupported: ${expr}`)
  }
  const checker = program.typeChecker
  return checker == null ? valueFromTypeNodeSyntax(expr, node) : valueFromResolvedType(expr, checker.getTypeFromTypeNode(node), checker, node)
}

export function valueFromFunctionReturnType(expr: string, fn: ts.SignatureDeclaration, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  const signature = checker.getSignatureFromDeclaration(fn)
  return signature == null ? null : valueFromResolvedType(expr, checker.getReturnTypeOfSignature(signature), checker, fn)
}

export function valueFromProjectCallReturnType(expr: string, call: ts.CallExpression, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  const signature = checker.getResolvedSignature(call)
  if (signature == null || !signatureBelongsToProject(signature, program)) return null
  return valueFromResolvedType(expr, checker.getReturnTypeOfSignature(signature), checker, call)
}

export function valueFromClassInstanceType(expr: string, classNode: ts.ClassDeclaration, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null || classNode.name == null) return null
  const symbol = checker.getSymbolAtLocation(classNode.name)
  return symbol == null ? null : valueFromResolvedType(expr, checker.getDeclaredTypeOfSymbol(symbol), checker, classNode)
}

export function valueFromTypePath(
  expr: string,
  type: ts.Type,
  segments: readonly ShapePathSegment[],
  checker: ts.TypeChecker,
  location: ts.Node,
): Value | null {
  return valueFromTypePathInternal(expr, type, segments, checker, location)
}

export function valueFromFunctionReturnPath(
  expr: string,
  fn: ts.SignatureDeclaration,
  segments: readonly ShapePathSegment[],
  program: ShapeProgram,
): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  const signature = checker.getSignatureFromDeclaration(fn)
  return signature == null
    ? null
    : valueFromTypePath(expr, checker.getReturnTypeOfSignature(signature), segments, checker, fn)
}

export function valueFromTypeNodePath(
  expr: string,
  node: ts.TypeNode | undefined,
  segments: readonly ShapePathSegment[],
  program: ShapeProgram,
): Value | null {
  const checker = program.typeChecker
  return checker == null || node == null
    ? null
    : valueFromTypePath(expr, checker.getTypeFromTypeNode(node), segments, checker, node)
}

export function valueFromNodePath(
  expr: string,
  node: ts.Node,
  segments: readonly ShapePathSegment[],
  program: ShapeProgram,
): Value | null {
  const checker = program.typeChecker
  return checker == null ? null : valueFromTypePath(expr, checker.getTypeAtLocation(node), segments, checker, node)
}

function signatureBelongsToProject(signature: ts.Signature, program: ShapeProgram) {
  const declaration = signature.declaration
  return declaration != null && program.project?.filesBySourceFile.has(declaration.getSourceFile()) === true
}

export function typeNodeContainsUnsupportedTuple(
  node: ts.TypeNode,
  checker: ts.TypeChecker | null,
  seen: Set<ts.Node> = new Set(),
): boolean {
  if (seen.has(node)) return false
  seen.add(node)
  if (ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node)) return true
  if (ts.isNamedTupleMember(node)) {
    return node.questionToken != null
      || node.dotDotDotToken != null
      || typeNodeContainsUnsupportedTuple(node.type, checker, seen)
  }
  if (ts.isTupleTypeNode(node)) {
    return node.elements.some(element => typeNodeContainsUnsupportedTuple(element, checker, seen))
  }
  if (ts.isTypeReferenceNode(node) && checker != null) {
    const symbol = checker.getSymbolAtLocation(node.typeName)
    if (symbol?.declarations?.some(declaration =>
      ts.isTypeAliasDeclaration(declaration)
      && typeNodeContainsUnsupportedTuple(declaration.type, checker, seen)) === true) return true
  }
  return node.getChildren().some(child =>
    ts.isTypeNode(child) && typeNodeContainsUnsupportedTuple(child, checker, seen))
}

function valueFromTypePathInternal(
  expr: string,
  type: ts.Type,
  segments: readonly ShapePathSegment[],
  checker: ts.TypeChecker,
  location: ts.Node,
): Value | null {
  if (segments.length === 0) return valueFromResolvedType(expr, type, checker, location)

  if (type.isUnion()) {
    const nullish = unionNullishKind(type.types)
    if (nullish != null) return null
    let value: Value | null = null
    for (const member of type.types) {
      const next = valueFromTypePathInternal(expr, member, segments, checker, location)
      if (next == null) return null
      value = value == null ? next : joinValues(value, next)
    }
    return value
  }

  if (checker.isTupleType(type) && fixedTupleElementTypes(type, checker) == null) {
    return unknown(`Optional and rest tuple elements are unsupported: ${expr}`)
  }

  const [segment, ...rest] = segments
  if (segment == null) return valueFromResolvedType(expr, type, checker, location)
  if (segment.kind === 'prop') {
    if (segment.name === 'length' && isArrayLikeType(type, checker)) {
      if (rest.length !== 0) return null
      const members = fixedTupleElementTypes(type, checker)
      return members == null
        ? arrayLengthValue(expr)
        : numberValue(members.length, members.length, 0, expr, linearConstant(members.length))
    }
    const next = propertyType(type, segment.name, checker, location)
    return next == null ? null : valueFromTypePathInternal(`${expr}.${segment.name}`, next, rest, checker, location)
  }

  if (segment.kind === 'index') {
    const next = indexedElementType(type, segment.index, checker)
    return next == null ? null : valueFromTypePathInternal(`${expr}[${segment.index}]`, next, rest, checker, location)
  }

  const tupleMembers = fixedTupleElementTypes(type, checker)
  if (tupleMembers != null) {
    let value: Value | null = null
    for (const member of tupleMembers) {
      const next = valueFromTypePathInternal(`${expr}[]`, member, rest, checker, location)
      if (next == null) return null
      value = value == null ? next : joinValues(value, next)
    }
    return value
  }

  const next = arrayElementType(type, checker)
  return next == null ? null : valueFromTypePathInternal(`${expr}[]`, next, rest, checker, location)
}

function propertyType(type: ts.Type, name: string, checker: ts.TypeChecker, location: ts.Node): ts.Type | null {
  const property = checker.getPropertyOfType(type, name) ?? checker.getPropertyOfType(checker.getApparentType(type), name)
  return property == null ? null : checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? location)
}

export function arrayElementType(type: ts.Type, checker: ts.TypeChecker): ts.Type | null {
  if (checker.isArrayType(type)) return checker.getTypeArguments(type as ts.TypeReference)[0] ?? null
  return type.getNumberIndexType() ?? checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? null
}

function indexedElementType(type: ts.Type, index: number, checker: ts.TypeChecker): ts.Type | null {
  if (checker.isTupleType(type)) return fixedTupleElementTypes(type, checker)?.[index] ?? null
  return arrayElementType(type, checker)
}

export function fixedTupleElementTypes(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] | null {
  if (!checker.isTupleType(type)) return null
  const tuple = type as ts.TupleTypeReference
  if (tuple.target.elementFlags.some(flag => flag !== ts.ElementFlags.Required)) return null
  return checker.getTypeArguments(tuple)
}

export function resolvedTypeContainsUnsupportedTuple(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (checker.isTupleType(type)) {
    const members = fixedTupleElementTypes(type, checker)
    return members == null || members.some(member => resolvedTypeContainsUnsupportedTuple(member, checker, seen))
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some(member => resolvedTypeContainsUnsupportedTuple(member, checker, seen))
  }
  const element = arrayElementType(type, checker)
  return element != null
    && element !== type
    && resolvedTypeContainsUnsupportedTuple(element, checker, seen)
}

export function valueFromResolvedType(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node): Value | null {
  if (resolvedTypeContainsUnsupportedTuple(type, checker)) {
    return unknown(`Optional and rest tuple elements are unsupported: ${expr}`)
  }
  if (type.isUnion()) return valueFromUnionType(expr, type.types, checker, location)
  if (tsNullishKind(type) != null) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
  const literal = literalValueFromTsType(expr, type)
  if (literal != null) return literal
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return null
  if (checker.isTypeAssignableTo(type, checker.getNumberType())) return unknownNumber(expr)
  if (checker.isTypeAssignableTo(type, checker.getBooleanType())) return literalValue([false, true], expr)
  if (checker.isTypeAssignableTo(type, checker.getStringType())) return unknown(`String values are not in the static layout subset: ${expr}`)
  if (checker.isTupleType(type)) {
    const members = fixedTupleElementTypes(type, checker)
    if (members == null) return unknown(`Optional and rest tuple elements are unsupported: ${expr}`)
    const elements = members.map((member, index) =>
      valueFromResolvedType(`${expr}[${index}]`, member, checker, location)
      ?? unknown(`${expr}[${index}] was not inferred from its tuple type`))
    return fixedTupleValue(elements, expr)
  }
  if (checker.isArrayLikeType(type)) return unknownArray(expr, arrayLengthValue(expr))
  if ((type.flags & ts.TypeFlags.Object) !== 0) return unknownObject(expr)
  return type.getProperties().length === 0 ? null : unknownObject(expr)
}

function valueFromTypeNodeSyntax(expr: string, node: ts.TypeNode): Value | null {
  if (ts.isParenthesizedTypeNode(node)) return valueFromTypeNodeSyntax(expr, node.type)
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return valueFromTypeNodeSyntax(expr, node.type)
  if (ts.isUnionTypeNode(node)) {
    let value: Value | null = null
    let nullish: NullishKind | null = null
    for (const member of node.types) {
      const kind = typeNodeNullishKind(member)
      if (kind != null) {
        nullish = nullish == null ? kind : mergeNullishKind(nullish, kind)
        continue
      }
      const next = valueFromTypeNodeSyntax(expr, member)
      if (next == null) return null
      value = value == null ? next : joinValues(value, next)
    }
    if (value == null) return nullish == null ? null : unknown(`Nullish value is not in the static layout subset: ${expr}`)
    return nullish == null ? value : nullableValue(value, expr, nullish)
  }
  if (ts.isLiteralTypeNode(node)) return literalValueFromTypeNode(expr, node)
  if (ts.isArrayTypeNode(node)) return unknownArray(expr)
  if (ts.isTupleTypeNode(node)) {
    if (node.elements.some(element =>
      ts.isOptionalTypeNode(element)
      || ts.isRestTypeNode(element)
      || (ts.isNamedTupleMember(element) && (element.questionToken != null || element.dotDotDotToken != null)))) {
      return unknown(`Optional and rest tuple elements are unsupported: ${expr}`)
    }
    return fixedTupleValue(node.elements.map((element, index) => {
      const type = ts.isNamedTupleMember(element) ? element.type : element
      return valueFromTypeNodeSyntax(`${expr}[${index}]`, type)
        ?? unknown(`${expr}[${index}] was not inferred from its tuple type`)
    }), expr)
  }
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return unknownNumber(expr)
    case ts.SyntaxKind.BooleanKeyword:
      return literalValue([false, true], expr)
    case ts.SyntaxKind.StringKeyword:
      return unknown(`String values are not in the static layout subset: ${expr}`)
    default:
      return null
  }
}

function literalValueFromTypeNode(expr: string, node: ts.LiteralTypeNode): Value | null {
  const literal = node.literal
  if (ts.isNumericLiteral(literal)) return finiteNumberValue([Number(literal.text)], expr)
  if (ts.isStringLiteral(literal)) return literalValue([literal.text], expr)
  if (literal.kind === ts.SyntaxKind.TrueKeyword) return literalValue([true], expr)
  if (literal.kind === ts.SyntaxKind.FalseKeyword) return literalValue([false], expr)
  return null
}

function typeNodeNullishKind(node: ts.TypeNode): NullishKind | null {
  if (node.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.VoidKeyword) return 'undefined'
  return null
}

function valueFromUnionType(expr: string, types: readonly ts.Type[], checker: ts.TypeChecker, location: ts.Node): Value | null {
  const nullish = unionNullishKind(types)
  const members = types.filter(type => tsNullishKind(type) == null)
  if (members.length === 0) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
  let value: Value | null = null
  for (const member of members) {
    const next = valueFromResolvedType(expr, member, checker, location)
    if (next == null) return null
    value = value == null ? next : joinValues(value, next)
  }
  if (value == null) return null
  return nullish == null ? value : nullableValue(value, expr, nullish)
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

function unionNullishKind(types: readonly ts.Type[]): NullishKind | null {
  let result: NullishKind | null = null
  for (const type of types) {
    const kind = tsNullishKind(type)
    if (kind == null) continue
    result = result == null ? kind : mergeNullishKind(result, kind)
  }
  return result
}

export function tsNullishKind(type: ts.Type): NullishKind | null {
  if ((type.flags & ts.TypeFlags.Null) !== 0) return 'null'
  if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return 'undefined'
  return null
}

function arrayLengthValue(expr: string) {
  return unknownArrayLength(expr)
}

export function isArrayLikeType(type: ts.Type, checker: ts.TypeChecker) {
  return checker.isTupleType(type) || checker.isArrayLikeType(type)
}
