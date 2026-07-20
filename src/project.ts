// Both commands resolve the tsconfig from the current directory — searching upward like
// `tsc` — and load that project and its declared references once. `fr [file]` prints lint
// findings — the CI gate — and `fr --audit [file]` prints the deep layer: every function's
// contracts plus refactoring suggestions. Each command's file version is the project
// version narrowed to that file: same configuration, same content kinds, same line
// formats, one file's slice.

import {existsSync, realpathSync} from 'node:fs'
import {resolve} from 'node:path'
import * as ts from 'typescript'
import {analyzeCheckedSource, type DetailedAnalysis} from './analyze.ts'
import {createFileAudit, formatFileAuditUnit} from './audit.ts'
import type {AssertionVerdict, FunctionAnalysis, RequirementFailure} from './engine/outcome.ts'
import type {SiteID} from './ir/ids.ts'
import {reportPath, siteLocation} from './ir/program.ts'
import {formatUnsupportedReason} from './report/index.ts'
import {checkFile} from './typescript/check.ts'
import {formatDiagnosticLocation, formatDiagnosticPrefix, formatTypeScriptDiagnostics, TypeScriptDiagnosticsError, usePrettyOutput} from './typescript/diagnostics.ts'
import {
  findTypeScriptConfig,
  loadTypeScriptProjectGraph,
  projectSources,
  type ProjectSource,
} from './typescript/project.ts'

type SimpleLintFinding = {
  kind: 'simple'
  file: string
  line: number
  column: number
  functionName: string
  stop: 'outOfBoundsRead' | 'nonExitingLoop'
}

type ErrorLintFinding = {
  kind: 'error'
  file: string
  line: number
  column: number
  rule: 'console-assert' | 'declared-requirement' | 'inferred-requirement'
  message: string
  related?: {label: string; line: number; column: number}
}

type LintFinding =
  | SimpleLintFinding
  | ErrorLintFinding

export type ProjectCoverage = {
  functions: number
  analyzed: number
  partial: number
  unsupported: number
}

type ProjectScan = {
  files: DetailedAnalysis[]
  coverage: ProjectCoverage
  pretty: boolean
}

