import type {CopyPlan, EntryPlan} from './types.ts'

/**
 * An entry's domain lines, as `file:line`: its own leading asserts, the callee conjuncts substituted into its domain, and
 * its leak sites. An input whose call records one of these lines is outside the entry's declared domain, e.g. a
 * menuHoverCorridorProperties call recording menuGeometry:154 (`anchor.width >= 0` in menuHoverContains). Used by
 * falseAlarm@reproducible, and by scoring@witness-v1's witness check and instrument gates.
 */
export function domainLines(copy: CopyPlan, entry: EntryPlan): Set<string> {
  const lines = new Set<string>()
  for (const precondition of entry.preconditions) if (precondition.origin === 'entry' || precondition.use !== 'unparsed') lines.add(`${precondition.file}:${precondition.line}`)
  for (const site of entry.leakSites) lines.add(`${copy.sites[site]!.file}:${copy.sites[site]!.line}`)
  return lines
}
