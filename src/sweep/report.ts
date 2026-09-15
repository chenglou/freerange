// Turns a sweep run into per-site outcomes, stdout findings and the JSON sidecar. No sweep result reaches lowering or
// analysis; the static verdicts are only read, to choose between a warning, an internal error and JSON only.
//
// Per-site outcomes, pooled over every entry of the file that reaches the site:
//   counterexample  a verified firing at recorder level >= 3
//   fails-1e-9      some level-2 firing and no verified level >= 3
//   held            no level >= 2, and N >= 1,000 in-domain reaching inputs
//   starved         no level >= 2, and 1 <= N < 1,000
//   not-reached     N = 0
//   precondition    the site is a discard site for every entry that reaches it
//   unverified      a level >= 3 firing whose verification failed, with the reason
//   not-run         the file didn't load, no entry ran, or the child was stopped before any entry finished
import * as ts from 'typescript'
import type {DetailedAnalysis} from '../analyze.ts'
import type {FunctionAnalysis} from '../engine/outcome.ts'
import {siteLocation} from '../ir/program.ts'
import {maxMagnitude, type Value} from './domain.ts'
import {decodeJson, formatCall} from './encode.ts'
import type {EntryResult, Requirement, SweepRun, SweepSettings, Verification} from './run.ts'
import type {CauseClass, FirstInput, Site, SiteCounts} from './types.ts'

export type StaticVerdict = 'proven' | 'refuted' | 'unproven' | 'blocked' | 'dead' | 'not lowered' | 'requirement' | 'requirements not checked' | 'outside'
export type SiteOutcome = 'counterexample' | 'fails-1e-9' | 'held' | 'starved' | 'not-reached' | 'precondition' | 'unverified' | 'not-run'
export type StaticFinding = {line: number; message: string}
export type SweepFinding = {line: number; column: number; level: 'warning' | 'error'; rule: 'console-assert-sweep' | 'internal'; message: string; details: string[]}
export type SweepReport = {findings: SweepFinding[]; summaryLine: string; internalError: boolean; json: unknown}

/** The static verdict of each site, read from the analysis `fr` already printed findings for. */
export function staticVerdictLookup(detailed: DetailedAnalysis, staticFindings: StaticFinding[]): (site: Site) => StaticVerdict {
  const {program, analysis} = detailed
  const byName = new Map<string, FunctionAnalysis>()
  for (const fn of analysis.functions) byName.set(fn.lowering.name, fn)
  const outsideLines = new Set(program.staticAnnotationIssues.map((issue) => siteLocation(program, issue.site).line))
  return (site) => {
    if (site.functionName == null || outsideLines.has(site.line)) return 'outside'
    const fn = byName.get(site.functionName)
    if (fn == null) return 'outside'
    if (fn.kind === 'notLowered') return 'not lowered'
    if (site.leading) {
      const unchecked = staticFindings.some((finding) => finding.message.startsWith(`console.assert requirements in ${site.functionName} were not checked`))
      return unchecked ? 'requirements not checked' : 'requirement'
    }
    const assertion = fn.assertions.find((candidate) => siteLocation(program, candidate.site).line === site.line)
    return assertion?.verdict ?? 'outside'
  }
}

/** What a verification must show before the report acts: a proved site already contradicts at level 2, an unreachable one on a reach. */
export function requirementFor(verdict: StaticVerdict): Requirement {
  switch (verdict) {
    case 'proven': return 'level2'
    case 'dead': return 'reach'
    case 'refuted': case 'unproven': case 'blocked': case 'not lowered': case 'requirement': case 'requirements not checked': case 'outside': return 'level3'
  }
}

function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatCap(cap: number): string {
  return cap.toExponential().replace('e+', 'e')
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? text
}

type FunctionRange = {name: string; start: number; end: number}

