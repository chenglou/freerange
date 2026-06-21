type MatrixSpring = {
  pos: number
  k: number // @fit > 0
  b: number // @fit > 0
}

type MatrixSpringBox = {
  spring: MatrixSpring
  index: number // @fit >= 0
}

type MatrixSwitchKind = 'compact' | 'wide' | 'hidden'

type MatrixSwitchSpec = {
  kind: MatrixSwitchKind
}

declare const matrixShapeApi: {
  box(items: {height: number}[]): {rows: {height: number}[]}
}

const matrixAliasMax = Math.max
const matrixCopiedAliasMax = matrixAliasMax

const matrixInput = {
  groups: [
    {items: [{pos: 4}, {pos: 8}]},
    {items: [{pos: 12}]},
  ],
}

function matrixSpring(
  pos: number,
  k: number = 290, // @fit > 0
  b: number = 30, // @fit > 0
): MatrixSpring {
  return {pos, k, b}
}

export function matrixNestedIifeMapDefaults(): MatrixSpringBox[][] {
  return (() => {
    const touched = {count: 0}
    return matrixInput.groups.map(group => group.items.map((item, index) => {
      touched.count = touched.count + 1
      return {
        spring: matrixSpring(Number.isFinite(item.pos) ? item.pos : 0),
        index,
      }
    }))
  })()
}

/** @fit
 * return.k == 10
 * return.b == 11
 */
export function matrixDefaultParamOrder(): MatrixSpring {
  const base = 10
  return ((k: number = base, b: number = k + 1) => matrixSpring(0, k, b))()
}

/** @fit
 * return.k == 290
 * return.b == 30
 */
export function matrixExplicitUndefinedDefaults(): MatrixSpring {
  return matrixSpring(0, undefined, undefined)
}

export function matrixIfRefinesNonnegative(value: number): number {
  if (value < 0) return 0
  return value
}

export function matrixTernaryLiteralJoin(value: number): number {
  return value > 5 ? 7 : 3
}

export function matrixFilterMapLiteralBooleans(): number[] {
  const items = [{value: 1, keep: true}, {value: -1, keep: false}, {value: 3, keep: true}]
  return items.filter(item => item.keep).map(item => item.value)
}

export function matrixForOfPushVisibleRows(): {height: number}[] {
  const items = [{height: 2, visible: true}, {height: 4, visible: false}, {height: 6, visible: true}]
  const rows = []
  for (const item of items) {
    if (item.visible) rows.push({height: item.height})
  }
  return rows
}

export function matrixForOfParamRows(items: {height: number}[]): {rows: {height: number}[]} {
  const rows = []
  for (const item of items) {
    const height = item.height
    rows.push({height})
  }
  return {rows}
}

export function matrixForOfParamVisibleRows(items: {height: number; visible: boolean}[]): {rows: {height: number}[]} {
  const rows = []
  for (const item of items) {
    if (item.visible) rows.push({height: item.height})
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given top: 0..1000
 * given step: 0..40
 */
export function matrixForOfParamCursorValues(
  items: number[],
  top: number = 10,
  step: number = 2,
): {rows: number[]; bottom: number} {
  const rows = []
  let y = top
  for (const _item of items) {
    rows.push(y)
    y += step
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int 0..50
 */
export function matrixForOfParamConditionalCount(items: {visible: boolean}[]): number {
  let count = 0
  for (const item of items) {
    if (item.visible) count += 1
  }
  return count
}

/** @fit
 * given items.length: int 0..50
 * given items[].width: 0..80
 */
export function matrixForOfParamRunningMax(items: {width: number}[]): number {
  let maxWidth = 0
  for (const item of items) {
    const width = item.width
    maxWidth = Math.max(maxWidth, width)
  }
  return maxWidth
}

/** @fit
 * given items.length: int 0..50
 */
export function matrixIndexedArrayConditionalCount(items: {visible: boolean}[]): number {
  let count = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.visible) count += 1
  }
  return count
}

/** @fit
 * given items.length: int 0..50
 * given items[].width: 0..80
 */
export function matrixIndexedArrayRunningMax(items: {width: number}[]): number {
  let maxWidth = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const width = item.width
    maxWidth = Math.max(maxWidth, width)
  }
  return maxWidth
}

/** @fit
 * given limit: int 0..30
 */
export function matrixIndexedLimitRange(limit: number = 5): number[] {
  const values = []
  for (let i = 0; i < limit; i++) {
    values.push(i)
  }
  return values
}

/** @fit
 * given items.length: int 0..20
 * given items[].height: 0..80
 */
export function matrixIndexedArrayParamRows(items: {height: number}[]): {rows: {height: number; sourceIndex: number}[]} {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    rows.push({height: item.height, sourceIndex: i})
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..20
 * given items[].height: 0..80
 */
export function matrixIndexedArrayGuardedRows(items: {height: number; visible: boolean}[]): {rows: {height: number; sourceIndex: number}[]} {
  const rows = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.visible) {
      rows.push({height: item.height, sourceIndex: i})
    }
  }
  return {rows}
}

