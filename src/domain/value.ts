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

// A value the analysis carries but makes no claims about — strings today. It flows
// through records, parameters, and returns; comparing two opaques gives an unknown
// boolean; every operation ON one is rejected at lowering. Nothing numeric is ever said
// about it, so nothing unsound can be: its whole job is to stop non-numeric content from
// rejecting the function around it.
export type AbstractOpaque = {
  kind: 'opaque'
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
  | AbstractOpaque

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
  const joined = tryJoinValues(left, right)
  // A top-level kind mismatch stays a crash: union-typed bindings are outside the accepted
  // subset and belong to a lowering gate. INSIDE structures the mismatch is survivable —
  // tryJoinValues callers drop the offending property instead — because every read of a
  // mixed-kind property is rejected by the gates.
  if (joined == null) throw new Error(`Cannot join ${left.kind} and ${right.kind}`)
  return joined
}

// The total join: null when the kinds cannot meet, instead of throwing. Record properties,
// array elements, tuple positions, and maybeNullish inners all join through this, so a
// mismatch deep inside a structure degrades (the property is dropped, unreadable anyway)
// rather than killing the run.
export function tryJoinValues(left: AbstractValue, right: AbstractValue): AbstractValue | null {
  // Missing values meet other kinds legitimately: a `number | null` binding joins a number
  // branch with a null branch.
  if (left.kind === 'nullish' && right.kind === 'nullish') {
    return {kind: 'nullish', sentinels: joinSentinels(left.sentinels, right.sentinels)}
  }
  if (left.kind === 'nullish') {
    return right.kind === 'maybeNullish'
      ? {kind: 'maybeNullish', inner: right.inner, sentinels: joinSentinels(left.sentinels, right.sentinels)}
      : {kind: 'maybeNullish', inner: right, sentinels: left.sentinels}
  }
  if (right.kind === 'nullish') return tryJoinValues(right, left)
  if (left.kind === 'maybeNullish' || right.kind === 'maybeNullish') {
    const leftInner = left.kind === 'maybeNullish' ? left.inner : left
    const rightInner = right.kind === 'maybeNullish' ? right.inner : right
    const leftSentinels = left.kind === 'maybeNullish' ? left.sentinels : null
    const rightSentinels = right.kind === 'maybeNullish' ? right.sentinels : null
    const sentinels = leftSentinels == null ? rightSentinels! : rightSentinels == null ? leftSentinels : joinSentinels(leftSentinels, rightSentinels)
    const inner = tryJoinValues(leftInner, rightInner)
    return inner == null ? null : {kind: 'maybeNullish', inner, sentinels}
  }
  // Tuples and arrays meet across forms: the tuple collapses to its homogeneous hull.
  if ((left.kind === 'tuple' || left.kind === 'array') && (right.kind === 'tuple' || right.kind === 'array')) {
    if (left.kind === 'tuple' && right.kind === 'tuple' && left.elements.length === right.elements.length) {
      const elements: AbstractValue[] = []
      for (let index = 0; index < left.elements.length; index++) {
        const element = tryJoinValues(left.elements[index]!, right.elements[index]!)
        if (element == null) return null
        elements.push(element)
      }
      return {kind: 'tuple', elements}
    }
    const leftArray = left.kind === 'tuple' ? arrayFromTupleTotal(left) : left
    const rightArray = right.kind === 'tuple' ? arrayFromTupleTotal(right) : right
    if (leftArray == null || rightArray == null) return null
    const element = leftArray.element == null ? rightArray.element
      : rightArray.element == null ? leftArray.element
      : tryJoinValues(leftArray.element, rightArray.element)
    if (element == null && leftArray.element != null && rightArray.element != null) return null
    return {kind: 'array', element, length: joinNumbers(leftArray.length, rightArray.length)}
  }
  if (left.kind !== right.kind) return null
  switch (left.kind) {
    case 'number': return joinNumbers(left, right as AbstractNumber)
    case 'boolean': return joinBooleans(left, right as AbstractBoolean)
    case 'record': return joinRecords(left, right as AbstractRecord)
    case 'void': return left
    case 'opaque': return left
    // Handled by the structural arms above; unreachable here.
    case 'tuple':
    case 'array':
      return null
  }
}

// The tuple's homogeneous hull, or null when its positions mix kinds (a mixed tuple never
// reaches a cross-form join through the gates; inside structures the caller drops it).
function arrayFromTupleTotal(tuple: AbstractTuple): AbstractArray | null {
  if (tuple.elements.length === 0) return {kind: 'array', element: null, length: constantLength(0)}
  let element: AbstractValue | null = tuple.elements[0]!
  for (let index = 1; index < tuple.elements.length; index++) {
    element = tryJoinValues(element, tuple.elements[index]!)
    if (element == null) return null
  }
  return {kind: 'array', element, length: constantLength(tuple.elements.length)}
}

function constantLength(length: number): AbstractNumber {
  return {kind: 'number', lower: length, upper: length, integer: true, mayBeNaN: false}
}


// Records join pointwise by property name, keeping only the names present on BOTH sides
// whose values can actually meet. Different shapes genuinely meet: TypeScript accepts
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
    if (other == null) continue
    const joined = tryJoinValues(property.value, other)
    if (joined == null) continue
    properties.push({name: property.name, value: joined})
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
    case 'opaque': return true
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
    // form a three-point lattice, void and opaque are points.
    case 'boolean':
    case 'void':
    case 'nullish':
    case 'opaque':
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
