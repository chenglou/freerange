import {importedNondecreasingRows, importedPreviousNamedIndexRows} from './import-pattern-helpers'

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given spacing: 0..10
 * return.rows[$i + 1].top == return.rows[$i].top + (return.rows[$i].height + spacing)
 */
export function importedPreviousNamedIndexSummary(items: {height: number}[], spacing: number) {
  return importedPreviousNamedIndexRows(items, spacing)
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given spacing: 0..10
 * return.rows[$i].top <= return.rows[$i + 1].top
 */
export function importedNondecreasingNamedIndexSummary(items: {height: number}[], spacing: number) {
  return importedNondecreasingRows(items, spacing)
}
