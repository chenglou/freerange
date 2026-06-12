// Shares the catalog's lastEnd name on purpose: the user's function keeps its
// own meaning everywhere. It returns the last y MINUS height, so the claim
// on negativeUserFunctionNotHijackedByCatalog is false at runtime and must not
// pass via the catalog. Lives in its own file because the module-level shadow
// applies file-wide.
function lastEnd(rows: {y: number; height: number}[]) {
  const last = rows[rows.length - 1]
  return last == null ? 0 : last.y - last.height
}

/** @fit
 * given items.length: int 1..10
 * given items[].height: 10..10
 * return >= 0
 */
export function negativeUserFunctionNotHijackedByCatalog(items: {height: number}[]) {
  const rows: {y: number; height: number}[] = []
  let y = 0
  for (const item of items) {
    rows.push({y: y, height: item.height})
    y += item.height
  }
  return lastEnd(rows) - 10
}

/** @fit
 * given rows.length: int 1..10
 * given rows[].y: 0..100
 * given rows[].height: 0..10
 * return: -10..100
 */
export function userFunctionWinsOverCatalogName(rows: {y: number; height: number}[]) {
  return lastEnd(rows)
}
