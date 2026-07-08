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
import {lowerSource} from './lower/program.ts'
import {createReport, formatReport, reportLegend} from './report/index.ts'

export function runProject(repoRoot: string, outputDirectory: string): void {
  mkdirSync(outputDirectory, {recursive: true})
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
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  // Every requires line in the run, with its home — the rarest and most actionable content,
  // surfaced in SUMMARY.txt instead of buried under the assumes bulk.
  const requiresIndex: string[] = []

  // Every numeric JSX style value in the run, one verdict line each, for STYLE-SLOTS.txt.
  const styleSlotLines: Array<{file: string; verdict: string; line: string}> = []
  const styleSlotCounts = new Map<string, number>()

  const sourceFiles = program.getSourceFiles().filter(sourceFile =>
    !sourceFile.fileName.includes('node_modules')
    && !sourceFile.isDeclarationFile
    && sourceFile.fileName.startsWith(resolve(repoRoot)))

  for (const sourceFile of sourceFiles) {
    const shortName = sourceFile.fileName.slice(resolve(repoRoot).length + 1)
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
      const lowered = lowerSource({sourceFile, checker}, resolve(repoRoot))
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
      // Reason tags from the IR, not prose, so the tally is stable. Style slots have their
      // own tally below and stay out of the function ones.
      const slotIds = new Set(lowered.styleSlots.map(slot => slot.fn))
      for (let fnId = 0; fnId < lowered.functions.length; fnId++) {
        const fn = lowered.functions[fnId]!
        if (slotIds.has(fnId)) continue
        if (fn.kind === 'unsupported') bump(reasonCounts, fn.reason.kind === 'call' ? `call:${fn.reason.callee}` : fn.reason.kind)
      }
      for (let fnId = 0; fnId < analysis.functions.length; fnId++) {
        const fn = analysis.functions[fnId]!
        if (slotIds.has(fnId)) continue
        if (fn.kind === 'partial') {
          for (const stop of fn.stops) bump(stopCounts, stop.reason.kind)
        }
      }
      for (const slot of report.styleSlots) {
        styleSlotLines.push({file: shortName, verdict: slot.verdict, line: slot.line})
        bump(styleSlotCounts, slot.verdict)
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
  const styleSlotOrder = ['may be NaN', 'may reach Infinity', 'may be zero or negative', 'needs a guard', 'ok', 'skipped']
  if (styleSlotLines.length > 0) {
    console.log('--- style slots ---')
    for (const verdict of styleSlotOrder) {
      const count = styleSlotCounts.get(verdict)
      if (count != null) console.log(`${String(count).padStart(5)}  ${verdict}`)
    }
    const slotReport = [
      'Numeric JSX style values, each analyzed as if extracted into its own function:',
      'variables from the surrounding component are inputs assumed to match their declared',
      'types, and the component body is deliberately not read. So a flag means the',
      'expression does not defend itself — a check earlier in the component may already',
      'prevent the bad case; look before fixing. The fix is the extract-to-.ts rewrite',
      'with the named guard, which also moves the math to where the analysis can verify',
      'the guard for good. Grouped worst-first.',
    ]
    for (const verdict of styleSlotOrder) {
      const group = styleSlotLines.filter(slot => slot.verdict === verdict)
      if (group.length === 0) continue
      slotReport.push('', `${verdict} (${group.length}):`)
      for (const slot of group) slotReport.push(`  ${slot.file} ${slot.line}`)
    }
    writeFileSync(`${outputDirectory}/STYLE-SLOTS.txt`, slotReport.join('\n') + '\n')
  }
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
    ...(styleSlotLines.length > 0
      ? [
          '',
          'style slots (see STYLE-SLOTS.txt):',
          ...styleSlotOrder.filter(verdict => styleSlotCounts.has(verdict))
            .map(verdict => `${String(styleSlotCounts.get(verdict)).padStart(5)}  ${verdict}`),
        ]
      : []),
  ]
  writeFileSync(`${outputDirectory}/SUMMARY.txt`, summary.join('\n') + '\n')

}
