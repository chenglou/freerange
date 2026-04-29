type MatrixSpring = {
  pos: number
  k: number // @fit > 0
  b: number // @fit > 0
}

type MatrixSpringBox = {
  spring: MatrixSpring
  index: number // @fit >= 0
}

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
        spring: matrixSpring(item.pos),
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

export function matrixMathClampColumns(width: number): number {
  const raw = Math.floor(width / 240)
  return Math.max(1, Math.min(raw, 7))
}
