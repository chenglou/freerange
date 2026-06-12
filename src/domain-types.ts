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
  isInteger: boolean
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

export type ObjectValue = {
  kind: 'object'
  props: Map<string, Value>
  expr: string | null
}

export type ArrayLayout = 'collection' | 'tuple'

export type ArrayValue = {
  kind: 'array'
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
