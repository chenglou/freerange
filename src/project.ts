// Project mode: the nearest TypeScript project (and its declared project references),
// then per-file lowering and analysis under each project's own compiler options.
// Full per-file reports go to an output directory mirroring the source tree names;
// LEGEND.txt and SUMMARY.txt (totals, the requires index, rejection and stop tallies)
// are written once per run, and stdout gets the tallies. Targeted file mode uses the same
// project programs and therefore resolves aliases identically.

import {mkdirSync, writeFileSync} from 'node:fs'
import {dirname, join, relative, resolve, sep} from 'node:path'
import * as ts from 'typescript'
import {analyzeProgram} from './engine/analyze.ts'
import type {SiteID} from './ir/ids.ts'
import {siteLocation} from './ir/program.ts'
import {lowerSource} from './lower/program.ts'
import {describePrecondition, type PreconditionOperation} from './report/format-requirement.ts'
import {createReport, formatReport, reportLegend} from './report/index.ts'
import {checkFile} from './typescript/check.ts'
import {formatTypeScriptDiagnostics, TypeScriptDiagnosticsError} from './typescript/diagnostics.ts'
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
  level: 'error' | 'warning'
  message: string
  rule: 'out-of-bounds-read' | 'non-exiting-loop'
}

type CallerContract = {functionName: string; condition: string}

type CallerContractFinding = {
  kind: 'callerContracts'
  file: string
  line: number
  column: number
  level: 'note'
  rule: 'caller-contract'
  operation: PreconditionOperation
  contracts: CallerContract[]
  additionalLocations: Array<{line: number; column: number}>
}

type LintFinding = SimpleLintFinding | CallerContractFinding

function sameCallerContracts(left: CallerContract[], right: CallerContract[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index]!.functionName !== right[index]!.functionName || left[index]!.condition !== right[index]!.condition) {
      return false
    }
  }
  return true
}

export type ProjectRunResult = {
  hasTypeScriptErrors: boolean
  rootDirectory: string
}

