import * as ts from 'typescript'
import {
  finiteNumberValue,
  joinValues,
  linearNameForExpression,
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
import {linearVariable} from './linear.ts'
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
  return checker == null ? null : valueFromTsType(expr, checker.getTypeAtLocation(node), checker, node)
}

export function valueFromTypeNode(expr: string, node: ts.TypeNode | undefined, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  return checker == null || node == null ? null : valueFromTsType(expr, checker.getTypeFromTypeNode(node), checker, node)
}

export function valueFromFunctionReturnType(expr: string, fn: ts.SignatureDeclaration, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  const signature = checker.getSignatureFromDeclaration(fn)
  return signature == null ? null : valueFromTsType(expr, checker.getReturnTypeOfSignature(signature), checker, fn)
}

export function valueFromProjectCallReturnType(expr: string, call: ts.CallExpression, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null) return null
  const signature = checker.getResolvedSignature(call)
  if (signature == null || !signatureBelongsToProject(signature, program)) return null
  return valueFromTsType(expr, checker.getReturnTypeOfSignature(signature), checker, call)
}

export function valueFromClassInstanceType(expr: string, classNode: ts.ClassDeclaration, program: ShapeProgram): Value | null {
  const checker = program.typeChecker
  if (checker == null || classNode.name == null) return null
  const symbol = checker.getSymbolAtLocation(classNode.name)
  return symbol == null ? null : valueFromTsType(expr, checker.getDeclaredTypeOfSymbol(symbol), checker, classNode)
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

function valueFromTypePathInternal(
  expr: string,
  type: ts.Type,
  segments: readonly ShapePathSegment[],
  checker: ts.TypeChecker,
  location: ts.Node,
): Value | null {
  if (segments.length === 0) return valueFromTsType(expr, type, checker, location)

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

  const [segment, ...rest] = segments
  if (segment == null) return valueFromTsType(expr, type, checker, location)
  if (segment.kind === 'prop') {
    if (segment.name === 'length' && isArrayLikeType(type, checker)) {
      return rest.length === 0 ? arrayLengthValue(expr, type) : null
    }
    const next = propertyType(type, segment.name, checker, location)
    return next == null ? null : valueFromTypePathInternal(`${expr}.${segment.name}`, next, rest, checker, location)
  }

  if (segment.kind === 'index') {
    const next = indexedElementType(type, segment.index, checker)
    return next == null ? null : valueFromTypePathInternal(`${expr}[${segment.index}]`, next, rest, checker, location)
  }

  const tupleMembers = tupleElementTypes(type, checker)
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

function arrayElementType(type: ts.Type, checker: ts.TypeChecker): ts.Type | null {
  if (checker.isArrayType(type)) return checker.getTypeArguments(type as ts.TypeReference)[0] ?? null
  return type.getNumberIndexType() ?? checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? null
}

function indexedElementType(type: ts.Type, index: number, checker: ts.TypeChecker): ts.Type | null {
  const tupleMembers = tupleElementTypes(type, checker)
  if (tupleMembers != null) return tupleMembers[index] ?? null
  return arrayElementType(type, checker)
}

function tupleElementTypes(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] | null {
  if (!checker.isTupleType(type)) return null
  const members = checker.getTypeArguments(type as ts.TypeReference)
  return members.length === 0 ? null : members
}

function valueFromTsType(expr: string, type: ts.Type, checker: ts.TypeChecker, location: ts.Node): Value | null {
  if (type.isUnion()) return valueFromUnionType(expr, type.types, checker, location)
  if (tsNullishKind(type) != null) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
  const literal = literalValueFromTsType(expr, type)
  if (literal != null) return literal
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return unknownNumber(expr)
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return literalValue([false, true], expr)
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return unknown(`String values are not in the static layout subset: ${expr}`)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return null
  if (isArrayLikeType(type, checker)) return unknownArray(expr, arrayLengthValue(expr, type))
  return type.getProperties().length === 0 ? null : unknownObject(expr)
}

function valueFromUnionType(expr: string, types: readonly ts.Type[], checker: ts.TypeChecker, location: ts.Node): Value | null {
  const nullish = unionNullishKind(types)
  const members = types.filter(type => tsNullishKind(type) == null)
  if (members.length === 0) return unknown(`Nullish value is not in the static layout subset: ${expr}`)
  let value: Value | null = null
  for (const member of members) {
    const next = valueFromTsType(expr, member, checker, location)
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

function tsNullishKind(type: ts.Type): NullishKind | null {
  if ((type.flags & ts.TypeFlags.Null) !== 0) return 'null'
  if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return 'undefined'
  return null
}

function arrayLengthValue(expr: string, type: ts.Type) {
  if (isTupleTypeReference(type)) {
    const maxLength = (type.target.combinedFlags & ts.ElementFlags.Variable) === 0 ? type.target.fixedLength : Number.POSITIVE_INFINITY
    return tupleLengthValue(expr, type.target.minLength, maxLength)
  }
  return unknownArrayLength(expr)
}

function isArrayLikeType(type: ts.Type, checker: ts.TypeChecker) {
  return checker.isTupleType(type) || checker.isArrayLikeType(type)
}

function isTupleTypeReference(type: ts.Type): type is ts.TupleTypeReference {
  return (type as Partial<ts.TupleTypeReference>).target?.elementFlags != null
}

function tupleLengthValue(expr: string, minLength: number, maxLength: number) {
  const lengthExpr = `${expr}.length`
  return numberValue(minLength, maxLength, true, lengthExpr, linearVariable(linearNameForExpression(lengthExpr)))
}