// `fr`: every file's lint findings plus project coverage. TypeScript errors throw before
// analysis; the returned failure covers Freerange's error-level findings.
export function runProjectFindings(searchFrom: string): boolean {
  const scan = analyzeProject(searchFrom)
  const findings = scan.files.flatMap(collectLintFindings)
    .sort((left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column)
  console.log(formatFindings(findings, scan.coverage, scan.pretty))
  return findings.some(finding => lintLevel(finding) === 'error')
}

// `fr <file>`: the project findings narrowed to one file — the same finding lines a
// project run prints for the file, with the file's own coverage counts.
export function runFileFindings(file: string): boolean {
  const target = analyzeTargetFile(file)
  const findings = collectLintFindings(target.detailed)
    .sort((left, right) => left.line - right.line || left.column - right.column)
  console.log(formatFindings(findings, fileCoverage(target.detailed), target.pretty))
  return findings.some(finding => lintLevel(finding) === 'error')
}

// `fr --audit`: the deep layer at project scope. One unit per file — contracts, then
// refactoring suggestions — with the explanatory prose once at the top and project
// coverage once at the end. The units all come from the one shared project analysis;
// nothing here creates a per-file TypeScript program. Audit output is informational and
// returns success; TypeScript errors throw before audit output.
export function runProjectAudit(searchFrom: string): boolean {
  const scan = analyzeProject(searchFrom)
  const audits = scan.files.map(createFileAudit)
    .sort((left, right) => left.file.localeCompare(right.file))
  console.log([
    ...audits.map(audit => formatFileAuditUnit(audit, scan.pretty)),
    formatCoverage(scan.coverage),
  ].join('\n\n'))
  return false
}

// `fr --audit <file>`: exactly one file's unit under the same preamble — a literal slice
// of the project audit.
export function runFileAudit(file: string): boolean {
  const target = analyzeTargetFile(file)
  console.log(formatFileAuditUnit(createFileAudit(target.detailed), target.pretty))
  return false
}

function analyzeProject(searchFrom: string): ProjectScan {
  const configPath = findTypeScriptConfig(searchFrom)
  if (configPath == null) {
    throw new Error(`No tsconfig.json found from ${resolve(searchFrom)} or any parent directory.`)
  }
  const projects = loadTypeScriptProjectGraph(configPath)
  const rootProject = projects.at(-1)!
  const sources = projectSources(projects)
  const diagnostics = uniqueDiagnostics(projects.flatMap(project => ts.getPreEmitDiagnostics(project.program)))
  requireNoTypeScriptErrors(diagnostics, rootProject.parsed.options)

  const files: DetailedAnalysis[] = []
  let analyzed = 0
  let partial = 0
  let unsupported = 0

  for (const source of sources) {
    const detailed = analyzeProjectSource(source, process.cwd())
    files.push(detailed)
    const perFile = fileCoverage(detailed)
    analyzed += perFile.analyzed
    partial += perFile.partial
    unsupported += perFile.unsupported
  }

  return {
    files,
    coverage: {
      functions: analyzed + partial + unsupported,
      analyzed,
      partial,
      unsupported,
    },
    pretty: usePrettyOutput(rootProject.parsed.options['pretty']),
  }
}

function collectLintFindings({program, analysis}: DetailedAnalysis): LintFinding[] {
  const file = reportPath(program)
  const findings: LintFinding[] = []
  const addError = (
    site: SiteID,
    rule: ErrorLintFinding['rule'],
    message: string,
    related?: ErrorLintFinding['related'],
  ): void => {
    const location = siteLocation(program, site)
    findings.push({kind: 'error', file, ...location, rule, message, ...(related == null ? {} : {related})})
  }

  const addRequirementFailure = (
    failure: RequirementFailure,
    stopSite: SiteID,
    functionName: string,
    calleeName: string | null,
  ): void => {
    if (failure.kind === 'elementInBounds') {
      if (calleeName == null) {
        const location = siteLocation(program, stopSite)
        findings.push({kind: 'simple', file, ...location, functionName, stop: 'outOfBoundsRead'})
      } else {
        const origin = siteLocation(program, failure.site)
        addError(
          stopSite,
          'inferred-requirement',
          `call to ${calleeName} makes an asserted element read definitely out of bounds`,
          {label: 'element read at', ...origin},
        )
      }
      return
    }

    if (failure.kind === 'nonzeroDivisor') {
      if (calleeName == null) {
        addError(
          stopSite,
          'inferred-requirement',
          `${failure.operation} has a divisor that is definitely zero in ${functionName}`,
        )
      } else {
        const origin = siteLocation(program, failure.site)
        addError(
          stopSite,
          'inferred-requirement',
          `call to ${calleeName} violates its nonzero divisor requirement`,
          {label: `${failure.operation} at`, ...origin},
        )
      }
      return
    }

    if (failure.kind === 'finiteInput') {
      const origin = siteLocation(program, failure.site)
      addError(
        stopSite,
        'inferred-requirement',
        calleeName == null
          ? failure.status === 'refuted'
            ? `number input is definitely not finite in ${functionName}`
            : `could not verify the number input in ${functionName}`
          : failure.status === 'refuted'
            ? `call to ${calleeName} passes a number that is definitely not finite`
            : `could not verify ${calleeName}'s number input at this call`,
        {label: 'input declared at', ...origin},
      )
      return
    }

    if (calleeName == null) {
      addError(
        stopSite,
        'declared-requirement',
        failure.status === 'refuted'
          ? `declared console.assert requirement is false in ${functionName}`
          : `could not express or prove the declared console.assert requirement in ${functionName}`,
      )
    } else {
      const origin = siteLocation(program, failure.site)
      addError(
        stopSite,
        'declared-requirement',
        failure.status === 'refuted'
          ? `call to ${calleeName} makes its declared requirement definitely false`
          : `could not express or prove ${calleeName}'s declared requirement at this call`,
        {label: 'declared at', ...origin},
      )
    }
  }

  const collectStops = (fn: FunctionAnalysis): void => {
    if (fn.kind !== 'partial') return
    for (const stop of fn.stops) {
      const reason = stop.reason
      switch (reason.kind) {
        case 'nonExitingLoop': {
          const location = siteLocation(program, stop.site)
          findings.push({
            kind: 'simple',
            file,
            line: location.line,
            column: location.column,
            functionName: fn.lowering.name,
            stop: reason.kind,
          })
          break
        }
        case 'requirementFailure': {
          const callee = reason.callee == null ? null : program.functions[reason.callee]
          if (reason.callee != null && callee == null) throw new Error(`Unknown function ${reason.callee}`)
          addRequirementFailure(reason.failure, stop.site, fn.lowering.name, callee?.name ?? null)
          break
        }
        case 'recursion':
        case 'calleeStopped':
        case 'loopLimit':
        case 'unsupportedCode':
        case 'moduleRead':
        case 'kindMismatch':
        case 'possiblyMissingElement': break
      }
    }
  }

  const collectAssertions = (fn: FunctionAnalysis): void => {
    if (fn.kind === 'notLowered') return
    for (const assertion of fn.assertions) {
      const message = assertionErrorMessage(fn.lowering.name, assertion)
      if (message != null) addError(assertion.site, 'console-assert', message)
    }
    // Leading calls are requirements rather than interior assertion records. A function
    // containing only requirements must still satisfy the same complete-function gate.
    if (fn.assertions.length > 0) return
    const requirementSite = firstStaticRequirementSite(fn.lowering)
    if (requirementSite == null) return
    const incomplete = fn.kind === 'partial' || fn.boundsAssumptions.length > 0
    if (!incomplete) return
    const ownRequirementFailure = fn.kind === 'partial' && fn.stops.some(stop =>
      stop.reason.kind === 'requirementFailure'
        && stop.reason.callee == null
        && stop.reason.failure.kind === 'declared')
    if (!ownRequirementFailure) {
      addError(
        requirementSite,
        'console-assert',
        `console.assert requirements in ${fn.lowering.name} were not checked because the function did not finish analysis without site-specific assumptions`,
      )
    }
  }

  // The module initializer is analyzed through the same engine but stored separately
  // because no function can call it. Its failures are still project lint findings.
  collectStops(analysis.initializer)
  collectAssertions(analysis.initializer)
  for (const issue of program.staticAnnotationIssues) {
    addError(
      issue.site,
      'console-assert',
      'console.assert is only supported inside a named top-level function declaration',
    )
  }
  for (const fn of analysis.functions) {
    collectStops(fn)
    collectAssertions(fn)
    if (fn.kind === 'notLowered') {
      if (fn.lowering.hasStaticAnnotations) {
        const reason = formatUnsupportedReason(fn.lowering.reason)
        addError(
          fn.lowering.site,
          'console-assert',
          fn.lowering.reason.kind === 'staticAssertionForm'
            ? `${reason} in ${fn.lowering.name}`
            : `console.assert in ${fn.lowering.name} was not checked because ${reason}`,
        )
      }
    }
  }
  return findings
}

function firstStaticRequirementSite(fn: Exclude<FunctionAnalysis, {kind: 'notLowered'}>['lowering']): SiteID | null {
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind === 'staticRequire') return instruction.site
    }
  }
  return null
}

