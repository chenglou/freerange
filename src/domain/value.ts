import {joinNumbers, sameNumbers, widenNumber, type AbstractNumber} from './number.ts'

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

// A tuple: fixed length, one value per position — produced by literals whose static type
// is a tuple ([4, 8, 24] as const). Follows the type system's own split: tuples are
// positional, arrays are homogeneous. A tuple meeting a different-length tuple or an
// array at a join collapses one-way into the array form.
export type AbstractTuple = {
  kind: 'tuple'
  elements: AbstractValue[]
}

// A homogeneous array: one element hull covering every element (null when no element was
// ever seen — the empty literal), plus a length interval.
export type AbstractArray = {
  kind: 'array'
  element: AbstractValue | null
  length: AbstractNumber
}

// Which of JavaScript's two missing-value sentinels a nullish value can be. Carried on
// the value so report lines can say "null" when only null is possible (a `number | null`
// binding) instead of hedging with both.
export type NullishSentinels = 'null' | 'undefined' | 'both'

// The value IS missing: null, undefined, or (after a join) either. Null and undefined
// share one abstract concept — `??` and loose `== null` treat them alike, and the
// narrowing rules consult the operand's static type wherever the two differ (a strict
// `!== null` cannot clear a possibly-undefined value).
export type AbstractNullish = {
  kind: 'nullish'
  sentinels: NullishSentinels
}

// A value that is either `inner` or missing. Never nested (joins flatten), and inner is
// never itself nullish — a value that is only missing is AbstractNullish, not a wrapper.
export type AbstractMaybeNullish = {
  kind: 'maybeNullish'
  inner: AbstractValue
  sentinels: NullishSentinels
}

export function joinSentinels(left: NullishSentinels, right: NullishSentinels): NullishSentinels {
  return left === right ? left : 'both'
}

export type AbstractValue =
  | AbstractNumber
  | AbstractBoolean
  | AbstractRecord
  | AbstractVoid
  | AbstractNullish
  | AbstractMaybeNullish
  | AbstractTuple
  | AbstractArray

export function unknownBoolean(): AbstractBoolean {
  return {kind: 'boolean', canBeTrue: true, canBeFalse: true}
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
  // Missing values meet other kinds legitimately: a `number | null` binding joins a number
  // branch with a null branch. Everything else keeps the kind-mismatch crash, which
  // belongs to a lowering gate.
  if (left.kind === 'nullish' && right.kind === 'nullish') {
    return {kind: 'nullish', sentinels: joinSentinels(left.sentinels, right.sentinels)}
  }
  if (left.kind === 'nullish') {
    return right.kind === 'maybeNullish'
      ? {kind: 'maybeNullish', inner: right.inner, sentinels: joinSentinels(left.sentinels, right.sentinels)}
      : {kind: 'maybeNullish', inner: right, sentinels: left.sentinels}
  }
  if (right.kind === 'nullish') return joinValues(right, left)
  if (left.kind === 'maybeNullish' || right.kind === 'maybeNullish') {
    const leftInner = left.kind === 'maybeNullish' ? left.inner : left
    const rightInner = right.kind === 'maybeNullish' ? right.inner : right
    const leftSentinels = left.kind === 'maybeNullish' ? left.sentinels : null
    const rightSentinels = right.kind === 'maybeNullish' ? right.sentinels : null
    const sentinels = leftSentinels == null ? rightSentinels! : rightSentinels == null ? leftSentinels : joinSentinels(leftSentinels, rightSentinels)
    return {kind: 'maybeNullish', inner: joinValues(leftInner, rightInner), sentinels}
  }
  // Tuples and arrays meet across forms: the tuple collapses to its homogeneous hull.
  if ((left.kind === 'tuple' || left.kind === 'array') && (right.kind === 'tuple' || right.kind === 'array')) {
    if (left.kind === 'tuple' && right.kind === 'tuple') {
      if (left.elements.length === right.elements.length) {
        return {kind: 'tuple', elements: left.elements.map((element, index) => joinValues(element, right.elements[index]!))}
      }
      return joinValues(arrayFromTuple(left), arrayFromTuple(right))
    }
    const leftArray = left.kind === 'tuple' ? arrayFromTuple(left) : left
    const rightArray = right.kind === 'tuple' ? arrayFromTuple(right) : right
    const element = leftArray.element == null ? rightArray.element
      : rightArray.element == null ? leftArray.element
      : joinValues(leftArray.element, rightArray.element)
    return {kind: 'array', element, length: joinNumbers(leftArray.length, rightArray.length)}
  }
  if (left.kind !== right.kind) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'record': return joinRecords(left, right as AbstractRecord)
    case 'void': return left
    case 'tuple':
    case 'array':
      throw new Error('handled above')
  }
}

