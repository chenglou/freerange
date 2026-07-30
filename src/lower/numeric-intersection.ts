import * as ts from 'typescript'

// TypeScript represents numeric brands as a number intersected with object metadata.
// Freerange uses the number and ignores the metadata; reading that metadata still stops
// because the runtime value is modeled as a number, not a record.
export function numberConstituent(type: ts.Type): ts.Type | null {
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return type
  if (!type.isIntersection()) return null
  const numberTypes = type.types.filter(member => (member.flags & ts.TypeFlags.NumberLike) !== 0)
  if (numberTypes.length !== 1) return null
  for (const member of type.types) {
    if (member !== numberTypes[0] && (member.flags & ts.TypeFlags.Object) === 0) return null
  }
  return numberTypes[0]!
}
