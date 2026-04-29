export type CorpusProbe =
  | {
      kind: 'check'
      name: string
      paths: string[]
    }
  | {
      kind: 'doctor'
      name: string
      paths: string[]
    }

export const corpusRoot = '/Users/chenglou/github/freerange-corpus'

export const corpusProbes: CorpusProbe[] = [
  {
    kind: 'check',
    name: 'react-grid-layout core check',
    paths: [
      `${corpusRoot}/react-grid-layout/src/core/calculate.ts`,
      `${corpusRoot}/react-grid-layout/src/core/constraints.ts`,
      `${corpusRoot}/react-grid-layout/src/core/position.ts`,
    ],
  },
  {
    kind: 'doctor',
    name: 'react-grid-layout core doctor',
    paths: [
      `${corpusRoot}/react-grid-layout/src/core/calculate.ts`,
      `${corpusRoot}/react-grid-layout/src/core/constraints.ts`,
      `${corpusRoot}/react-grid-layout/src/core/position.ts`,
    ],
  },
  {
    kind: 'check',
    name: 'xyflow general/resizer check',
    paths: [
      `${corpusRoot}/xyflow/packages/system/src/utils/general.ts`,
      `${corpusRoot}/xyflow/packages/system/src/xyresizer/utils.ts`,
    ],
  },
  {
    kind: 'doctor',
    name: 'xyflow general/resizer doctor',
    paths: [
      `${corpusRoot}/xyflow/packages/system/src/utils/general.ts`,
      `${corpusRoot}/xyflow/packages/system/src/xyresizer/utils.ts`,
    ],
  },
]