function functionRanges(sourceFile: ts.SourceFile): FunctionRange[] {
  const lineOf = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1
  const result: FunctionRange[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) result.push({name: statement.name.text, start: lineOf(statement.getStart(sourceFile)), end: lineOf(statement.end)})
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (ts.isIdentifier(declaration.name) && initializer != null && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        result.push({name: declaration.name.text, start: lineOf(initializer.getStart(sourceFile)), end: lineOf(initializer.end)})
      }
    }
  }
  return result
}

/** The line of the first call of `callee` inside `range`, for a call a stack trace doesn't show, e.g. a tail call. */
function firstCallLine(sourceFile: ts.SourceFile, callee: string, range: FunctionRange | undefined): number | null {
  let line: number | null = null
  const visit = (node: ts.Node): void => {
    if (line != null) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      const callLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      if (range != null && range.start <= callLine && callLine <= range.end) line = callLine
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return line
}

/** The 1-based column of the first call of `callee` on `line`, or 1 when none is found. */
function callColumn(sourceFile: ts.SourceFile, line: number, callee: string): number {
  let column = 1
  const visit = (node: ts.Node): void => {
    if (column !== 1) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      if (position.line + 1 === line) column = position.character + 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return column
}

type Aggregate = {n: number; drawn: number; level2: number; level3: number; byCause: Record<CauseClass, number>; reaching: number; discarding: number}

function aggregate(entries: EntryResult[], site: Site): Aggregate {
  const result: Aggregate = {n: 0, drawn: 0, level2: 0, level3: 0, byCause: {subnormal: 0, drift: 0, large: 0, ordinary: 0}, reaching: 0, discarding: 0}
  for (const {entry, counts} of entries) {
    const siteCounts = counts?.sites.find((candidate) => candidate.site === site.index)
    if (counts == null || siteCounts == null) continue
    result.reaching += 1
    if (entry.discardSites.some((discard) => discard.site === site.index)) {
      result.discarding += 1
      continue
    }
    result.n += siteCounts.reached
    result.drawn += counts.drawn
    result.level2 += siteCounts.level2
    result.level3 += siteCounts.level3
    for (const cause of Object.keys(result.byCause) as CauseClass[]) result.byCause[cause] += siteCounts.byCause[cause]
  }
  return result
}

function firstFor(counts: SiteCounts, requirement: Requirement): FirstInput | null {
  switch (requirement) {
    case 'level3': return counts.first3
    case 'level2': return counts.first2
    case 'reach': return counts.firstReach
  }
}

/** Why a verification doesn't confirm the site, or null when it does. */
function verificationFailure(verification: Verification | undefined, site: Site, requirement: Requirement, sites: Site[], entries: EntryResult[], limits: SweepSettings['limits']): string | null {
  if (verification == null) return 'no input to verify'
  const line = verification.line
  if (line == null) return verification.item.item >= limits.verifyItems ? 'verification cap' : 'timed out'
  if (!line.digestMatches) return 'the regenerated input has a different digest'
  if (line.discarded != null) return `a ${line.discarded} discard console.assert failed on the regenerated input`
  if (line.overBudget) return 'the regenerated call passed the step budget'
  if (line.importedFailed) return 'a console.assert of an imported module failed (R1)'
  if (!line.finite) return 'a number in the input is not finite'
  if (line.threw != null) return `the regenerated call threw: ${firstLine(line.threw)}`
  const needed = requirement === 'level3' ? 3 : requirement === 'level2' ? 2 : 1
  if (line.level < needed) return requirement === 'reach' ? 'the regenerated input does not reach the assert in a fresh child' : `the regenerated input does not fail the assert at level ${needed} or above in a fresh child`
  if (requirement !== 'reach' && !line.fired.some((fired) => fired.line === site.line)) return 'the uninstrumented copy does not fail the assert line'
  const entry = entries.find((result) => result.entry.ordinal === verification.item.entry)?.entry
  const discardLines = new Set((entry?.discardSites ?? []).map((discard) => sites[discard.site]!.line))
  if (line.fired.some((fired) => fired.line !== site.line && discardLines.has(fired.line))) return `a leading or discard console.assert of ${entry?.name ?? 'the entry'} failed in the uninstrumented call`
  return null
}

type SiteReport = {site: Site; verdict: StaticVerdict; outcome: SiteOutcome; aggregate: Aggregate; why: string | null; first: {entry: EntryResult; input: FirstInput; verified: boolean} | null; action: 'warning' | 'call-site warning' | 'internal' | 'json only' | null; callLine: number | null}

export function sweepReport(options: {run: SweepRun; verdictOf: (site: Site) => StaticVerdict; detailed: DetailedAnalysis; staticFindings: StaticFinding[]; sourceFile: ts.SourceFile; settings: SweepSettings; level: 'warning' | 'error'; reportFile: string}): SweepReport {
  const {run, verdictOf, detailed, staticFindings, sourceFile, settings, level, reportFile} = options
  const limits = settings.limits
  const settingsJson = {level, filters: settings.filters, cap: settings.cap, budget: limits.inputsPerEntry, seed: 1, p0Inputs: 10_000, p2ProductMax: 50_000, stepBudget: limits.stepBudget, limits}
  const findings: SweepFinding[] = []
  const fileWarning = (message: string, line = 1) => findings.push({line, column: 1, level: 'warning', rule: 'console-assert-sweep', message, details: []})
  if (run.kind === 'not-run') {
    fileWarning(run.reason)
    const siteCap = run.reason.includes('above the cap')
    return {findings, internalError: false, summaryLine: 'sweep: 0 of 0 functions run; 0 asserts held on at least 1,000 generated inputs; 0 counterexamples; 0 functions not run', json: {file: reportFile, settings: settingsJson, status: {kind: 'not-run', reason: run.reason}, entries: [], sites: [], internalErrors: [], caps: {siteCap: siteCap ? 1 : 0}, timing: {}}}
  }

  const byName = new Map<string, FunctionAnalysis>()
  for (const fn of detailed.analysis.functions) byName.set(fn.lowering.name, fn)
  const ranges = functionRanges(sourceFile)
  const functionAt = (line: number) => ranges.find((range) => range.start <= line && line <= range.end)?.name ?? null
  const leadingLines = (name: string | null) => new Set(run.sites.filter((site) => site.leading && site.functionName === name).map((site) => site.line))
  // Freerange's claims inside a function assume its leading asserts, finite number inputs and every inferred precondition,
  // e.g. `requires: (width - 5) >= 0` propagated from a callee's leading assert. The sweep draws inputs only against leading
  // asserts, so a firing contradicts a static claim only in a fully analyzed function whose inferred preconditions all come
  // from its own leading asserts or finite inputs. Otherwise this says why the claim is conditional.
  const conditionalClaim = (name: string): string | null => {
    const fn = byName.get(name)
    if (fn == null || fn.kind !== 'analyzed') return `${name} was not fully analyzed`
    const own = leadingLines(name)
    const extra = fn.preconditions.find((precondition) => !(precondition.kind === 'declaredNumberCheck' && precondition.purpose === 'finiteInput') && !own.has(siteLocation(detailed.program, precondition.site).line))
    return extra == null ? null : `${name} has an inferred precondition from line ${siteLocation(detailed.program, extra.site).line} that generated inputs are not checked against`
  }
  const anyFinished = run.entries.some((result) => result.counts != null)

  const reports: SiteReport[] = run.sites.map((site) => {
    const verdict = verdictOf(site)
    const requirement = requirementFor(verdict)
    const totals = aggregate(run.entries, site)
    const report: SiteReport = {site, verdict, outcome: 'not-run', aggregate: totals, why: null, first: null, action: null, callLine: null}
    if (!anyFinished) {
      report.why = run.loadError ?? 'no entry finished'
      return report
    }
    if (totals.reaching > 0 && totals.discarding === totals.reaching) {
      report.outcome = 'precondition'
      return report
    }
    const verification = run.verifications.find((candidate) => candidate.item.site === site.index)
    const failure = verificationFailure(verification, site, requirement, run.sites, run.entries, limits)
    if (verification != null) {
      const entry = run.entries.find((result) => result.entry.ordinal === verification.item.entry)!
      const counts = entry.counts?.sites.find((candidate) => candidate.site === site.index)
      const input = counts == null ? null : firstFor(counts, requirement)
      if (input != null) report.first = {entry, input, verified: failure == null}
    }
    const verifiedLevel = failure == null ? verification?.line?.level ?? 0 : 0
    if (totals.level3 > 0 && requirement !== 'reach') {
      report.outcome = verifiedLevel >= 3 ? 'counterexample' : verifiedLevel === 2 ? 'fails-1e-9' : 'unverified'
      report.why = failure
    } else if (totals.level2 > 0) {
      report.outcome = 'fails-1e-9'
    } else {
      report.outcome = totals.n >= limits.held ? 'held' : totals.n >= 1 ? 'starved' : 'not-reached'
    }
    if (failure != null || verification?.line == null) return report
    const fired = verification.line.fired.find((candidate) => candidate.line === site.line)
    const entryName = report.first?.entry.entry.name ?? ''
    const inEntry = (name: string | null): name is string => name != null && name === entryName
    if (verdict === 'dead') {
      const conditional = inEntry(site.functionName) ? conditionalClaim(site.functionName) : `the assert is reached through ${entryName}`
      report.action = conditional == null ? 'internal' : 'json only'
      report.why = conditional
      return report
    }
    if (verifiedLevel < 2 || (verifiedLevel === 2 && verdict !== 'proven')) return report
    if (site.leading && site.functionName != null && site.functionName !== entryName) {
      const callee = site.functionName
      const callLine = fired?.callerLine ?? firstCallLine(sourceFile, callee, ranges.find((range) => range.name === entryName))
      report.callLine = callLine
      if (verifiedLevel < 3) return report
      const caller = callLine == null ? null : functionAt(callLine)
      const staticCall = callLine != null && staticFindings.some((finding) => finding.line === callLine && finding.message.startsWith(`call to ${callee}`))
      const conditional = !inEntry(caller) ? 'the call is not directly in the entry'
        : byName.get(callee)?.kind === 'notLowered' ? `${callee} was not lowered`
        : staticCall ? 'Freerange reports a finding at this call'
        : conditionalClaim(caller)
      report.action = conditional == null ? 'internal' : 'call-site warning'
      report.why = conditional
      return report
    }
    switch (verdict) {
      case 'proven': {
        const conditional = inEntry(site.functionName) ? conditionalClaim(site.functionName) : `the assert is reached through ${entryName}`
        report.action = conditional == null ? 'internal' : 'json only'
        report.why = conditional
        return report
      }
      case 'refuted':
        report.action = 'json only'
        return report
      case 'unproven': case 'blocked': case 'not lowered': case 'requirement': case 'requirements not checked': case 'outside':
        report.action = 'warning'
        return report
    }
  })

  const formatInput = (report: SiteReport) => {
    const first = report.first!
    const args = decodeJson(first.input.args) as Value[]
    const text = formatCall(first.entry.entry.name, args)
    const bytes = new TextEncoder().encode(text)
    if (bytes.length <= limits.inputBytes) return {text, magnitude: maxMagnitude(args), truncated: false}
    const kept = new TextDecoder().decode(bytes.slice(0, limits.inputBytes))
    return {text: `${kept}… [input truncated at ${formatCount(limits.inputBytes)} bytes; the JSON sidecar keeps input ${first.input.index} of ${first.entry.entry.name}]`, magnitude: maxMagnitude(args), truncated: true}
  }

  let internalError = false
  let printedCounterexamples = 0
  let counterexamples = 0
  let truncatedInputs = 0
  const internalErrors: {line: number; message: string}[] = []
  const ordered = [...reports].sort((left, right) => left.site.line - right.site.line || left.site.column - right.site.column)
  for (const report of ordered) {
    if (report.action == null || report.action === 'json only') continue
    const {site} = report
    const input = formatInput(report)
    if (input.truncated) truncatedInputs += 1
    const entryName = report.first!.entry.entry.name
    const functionName = site.functionName ?? entryName
    switch (report.action) {
      case 'internal': {
        internalError = true
        const message = report.verdict === 'dead' ? 'unreachable assert was reached'
          : site.leading ? `soundness violation: requirement of ${site.functionName ?? ''} proved at this call can fail`
          : `soundness violation: console.assert proved in ${functionName} can fail: ${site.text}`
        const line = site.leading && report.callLine != null ? report.callLine : site.line
        const column = site.leading && report.callLine != null ? callColumn(sourceFile, report.callLine, site.functionName ?? '') : site.column
        internalErrors.push({line, message})
        findings.push({line, column, level: 'error', rule: 'internal', message, details: [`  input: ${input.text}`]})
        break
      }
      case 'warning': {
        counterexamples += 1
        if (printedCounterexamples >= limits.printed) break
        printedCounterexamples += 1
        findings.push({
          line: site.line, column: site.column, level, rule: 'console-assert-sweep', message: `console.assert condition failed on a generated input in ${functionName}: ${site.text}`,
          details: [
            `  input: ${input.text}`,
            `  fix ${functionName} if a caller can pass this input; otherwise say when the property holds: add a leading console.assert to ${entryName} that rules this input out, or guard this assert with the condition it needs`,
            `  domain: ${report.aggregate.n} of ${report.aggregate.drawn} generated inputs reached this assert in the domain; numbers no assert bounds are drawn from [-${formatCap(settings.cap)}, ${formatCap(settings.cap)}]; largest |number| in this input: ${input.magnitude}`,
          ],
        })
        break
      }
      case 'call-site warning': {
        counterexamples += 1
        if (printedCounterexamples >= limits.printed) break
        printedCounterexamples += 1
        const callLine = report.callLine ?? site.line
        const caller = report.callLine == null ? entryName : functionAt(report.callLine) ?? entryName
        findings.push({
          line: callLine, column: report.callLine == null ? site.column : callColumn(sourceFile, callLine, site.functionName ?? ''), level, rule: 'console-assert-sweep',
          message: `call to ${site.functionName ?? ''} failed its leading console.assert on a generated input in ${caller}: ${site.text}`,
          details: [`  input: ${input.text}`, `  fix ${caller} if a caller of ${entryName} can pass this input; otherwise add a leading console.assert to ${entryName} that rules it out`],
        })
        break
      }
    }
  }

  if (run.loadError != null) fileWarning(`could not load ${reportFile} for a sweep: ${firstLine(run.loadError)}`)
  else if (run.run != null && run.run.killed != null) fileWarning(`sweep of ${reportFile} stopped: ${run.run.killed}`)
  else if (run.run != null && run.run.doneMaxRssKb == null) fileWarning(`sweep of ${reportFile} stopped: the child exited with code ${run.run.exitCode ?? 'none'} before it finished`)
  for (const result of run.entries) {
    const counts = result.counts
    if (counts != null && counts.threw > 0 && counts.inDomain === 0) fileWarning(`sweep of ${reportFile}: every generated call of ${result.entry.name} that was not discarded threw: ${firstLine(counts.firstThrow ?? '')}`, result.entry.line)
  }

  const statusText = (result: EntryResult) => {
    switch (result.status.kind) {
      case 'run': return 'run'
      case 'unsupported': return `unsupported:${result.status.reason}`
      case 'not-run': return `not-run:${result.status.reason}`
      case 'load-failed': return 'load-failed'
      case 'killed': return `killed:${result.status.reason}`
    }
  }
  const ran = run.entries.filter((result) => result.counts != null).length
  const held = reports.filter((report) => report.outcome === 'held').length
  const summaryLine = `sweep: ${ran} of ${run.entries.length} functions run; ${held} asserts held on at least ${formatCount(limits.held)} generated inputs; ${counterexamples} counterexamples; ${run.entries.length - ran} functions not run`
  const killedBy = (reason: string) => (run.run?.killed === reason ? 1 : 0)
  const json = {
    file: reportFile,
    settings: settingsJson,
    status: {kind: 'ran', loadError: run.loadError, killed: run.run?.killed ?? null, exitCode: run.run?.exitCode ?? null, verifyKilled: run.verify?.killed ?? null},
    entries: run.entries.map((result) => ({
      name: result.entry.name, line: result.entry.line, status: statusText(result), drawn: result.counts?.drawn ?? 0, inDomain: result.counts?.inDomain ?? 0,
      discards: result.counts?.discards ?? {leading: 0, F1: 0, F3: 0, R1: 0}, overBudget: result.counts?.overBudget ?? 0, threw: result.counts?.threw ?? 0,
      discardSites: result.entry.discardSites.map((discard) => ({line: run.sites[discard.site]!.line, cause: discard.cause})), lengthTies: result.entry.lengthTies,
    })),
    sites: reports.map((report) => ({
      key: report.site.key, line: report.site.line, column: report.site.column, function: report.site.functionName, role: report.site.leading ? 'requirement' : report.verdict === 'outside' ? 'outside' : 'assertion',
      staticVerdict: report.verdict, outcome: report.outcome, n: report.aggregate.n, drawn: report.aggregate.drawn, level2: report.aggregate.level2, level3: report.aggregate.level3, firingByCause: report.aggregate.byCause,
      first: report.first == null ? null : {entry: report.first.entry.entry.name, index: report.first.input.index, input: report.first.input.args, margin: report.first.input.margin, cause: report.first.input.cause, verified: report.first.verified},
      why: report.why, action: report.action, callLine: report.callLine, caller: report.callLine == null ? null : functionAt(report.callLine),
    })),
    internalErrors,
    caps: {
      entryCap: run.entries.filter((result) => result.status.kind === 'not-run').length, siteCap: 0,
      stepBudget: run.entries.reduce((total, result) => total + (result.counts?.overBudget ?? 0), 0),
      heartbeat: killedBy('heartbeat'), hardLimit: killedBy('hard limit') + (run.verify?.killed === 'hard limit' ? 1 : 0), rss: killedBy('RSS') + (run.verify?.killed === 'RSS' ? 1 : 0),
      outputCap: killedBy('output cap') + (run.verify?.killed === 'output cap' ? 1 : 0), loadStep: killedBy('load step'),
      verificationCap: Math.max(0, run.verifications.length - limits.verifyItems), verificationTimedOut: run.verifications.filter((verification) => verification.line == null && verification.item.item < limits.verifyItems).length,
      printedCounterexamples: Math.max(0, counterexamples - printedCounterexamples), inputTruncated: truncatedInputs,
    },
    timing: {
      totalMs: run.ms,
      // The `fr` process's own peak RSS (getrusage self): /usr/bin/time -l also counts a killed child's peak toward its parent.
      parentMaxRssKb: process.resourceUsage().maxRSS,
      run: run.run == null ? null : {ms: run.run.ms, peakRssKb: run.run.peakRssKb, doneMaxRssKb: run.run.doneMaxRssKb},
      verify: run.verify == null ? null : {ms: run.verify.ms, peakRssKb: run.verify.peakRssKb, doneMaxRssKb: run.verify.doneMaxRssKb},
    },
  }
  return {findings, summaryLine, internalError, json}
}
