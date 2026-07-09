import {importedPad, importedTarget} from './module-imports-helper'

export function ImportedConstantStyle(props: {useSmallTarget: boolean; total: number}) {
  const target = props.useSmallTarget ? importedPad : importedTarget
  const progress = (props.total / target) * 100
  const width = Math.min(progress, 100)
  return <div style={{width}} />
}
