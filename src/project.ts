// The two commands load the nearest TypeScript project and its declared references once
// and analyze type-correct source files. `fr [file]` prints lint findings — the CI gate —
// and `fr --audit [file]` prints the deep layer: every function's contracts plus
// refactoring suggestions. Each command's file version is the project version narrowed to
// that file: same content kinds, same line formats, one file's slice.

import {existsSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import * as ts from 'typescript'
import {analyzeCheckedSource, type DetailedAnalysis} from './analyze.ts'
import {auditPreamble, createFileAudit, formatFileAuditUnit} from './audit.ts'
import type {FunctionAnalysis} from './engine/outcome.ts'
import type {SiteID} from './ir/ids.ts'
import {reportPath, siteLocation} from './ir/program.ts'
import {describePrecondition, type PreconditionOperation} from './report/format-requirement.ts'
import {checkFile} from './typescript/check.ts'
import {formatTypeScriptDiagnostics, TypeScriptDiagnosticsError, usePrettyOutput} from './typescript/diagnostics.ts'
import {
  findTypeScriptConfig,
  loadTypeScriptProjectGraph,
  projectSources,
  type LoadedTypeScriptProject,
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

type CallerContract = {functionName: string; condition: string}

type CallerContractFinding = {
  kind: 'callerContracts'
  file: string
  line: number
  column: number
  operation: PreconditionOperation
  contracts: CallerContract[]
  additionalLocations: Array<{line: number; column: number}>
}

type LintFinding = SimpleLintFinding | CallerContractFinding

export type ProjectCoverage = {
  files: number
  typeErrorFiles: number
  functions: number
  analyzed: number
  partial: number
  unsupported: number
}

type ProjectScan = {
  files: DetailedAnalysis[]
  coverage: ProjectCoverage
  hasTypeScriptErrors: boolean
  pretty: boolean
}

// `fr`: every file's lint findings plus project coverage. Findings are the CI gate, so
// the returned failure covers error-level findings as well as TypeScript errors.
export function runProjectFindings(searchFrom: string): boolean {
  const scan = analyzeProject(searchFrom)
  const findings = scan.files.flatMap(collectLintFindings)
    .sort((left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column)
  console.log(formatFindings(findings, scan.coverage, scan.pretty))
  return scan.hasTypeScriptErrors || findings.some(finding => lintLevel(finding) === 'error')
}

// `fr <file>`: the project findings narrowed to one file — the same finding lines a
// project run prints for the file, with the file's own coverage counts.
export function runFileFindings(file: string): boolean {
  const target = analyzeTargetFile(file)
  if (target == null) return true
  const findings = collectLintFindings(target.detailed)
    .sort((left, right) => left.line - right.line || left.column - right.column)
  console.log(formatFindings(findings, fileCoverage(target.detailed), target.pretty))
  return findings.some(finding => lintLevel(finding) === 'error')
}

// `fr --audit`: the deep layer at project scope. One unit per file — contracts, then
// refactoring suggestions — with the explanatory prose once at the top and project
// coverage once at the end. The units all come from the one shared project analysis;
// nothing here creates a per-file TypeScript program. Audit output is informational: the
// returned failure only signals TypeScript errors.
export function runProjectAudit(searchFrom: string): boolean {
  const scan = analyzeProject(searchFrom)
  const audits = scan.files.map(createFileAudit)
    .sort((left, right) => left.file.localeCompare(right.file))
  console.log([
    auditPreamble,
    ...audits.map(formatFileAuditUnit),
    formatCoverage(scan.coverage),
  ].join('\n\n'))
  return scan.hasTypeScriptErrors
}

// `fr --audit <file>`: exactly one file's unit under the same preamble — a literal slice
// of the project audit.
export function runFileAudit(file: string): boolean {
  const target = analyzeTargetFile(file)
  if (target == null) return true
  console.log([auditPreamble, formatFileAuditUnit(createFileAudit(target.detailed))].join('\n\n'))
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
  const diagnosticsByProject = new Map(projects.map(project => [project, collectProjectDiagnostics(project)]))
  const allDiagnostics = uniqueDiagnostics(projects.flatMap(project => diagnosticsByProject.get(project)!.all))
  printTypeScriptDiagnostics(allDiagnostics, rootProject.parsed.options, process.cwd())

  const files: DetailedAnalysis[] = []
  let typeErrorFiles = 0
  let analyzed = 0
  let partial = 0
  let unsupported = 0

  for (const source of sources) {
    const projectDiagnostics = diagnosticsByProject.get(source.project)!
    const diagnostics = [
      ...projectDiagnostics.global,
      ...(projectDiagnostics.byFile.get(resolve(source.sourceFile.fileName)) ?? []),
    ]
    if (hasErrorDiagnostics(diagnostics)) {
      typeErrorFiles++
      continue
    }

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
      files: sources.length,
      typeErrorFiles,
      functions: analyzed + partial + unsupported,
      analyzed,
      partial,
      unsupported,
    },
    hasTypeScriptErrors: hasErrorDiagnostics(allDiagnostics),
    pretty: usePrettyOutput(rootProject.parsed.options['pretty']),
  }
}

function collectLintFindings({program, analysis}: DetailedAnalysis): LintFinding[] {
  const file = reportPath(program)
  const findings: LintFinding[] = []
  const callerContractsBySite = new Map<SiteID, CallerContractFinding>()

  const collectStops = (fn: FunctionAnalysis): void => {
    if (fn.kind !== 'partial') return
    for (const stop of fn.stops) {
      if (stop.reason.kind !== 'outOfBoundsRead' && stop.reason.kind !== 'nonExitingLoop') continue
      const location = siteLocation(program, stop.site)
      findings.push({
        kind: 'simple',
        file,
        line: location.line,
        column: location.column,
        functionName: fn.lowering.name,
        stop: stop.reason.kind,
      })
    }
  }

  // The module initializer is analyzed through the same engine but stored separately
  // because no function can call it. Its failures are still project lint findings.
  collectStops(analysis.initializer)
  for (const fn of analysis.functions) {
    collectStops(fn)
    if (fn.kind !== 'analyzed') continue

    const parameterNames = fn.lowering.parameters.map(parameter => parameter.name)
    for (const precondition of fn.preconditions) {
      const description = describePrecondition(precondition, parameterNames)
      let finding = callerContractsBySite.get(precondition.site)
      if (finding == null) {
        const location = siteLocation(program, precondition.site)
        finding = {
          kind: 'callerContracts',
          file,
          line: location.line,
          column: location.column,
          operation: description.operation,
          contracts: [],
          additionalLocations: [],
        }
        callerContractsBySite.set(precondition.site, finding)
      } else if (finding.operation !== description.operation) {
        throw new Error(
          `One operation site produced both ${finding.operation} and ${description.operation} requirements`,
        )
      }
      finding.contracts.push({functionName: fn.lowering.name, condition: description.condition})
    }
  }

  const groupedCallerContracts: CallerContractFinding[] = []
  const callerContractOperations = [...callerContractsBySite.values()]
    .sort((left, right) => left.line - right.line || left.column - right.column)
  for (const finding of callerContractOperations) {
    const existing = groupedCallerContracts.find(candidate =>
      candidate.operation === finding.operation && sameCallerContracts(candidate.contracts, finding.contracts))
    if (existing == null) groupedCallerContracts.push(finding)
    else existing.additionalLocations.push({line: finding.line, column: finding.column})
  }
  findings.push(...groupedCallerContracts)
  return findings
}

// Project and file findings share this format: with a file argument, the output is the
// project output narrowed to the file, so only the coverage counts differ.
function formatFindings(findings: LintFinding[], coverage: ProjectCoverage, pretty: boolean): string {
  const lines: string[] = []
  for (const finding of findings) lines.push(...formatLintFinding(finding, pretty))

  if (findings.length === 0) lines.push('No lint findings.')
  const errors = findings.filter(finding => lintLevel(finding) === 'error').length
  const warnings = findings.filter(finding => lintLevel(finding) === 'warning').length
  const notes = findings.filter(finding => lintLevel(finding) === 'note').length
  lines.push(
    '',
    `${findings.length} finding${findings.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}).`,
    formatCoverage(coverage),
    'Lint findings come only from analyzed paths. Run `fr --audit [file]` for every function\'s contracts and refactoring suggestions.',
  )
  return lines.join('\n')
}

// The findings-mode coverage counts for one file, in the same shape project coverage
// uses; a file that reaches this point has no TypeScript errors, so nothing was skipped.
function fileCoverage(detailed: DetailedAnalysis): ProjectCoverage {
  const coverage = {
    files: 1,
    typeErrorFiles: 0,
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

function formatLintFinding(finding: LintFinding, pretty: boolean): string[] {
  const location = formatDiagnosticLocation(finding.file, finding.line, finding.column, pretty)
  if (finding.kind === 'simple') {
    return [finding.stop === 'outOfBoundsRead'
      ? `${formatLintPrefix(finding, 'out-of-bounds-read', pretty)}asserted element read (arr[i]!) is provably out of bounds in ${finding.functionName}`
      : `${formatLintPrefix(finding, 'non-exiting-loop', pretty)}loop in ${finding.functionName} has no analyzable exit; it may never terminate`]
  }
  const operationCount = finding.additionalLocations.length + 1
  if (operationCount === 1 && finding.contracts.length === 1) {
    const contract = finding.contracts[0]!
    return [
      `${formatLintPrefix(finding, 'caller-contract', pretty)}callers of ${contract.functionName} must keep ${contract.condition} (${finding.operation} at ${location})`,
    ]
  }

  const operationSubject = operationCount === 1
    ? `this ${finding.operation}`
    : `${operationCount} ${finding.operation === 'element read' ? 'element reads' : `${finding.operation}s`}`
  const conditionSubject = `${finding.contracts.length} caller condition${finding.contracts.length === 1 ? '' : 's'}`
  const lines = [
    `${formatLintPrefix(finding, 'caller-contract', pretty)}${operationSubject} ${operationCount === 1 ? 'requires' : 'require'} ${conditionSubject}`,
  ]
  let lastShownLine = finding.line
  let lastShownColumn = finding.column
  for (const additional of finding.additionalLocations) {
    if (lastShownLine === additional.line && lastShownColumn === additional.column) continue
    lastShownLine = additional.line
    lastShownColumn = additional.column
    lines.push(`  also at ${formatDiagnosticLocation(finding.file, additional.line, additional.column, pretty)}`)
  }
  for (const contract of finding.contracts) lines.push(`  ${contract.functionName}: ${contract.condition}`)
  return lines
}

function lintLevel(finding: LintFinding): 'error' | 'warning' | 'note' {
  if (finding.kind === 'callerContracts') return 'note'
  return finding.stop === 'outOfBoundsRead' ? 'error' : 'warning'
}

function formatLintPrefix(finding: LintFinding, rule: string, pretty: boolean): string {
  const location = formatDiagnosticLocation(finding.file, finding.line, finding.column, pretty)
  const level = lintLevel(finding)
  const separator = pretty ? ' - ' : ': '
  const formattedLevel = pretty
    ? color(level === 'error' ? 91 : level === 'warning' ? 93 : 96, level)
    : level
  const ruleLabel = ` [${rule}]: `
  return `${location}${separator}${formattedLevel}${pretty ? color(90, ruleLabel) : ruleLabel}`
}

function formatDiagnosticLocation(file: string, line: number, column: number, pretty: boolean): string {
  return pretty
    ? `${color(96, file)}:${color(93, line)}:${color(93, column)}`
    : `${file}(${line},${column})`
}

function color(code: number, text: string | number): string {
  return `\u001B[${code}m${text}\u001B[0m`
}

function formatCoverage(coverage: ProjectCoverage): string {
  return `coverage: ${coverage.analyzed}/${coverage.functions} named top-level function declarations fully analyzed; ${coverage.partial} partial; ${coverage.unsupported} unsupported; ${coverage.typeErrorFiles}/${coverage.files} project files skipped for TypeScript errors.`
}

function sameCallerContracts(left: CallerContract[], right: CallerContract[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index]!.functionName !== right[index]!.functionName
      || left[index]!.condition !== right[index]!.condition) {
      return false
    }
  }
  return true
}

// A target file analyzed on its own, with the output styling its project configures.
// null means the file has TypeScript errors (already printed) and cannot be analyzed.
type TargetFile = {detailed: DetailedAnalysis; pretty: boolean}

function analyzeTargetFile(file: string): TargetFile | null {
  const absoluteFile = resolve(file)
  if (!existsSync(absoluteFile)) throw new Error(`File not found: ${absoluteFile}`)
  const configPath = findTypeScriptConfig(dirname(absoluteFile))
  if (configPath == null) {
    try {
      return {
        detailed: analyzeCheckedSource(checkFile(absoluteFile), process.cwd()),
        pretty: usePrettyOutput(),
      }
    } catch (error) {
      if (!(error instanceof TypeScriptDiagnosticsError)) throw error
      printTypeScriptDiagnostics(error.diagnostics, error.options, process.cwd())
      return null
    }
  }

  const projects = loadTypeScriptProjectGraph(configPath)
  const source = projectSources(projects).find(candidate => resolve(candidate.sourceFile.fileName) === absoluteFile)
  if (source == null) throw new Error(`${absoluteFile} is not part of the TypeScript project ${configPath}.`)
  const diagnostics = ts.getPreEmitDiagnostics(source.project.program, source.sourceFile)
  printTypeScriptDiagnostics(diagnostics, source.project.parsed.options, process.cwd())
  if (hasErrorDiagnostics(diagnostics)) return null
  return {
    detailed: analyzeProjectSource(source, process.cwd()),
    pretty: usePrettyOutput(source.project.parsed.options['pretty']),
  }
}

type CollectedProjectDiagnostics = {
  all: readonly ts.Diagnostic[]
  global: readonly ts.Diagnostic[]
  byFile: Map<string, ts.Diagnostic[]>
}

function collectProjectDiagnostics(project: LoadedTypeScriptProject): CollectedProjectDiagnostics {
  const all = ts.getPreEmitDiagnostics(project.program)
  const global: ts.Diagnostic[] = []
  const byFile = new Map<string, ts.Diagnostic[]>()
  for (const diagnostic of all) {
    if (diagnostic.file == null) {
      global.push(diagnostic)
      continue
    }
    const file = resolve(diagnostic.file.fileName)
    const diagnostics = byFile.get(file)
    if (diagnostics == null) byFile.set(file, [diagnostic])
    else diagnostics.push(diagnostic)
  }
  return {all, global, byFile}
}

function analyzeProjectSource(source: ProjectSource, reportBaseDirectory: string): DetailedAnalysis {
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

function hasErrorDiagnostics(diagnostics: readonly ts.Diagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
}
