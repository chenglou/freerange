#!/usr/bin/env bun
// Survey harness for running the analyzer across a whole real-world repo: one TypeScript
// program over every file (the repo's own tsconfig plus the options the analyzer
// requires), then per-file lowering and analysis, aggregated into a rejection-frequency
// table. Full per-file reports go to an output directory; stdout gets only tallies.
// Usage: bun survey.ts <repo-root> <output-dir>

import {mkdirSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import * as ts from 'typescript'
import {analyzeProgram} from './src/engine/analyze.ts'
import {lowerSource} from './src/lower/program.ts'
import {createReport, formatReport, reportLegend} from './src/report/index.ts'

const [repoRoot, outputDirectory] = process.argv.slice(2)
if (repoRoot == null || outputDirectory == null) {
  console.error('Usage: bun survey.ts <repo-root> <output-dir>')
  process.exit(1)
}
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
    // Reason tags from the IR, not prose, so the tally is stable.
    for (const fn of lowered.functions) {
      if (fn.kind === 'unsupported') bump(reasonCounts, fn.reason.kind === 'call' ? `call:${fn.reason.callee}` : fn.reason.kind)
    }
    for (const fn of analysis.functions) {
      if (fn.kind === 'partial') {
        for (const stop of fn.stops) bump(stopCounts, stop.reason.kind)
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
  ...[...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${String(count).padStart(5)}  ${reason}`),
  '',
  'stop reasons:',
  ...[...stopCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${String(count).padStart(5)}  ${reason}`),
]
writeFileSync(`${outputDirectory}/SUMMARY.txt`, summary.join('\n') + '\n')
