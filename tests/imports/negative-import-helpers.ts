export function unannotatedImportedClamp(width: number) {
  return Math.min(width, 320)
}

export default function unannotatedDefaultImportedClamp(width: number) {
  return Math.min(width, 320)
}

/** @fit
 * given width: 0..1000
 * return: 0..100
 */
export function importedClampWithBadContract(width: number) {
  return Math.min(width, 320)
}

export class NegativeImportedClassBox {
  constructor(public top: number, public height: number) {}

  /** @fit
   * given this.top: 0..1000
   * given this.height: -100..1000
   * return >= this.top
   */
  get bottom() {
    return this.top + this.height
  }
}

export class NegativeImportedClassBoxNeedsHeight {
  constructor(public top: number, public height: number) {}

  /** @fit
   * given this.top: 0..1000
   * given this.height: 0..1000
   * return >= this.top
   */
  get bottom() {
    return this.top + this.height
  }
}

export type ImportedOptionalRows = {
  rows?: {height: number}[]
}

export type NegativeImportedTypeFieldSpring = {
  k: number // @fit > 0
  b: number // @fit > 0
}

export type NegativeImportedTypeFieldRows = {
  rows: {
    height: number // @fit 0..40
  }[]
}

/** @fit
 * return.length == 4
 * return[2] >= 0
 */
export function importedTupleWithOneOffset(value: number): [number, number, number, number] {
  return [0, 0, Math.abs(value), value]
}
