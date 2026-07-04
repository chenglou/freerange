import {finiteInputNumber, joinNumbers, sameNumbers, widenNumber, type AbstractNumber} from './number.ts'

export type AbstractBoolean = {
  kind: 'boolean'
  canBeTrue: boolean
  canBeFalse: boolean
}

// An object is a plain structural value: its property values, nothing else. Values are
// immutable after construction (the acceptance pass rejects property writes), so a record
// held across any amount of control flow keeps exactly the property values it was built
// with — no identity, no heap, no aliasing questions. The cost: two separately constructed
// records with equal property values are indistinguishable, so "definitely different
// objects" is inexpressible. Nothing observes that today (`===` never lowers for objects);
// if object comparison ever enters the subset, this is the representation to revisit.
// Properties keep their construction order (the literal's textual order), which is what
// report lines print in; joins and comparisons match properties by name, never by index.
export type AbstractRecord = {
  kind: 'record'
  properties: Array<{name: string; value: AbstractValue}>
}

type AbstractVoid = {
  kind: 'void'
}

export type AbstractValue = AbstractNumber | AbstractBoolean | AbstractRecord | AbstractVoid

export function unknownBoolean(): AbstractBoolean {
  return {kind: 'boolean', canBeTrue: true, canBeFalse: true}
}

// The abstract value a declared kind seeds: any finite number, or any boolean.
export function declaredKindValue(kind: 'number' | 'boolean'): AbstractValue {
  return kind === 'number' ? finiteInputNumber() : unknownBoolean()
}

export function recordValue(properties: Array<{name: string; value: AbstractValue}>): AbstractRecord {
  return {kind: 'record', properties}
}

// The named property's value, or null when the record does not carry the property (a join
// dropped it — see joinValues). Callers turn null into their own stop or rejection.
export function recordProperty(record: AbstractRecord, name: string): AbstractValue | null {
  const property = record.properties.find(candidate => candidate.name === name)
  return property == null ? null : property.value
}

export function joinValues(left: AbstractValue, right: AbstractValue): AbstractValue {
  // Kind mismatches stay a crash: union-typed bindings are outside the accepted subset and
  // belong to a lowering gate, not to the join.
  if (left.kind !== right.kind) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'record': return joinRecords(left, right as AbstractRecord)
    case 'void': return left
  }
}

// Records join pointwise by property name, keeping only the names present on BOTH sides.
// Different shapes genuinely meet: TypeScript's width subtyping types
// `flag ? {x: 1} : {x: 2, y: 3}` as `{x: number}`, so on the flag-true path `y` does not
// exist — keeping the union of names would publish an ensures line about a property that
// is sometimes absent. Reads outside the intersection are already unreachable: the static
// type only exposes the shared names, and property accesses are gated on the static type.
function joinRecords(left: AbstractRecord, right: AbstractRecord): AbstractRecord {
  const properties: Array<{name: string; value: AbstractValue}> = []
  for (const property of left.properties) {
    const other = recordProperty(right, property.name)
    if (other != null) properties.push({name: property.name, value: joinValues(property.value, other)})
  }
  return {kind: 'record', properties}
}

export function sameValues(left: AbstractValue, right: AbstractValue): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'number': return sameNumbers(left, right as AbstractNumber)
    case 'boolean': {
      const other = right as AbstractBoolean
      return left.canBeTrue === other.canBeTrue && left.canBeFalse === other.canBeFalse
    }
    case 'record': {
      // By name, not by index: two equal records can carry their properties in different
      // orders (e.g. a join's result takes the left side's order).
      const other = right as AbstractRecord
      return left.properties.length === other.properties.length
        && left.properties.every(property => {
          const otherValue = recordProperty(other, property.name)
          return otherValue != null && sameValues(property.value, otherValue)
        })
    }
    case 'void': return true
  }
}

// Widening exists to bound the lattice height at loop headers; every kind must decide its
// own story here, so a future kind cannot silently fall into an unbounded default and spin
// fixed points into the round limit.
export function widenValue(previous: AbstractValue, next: AbstractValue): AbstractValue {
  switch (next.kind) {
    // Numbers are the one unbounded lattice; bounds that grew jump to their extreme.
    case 'number': return previous.kind === 'number' ? widenNumber(previous, next) : next
    // A record's number leaves are unbounded, so widening recurses pointwise — a
    // loop-carried `metrics = {height: metrics.height + 1}` must widen height, not grow it
    // one round at a time into the round limit. A property the previous round lacked has
    // nothing to widen against and passes through. (A structure whose nesting genuinely
    // grows each round — possible only through a recursive declared type — never
    // stabilizes; the loop round limit records that path as a stop, which is the honest
    // answer.)
    case 'record': {
      if (previous.kind !== 'record') return next
      const previousRecord = previous
      return {
        kind: 'record',
        properties: next.properties.map(property => {
          const before = recordProperty(previousRecord, property.name)
          return before == null ? property : {name: property.name, value: widenValue(before, property.value)}
        }),
      }
    }
    // Bounded lattices need no widening: booleans have height two, void is a point.
    case 'boolean':
    case 'void':
      return next
  }
}

function joinBooleans(left: AbstractBoolean, right: AbstractBoolean): AbstractBoolean {
  return {
    kind: 'boolean',
    canBeTrue: left.canBeTrue || right.canBeTrue,
    canBeFalse: left.canBeFalse || right.canBeFalse,
  }
}