/** @fit
 * given items.length: int 0..50
 * given top: 0..1000
 * given step: 0..40
 */
export function matrixIndexedArrayGuardedCursorValues(
  items: {visible: boolean}[],
  top: number = 10,
  step: number = 2,
): {rows: number[]; bottom: number} {
  const rows = []
  let y = top
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.visible) rows.push(y)
    y += step
  }
  return {rows, bottom: y}
}

/** @fit
 * given items.length: int 0..50
 * given top: 0..1000
 * given step: 0..40
 */
export function matrixIndexedArrayCursorValues(
  items: number[],
  top: number = 10,
  step: number = 2,
): {rows: number[]; bottom: number} {
  const rows = []
  let y = top
  for (let i = 0; i < items.length; i++) {
    rows.push(y)
    y = y + step
  }
  return {rows, bottom: y}
}

export function matrixMathClampColumns(width: number): number {
  const raw = Math.floor(width / 240)
  return Math.max(1, Math.min(raw, 7))
}

export function matrixElseIfContinuation(value: number): number {
  if (value < 0) return -1
  else if (value > 0) return 1
  return 0
}

export function matrixThrowGuardNarrowsPositive(value: number): number {
  if (value < 0) throw new Error('negative')
  return value
}

export function matrixSwitchFiniteLiteral(kind: MatrixSwitchKind): number {
  switch (kind) {
    case 'compact':
      return 1
    case 'wide':
      return 4
    default:
      return 0
  }
}

export function matrixSwitchContinuation(kind: MatrixSwitchKind): number {
  switch (kind) {
    case 'compact':
      return 1
  }
  return 0
}

export function matrixSwitchGroupedCases(kind: MatrixSwitchKind): string {
  switch (kind) {
    case 'compact':
    case 'wide':
      return 'visible'
    case 'hidden':
      return 'hidden'
  }
}

function matrixSwitchKindIs(left: MatrixSwitchKind, right: MatrixSwitchKind): boolean {
  return left === right
}

export function matrixSwitchNarrowsDiscriminantPath(spec: MatrixSwitchSpec): number {
  switch (spec.kind) {
    case 'compact':
      if (matrixSwitchKindIs(spec.kind, 'wide')) return 99
      return 1
    case 'wide':
      if (matrixSwitchKindIs(spec.kind, 'hidden')) return 99
      return 4
    default:
      if (matrixSwitchKindIs(spec.kind, 'compact')) return 99
      return 0
  }
}

export function matrixStringishMutationPreservesTuple(): [string, number] {
  const items = [1, 2]
  let path = ''
  const value = 5
  path += `M ${items.length}`
  return [path, value]
}

export function matrixTypeofUndefinedGuard(max?: number): number {
  if (typeof max !== 'undefined') return Math.max(max, 0)
  return 0
}

export function matrixOptionalPropertyNullishFallback(dimensions: {width?: number}): number {
  return Math.max(dimensions?.width ?? 0, 0)
}

export function matrixNullableObjectOptionalFallback(dimensions: {width: number} | null): number {
  return Math.max(dimensions?.width ?? 0, 0)
}

export function matrixLocalMathAlias(value: number): number {
  return matrixCopiedAliasMax(value, 10)
}

export function matrixPropertyAccessCallShape(items: {height: number}[]): {rows: {height: number}[]} {
  return matrixShapeApi.box(items)
}

class MatrixClassBox {
  constructor(
    public width: number,
    public height: number,
  ) {}

  area(): number {
    return this.width * this.height
  }
}

export function matrixClassMethodThis(box: MatrixClassBox): number {
  return box.area()
}
