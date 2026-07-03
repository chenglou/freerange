import {importedPad} from './module-imports-helper'

export function paddedBy(width: number): number {
  return Math.max(0, width) + importedPad
}
