import type {
  FitInferReport,
  FitInferSummary,
} from './check-types.ts'

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

export function printInferSummary(summary: FitInferSummary) {
  console.log(`fr infer --all: ${summary.files.length} files, ${summary.functions} functions`)
  console.log(`facts: ${summary.facts.return} return, ${summary.facts.locals} locals, ${summary.facts.loop} loop`)
  console.log(`specs: ${summary.specs.checked} checked, ${summary.specs.assumptions} assumptions, ${summary.specs.notInferred} not-inferred, ${summary.specs.redundant} redundant`)
  console.log(`unsupported: ${summary.unsupported.stops} stops`)

  printSection('noisiest', summary.unsupported.noisiest.map(item => `${item.file}:${item.functionName}: ${item.count} unsupported`))
  printSection('top unsupported', summary.unsupported.topReasons.map(item => `${item.count}x ${item.reason}`))
  if (summary.functions > 0) console.log('next: run fr infer --function name file.ts to inspect one function')
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
