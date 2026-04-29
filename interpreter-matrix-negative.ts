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
