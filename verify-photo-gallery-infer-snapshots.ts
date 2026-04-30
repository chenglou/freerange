import {inferFitFiles} from './src/check-core.ts'
import type {FitInferFunctionReport, FitInferLoopReport} from './src/check-types.ts'
import {displayWorkspaceFile, verifySnapshot} from './snapshot.ts'

const expectedPath = 'photo-gallery-infer.expected.txt'

const report = inferFitFiles(['photo-gallery/index.ts'], {all: true})
const lines = [
  `${displayWorkspaceFile(report.files[0] ?? 'photo-gallery/index.ts')} --all`,
]

for (const fn of report.functions) addFunction(lines, fn)

if (!await verifySnapshot(expectedPath, lines.join('\n'), 'photo-gallery infer snapshots')) process.exitCode = 1

function addFunction(lines: string[], fn: FitInferFunctionReport) {
  lines.push('')
  lines.push(`function ${fn.functionName}`)
  addSection(lines, 'return', fn.facts.map(fact => fact.text))
  addSection(lines, 'locals', fn.locals.map(fact => fact.text))
  addSection(lines, 'checked', fn.specs.filter(spec => spec.status === 'checked').map(spec => spec.text))
  addSection(lines, 'assumptions', fn.specs.filter(spec => spec.status === 'assumed').map(spec => spec.text))
  addSection(lines, 'not-inferred', fn.specs.filter(spec => spec.status === 'not-inferred').map(spec => `${spec.text}${spec.reason == null ? '' : `: ${spec.reason}`}`))
  addSection(lines, 'redundant', fn.redundant.map(item => `${item.text} (covered by ${item.reason})`))
  for (const loop of fn.loops) addLoop(lines, loop)
  addSection(lines, 'unsupported', fn.unsupported)
}

function addLoop(lines: string[], loop: FitInferLoopReport) {
  lines.push(`loop ${loop.line}: ${loop.header}`)
  addSection(lines, 'inferred', loop.facts.map(fact => fact.text), '  ')
  addSection(lines, 'checked', loop.specs.filter(spec => spec.status === 'checked').map(spec => spec.text), '  ')
  addSection(lines, 'assumptions', loop.specs.filter(spec => spec.status === 'assumed').map(spec => spec.text), '  ')
  addSection(lines, 'not-inferred', loop.specs.filter(spec => spec.status === 'not-inferred').map(spec => `${spec.text}${spec.reason == null ? '' : `: ${spec.reason}`}`), '  ')
  addSection(lines, 'redundant', loop.redundant.map(item => `${item.text} (covered by ${item.reason})`), '  ')
  addSection(lines, 'unsupported', loop.unsupported, '  ')
}

function addSection(lines: string[], name: string, items: string[], indent = '') {
  if (items.length === 0) return
  lines.push(`${indent}${name}:`)
  for (const item of items) {
    for (const line of item.split('\n')) lines.push(`${indent}  ${line}`)
  }
}
