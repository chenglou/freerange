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
