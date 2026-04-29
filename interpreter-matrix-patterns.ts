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
