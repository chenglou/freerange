import {inferFitFiles} from './src/check.ts'
import {printInferReport} from './src/infer-output.ts'

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
  printInferReport(report)
}