export function runProject(searchFrom: string, requestedOutputDirectory?: string): ProjectRunResult {
  const configPath = findTypeScriptConfig(searchFrom)
  if (configPath == null) {
    throw new Error(`No tsconfig.json found from ${resolve(searchFrom)} or any parent directory.`)
  }
  const projects = loadTypeScriptProjectGraph(configPath)
  const rootProject = projects.at(-1)!
  const rootDirectory = rootProject.rootDirectory
  const outputDirectory = resolve(requestedOutputDirectory ?? join(rootDirectory, 'freerange-report'))
  mkdirSync(outputDirectory, {recursive: true})
  const sources = projectSources(projects)
  const diagnosticsByProject = new Map(projects.map(project => [project, collectProjectDiagnostics(project)]))
  const allDiagnostics = uniqueDiagnostics(projects.flatMap(project => diagnosticsByProject.get(project)!.all))

  console.error(`program over ${sources.length} files in ${projects.length} TypeScript project${projects.length === 1 ? '' : 's'}...`)
  printTypeScriptDiagnostics(allDiagnostics, rootProject.parsed.options, process.cwd())
  console.error('typecheck done, analyzing per file...')

  type FileRow = {
    file: string
    functions: number
    analyzed: number
    partial: number
    unsupported: number
    verdict: 'typeErrors' | 'noFunctions' | 'analyzed'
  }
  const rows: FileRow[] = []
  const reasonCounts = new Map<string, number>()
  const stopCounts = new Map<string, number>()
  const bump = <Key>(map: Map<Key, number>, key: Key): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  // Every requires line in the run, with its home — the rarest and most actionable content,
  // surfaced in SUMMARY.txt instead of buried under the assumes bulk.
  const requiresIndex: string[] = []

  // The linter view: only obligations nobody discharges, at points where failure is
  // silent. Requirements propagated through several functions stay attached to the one
  // operation that created them instead of appearing as independent findings.
  const lintFindings: LintFinding[] = []

  for (const source of sources) {
    const {project, sourceFile} = source
    const shortName = relative(rootDirectory, sourceFile.fileName).split(sep).join('/')
    console.error(`  ${shortName}`)
    const projectDiagnostics = diagnosticsByProject.get(project)!
    const diagnostics = [
      ...projectDiagnostics.global,
      ...(projectDiagnostics.byFile.get(resolve(sourceFile.fileName)) ?? []),
    ]
    const errors = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    if (errors.length > 0) {
      rows.push({file: shortName, functions: 0, analyzed: 0, partial: 0, unsupported: 0, verdict: 'typeErrors'})
      const first = errors[0]!
      writeFileSync(`${outputDirectory}/${shortName.replaceAll('/', '__')}.txt`,
        `TYPE ERRORS (${errors.length}):\n${ts.flattenDiagnosticMessageText(first.messageText, '\n')}\n`)
      continue
    }
    try {
      const lowered = lowerSource({sourceFile, checker: project.program.getTypeChecker()}, rootDirectory)
      const analysis = analyzeProgram(lowered)
      const report = createReport(lowered, analysis)
      const callerContractsBySite = new Map<SiteID, CallerContractFinding>()
      const functionReports = report.functions.filter(entry => entry.name !== 'module initialization')
      let analyzed = 0
      let partial = 0
      let unsupported = 0
      for (const entry of functionReports) {
        if (entry.kind === 'analyzed') analyzed++
        if (entry.kind === 'partial') partial++
        if (entry.kind === 'unsupported') unsupported++
      }
      // Reason tags from the IR, not prose, so the tally is stable.
      for (let fnId = 0; fnId < lowered.functions.length; fnId++) {
        const fn = lowered.functions[fnId]!
        if (fn.kind === 'unsupported') bump(reasonCounts, fn.reason.kind === 'call' ? `call:${fn.reason.callee}` : fn.reason.kind)
      }
      for (let fnId = 0; fnId < analysis.functions.length; fnId++) {
        const fn = analysis.functions[fnId]!
        if (fn.kind === 'partial') {
          for (const stop of fn.stops) {
            bump(stopCounts, stop.reason.kind)
            // These two stops are findings in their own right, not coverage gaps.
            if (stop.reason.kind !== 'outOfBoundsRead' && stop.reason.kind !== 'nonExitingLoop') continue
            const location = siteLocation(lowered, stop.site)
            lintFindings.push(stop.reason.kind === 'outOfBoundsRead'
              ? {kind: 'simple', file: shortName, line: location.line, column: location.column, level: 'error', message: `asserted element read (arr[i]!) is provably out of bounds in ${fn.lowering.name}`, rule: 'out-of-bounds-read'}
              : {kind: 'simple', file: shortName, line: location.line, column: location.column, level: 'warning', message: `loop in ${fn.lowering.name} has no analyzable exit — it may never terminate`, rule: 'non-exiting-loop'})
          }
        }
        // An obligation that escaped to the function boundary: every same-file call
        // discharging it stays silent, so what remains is a contract outside callers must
        // uphold, unverifiable from this repo's analyzed subset alone.
        if (fn.kind === 'analyzed') {
          const parameterNames = fn.lowering.parameters.map(parameter => parameter.name)
          for (const precondition of fn.preconditions) {
            const description = describePrecondition(precondition, parameterNames)
            let finding = callerContractsBySite.get(precondition.site)
            if (finding == null) {
              const location = siteLocation(lowered, precondition.site)
              finding = {
                kind: 'callerContracts',
                file: shortName,
                line: location.line,
                column: location.column,
                level: 'note',
                rule: 'caller-contract',
                operation: description.operation,
                contracts: [],
                additionalLocations: [],
              }
              callerContractsBySite.set(precondition.site, finding)
            } else if (finding.operation !== description.operation) {
              throw new Error(`One operation site produced both ${finding.operation} and ${description.operation} requirements`)
            }
            finding.contracts.push({functionName: fn.lowering.name, condition: description.condition})
          }
        }
      }
      const groupedCallerContracts: CallerContractFinding[] = []
      const callerContractOperations = [...callerContractsBySite.values()]
        .sort((a, b) => a.line - b.line || a.column - b.column)
      for (const finding of callerContractOperations) {
        const existing = groupedCallerContracts.find(candidate =>
          candidate.operation === finding.operation && sameCallerContracts(candidate.contracts, finding.contracts))
        if (existing == null) {
          groupedCallerContracts.push(finding)
        } else {
          existing.additionalLocations.push({line: finding.line, column: finding.column})
        }
      }
      lintFindings.push(...groupedCallerContracts)
      rows.push({
        file: shortName,
        functions: functionReports.length,
        analyzed,
        partial,
        unsupported,
        verdict: functionReports.length === 0 ? 'noFunctions' : 'analyzed',
      })
      for (const entry of functionReports) {
        if (entry.kind === 'analyzed') {
          for (const precondition of entry.requires) requiresIndex.push(`${shortName} ${entry.name}: ${precondition}`)
        }
      }
      writeFileSync(`${outputDirectory}/${shortName.replaceAll('/', '__')}.txt`, formatReport(report, {legend: false}))
    } catch (error) {
      rows.push({file: shortName, functions: 0, analyzed: 0, partial: 0, unsupported: 0, verdict: 'typeErrors'})
      writeFileSync(`${outputDirectory}/${shortName.replaceAll('/', '__')}.txt`, `ANALYZER ERROR: ${String(error)}\n`)
      bump(reasonCounts, `ANALYZER_CRASH:${String(error).slice(0, 80)}`)
    }
  }

  const totals = {
    files: rows.length,
    typeErrors: rows.filter(row => row.verdict === 'typeErrors').length,
    noFunctions: rows.filter(row => row.verdict === 'noFunctions').length,
    functions: rows.reduce((sum, row) => sum + row.functions, 0),
    analyzed: rows.reduce((sum, row) => sum + row.analyzed, 0),
    partial: rows.reduce((sum, row) => sum + row.partial, 0),
    unsupported: rows.reduce((sum, row) => sum + row.unsupported, 0),
  }
  console.log(JSON.stringify(totals))
  console.log('--- rejection reasons (top 30) ---')
  for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`${String(count).padStart(5)}  ${reason}`)
  }
  console.log('--- stop reasons (top 15) ---')
  for (const [reason, count] of [...stopCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${String(count).padStart(5)}  ${reason}`)
  }
  console.log('--- files with the most fully analyzed functions ---')
  for (const row of [...rows].sort((a, b) => b.analyzed - a.analyzed).slice(0, 15)) {
    console.log(`${String(row.analyzed).padStart(4)} analyzed / ${String(row.functions).padStart(4)} total  ${row.file}`)
  }
  lintFindings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
  const lintCounts = new Map<string, number>()
  for (const finding of lintFindings) bump(lintCounts, `${finding.level}:${finding.rule}`)
  console.log('--- lint ---')
  for (const [rule, count] of [...lintCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(5)}  ${rule}`)
  }
  const lintReport = [
    'freerange lint: actionable failures and caller obligations from analyzed functions.',
    'error   = provably wrong on some reachable path.',
    'warning = an analyzed path may fail to terminate.',
    'note    = a contract outside callers must uphold; unverifiable from this repo alone.',
    'The full value analysis (every function, every range) lives in the per-file reports.',
    '',
  ]
  for (const finding of lintFindings) {
    const location = `${finding.file}:${finding.line}:${finding.column}`
    if (finding.kind === 'simple') {
      lintReport.push(`${location}  ${finding.level}  ${finding.message}  [${finding.rule}]`)
      continue
    }
    const operationCount = finding.additionalLocations.length + 1
    if (operationCount === 1 && finding.contracts.length === 1) {
      const contract = finding.contracts[0]!
      lintReport.push(`${location}  note  callers of ${contract.functionName} must keep ${contract.condition} (${finding.operation} at ${location})  [caller-contract]`)
      continue
    }
    const operationSubject = operationCount === 1
      ? `this ${finding.operation}`
      : `${operationCount} ${finding.operation === 'element read' ? 'element reads' : `${finding.operation}s`}`
    const conditionSubject = `${finding.contracts.length} caller condition${finding.contracts.length === 1 ? '' : 's'}`
    lintReport.push(`${location}  note  ${operationSubject} ${operationCount === 1 ? 'requires' : 'require'} ${conditionSubject}  [caller-contract]`)
    let lastShownLine = finding.line
    let lastShownColumn = finding.column
    for (const additional of finding.additionalLocations) {
      if (lastShownLine === additional.line && lastShownColumn === additional.column) continue
      lastShownLine = additional.line
      lastShownColumn = additional.column
      lintReport.push(`  also at ${finding.file}:${additional.line}:${additional.column}`)
    }
    for (const contract of finding.contracts) lintReport.push(`  ${contract.functionName}: ${contract.condition}`)
  }
  writeFileSync(`${outputDirectory}/LINT.txt`, lintReport.join('\n') + '\n')
  writeFileSync(`${outputDirectory}/__rows.json`, JSON.stringify(rows, null, 1))
  // The legend once per run (per-file reports omit it), and the summary this run's
  // measuring otherwise gets rebuilt by hand: totals, the full reason and stop tallies,
  // and the requires index. Checked in, its diff is the progress metric.
  writeFileSync(`${outputDirectory}/LEGEND.txt`, `${reportLegend}\n`)
  const summary = [
    JSON.stringify(totals),
    '',
    `requires (${requiresIndex.length}):`,
    ...requiresIndex.map(line => `  ${line}`),
    '',
    'rejection reasons:',
    ...[...reasonCounts.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${String(count).padStart(5)}  ${reason}`),
    // Once-seen reasons are a tail, not a trend — atop the tally they read as noise, and
    // their actionable form (location plus rewrite hint) lives in the per-file reports.
    `  seen once: ${[...reasonCounts.entries()].filter(([, count]) => count === 1).map(([reason]) => reason).sort().join(', ')}`,
    '',
    'stop reasons:',
    ...[...stopCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${String(count).padStart(5)}  ${reason}`),
  ]
  writeFileSync(`${outputDirectory}/SUMMARY.txt`, summary.join('\n') + '\n')
  return {hasTypeScriptErrors: hasErrorDiagnostics(allDiagnostics), rootDirectory}
}

