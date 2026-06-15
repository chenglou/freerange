import {importedPreviousNamedIndexRows} from './import-pattern-helpers'

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given spacing: 0..10
 * return.rows[$i].top == return.rows[$i - 1].top + (return.rows[$i - 1].height + spacing + 1)
 */
export function negativeImportedPreviousNamedIndexSummary(items: {height: number}[], spacing: number) {
  return importedPreviousNamedIndexRows(items, spacing)
}

/** @fit
 * given items.length: int 1..50
 * given items[].height: 0..40
 * given spacing: 0..10
 * return.rows[].top >= 1
 */
export function negativeAdjacentSummaryDoesNotDescribeFirstItem(items: {height: number}[], spacing: number) {
  return importedPreviousNamedIndexRows(items, spacing)
}
