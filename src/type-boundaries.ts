import * as ts from 'typescript'
import {
  arrayAsCollection,
  arrayElement,
  arrayLength,
  arraySummary,
  collectionValue,
  fixedTupleValue,
  joinValues,
  unsupportedTupleValue,
  unknown,
  type Value,
} from './domain.ts'
import {
  arrayElementType,
  fixedTupleElementTypes,
  isArrayLikeType,
  resolvedTypeContainsUnsupportedTuple,
  tsNullishKind,
  typeNodeContainsUnsupportedTuple,
  valueFromFunctionReturnType,
  valueFromNodeType,
  valueFromResolvedType,
  valueFromTypeNode,
  type ShapeProgram,
} from './shapes.ts'

export function valueAtNodeTypeBoundary(value: Value, expr: string, node: ts.Node, program: ShapeProgram): Value {
  const checker = program.typeChecker
  return checker == null
    ? adaptValueToShape(value, valueFromNodeType(expr, node, program))
    : adaptValueToTsType(value, expr, checker.getTypeAtLocation(node), checker, node)
}

export function valueAtTypeNodeBoundary(
  value: Value,
  expr: string,
  node: ts.TypeNode | undefined,
  fallbackNode: ts.Node,
  program: ShapeProgram,
): Value {
  if (node != null && typeNodeContainsUnsupportedTuple(node, program.typeChecker)) {
    return unsupportedTupleValue(`Optional and rest tuple elements are unsupported: ${expr}`)
  }
  const checker = program.typeChecker
  if (checker == null) {
    return adaptValueToShape(value, valueFromTypeNode(expr, node, program) ?? valueFromNodeType(expr, fallbackNode, program))
  }
  const type = node == null ? checker.getTypeAtLocation(fallbackNode) : checker.getTypeFromTypeNode(node)
  return adaptValueToTsType(value, expr, type, checker, node ?? fallbackNode)
}

export function valueAtFunctionReturnBoundary(
  value: Value,
  expr: string,
  fn: ts.SignatureDeclaration,
  program: ShapeProgram,
): Value {
  if (fn.type == null) return value
  if (typeNodeContainsUnsupportedTuple(fn.type, program.typeChecker)) {
    return unsupportedTupleValue(`Optional and rest tuple elements are unsupported: ${expr}`)
  }
  const checker = program.typeChecker
  if (checker == null) return adaptValueToShape(value, valueFromFunctionReturnType(expr, fn, program))
  return adaptValueToTsType(value, expr, checker.getTypeFromTypeNode(fn.type), checker, fn.type)
}

function adaptValueToShape(value: Value, shape: Value | null): Value {
  if (shape == null) return value
  if (shape.kind === 'unknown' && shape.cause === 'unsupported-tuple') return shape
  if (shape.kind === 'array') {
    if (value.kind === 'unknown') return unknownCanUseTypeFallback(value) ? shape : value
    if (value.kind !== 'array') return value
    if (shape.layout === 'collection') {
      return collectionValue(arrayLength(value), arrayElement(value), value.expr, value.referenceIds, arraySummary(value))
    }
    return value.layout === 'tuple' && value.elements.length === shape.elements.length
      ? value
      : unknown(`A fixed tuple with ${shape.elements.length} elements was required`)
  }
  if (shape.kind === 'nullable' && value.kind === 'nullable') {
    return {...value, present: adaptValueToShape(value.present, shape.present)}
  }
  return value.kind === 'unknown' && unknownCanUseTypeFallback(value) ? shape : value
}