export function runFiles(files: string[]): boolean {
  const absoluteFiles = files.map(file => resolve(file))
  const reports: Array<string | null> = Array.from({length: files.length}, () => null)
  const configGroups = new Map<string, Array<{file: string; index: number}>>()
  const fallbackFiles: Array<{file: string; index: number}> = []

  for (let index = 0; index < absoluteFiles.length; index++) {
    const file = absoluteFiles[index]!
    const configPath = findTypeScriptConfig(dirname(file))
    if (configPath == null) {
      fallbackFiles.push({file, index})
      continue
    }
    const group = configGroups.get(configPath)
    if (group == null) configGroups.set(configPath, [{file, index}])
    else group.push({file, index})
  }

  let hasTypeScriptErrors = false
  for (const [configPath, group] of configGroups) {
    const projects = loadTypeScriptProjectGraph(configPath)
    const rootProject = projects.at(-1)!
    const sourcesByFile = new Map(projectSources(projects).map(source => [resolve(source.sourceFile.fileName), source]))
    for (const target of group) {
      const source = sourcesByFile.get(target.file)
      if (source == null) {
        throw new Error(`${target.file} is not part of the TypeScript project ${configPath}.`)
      }
      const diagnostics = ts.getPreEmitDiagnostics(source.project.program, source.sourceFile)
      if (diagnostics.length > 0) {
        printTypeScriptDiagnostics(diagnostics, source.project.parsed.options, process.cwd())
      }
      if (hasErrorDiagnostics(diagnostics)) {
        hasTypeScriptErrors = true
        continue
      }
      reports[target.index] = formatReport(analyzeProjectSource(source, rootProject.rootDirectory))
    }
  }

  for (const target of fallbackFiles) {
    try {
      const checked = checkFile(target.file)
      const lowered = lowerSource(checked, process.cwd())
      reports[target.index] = formatReport(createReport(lowered, analyzeProgram(lowered)))
    } catch (error) {
      if (!(error instanceof TypeScriptDiagnosticsError)) throw error
      printTypeScriptDiagnostics(error.diagnostics, error.options, process.cwd())
      hasTypeScriptErrors = true
    }
  }

  let printed = false
  for (const report of reports) {
    if (report == null) continue
    if (printed) console.log('')
    console.log(report)
    printed = true
  }
  return hasTypeScriptErrors
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

function analyzeProjectSource(source: ProjectSource, baseDirectory: string) {
  const lowered = lowerSource({
    sourceFile: source.sourceFile,
    checker: source.project.program.getTypeChecker(),
  }, baseDirectory)
  return createReport(lowered, analyzeProgram(lowered))
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
