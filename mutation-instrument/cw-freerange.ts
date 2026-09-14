// contract-writing-v1 4f: Freerange's verdict on each console.assert a writer added, joined from `fr --audit <file>`
// (src/report/index.ts formatReport) and `fr <file>` (src/project.ts's console-assert findings):
//   interior assert  proved: a `proves:` line at its line and column
//                    could not prove, can be false, unreachable: a finding at its line with that wording
//                    not analyzed: its function is unsupported or partially supported, a finding at its line rejects the
//                    condition's form or says the function didn't finish analysis, or the file has TypeScript errors
//   leading assert   accepted: a `requires:` line declared at its line and column; rejected: a finding at its line. A
//                    requirement is never counted as proved.
// A verdict matching none of these is `unclassified` and printed with its evidence.
import type {Site} from './types.ts'

export type AssertStatus = 'proved' | 'could not prove' | 'can be false' | 'unreachable' | 'not analyzed' | 'accepted' | 'rejected' | 'unclassified'
type AuditFunction = {name: string; kind: 'analyzed' | 'unsupported' | 'partial'; lines: string[]}
type Finding = {line: number; message: string; text: string}

// Findings that say a condition or a function wasn't checked (src/project.ts, src/report/format-unsupported.ts's forms).
const NOT_CHECKED = [
  /^console\.assert must contain one direct numeric comparison/,
  /^calculate or read the value before console\.assert/,
  /^console\.assert cannot call a function inside its condition/,
  /^console\.assert in \S+ was not checked because /,
  /^console\.assert requirements in \S+ were not checked because /,
  /^could not check console\.assert condition in /,
  /^console\.assert is only supported inside a named top-level function/,
]

/** The audit's functions, e.g. `pillPreviewChargeProgress` with its `requires:` and `proves:` lines. */
export function parseAudit(text: string): AuditFunction[] {
  const functions: AuditFunction[] = []
  let inContracts = false
  for (const line of text.split('\n')) {
    if (line === '## Contracts') {
      inContracts = true
      continue
    }
    if (!inContracts || line === '') continue
    if (!line.startsWith('  ')) {
      functions.push({name: line, kind: 'analyzed', lines: []})
      continue
    }
    const current = functions.at(-1)
    if (current == null) throw new Error(`an audit line before any function: ${line}`)
    current.lines.push(line)
    if (line.startsWith('  unsupported: ')) current.kind = 'unsupported'
    else if (line.startsWith('  partially supported: ')) current.kind = 'partial'
  }
  return functions
}

/** Every console-assert finding, e.g. `src/components/ranking/rankingGeometry.ts(52,18): error [console-assert]: …`. */
export function parseFindings(text: string): Finding[] {
  return [...text.matchAll(/^\S+\((\d+),\d+\): (?:error|warning) \[console-assert\]: (.+)$/gm)].map((match) => ({line: Number(match[1]), message: match[2]!, text: match[0]}))
}

/** An audit line that cites `site` as `(assertion at file:line:column)` or `(declared at file:line:column)`. */
function citesSite(line: string, label: 'assertion at' | 'declared at', site: Site) {
  const match = / \((assertion at|declared at) \S+:(\d+):(\d+)\)$/.exec(line)
  return match != null && match[1] === label && Number(match[2]) === site.line && Number(match[3]) === site.column
}

export function assertVerdict(site: Site, audit: AuditFunction[], findings: Finding[], typeErrors: boolean): {status: AssertStatus; evidence: string[]} {
  const fn = audit.find((candidate) => candidate.name === site.functionName) ?? null
  const lineFindings = findings.filter((finding) => finding.line === site.line)
  const evidence = lineFindings.map((finding) => finding.text)
  const functionEvidence = fn == null ? [`no audit entry for ${site.functionName ?? 'a top-level statement'}`] : fn.lines.filter((line) => line.startsWith('  unsupported: ') || line.startsWith('  partially supported: '))
  if (typeErrors) return {status: 'not analyzed', evidence: [...evidence, 'TypeScript errors']}
  if (site.leading) {
    const requires = fn?.lines.find((line) => line.startsWith('  requires: ') && citesSite(line, 'declared at', site)) ?? null
    if (requires != null) return {status: 'accepted', evidence: [requires, ...evidence]}
    if (lineFindings.length > 0) return {status: 'rejected', evidence}
    if (fn == null || fn.kind !== 'analyzed') return {status: 'not analyzed', evidence: functionEvidence}
    return {status: 'unclassified', evidence}
  }
  const proves = fn?.lines.find((line) => line.startsWith('  proves: ') && citesSite(line, 'assertion at', site)) ?? null
  if (proves != null) return {status: 'proved', evidence: [proves, ...evidence]}
  for (const finding of lineFindings) {
    if (finding.message.startsWith('could not prove console.assert condition in ')) return {status: 'could not prove', evidence}
    if (finding.message.startsWith('console.assert condition can be false in ')) return {status: 'can be false', evidence}
    if (finding.message.startsWith('console.assert is unreachable in ')) return {status: 'unreachable', evidence}
  }
  if (lineFindings.some((finding) => NOT_CHECKED.some((pattern) => pattern.test(finding.message)))) return {status: 'not analyzed', evidence}
  if (fn == null || fn.kind !== 'analyzed') return {status: 'not analyzed', evidence: [...evidence, ...functionEvidence]}
  return {status: 'unclassified', evidence}
}
