import {IMPORTED_MINIMUM} from './assertion-constant'

export function importedMinimum(value: number): number {
  console.assert(value >= IMPORTED_MINIMUM)
  return value
}

export function callsImportedMinimum(): number {
  return importedMinimum(2)
}
