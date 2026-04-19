import {inferFitFiles, type FitCheck, verifyFitFiles} from './src/check.ts'

const positiveFiles = ['patterns.ts', 'import-patterns.ts']
const negativeFiles = ['negative-patterns.ts', 'negative-import-patterns.ts']
const negativeExpectedPath = 'negative-patterns.expected.txt'

const positiveReport = await verifyFitFiles(positiveFiles)
if (positiveReport.phase !== 'ready') {
  console.error(JSON.stringify(positiveReport, null, 2))
  process.exitCode = 1
} else {
  console.log(`positive: ${positiveReport.summary.pass} pass, 0 fail, 0 unknown`)
}

const negativeReport = await verifyFitFiles(negativeFiles)
const actualNegative = normalizeNegative(negativeReport.checks)
const expectedNegative = normalizeText(await Bun.file(negativeExpectedPath).text())

if (actualNegative !== expectedNegative) {
  console.error('expected negative messages changed')
  console.error('\nExpected:\n' + expectedNegative)
  console.error('Actual:\n' + actualNegative)
  process.exitCode = 1
} else {
  console.log(`negative: ${negativeReport.checks.filter(check => check.status !== 'pass').length} expected messages`)
}

const inferReport = inferFitFiles(['patterns.ts'], {functionName: 'typedObjectParamArrayShape'})
const inferFacts = new Set(inferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedInferFacts = [
  'result.rows.length == params.items.length',
  'result.rows.length: int 0..Infinity',
  'result.rows[].height == params.items[].height',
]
const missingInferFacts = expectedInferFacts.filter(fact => !inferFacts.has(fact))
if (missingInferFacts.length > 0) {
  console.error('expected inferred facts changed')
  console.error(missingInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer: ${expectedInferFacts.length} expected facts`)
}

const loopInferReport = inferFitFiles(['patterns.ts'], {functionName: 'localLoopAnnotation'})
const loopReport = loopInferReport.functions[0]?.loops[0]
const loopFacts = new Set(loopReport?.facts.map(fact => fact.text) ?? [])
const loopSpecStatuses = new Map(loopReport?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedLoopFacts = [
  'rows.length == items.length',
  'rows[].height: 0..40',
  'nondecreasing(rows.top)',
  'spaced(rows, gap)',
]
const missingLoopFacts = expectedLoopFacts.filter(fact => !loopFacts.has(fact))
const expectedLoopSpecStatuses = [
  ['given items[].height: 0..40', 'trusted'],
  ['rows.length == items.length', 'source-proved'],
  ['spaced(rows, gap)', 'source-proved'],
] as const
const badLoopSpecStatuses = expectedLoopSpecStatuses.filter(([text, status]) => loopSpecStatuses.get(text) !== status)
if (missingLoopFacts.length > 0 || badLoopSpecStatuses.length > 0) {
  console.error('expected loop inferred facts changed')
  console.error(missingLoopFacts.map(fact => `missing: ${fact}`).join('\n'))
  console.error(badLoopSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer loops: ${expectedLoopFacts.length} expected facts`)
}

function normalizeNegative(checks: FitCheck[]) {
  const lines = checks
    .filter(check => check.status !== 'pass')
    .map(check => {
      const head = `${check.status.toUpperCase()} ${check.file}:${check.functionName}: ${check.text}`
      if (check.reason == null) return head
      const reason = check.reason.split('\n').map(line => `  ${line}`).join('\n')
      return `${head}\n${reason}`
    })
  return normalizeText(lines.join('\n'))
}

function normalizeText(text: string) {
  return text.trimEnd() + '\n'
}
