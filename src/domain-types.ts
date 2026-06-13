import type {ComparisonOperator} from './parser.ts'
import type {LinearExpr} from './linear.ts'

export type LinearConstraint = {
  diff: LinearExpr | null
  op: ComparisonOperator
  text?: string
  leftExpr?: string
  rightExpr?: string
  source: ConstraintSource
  fromRange?: true
  integerStrict?: true
}

export type ConstraintSource = 'function-given' | 'loop-given' | 'code' | 'branch' | 'contract'

export type Value = NumberValue | LiteralValue | ObjectValue | ArrayValue | NullValue | NullableValue | UnknownValue

export type NullishKind = 'null' | 'undefined' | 'nullish'
export type LiteralPrimitive = string | boolean

export type NumberValue = {
  kind: 'number'
  min: number
  max: number
  // Every possible runtime value is an integer multiple of 2^grid (so `int`
  // is grid 0 and a coarser grid implies the finer ones); null means no known
  // grid. Rounding to nearest keeps a value on its grid, so the grid survives
  // the float ops that produced the value — what rounding breaks is only the
  // algebraic identity between result and operands, which the linear-form
  // exactness gate decides separately.
  grid: number | null
  // A fully unbounded hull normally admits NaN, but a computation can be
  // overflow-capable yet NaN-free (a finite value divided by 0.998 reaches
  // ±Infinity, never NaN). The op that proves its operands avoid the
  // indeterminate forms (Inf−Inf, 0·Inf, Inf/Inf, 0/0, Inf%d) sets this so
  // the value still compares equal to itself. Only set alongside a fully
  // unbounded hull; a value with any finite bound excludes NaN already.
  neverNaN?: true
  expr: string | null
  linear: LinearExpr | null
  cases: NumberCase[] | null
  origin: string[]
}

export type LiteralValue = {
  kind: 'literal'
  values: LiteralPrimitive[]
  expr: string | null
  origin: string[]
}

// A branch join keeps every allocation the value may reference. The IDs let
// mutation invalidation distinguish an exact alias from a conditional alias.
export type ReferenceIds = readonly number[]

export type ObjectValue = {
  kind: 'object'
  referenceIds: ReferenceIds
  props: Map<string, Value>
  expr: string | null
}

export type ArrayLayout = 'collection' | 'tuple'

export type ArrayValue = {
  kind: 'array'
  referenceIds: ReferenceIds
  layout: ArrayLayout
  length: NumberValue
  elements: Value[] | null
  element: Value | null
  expr: string | null
  summary: ArraySummary | null
}

export type NullValue = {
  kind: 'null'
  expr: string | null
}

export type NullableValue = {
  kind: 'nullable'
  present: Value
  absent: NullishKind
  expr: string | null
}

export type ArraySummary = {
  origin?: ArrayOrigin | null
  relations: SequenceRelation[]
  advances: {prop: string; value: NumberValue}[]
  lastEnd: RowEnd | null
  extentEnds: (RowEnd & {emptyExpr: string})[]
}

// A loop's final cursor value, tagged with the pushed fields its recurrence
// ran over. It means "final position + size" only when those fields form one
// of the catalog's axes — directly, or after a rename through map.
export type RowEnd = {
  value: NumberValue
  positionPath: string[]
  sizePath: string[]
}

export type ArrayOrigin =
  | {kind: 'identity'; sourceExpr: string}
  | {kind: 'subsequence'; sourceExpr: string}

export type SequenceRelation = {
  kind: 'adjacent-comparison'
  left: SequenceTerm
  op: ComparisonOperator
  right: SequenceExpression
  // The relation states the loop's own computation (the addends name the
  // amounts the code added, in whatever grouping it used), not a
  // real-arithmetic identity: rounding separates the two by ulps, so no
  // consumer may turn a rounded relation back into algebra. Sequence builtins
  // like spaced read it as provenance; an exact relation (integer data) keeps
  // the full identity.
  rounded?: true
}

export type SequenceTerm = {
  item: 'previous' | 'next'
  path: string[]
}

export type SequenceExpression = {
  terms: SequenceTerm[]
  addends: string[]
}

export type UnknownValue = {
  kind: 'unknown'
  reason: string
}

export type NumberCase = {
  value: NumberValue
  assumptions: LinearConstraint[]
}
