// Turns `fr <file>` output into one verdict per console.assert site.
//
// Findings mode prints nothing for a proven assertion, so a verdict comes from what is printed and what isn't:
// - an interior assert with a finding at its line gets that finding's verdict: `can be false` → can-be-false;
//   `could not prove`, `could not check` and unrecognized console-assert messages → could-not-prove; `unreachable` →
//   proved, with the reason `unreachable`;
// - a function Freerange didn't lower gets one finding at its first unsupported construct (src/project.ts:310-321); every
//   assert in that function is not-analyzed with that message as the reason;
// - a leading assert is a caller requirement, not a claim: without a finding it gets the verdict `requirement`;
// - an interior assert in a lowered function with no finding is proved.
// A run that timed out, crashed or stopped on TypeScript errors makes every site in the file not-analyzed.
import type {AssertSite} from './asserts.ts'

export type Finding = {
  file: string
  line: number
  column: number
  level: string
  rule: string
  message: string
}

export type ParsedFreerangeOutput = {
  findings: Finding[]
  coverageLine: string | null
  truncated: boolean
}

// A cap on parsed finding lines, far above any corpus file today (the largest recorded output has 37 findings).
export const maxFindingLines = 20_000

const findingPattern = /^(.+?)\((\d+),(\d+)\): (error|warning) \[([a-z-]+)\]: (.*)$/

export function parseFreerangeOutput(stdout: string, cap = maxFindingLines): ParsedFreerangeOutput {
  const findings: Finding[] = []
  let coverageLine: string | null = null
  let truncated = false
  const lines = stdout.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.startsWith('coverage: ')) {
      coverageLine = line
      continue
    }
    const match = findingPattern.exec(line)
    if (match == null) continue
    if (findings.length >= cap) {
      truncated = true
      break
    }
    findings.push({
      file: match[1]!,
      line: Number(match[2]),
      column: Number(match[3]),
      level: match[4]!,
      rule: match[5]!,
      message: match[6]!,
    })
  }
  return {findings, coverageLine, truncated}
}

export type Verdict = 'proved' | 'could-not-prove' | 'can-be-false' | 'not-analyzed' | 'requirement'

export type SiteVerdict = {
  verdict: Verdict
  reason: string
  finding: string | null
}

export type RunOutcome =
  | {kind: 'ran'; output: ParsedFreerangeOutput}
  | {kind: 'failed'; reason: string}

type SiteFindingKind = 'refuted' | 'unproven' | 'blocked' | 'dead' | 'outside' | 'notChecked' | 'declaredRefuted' | 'declaredUnproven' | 'unrecognized'

export type ClassifiedFinding =
  | {scope: 'site'; kind: SiteFindingKind; functionName: string | null}
  | {scope: 'function'; kind: 'notLowered' | 'requirementsUnchecked'; functionName: string}
  | {scope: 'other'}

const identifier = '([A-Za-z_$][\\w$]*)'
const staticFormPrefixes = [
  'console.assert must ',
  'calculate or read the value before console.assert',
  'console.assert cannot call a function',
  'a leading console.assert describes what callers must provide',
  'optional console.assert calls are not supported',
]

export function classifyFinding(finding: Finding): ClassifiedFinding {
  const message = finding.message
  if (finding.rule === 'declared-requirement') {
    if (message.startsWith('call to ')) return {scope: 'other'}
    const refuted = new RegExp(`^declared console\\.assert requirement is false in ${identifier}$`).exec(message)
    if (refuted != null) return {scope: 'site', kind: 'declaredRefuted', functionName: refuted[1]!}
    const unproven = new RegExp(`^could not express or prove the declared console\\.assert requirement in ${identifier}$`).exec(message)
    if (unproven != null) return {scope: 'site', kind: 'declaredUnproven', functionName: unproven[1]!}
    return {scope: 'other'}
  }
  if (finding.rule !== 'console-assert') return {scope: 'other'}

  const siteForms: Array<[RegExp, SiteFindingKind]> = [
    [new RegExp(`^console\\.assert condition can be false in ${identifier}: `), 'refuted'],
    [new RegExp(`^could not prove console\\.assert condition in ${identifier}: `), 'unproven'],
    [new RegExp(`^could not check console\\.assert condition in ${identifier}; `), 'blocked'],
    [new RegExp(`^console\\.assert is unreachable in ${identifier}: `), 'dead'],
  ]
  for (const [pattern, kind] of siteForms) {
    const match = pattern.exec(message)
    if (match != null) return {scope: 'site', kind, functionName: match[1]!}
  }
  if (message.startsWith('console.assert is only supported inside a named top-level function')) {
    return {scope: 'site', kind: 'outside', functionName: null}
  }
  const requirements = new RegExp(`^console\\.assert requirements in ${identifier} were not checked because `).exec(message)
  if (requirements != null) return {scope: 'function', kind: 'requirementsUnchecked', functionName: requirements[1]!}
  const notChecked = new RegExp(`^console\\.assert in ${identifier} was not checked because `).exec(message)
  if (notChecked != null) return {scope: 'function', kind: 'notLowered', functionName: notChecked[1]!}
  if (staticFormPrefixes.some(prefix => message.startsWith(prefix))) {
    // Freerange 0.0.5 names the function at the end; a branch that leaves only the assertion unchecked appends the
    // condition after the name, which makes the finding about one site.
    const atEnd = new RegExp(` in ${identifier}$`).exec(message)
    if (atEnd != null) return {scope: 'function', kind: 'notLowered', functionName: atEnd[1]!}
    const withCondition = new RegExp(` in ${identifier}: `).exec(message)
    if (withCondition != null) return {scope: 'site', kind: 'notChecked', functionName: withCondition[1]!}
  }
  return {scope: 'site', kind: 'unrecognized', functionName: null}
}

