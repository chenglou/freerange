import {inferFitFiles} from './src/check.ts'

const args = Bun.argv.slice(2)
let functionName: string | undefined
let all = false
const paths: string[] = []

for (let index = 0; index < args.length; index++) {
  const arg = args[index]!
  if (arg === '--function') {
    functionName = args[++index]
    continue
  }
  if (arg.startsWith('--function=')) {
    functionName = arg.slice('--function='.length)
    continue
  }
  if (arg === '--all') {
    all = true
    continue
  }
  paths.push(arg)
}

if (paths.length === 0) {
  console.error('Usage: bun infer.ts [--function name] [--all] <file.ts> ...')
  process.exitCode = 1
} else {
  const report = inferFitFiles(paths, {
    ...(functionName == null ? {} : {functionName}),
    all,
  })
  for (const fn of report.functions) {
    console.log(`${fn.file}:${fn.functionName}`)
    printSection('result', fn.facts.map(fact => fact.text))
    printSection('locals', fn.locals.map(fact => fact.text))
    printSection('source-proved', fn.specs.filter(spec => spec.status === 'source-proved').map(spec => spec.text))
    printSection('trusted', fn.specs.filter(spec => spec.status === 'trusted').map(spec => spec.text))
    printSection('not-inferred', fn.specs.filter(spec => spec.status === 'not-inferred').map(spec => `${spec.text}${spec.reason == null ? '' : `: ${spec.reason}`}`))
    printSection('redundant', fn.redundant.map(redundantLine))
    for (const loop of fn.loops) {
      console.log(`loop ${loop.line}: ${loop.header}`)
      printSection('inferred', loop.facts.map(fact => fact.text), '  ')
      printSection('source-proved', loop.specs.filter(spec => spec.status === 'source-proved').map(spec => spec.text), '  ')
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
  for (const line of lines) console.log(`${indent}  ${line}`)
}

function redundantLine(item: {text: string; reason: string}) {
  return `${item.text} (covered by ${item.reason})`
}
