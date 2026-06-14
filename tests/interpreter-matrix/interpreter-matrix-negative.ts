type MatrixPositiveValue = {
  value: number // @fit > 0
}

type MatrixDefaultValue = {
  value: number // @fit >= 0
}

function matrixNegativeDefault(
  value: number = -1, // @fit >= 0
): MatrixDefaultValue {
  return {value}
}

export function negativeMatrixDefaultViolatesType(): MatrixDefaultValue {
  return matrixNegativeDefault()
}

export function negativeMatrixMapMutationForgetsAlias(): MatrixPositiveValue[] {
  const source = [{value: 1}]
  return source.map(item => {
    const alias = item
    alias.value = -1
    return {value: item.value}
  })
}

export function negativeMatrixCursorUpdateBeforePush(items: number[], step: number = 2): number[] {
  const rows = []
  let y = 0
  for (const _item of items) {
    y += step
    rows.push(y)
  }
  return rows
}

export function negativeMatrixConditionalElseCount(items: {visible: boolean}[]): number {
  let count = 0
  for (const item of items) {
    if (item.visible) count += 1
    else count += 2
  }
  return count
}

export function negativeMatrixMixedExtremumAndCursor(items: {width: number}[]): number {
  let maxWidth = 0
  let total = 0
  for (const item of items) {
    maxWidth = Math.max(maxWidth, item.width)
    total += item.width
  }
  return maxWidth + total
}

export function negativeMatrixIndexedLoopStartsAtOne(limit: number = 5): number[] {
  const values = []
  for (let i = 1; i < limit; i++) {
    values.push(i)
  }
  return values
}

export function negativeMatrixIndexedArrayGuardedElse(items: {value: number; visible: boolean}[]): number[] {
  const values = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.visible) values.push(item.value)
    else values.push(0)
  }
  return values
}

export function negativeMatrixIndexedArrayPushesIntoSource(items: number[]): number[] {
  for (let i = 0; i < items.length; i++) {
    items.push(i)
  }
  return items
}

export function negativeMatrixIndexedCursorUpdateBeforePush(items: number[], step: number = 2): number[] {
  const rows = []
  let y = 0
  for (let i = 0; i < items.length; i++) {
    y += step
    rows.push(y)
  }
  return rows
}

export function negativeMatrixIndexedConditionalElseCount(items: {visible: boolean}[]): number {
  let count = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.visible) count += 1
    else count += 2
  }
  return count
}

export function negativeMatrixIndexedMixedExtremumAndCursor(items: {width: number}[]): number {
  let maxWidth = 0
  let total = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    maxWidth = Math.max(maxWidth, item.width)
    total += item.width
  }
  return maxWidth + total
}

export function negativeMatrixGuardedExtremumUnsafeReset(items: {height: 0 | 1; endsRow: boolean}[]): {rows: {height: number}[]} {
  const rows = []
  let rowHeight = 0
  for (const item of items) {
    rowHeight = Math.max(rowHeight, item.height)
    if (item.endsRow) {
      rows.push({height: rowHeight})
      rowHeight = -1
    }
  }
  return {rows}
}

declare const negativeMatrixImpureLoopApi: {
  touch(): number
}

export function negativeMatrixUnsupportedLoopImpureRead(items: number[], value: number): number {
  let scratch = 0
  const kept = value
  for (let i = 1; i < items.length; i++) {
    scratch += negativeMatrixImpureLoopApi.touch()
  }
  return kept
}

export function negativeMatrixTryCatchUnsupported(): number {
  try {
    return 1
  } catch {
    return 2
  }
}

export function negativeMatrixSwitchBroadStringUnsupported(kind: string): number {
  switch (kind) {
    case 'compact':
      return 1
    default:
      return 0
  }
}

export function negativeMatrixSwitchFallthroughUnsupported(kind: 'compact' | 'wide'): number {
  switch (kind) {
    case 'compact':
      return 1
    case 'wide':
  }
  return 0
}

export function negativeMatrixArrayAtDynamicUnsupported(items: number[], index: number): number {
  return items.at(index)!
}

export function negativeMatrixNullishFallbackString(dimensions: {width?: number}): number {
  // @ts-expect-error This case intentionally keeps a non-numeric fallback.
  return Math.max(dimensions?.width ?? 'wide', 0)
}

let negativeMatrixMutableMaxAlias = Math.max

export function negativeMatrixMutableAliasUnsupported(value: number): number {
  return negativeMatrixMutableMaxAlias(value, 0)
}