function adaptValueToTsType(
  value: Value,
  expr: string,
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
): Value {
  if (resolvedTypeContainsUnsupportedTuple(type, checker)) {
    return unsupportedTupleValue(`Optional and rest tuple elements are unsupported: ${expr}`)
  }
  if (type.isUnion()) {
    const presentTypes = type.types.filter(member => tsNullishKind(member) == null)
    const presentValue = value.kind === 'nullable' ? value.present : value
    let adapted = presentValue
    if (presentTypes.length > 0 && presentTypes.every(member => isArrayLikeType(member, checker))) {
      const tupleMembers = presentTypes.map(member => fixedTupleElementTypes(member, checker))
      if (tupleMembers.every(members => members != null)) {
        const lengths = new Set(tupleMembers.map(members => members.length))
        if (lengths.size === 1) {
          if (presentValue.kind === 'unknown') {
            adapted = unknownCanUseTypeFallback(presentValue)
              ? valueFromResolvedType(expr, type, checker, location) ?? presentValue
              : presentValue
          } else if (presentValue.kind === 'array' && presentValue.layout === 'tuple'
            && presentValue.elements.length === tupleMembers[0]!.length) {
            adapted = presentTypes
              .map(member => adaptValueToTsType(presentValue, expr, member, checker, location))
              .reduce(joinValues)
          } else {
            adapted = unknown(`A fixed tuple with ${tupleMembers[0]!.length} elements was required`)
          }
        } else {
          adapted = presentValue.kind === 'array'
            ? arrayAsCollection(presentValue)
            : presentValue.kind === 'unknown' && unknownCanUseTypeFallback(presentValue)
              ? valueFromResolvedType(expr, type, checker, location) ?? presentValue
              : presentValue
        }
      } else {
        adapted = presentValue.kind === 'array'
          ? arrayAsCollection(presentValue)
          : presentValue.kind === 'unknown' && unknownCanUseTypeFallback(presentValue)
            ? valueFromResolvedType(expr, type, checker, location) ?? presentValue
            : presentValue
      }
    } else if (presentValue.kind === 'unknown' && unknownCanUseTypeFallback(presentValue)) {
      adapted = valueFromResolvedType(expr, type, checker, location) ?? presentValue
    }
    return value.kind === 'nullable' ? {...value, present: adapted} : adapted
  }

  if (checker.isTupleType(type)) {
    const members = fixedTupleElementTypes(type, checker)
    if (members == null) return unsupportedTupleValue(`Optional and rest tuple elements are unsupported: ${expr}`)
    if (value.kind === 'unknown') {
      const shape = valueFromResolvedType(expr, type, checker, location)
      return shape != null && unknownCanUseTypeFallback(value) ? shape : value
    }
    if (value.kind !== 'array' || value.layout !== 'tuple' || value.elements.length !== members.length) {
      return unknown(`A fixed tuple with ${members.length} elements was required`)
    }
    return fixedTupleValue(
      value.elements.map((element, index) =>
        adaptValueToTsType(element, `${expr}[${index}]`, members[index]!, checker, location)),
      value.expr,
      value.referenceIds,
    )
  }

  if (checker.isArrayLikeType(type)) {
    if (value.kind === 'unknown') {
      const shape = valueFromResolvedType(expr, type, checker, location)
      return shape != null && unknownCanUseTypeFallback(value) ? shape : value
    }
    if (value.kind !== 'array') return value
    const targetElementType = arrayElementType(type, checker)
    const element = arrayElement(value)
    return collectionValue(
      arrayLength(value),
      element == null || targetElementType == null
        ? element
        : adaptValueToTsType(element, `${expr}[]`, targetElementType, checker, location),
      value.expr,
      value.referenceIds,
      arraySummary(value),
    )
  }

  if ((type.flags & ts.TypeFlags.Object) !== 0 && value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const symbol of type.getProperties()) {
      const current = value.props.get(symbol.name)
      if (current == null) continue
      props.set(symbol.name, adaptValueToTsType(
        current,
        `${expr}.${symbol.name}`,
        checker.getTypeOfSymbolAtLocation(symbol, location),
        checker,
        location,
      ))
    }
    return {...value, props}
  }

  if (value.kind === 'unknown' && unknownCanUseTypeFallback(value)) {
    return valueFromResolvedType(expr, type, checker, location) ?? value
  }
  return value
}

function unknownCanUseTypeFallback(value: Extract<Value, {kind: 'unknown'}>) {
  return value.cause === 'not-inferred'
}