export function arrayFromTuple(tuple: AbstractTuple): AbstractArray {
  const element = tuple.elements.length === 0
    ? null
    : tuple.elements.reduce((joined, next) => joinValues(joined, next))
  return {kind: 'array', element, length: constantLength(tuple.elements.length)}
}

function constantLength(length: number): AbstractNumber {
  return {kind: 'number', lower: length, upper: length, integer: true, mayBeNaN: false}
}

// Whether two property values can meet in joinValues without a kind-mismatch crash: same
// kind, or a legitimate missing-value meet ({x: 1} on one branch, {x: null} on another).
function joinableKinds(left: AbstractValue, right: AbstractValue): boolean {
  if (left.kind === right.kind) return true
  return left.kind === 'nullish' || right.kind === 'nullish'
    || left.kind === 'maybeNullish' || right.kind === 'maybeNullish'
}

// Records join pointwise by property name, keeping only the names present on BOTH sides
// with MATCHING kinds. Different shapes genuinely meet: TypeScript accepts
// `flag ? {x: 1} : {x: 2, y: 3}` wherever `{x: number}` is expected, so on the flag-true
// path `y` does not exist — keeping the union of names would publish an ensures line about
// a property that is sometimes absent. A same-named property whose kinds differ (from a
// union like `{value: number} | {value: boolean}`) is dropped the same way instead of
// crashing the join: reading such a property is impossible anyway, because the property
// access gate rejects results whose static type mixes kinds. Either way, every readable
// property survives the join.
function joinRecords(left: AbstractRecord, right: AbstractRecord): AbstractRecord {
  const properties: Array<{name: string; value: AbstractValue}> = []
  for (const property of left.properties) {
    const other = recordProperty(right, property.name)
    if (other == null || !joinableKinds(property.value, other)) continue
    properties.push({name: property.name, value: joinValues(property.value, other)})
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
    case 'nullish': return left.sentinels === (right as AbstractNullish).sentinels
    case 'maybeNullish': {
      const other = right as AbstractMaybeNullish
      return left.sentinels === other.sentinels && sameValues(left.inner, other.inner)
    }
    case 'tuple': {
      const other = right as AbstractTuple
      return left.elements.length === other.elements.length
        && left.elements.every((element, index) => sameValues(element, other.elements[index]!))
    }
    case 'array': {
      const other = right as AbstractArray
      const sameElement = left.element == null || other.element == null
        ? left.element === other.element
        : sameValues(left.element, other.element)
      return sameElement && sameNumbers(left.length, other.length)
    }
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
    case 'maybeNullish': {
      // The unbounded part is inside; the missing half is a small finite lattice.
      const previousInner = previous.kind === 'maybeNullish' ? previous.inner : previous
      return {kind: 'maybeNullish', inner: widenValue(previousInner, next.inner), sentinels: next.sentinels}
    }
    case 'tuple': {
      if (previous.kind !== 'tuple' || previous.elements.length !== next.elements.length) return next
      const previousTuple = previous
      return {
        kind: 'tuple',
        elements: next.elements.map((element, index) => widenValue(previousTuple.elements[index]!, element)),
      }
    }
    case 'array': {
      if (previous.kind !== 'array') return next
      const element = next.element == null ? null
        : previous.element == null ? next.element
        : widenValue(previous.element, next.element)
      return {kind: 'array', element, length: widenNumber(previous.length, next.length)}
    }
    // Bounded lattices need no widening: booleans have height two, the missing sentinels
    // form a three-point lattice, void is a point.
    case 'boolean':
    case 'void':
    case 'nullish':
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
