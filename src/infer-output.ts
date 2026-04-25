import type {FitInferReport} from './check.ts'

export function printInferReport(report: FitInferReport) {
  for (const fn of report.functions) {
    console.log(`${fn.file}:${fn.functionName}`)
    printSection('return', fn.facts.map(fact => fact.text))
    printSection('locals', fn.locals.map(fact => fact.text))
    printSection('checked', fn.specs.filter(spec => spec.status === 'checked').map(spec => spec.text))
    printSection('trusted', fn.specs.filter(spec => spec.status === 'trusted').map(spec => spec.text))
    printSection('not-inferred', fn.specs.filter(spec => spec.status === 'not-inferred').map(spec => `${spec.text}${spec.reason == null ? '' : `: ${spec.reason}`}`))
    printSection('redundant', fn.redundant.map(redundantLine))
    for (const loop of fn.loops) {
      console.log(`loop ${loop.line}: ${loop.header}`)
      printSection('inferred', loop.facts.map(fact => fact.text), '  ')
      printSection('checked', loop.specs.filter(spec => spec.status === 'checked').map(spec => spec.text), '  ')
      printSection('trusted', loop.specs.filter(spec => spec.status === 'trusted').map(spec => spec.text), '  ')
      printSection('not-inferred', loop.specs.filter(spec => spec.status === 'not-inferred').map(spec => `${spec.text}${spec.reason == null ? '' : `: ${spec.reason}`}`), '  ')
      printSection('redundant', loop.redundant.map(redundantLine), '  ')
      printSection('unsupported', loop.unsupported, '  ')
    }
    printSection('unsupported', fn.unsupported)
    console.log()
  }
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
