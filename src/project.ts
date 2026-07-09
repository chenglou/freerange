// Project mode: one TypeScript program over every file of a repo (the repo's own
// tsconfig plus the options the analyzer requires), then per-file lowering and analysis.
// Full per-file reports go to an output directory mirroring the source tree names;
// LEGEND.txt and SUMMARY.txt (totals, the requires index, rejection and stop tallies)
// are written once per run, and stdout gets the tallies. This is the only mode that
// analyzes repos with path aliases — single-file analysis cannot resolve them.

import {mkdirSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import * as ts from 'typescript'
import {analyzeProgram} from './engine/analyze.ts'
import {siteLocation} from './ir/program.ts'
import {lowerSource} from './lower/program.ts'
import {formatPrecondition} from './report/format-requirement.ts'
import {createReport, formatReport, reportLegend} from './report/index.ts'

export function runProject(repoRoot: string, outputDirectory: string): void {
  mkdirSync(outputDirectory, {recursive: true})
  const absoluteRepoRoot = resolve(repoRoot)
  const configPath = ts.findConfigFile(repoRoot, path => ts.sys.fileExists(path), 'tsconfig.json')
  if (configPath == null) throw new Error(`No tsconfig.json under ${repoRoot}`)
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {
    // The options the analyzer's element-read regime requires, forced over the repo's own.
    noUncheckedIndexedAccess: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (parsed == null) throw new Error('tsconfig parse failed')

  console.error(`program over ${parsed.fileNames.length} files...`)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
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
  // silent, one conventional file:line:column line each — against the per-file reports,
  // which print everything the analysis knows. See the LINT.txt header for the levels.
  type LintEntry = {file: string; line: number; column: number; level: 'error' | 'warning' | 'note'; message: string; rule: string}
  const lintEntries: LintEntry[] = []

  const sourceFiles = program.getSourceFiles().filter(sourceFile =>
    !sourceFile.fileName.includes('node_modules')
    && !sourceFile.isDeclarationFile
    && sourceFile.fileName.startsWith(absoluteRepoRoot))

  for (const sourceFile of sourceFiles) {
    const shortName = sourceFile.fileName.slice(absoluteRepoRoot.length + 1)
    console.error(`  ${shortName}`)
    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ]
    if (diagnostics.length > 0) {
      rows.push({file: shortName, functions: 0, analyzed: 0, partial: 0, unsupported: 0, verdict: 'typeErrors'})
      const first = diagnostics[0]!
      writeFileSync(`${outputDirectory}/${shortName.replaceAll('/', '__')}.txt`,
        `TYPE ERRORS under required options (${diagnostics.length}):\n${ts.flattenDiagnosticMessageText(first.messageText, '\n')}\n`)
      continue
    }
    try {
      const lowered = lowerSource({sourceFile, checker}, absoluteRepoRoot)
      const analysis = analyzeProgram(lowered)
      const report = createReport(lowered, analysis)
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
            lintEntries.push(stop.reason.kind === 'outOfBoundsRead'
              ? {file: shortName, line: location.line, column: location.column, level: 'error', message: `asserted element read (arr[i]!) is provably out of bounds in ${fn.lowering.name}`, rule: 'out-of-bounds-read'}
              : {file: shortName, line: location.line, column: location.column, level: 'warning', message: `loop in ${fn.lowering.name} has no analyzable exit — it may never terminate`, rule: 'non-exiting-loop'})
          }
        }
        // An obligation that escaped to the function boundary: every same-file call
        // discharging it stays silent, so what remains is a contract outside callers must
        // uphold, unverifiable from this repo's analyzed subset alone.
        if (fn.kind === 'analyzed') {
          const parameterNames = fn.lowering.parameters.map(parameter => parameter.name)
          for (const precondition of fn.preconditions) {
            const location = siteLocation(lowered, precondition.site)
            lintEntries.push({
              file: shortName,
              line: location.line,
              column: location.column,
              level: 'note',
              message: `callers of ${fn.lowering.name} must keep ${formatPrecondition(precondition, parameterNames, lowered)}`,
              rule: 'caller-contract',
            })
          }
        }
      }
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
  lintEntries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
  const lintCounts = new Map<string, number>()
  for (const entry of lintEntries) bump(lintCounts, `${entry.level}:${entry.rule}`)
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
    ...lintEntries.map(entry => `${entry.file}:${entry.line}:${entry.column}  ${entry.level}  ${entry.message}  [${entry.rule}]`),
  ]
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
}