function assertionErrorMessage(functionName: string, assertion: AssertionVerdict): string | null {
  switch (assertion.verdict) {
    case 'proven': return null
    case 'refuted': return `console.assert condition can be false in ${functionName}: ${assertion.text}`
    case 'unproven': return `could not prove console.assert condition in ${functionName}: ${assertion.text}`
    case 'dead': return `console.assert is unreachable in ${functionName}: ${assertion.text}`
    case 'blocked': return `could not check console.assert condition in ${functionName}; the function did not finish analysis without site-specific assumptions: ${assertion.text}`
  }
}

// Project and file findings share this format: with a file argument, the output is the
// project output narrowed to the file, so only the coverage counts differ.
function formatFindings(findings: LintFinding[], coverage: ProjectCoverage, pretty: boolean): string {
  const lines: string[] = []
  for (const finding of findings) lines.push(formatLintFinding(finding, pretty))

  if (findings.length === 0) lines.push('No lint findings.')
  const errors = findings.filter(finding => lintLevel(finding) === 'error').length
  const warnings = findings.filter(finding => lintLevel(finding) === 'warning').length
  lines.push(
    '',
    `${findings.length} finding${findings.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}).`,
    formatCoverage(coverage),
    'Run `fr --audit [file]` for every function\'s contracts and refactoring suggestions.',
  )
  return lines.join('\n')
}

// The findings-mode coverage counts for one file, in the same shape project coverage
// uses; a file that reaches this point has no TypeScript errors, so nothing was skipped.
function fileCoverage(detailed: DetailedAnalysis): ProjectCoverage {
  const coverage = {
    functions: detailed.analysis.functions.length,
    analyzed: 0,
    partial: 0,
    unsupported: 0,
  }
  for (const fn of detailed.analysis.functions) {
    switch (fn.kind) {
      case 'analyzed': coverage.analyzed++; break
      case 'partial': coverage.partial++; break
      case 'notLowered': coverage.unsupported++; break
    }
  }
  return coverage
}

