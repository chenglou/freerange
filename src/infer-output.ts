import type {FitInferReport} from './check-types.ts'

export function printInferReport(report: FitInferReport) {
  for (const fn of report.functions) {
    console.log(`${fn.file}:${fn.functionName}`)
    printSection('return', fn.facts.map(fact => fact.text))
    printSection('locals', fn.locals.map(fact => fact.text))
    printSection('checked', fn.specs.filter(spec => spec.status === 'checked').map(spec => spec.text))
    printSection('assumptions', fn.specs.filter(spec => spec.status === 'assumed').map(spec => spec.text))
    printSection('not-inferred', fn.specs.filter(spec => spec.status === 'not-inferred').map(spec => `${spec.text}${spec.reason == null ? '' : `: ${spec.reason}`}`))
    printSection('redundant', fn.redundant.map(redundantLine))
    for (const loop of fn.loops) {
      console.log(`loop ${loop.line}: ${loop.header}`)
      printSection('inferred', loop.facts.map(fact => fact.text), '  ')
      printSection('checked', loop.specs.filter(spec => spec.status === 'checked').map(spec => spec.text), '  ')
      printSection('assumptions', loop.specs.filter(spec => spec.status === 'assumed').map(spec => spec.text), '  ')
      printSection('not-inferred', loop.specs.filter(spec => spec.status === 'not-inferred').map(spec => `${spec.text}${spec.reason == null ? '' : `: ${spec.reason}`}`), '  ')
      printSection('redundant', loop.redundant.map(redundantLine), '  ')
      printSection('unsupported', loop.unsupported, '  ')
    }
    printSection('unsupported', fn.unsupported)
    console.log()
  }
}

export function printInferSummary(report: FitInferReport) {
  const functionCount = report.functions.length
  const returnFacts = report.functions.reduce((total, fn) => total + fn.facts.length, 0)
  const localFacts = report.functions.reduce((total, fn) => total + fn.locals.length, 0)
  const loopFacts = report.functions.reduce((total, fn) => total + fn.loops.reduce((loopTotal, loop) => loopTotal + loop.facts.length, 0), 0)
  const checked = report.functions.reduce((total, fn) => total + fn.specs.filter(spec => spec.status === 'checked').length, 0)
  const assumptions = report.functions.reduce((total, fn) => total + fn.specs.filter(spec => spec.status === 'assumed').length, 0)
  const notInferred = report.functions.reduce((total, fn) => total + fn.specs.filter(spec => spec.status === 'not-inferred').length, 0)
  const redundant = report.functions.reduce((total, fn) => total + fn.redundant.length, 0)
  const unsupportedCount = report.functions.reduce((total, fn) => total + fn.unsupported.length + fn.loops.reduce((loopTotal, loop) => loopTotal + loop.unsupported.length, 0), 0)

  console.log(`fr infer --all: ${report.files.length} files, ${functionCount} functions`)
  console.log(`facts: ${returnFacts} return, ${localFacts} locals, ${loopFacts} loop`)
  console.log(`specs: ${checked} checked, ${assumptions} assumptions, ${notInferred} not-inferred, ${redundant} redundant`)
  console.log(`unsupported: ${unsupportedCount} stops`)

  const noisy = noisiestFunctions(report)
  printSection('noisiest', noisy.map(item => `${item.file}:${item.functionName}: ${item.count} unsupported`))
  const reasons = topUnsupportedReasons(report)
  printSection('top unsupported', reasons.map(item => `${item.count}x ${item.reason}`))
  if (functionCount > 0) console.log('next: run fr infer --function name file.ts to inspect one function')
}

function printSection(name: string, lines: string[], indent = '') {
  if (lines.length === 0) return
  console.log(`${indent}${name}:`)
  for (const line of lines) printLines(line, `${indent}  `)
}

function printLines(text: string, indent: string) {
  for (const line of text.split('\n')) console.log(`${indent}${line}`)
}

function redundantLine(item: {text: string; reason: string}) {
  return `${item.text} (covered by ${item.reason})`
}

function noisiestFunctions(report: FitInferReport) {
  return report.functions
    .map(fn => ({
      file: fn.file,
      functionName: fn.functionName,
      count: fn.unsupported.length + fn.loops.reduce((total, loop) => total + loop.unsupported.length, 0),
    }))
    .filter(item => item.count > 0)
    .sort((left, right) => right.count - left.count || left.file.localeCompare(right.file) || left.functionName.localeCompare(right.functionName))
    .slice(0, 5)
}

function topUnsupportedReasons(report: FitInferReport) {
  const counts = new Map<string, number>()
  for (const fn of report.functions) {
    for (const reason of fn.unsupported) countReason(counts, reason)
    for (const loop of fn.loops) {
      for (const reason of loop.unsupported) countReason(counts, reason)
    }
  }
  return [...counts]
    .map(([reason, count]) => ({reason, count}))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, 8)
}

function countReason(counts: Map<string, number>, reason: string) {
  const firstLine = reason.split('\n')[0]?.trim()
  if (firstLine == null || firstLine.length === 0) return
  const normalized = firstLine.match(/^unsupported .* line \d+: (.*)$/)?.[1] ?? firstLine
  counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
}
