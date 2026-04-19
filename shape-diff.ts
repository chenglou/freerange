import {inspectFitShapes} from './src/check.ts'

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
  console.error('Usage: bun shape-diff.ts [--function name] [--all] <file.ts> ...')
  process.exitCode = 1
} else {
  const report = inspectFitShapes(paths, {
    ...(functionName == null ? {} : {functionName}),
    all,
  })
  if (report.insights.length === 0) {
    console.log('shape-diff: no TypeScript-only structural facts')
  }

  for (const insight of report.insights) {
    console.log(`${insight.file}:${insight.functionName}`)
    console.log(`  ${insight.subject}`)
    printSection('freerange', insight.freerange, '    ')
    printSection('typescript-only', insight.typescript, '    ')
  }
}

function printSection(name: string, lines: string[], indent = '') {
  if (lines.length === 0) return
  console.log(`${indent}${name}:`)
  for (const line of lines) console.log(`${indent}  ${line}`)
}