function siteVerdictFor(kind: SiteFindingKind, message: string): SiteVerdict {
  switch (kind) {
    case 'refuted':
    case 'declaredRefuted': return {verdict: 'can-be-false', reason: message, finding: message}
    case 'unproven':
    case 'blocked':
    case 'declaredUnproven':
    case 'unrecognized': return {verdict: 'could-not-prove', reason: message, finding: message}
    case 'dead': return {verdict: 'proved', reason: `unreachable: ${message}`, finding: message}
    case 'outside':
    case 'notChecked': return {verdict: 'not-analyzed', reason: message, finding: message}
  }
}

function sameFile(findingFile: string, siteFile: string): boolean {
  return findingFile.replace(/^\.\//, '') === siteFile.replace(/^\.\//, '')
}

export function joinVerdicts(sites: AssertSite[], outcome: RunOutcome): Map<string, SiteVerdict> {
  const verdicts = new Map<string, SiteVerdict>()
  if (outcome.kind === 'failed') {
    for (const site of sites) verdicts.set(site.key, {verdict: 'not-analyzed', reason: outcome.reason, finding: null})
    return verdicts
  }
  const file = sites[0]?.file
  const siteFindings = new Map<number, Array<{kind: SiteFindingKind; message: string}>>()
  const functionFindings = new Map<string, Array<{kind: 'notLowered' | 'requirementsUnchecked'; message: string}>>()
  for (const finding of outcome.output.findings) {
    if (file != null && !sameFile(finding.file, file)) continue
    const classified = classifyFinding(finding)
    if (classified.scope === 'site') {
      const list = siteFindings.get(finding.line) ?? []
      list.push({kind: classified.kind, message: finding.message})
      siteFindings.set(finding.line, list)
    } else if (classified.scope === 'function') {
      const list = functionFindings.get(classified.functionName) ?? []
      list.push({kind: classified.kind, message: finding.message})
      functionFindings.set(classified.functionName, list)
    }
  }

  for (const site of sites) {
    const atLine = siteFindings.get(site.line) ?? []
    const matching = atLine.find(entry => entry.message.endsWith(site.text)) ?? atLine[0]
    if (matching != null) {
      verdicts.set(site.key, siteVerdictFor(matching.kind, matching.message))
      continue
    }
    const fnFindings = site.topLevelFunction == null ? [] : functionFindings.get(site.topLevelFunction) ?? []
    const notLowered = fnFindings.find(entry => entry.kind === 'notLowered')
    if (notLowered != null) {
      verdicts.set(site.key, {verdict: 'not-analyzed', reason: notLowered.message, finding: notLowered.message})
      continue
    }
    switch (site.role) {
      case 'outside':
        verdicts.set(site.key, {verdict: 'not-analyzed', reason: 'outside a named top-level function, and no finding names it', finding: null})
        break
      case 'requirement': {
        const unchecked = fnFindings.find(entry => entry.kind === 'requirementsUnchecked')
        verdicts.set(site.key, unchecked == null
          ? {verdict: 'requirement', reason: 'leading console.assert: a caller requirement, assumed inside the function', finding: null}
          : {verdict: 'could-not-prove', reason: unchecked.message, finding: unchecked.message})
        break
      }
      case 'assertion':
        verdicts.set(site.key, {verdict: 'proved', reason: 'interior assert in a lowered function with no finding at its line', finding: null})
        break
    }
  }
  return verdicts
}

// The reason a Freerange run produced no usable output: a timeout, a spawn failure, a TypeScript error exit, or output
// without the coverage line findings mode always prints.
export function failedRunReason(run: {timedOut: boolean; timeoutMs: number; spawnError: string | null; exitCode: number | null; stderr: string; coverageLine: string | null}): string | null {
  if (run.timedOut) return `timeout after ${Math.round(run.timeoutMs / 1000)} s`
  if (run.spawnError != null) return `could not start: ${run.spawnError}`
  if (run.coverageLine != null) return null
  const typeScriptError = run.stderr.split('\n').find(line => /error TS\d+/.test(line))
  if (typeScriptError != null) return `TypeScript errors before analysis: ${typeScriptError.trim()}`
  const lastLine = run.stderr.split('\n').map(line => line.trim()).find(line => line.length > 0 && !/^\d+\s/.test(line))
  return `no findings summary (exit ${run.exitCode ?? 'none'}${lastLine == null ? '' : `: ${lastLine}`})`
}