function formatLintFinding(finding: LintFinding, pretty: boolean): string {
  switch (finding.kind) {
    case 'simple': return finding.stop === 'outOfBoundsRead'
      ? `${formatLintPrefix(finding, 'out-of-bounds-read', pretty)}asserted element read (arr[i]!) is provably out of bounds in ${finding.functionName}`
      : `${formatLintPrefix(finding, 'non-exiting-loop', pretty)}loop in ${finding.functionName} has no analyzable exit; it may never terminate`
    case 'error': {
      const related = finding.related == null
        ? ''
        : ` (${finding.related.label} ${formatDiagnosticLocation({
          file: finding.file,
          line: finding.related.line,
          column: finding.related.column,
        }, pretty)})`
      return `${formatLintPrefix(finding, finding.rule, pretty)}${finding.message}${related}`
    }
  }
}

function lintLevel(finding: LintFinding): 'error' | 'warning' {
  switch (finding.kind) {
    case 'simple': return finding.stop === 'outOfBoundsRead' ? 'error' : 'warning'
    case 'error': return 'error'
  }
}

function formatLintPrefix(finding: LintFinding, rule: string, pretty: boolean): string {
  return formatDiagnosticPrefix(finding, lintLevel(finding), rule, pretty)
}

function formatCoverage(coverage: ProjectCoverage): string {
  return `coverage: ${coverage.analyzed}/${coverage.functions} named top-level function declarations fully analyzed; ${coverage.partial} partially supported; ${coverage.unsupported} unsupported.`
}

// A target file analyzed on its own, with the output styling its project configures.
type TargetFile = {detailed: DetailedAnalysis; pretty: boolean}

// The configuration rule: like a bare `fr`, the tsconfig is resolved from the current
// directory, never from the file's own directory. The file argument narrows the output,
// not the configuration, so a nested tsconfig near the file cannot make `fr sub/file.ts`
// disagree with what `fr` reports for that same file. When a project exists, the file
// must belong to it; otherwise there is no project result for file mode to be a subset of.
function analyzeTargetFile(file: string): TargetFile {
  const absoluteFile = resolve(file)
  if (!existsSync(absoluteFile)) throw new Error(`File not found: ${absoluteFile}`)
  const configPath = findTypeScriptConfig(process.cwd())
  if (configPath == null) return analyzeFileAlone(absoluteFile)

  const projects = loadTypeScriptProjectGraph(configPath)
  const rootProject = projects.at(-1)!
  const targetPath = canonicalFilePath(absoluteFile)
  const source = projectSources(projects).find(candidate =>
    canonicalFilePath(candidate.sourceFile.fileName) === targetPath)
  if (source == null) {
    throw new Error(`File is not part of the project resolved from ${configPath}: ${absoluteFile}`)
  }
  const diagnostics = ts.getPreEmitDiagnostics(source.project.program, source.sourceFile)
  requireNoTypeScriptErrors(diagnostics, rootProject.parsed.options)
  return {
    detailed: analyzeProjectSource(source, process.cwd()),
    pretty: usePrettyOutput(rootProject.parsed.options['pretty']),
  }
}

function canonicalFilePath(file: string): string {
  const real = realpathSync.native(file)
  return ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase()
}

// A single-file program when no tsconfig resolves from the current directory.
function analyzeFileAlone(absoluteFile: string): TargetFile {
  return {
    detailed: analyzeCheckedSource(checkFile(absoluteFile), process.cwd()),
    pretty: usePrettyOutput(undefined),
  }
}

function analyzeProjectSource(
  source: ProjectSource,
  reportBaseDirectory: string,
): DetailedAnalysis {
  return analyzeCheckedSource({
    sourceFile: source.sourceFile,
    checker: source.project.program.getTypeChecker(),
  }, reportBaseDirectory)
}

function uniqueDiagnostics(diagnostics: readonly ts.Diagnostic[]): ts.Diagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    const key = `${diagnostic.file?.fileName ?? ''}:${diagnostic.start ?? ''}:${diagnostic.length ?? ''}:${diagnostic.code}:${message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function printTypeScriptDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  options: ts.CompilerOptions,
  currentDirectory: string,
): void {
  if (diagnostics.length === 0) return
  console.error(formatTypeScriptDiagnostics(diagnostics, options, currentDirectory).trimEnd())
}

function requireNoTypeScriptErrors(
  diagnostics: readonly ts.Diagnostic[],
  options: ts.CompilerOptions,
): void {
  if (hasErrorDiagnostics(diagnostics)) {
    throw new TypeScriptDiagnosticsError(diagnostics, options, process.cwd())
  }
  printTypeScriptDiagnostics(diagnostics, options, process.cwd())
}

function hasErrorDiagnostics(diagnostics: readonly ts.Diagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
}
