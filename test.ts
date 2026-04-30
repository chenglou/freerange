import {inferFitFiles} from './src/check.ts'
import {divideNumbers, multiplyNumbers, numberValue, runningSumNumber, subtractNumbers} from './src/domain.ts'
import {type FitCheck, verifyFitFiles} from './src/reports.ts'

const positiveFiles = ['patterns.ts', 'import-patterns.ts', 'interpreter-matrix-patterns.ts']
const negativeFiles = ['negative-patterns.ts', 'negative-import-patterns.ts', 'interpreter-matrix-negative.ts']
const negativeExpectedPath = 'negative-patterns.expected.txt'
const inferSnapshotExpectedPath = 'infer-snapshots.expected.txt'
const repoDir = new URL('.', import.meta.url).pathname
const workspaceDir = repoDir.replace(/\/[^/]+\/$/, '/')

const positiveReport = await verifyFitFiles(positiveFiles)
if (positiveReport.phase !== 'ready') {
  console.error(JSON.stringify(positiveReport, null, 2))
  process.exitCode = 1
} else {
  console.log(`positive: ${positiveReport.summary.pass} pass, 0 fail, 0 unknown`)
}

const photoGalleryReport = await verifyFitFiles(['photo-gallery/index.ts'])
if (photoGalleryReport.phase !== 'ready' || photoGalleryReport.summary.pass !== 26 || photoGalleryReport.summary.fail !== 0 || photoGalleryReport.summary.unknown !== 0) {
  console.error('expected photo-gallery literal data to stay summarized')
  console.error(photoGalleryReport.phase === 'ready'
    ? `got ${photoGalleryReport.summary.pass} pass, ${photoGalleryReport.summary.fail} fail, ${photoGalleryReport.summary.unknown} unknown`
    : JSON.stringify(photoGalleryReport, null, 2))
  process.exitCode = 1
} else {
  console.log('photo-gallery: summarized array data')
}

const unboundedNonnegativeProduct = multiplyNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, false, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, false, 'right'),
)
if (unboundedNonnegativeProduct.min !== 0 || unboundedNonnegativeProduct.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity product, got ${unboundedNonnegativeProduct.min}..${unboundedNonnegativeProduct.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded nonnegative product')
}

const unboundedNonnegativeQuotient = divideNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, false, 'left'),
  numberValue(1, Number.POSITIVE_INFINITY, false, 'right'),
)
if (unboundedNonnegativeQuotient.kind !== 'number' || unboundedNonnegativeQuotient.min !== 0 || unboundedNonnegativeQuotient.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity quotient, got ${unboundedNonnegativeQuotient.kind === 'number' ? `${unboundedNonnegativeQuotient.min}..${unboundedNonnegativeQuotient.max}` : unboundedNonnegativeQuotient.kind}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded nonnegative quotient')
}

const unboundedNonnegativeRunningSum = runningSumNumber(
  numberValue(0, Number.POSITIVE_INFINITY, false, 'start'),
  numberValue(0, Number.POSITIVE_INFINITY, true, 'count'),
  numberValue(0, Number.POSITIVE_INFINITY, false, 'increment'),
)
if (unboundedNonnegativeRunningSum.min !== 0 || unboundedNonnegativeRunningSum.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected 0..Infinity running sum, got ${unboundedNonnegativeRunningSum.min}..${unboundedNonnegativeRunningSum.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded nonnegative running sum')
}

const unboundedDifference = subtractNumbers(
  numberValue(0, Number.POSITIVE_INFINITY, false, 'left'),
  numberValue(0, Number.POSITIVE_INFINITY, false, 'right'),
)
if (unboundedDifference.min !== Number.NEGATIVE_INFINITY || unboundedDifference.max !== Number.POSITIVE_INFINITY) {
  console.error(`expected -Infinity..Infinity difference, got ${unboundedDifference.min}..${unboundedDifference.max}`)
  process.exitCode = 1
} else {
  console.log('domain: unbounded difference')
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
  'return.rows.length == params.items.length',
  'return.rows.length: int 0..Infinity',
  'return.rows[].height == params.items[].height',
  'return.rows follows params.items by index',
]
const missingInferFacts = expectedInferFacts.filter(fact => !inferFacts.has(fact))
if (missingInferFacts.length > 0) {
  console.error('expected inferred facts changed')
  console.error(missingInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer: ${expectedInferFacts.length} expected facts`)
}

const filterInferReport = inferFitFiles(['patterns.ts'], {functionName: 'filteredRowsKeepElementDomain'})
const filterInferFacts = new Set(filterInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedFilterInferFacts = [
  'return.rows is an order-preserving subset of items',
]
const missingFilterInferFacts = expectedFilterInferFacts.filter(fact => !filterInferFacts.has(fact))
if (missingFilterInferFacts.length > 0) {
  console.error('expected filter inferred facts changed')
  console.error(missingFilterInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer filter: ${expectedFilterInferFacts.length} expected facts`)
}

const filterMapInferReport = inferFitFiles(['patterns.ts'], {functionName: 'filteredMappedRowsKeepBaseLineage'})
const filterMapInferFacts = new Set(filterMapInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedFilterMapInferFacts = [
  'return.rows is an order-preserving subset of items',
]
const missingFilterMapInferFacts = expectedFilterMapInferFacts.filter(fact => !filterMapInferFacts.has(fact))
if (missingFilterMapInferFacts.length > 0) {
  console.error('expected filter-map inferred facts changed')
  console.error(missingFilterMapInferFacts.map(fact => `missing: ${fact}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer filter-map: ${expectedFilterMapInferFacts.length} expected facts`)
}

const loopInferReport = inferFitFiles(['patterns.ts'], {functionName: 'localLoopAnnotation'})
const loopFunctionSpecStatuses = new Map(loopInferReport.functions[0]?.specs.map(spec => [spec.text, spec.status]) ?? [])
const loopReport = loopInferReport.functions[0]?.loops[0]
const loopFacts = new Set(loopReport?.facts.map(fact => fact.text) ?? [])
const loopSpecStatuses = new Map(loopReport?.specs.map(spec => [spec.text, spec.status]) ?? [])
const loopRedundantSpecs = new Map(loopReport?.redundant.map(spec => [spec.text, spec.reason]) ?? [])
const expectedLoopFacts = [
  'rows.length == items.length',
  'rows[].height: 0..40',
  'nondecreasing(rows.top)',
  'spaced(rows, gap)',
]
const missingLoopFacts = expectedLoopFacts.filter(fact => !loopFacts.has(fact))
const expectedLoopSpecStatuses = [
  ['given items[].height: 0..40', 'assumed'],
  ['rows.length == items.length', 'checked'],
  ['spaced(rows, gap)', 'checked'],
  ['lastEnd(rows) == y - gap', 'checked'],
] as const
const expectedLoopFunctionSpecStatuses = [
  ['given items.length: int 1..50', 'assumed'],
  ['return.bottom >= top', 'checked'],
  ['return.rows.length == items.length', 'checked'],
] as const
const badLoopSpecStatuses = expectedLoopSpecStatuses.filter(([text, status]) => loopSpecStatuses.get(text) !== status)
const expectedLoopRedundantSpecs = [
  ['rows.length == items.length', 'rows.length == items.length'],
  ['rows[].height: 0..40', 'rows[].height: 0..40'],
] as const
const missingLoopRedundantSpecs = expectedLoopRedundantSpecs.filter(([text, reason]) => loopRedundantSpecs.get(text) !== reason)
const unexpectedlyRedundantLoopSpecs = ['lastEnd(rows) == y - gap'].filter(text => loopRedundantSpecs.has(text))
const badLoopFunctionSpecStatuses = expectedLoopFunctionSpecStatuses.filter(([text, status]) => loopFunctionSpecStatuses.get(text) !== status)
if (missingLoopFacts.length > 0 || badLoopSpecStatuses.length > 0 || missingLoopRedundantSpecs.length > 0 || unexpectedlyRedundantLoopSpecs.length > 0 || badLoopFunctionSpecStatuses.length > 0) {
  console.error('expected loop inferred facts changed')
  console.error(missingLoopFacts.map(fact => `missing: ${fact}`).join('\n'))
  console.error(badLoopSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  console.error(missingLoopRedundantSpecs.map(([text, reason]) => `expected redundant ${text}: ${reason}`).join('\n'))
  console.error(unexpectedlyRedundantLoopSpecs.map(text => `unexpected redundant: ${text}`).join('\n'))
  console.error(badLoopFunctionSpecStatuses.map(([text, status]) => `expected function ${text}: ${status}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer loops: ${expectedLoopFacts.length} expected facts`)
}

const segmentedLoopInferReport = inferFitFiles(['patterns.ts'], {functionName: 'segmentedStackRowsWithGuardLocalResetAlias'})
const segmentedFunction = segmentedLoopInferReport.functions[0]
const segmentedFacts = new Set(segmentedFunction?.facts.map(fact => fact.text) ?? [])
const segmentedSpecs = new Map(segmentedFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedSegmentedFacts = [
  'return.rows.length: int 0..50',
  'return.rows[].bottom == (rows[].top + rows[].height)',
  'nondecreasing(return.rows.top)',
  'spaced(return.rows, gap)',
]
const missingSegmentedFacts = expectedSegmentedFacts.filter(fact => !segmentedFacts.has(fact))
const expectedSegmentedSpecStatuses = [
  ['return.rows.length <= items.length', 'checked'],
  ['return.rows[].bottom == return.rows[].top + return.rows[].height', 'checked'],
  ['spaced(return.rows, gap)', 'checked'],
] as const
const badSegmentedSpecStatuses = expectedSegmentedSpecStatuses.filter(([text, status]) => segmentedSpecs.get(text) !== status)
if (missingSegmentedFacts.length > 0 || badSegmentedSpecStatuses.length > 0) {
  console.error('expected segmented loop inferred facts changed')
  console.error(missingSegmentedFacts.map(fact => `missing: ${fact}`).join('\n'))
  console.error(badSegmentedSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer segmented loop: ${expectedSegmentedFacts.length} expected facts`)
}

const redundantInferReport = inferFitFiles(['patterns.ts'], {functionName: 'scalarPushLoop'})
const redundantFunction = redundantInferReport.functions[0]
const redundantFacts = new Map(redundantFunction?.redundant.map(fact => [fact.text, fact.reason]) ?? [])
const expectedRedundantFacts = [
  ['return.length == items.length', 'return.length == items.length'],
  ['return[]: 0..3000', 'return[]: 0..3000'],
] as const
const missingRedundantFacts = expectedRedundantFacts.filter(([fact, reason]) => redundantFacts.get(fact) !== reason)
const redundantSpecStatuses = new Map(redundantFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedRedundantSpecStatuses = [
  ['given items.length: int 0..50', 'assumed'],
  ['return.length == items.length', 'checked'],
  ['return[]: 0..3000', 'checked'],
] as const
const badRedundantSpecStatuses = expectedRedundantSpecStatuses.filter(([text, status]) => redundantSpecStatuses.get(text) !== status)
if (missingRedundantFacts.length > 0 || badRedundantSpecStatuses.length > 0) {
  console.error('expected function-level redundant facts changed')
  console.error(missingRedundantFacts.map(([fact, reason]) => `missing redundant: ${fact} covered by ${reason}`).join('\n'))
  console.error(badRedundantSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer redundant: ${expectedRedundantFacts.length} expected facts`)
}

const tupleInferReport = inferFitFiles(['patterns.ts'], {functionName: 'scalarStringishMutationPreservesTupleFacts'})
const tupleFacts = new Set(tupleInferReport.functions[0]?.facts.map(fact => fact.text) ?? [])
if (!tupleFacts.has('return.length == 2')) {
  console.error('expected fixed tuple length inference to stay readable')
  process.exitCode = 1
} else {
  console.log('infer tuple length: readable')
}

const equalityRedundantReport = inferFitFiles([
  '../vibescript/demos/photo-gallery/layout.ts',
  '../vibescript/demos/photo-gallery/prompt-layout.ts',
], {functionName: 'getGridLayout'})
const equalityRedundantLoop = equalityRedundantReport.functions[0]?.loops[0]
const equalityRedundantFacts = new Map(equalityRedundantLoop?.redundant.map(fact => [fact.text, fact.reason]) ?? [])
const expectedEqualityRedundantFacts = [
  ['rows[].bottom == rows[].top + rows[].height', 'rows[].bottom == (rows[].top + rows[].height)'],
] as const
const missingEqualityRedundantFacts = expectedEqualityRedundantFacts.filter(([fact, reason]) => equalityRedundantFacts.get(fact) !== reason)
if (missingEqualityRedundantFacts.length > 0) {
  console.error('expected equality redundant facts changed')
  console.error(missingEqualityRedundantFacts.map(([fact, reason]) => `missing redundant: ${fact} covered by ${reason}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer equality redundant: ${expectedEqualityRedundantFacts.length} expected facts`)
}

const callSiteTextReport = inferFitFiles(['patterns.ts'], {functionName: 'userlandClampThroughArithmeticAlias'})
const callSiteTextFacts = new Set(callSiteTextReport.functions[0]?.facts.map(fact => fact.text) ?? [])
const expectedCallSiteTextFacts = [
  'return == max(0, min(value, (position.cols - w)))',
]
const missingCallSiteTextFacts = expectedCallSiteTextFacts.filter(fact => !callSiteTextFacts.has(fact))
if (missingCallSiteTextFacts.length > 0) {
  console.error('expected call-site inferred text changed')
  console.error(missingCallSiteTextFacts.map(fact => `missing: ${fact}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer call-site text: ${expectedCallSiteTextFacts.length} expected facts`)
}

const actualInferSnapshot = normalizeText([
  formatInferSnapshot(['patterns.ts'], 'typedObjectParamArrayShape'),
  formatInferSnapshot(['patterns.ts'], 'propertyAccessCallShape'),
  formatInferSnapshot(['patterns.ts'], 'mapCallbackReturnShape'),
  formatInferSnapshot(['patterns.ts'], 'scalarPushLoop'),
  formatInferSnapshot(['import-patterns.ts'], 'namespaceImportedStructuralShape'),
  formatInferSnapshot(['patterns.ts'], 'mapBlockRowsWithDestructure'),
  formatInferSnapshot(['patterns.ts'], 'localLoopAnnotation'),
  formatInferSnapshot([
    '../vibescript/demos/photo-gallery/layout.ts',
    '../vibescript/demos/photo-gallery/prompt-layout.ts',
  ], 'getGridLayout'),
  formatInferSnapshot([
    '../vibescript/demos/photo-gallery/layout.ts',
    '../vibescript/demos/photo-gallery/prompt-layout.ts',
  ], 'getLineLayout'),
].join('\n'))
const expectedInferSnapshot = normalizeText(await Bun.file(inferSnapshotExpectedPath).text())
if (actualInferSnapshot !== expectedInferSnapshot) {
  console.error('expected infer snapshot changed')
  console.error('\nExpected:\n' + expectedInferSnapshot)
  console.error('Actual:\n' + actualInferSnapshot)
  process.exitCode = 1
} else {
  console.log('infer snapshot: matched')
}

await runCliRegressionTests()

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

function formatInferSnapshot(paths: string[], functionName: string) {
  const report = inferFitFiles(paths, {functionName})
  const fn = report.functions[0]
  if (fn == null) return `${functionName}\n  missing function`
  const lines = [`${displayFile(fn.file)}:${fn.functionName}`]
  addSection(lines, 'return', snapshotItems(functionName, 'return', fn.facts.map(fact => fact.text)))
  addSection(lines, 'locals', snapshotItems(functionName, 'locals', fn.locals.map(fact => fact.text)))
  for (const loop of fn.loops) {
    lines.push(`loop ${loop.line}: ${loop.header}`)
    addSection(lines, 'inferred', snapshotItems(functionName, 'loop', loop.facts.map(fact => fact.text)), '  ')
    addSection(lines, 'checked', loop.specs.filter(spec => spec.status === 'checked').map(spec => spec.text), '  ')
    addSection(lines, 'assumptions', loop.specs.filter(spec => spec.status === 'assumed').map(spec => spec.text), '  ')
    addSection(lines, 'not-inferred', loop.specs.filter(spec => spec.status === 'not-inferred').map(spec => spec.text), '  ')
  }
  addSection(lines, 'unsupported', fn.unsupported.filter(line => line.startsWith('Forgot unsupported')))
  return lines.join('\n')
}

function snapshotItems(functionName: string, section: string, items: string[]) {
  if (functionName === 'getGridLayout') return items.filter(item => keepGridLayoutSnapshotItem(section, item))
  if (functionName === 'getLineLayout') return items.filter(item => keepLineLayoutSnapshotItem(section, item))
  return items
}

function keepGridLayoutSnapshotItem(section: string, item: string) {
  if (item.includes('.fragments')) return false
  if (item === 'return.items.length == layoutSources.length') return true
  if (item === 'return.contentHeight == nextRowTop') return true
  if (item === 'return.contentHeight: 40..Infinity') return true
  if (item === 'return.rows.length == rows.length') return true
  if (item === 'return.rows[].bottom == (rows[].top + rows[].height)') return true
  if (item === 'return.rows[].bottom: 40..Infinity') return true
  if (item === 'return.rows[].height == rows[].height') return true
  if (item === 'return.rows[].height: 0..Infinity') return true
  if (item === 'return.rows[].top == rows[].top') return true
  if (item === 'return.rows[].top: 40..Infinity') return true
  if (item === 'nondecreasing(return.rows.top)') return true
  if (item === 'spaced(return.rows, boxesGapY)') return true
  if (section === 'return') {
    return item === 'return.items[].imageBox.sizeX: 0..1952'
      || item === 'return.items[].layoutBox.sizeX: 0..1952'
      || item.includes('return.items[].prompt.box.sizeX ==')
      || item.includes('return.items[].prompt.box.sizeY ==')
      || item.includes('return.items[].prompt.lines.length ==')
      || item === 'return.items[].prompt.lines.length: int 0..Infinity'
  }
  return item === 'cols: int 1..7'
    || item === 'boxMaxSizeX: 18.285714285714285..1952'
    || item === 'rows[].bottom == (rows[].top + rows[].height)'
    || item === 'rows[].bottom: 40..Infinity'
    || item === 'rows[].height: 0..Infinity'
    || item === 'rows[].top: 40..Infinity'
    || item === 'nondecreasing(rows.top)'
    || item === 'spaced(rows, boxesGapY)'
    || item === 'measurements.length == layoutSources.length'
    || item === 'measurements[].imageSizeX: 0..1952'
    || item.includes('measurements[].promptLayout.lineCount ==')
    || item.includes('measurements[].promptLayout.lines.length ==')
    || item === 'measurements[].promptLayout.lines.length: int 0..Infinity'
    || item.includes('measurements[].promptLayout.visibleHeight ==')
    || item.includes('measurements[].promptLayout.width ==')
}

function keepLineLayoutSnapshotItem(section: string, item: string) {
  if (item.includes('.fragments')) return false
  if (section === 'return') {
    return item === 'return.items.length == layoutSources.length'
      || item === 'return.items.length: int 0..Infinity'
      || item === 'return.items[].imageBox.sizeX == get1DItemSizeResult.imageSizeX'
      || item === 'return.items[].imageBox.sizeY == get1DItemSizeResult.imageSizeY'
      || item.includes('return.items[].prompt.box.sizeX ==')
      || item.includes('return.items[].prompt.box.sizeY ==')
      || item.includes('return.items[].prompt.lines.length ==')
      || item === 'return.items[].prompt.lines.length: int 0..Infinity'
      || item.includes('return.items[].prompt.lines[].width ==')
  }
  return item === 'box1DMaxSizeX == ((windowSizeX - (boxes1DGapX * 2)) - (hitArea1DSizeX * 2))'
    || item === 'box1DMaxSizeY == ((windowSizeY - windowPaddingTop) - boxes1DGapY)'
    || item === 'measurements.length == layoutSources.length'
    || item === 'measurements.length: int 0..Infinity'
    || item === 'items.length == layoutSources.length'
    || item === 'items.length: int 0..Infinity'
    || item === 'measurements[].imageSizeX == get1DItemSizeResult.imageSizeX'
    || item === 'measurements[].imageSizeY == get1DItemSizeResult.imageSizeY'
    || item === 'measurements[].layoutHeight == get1DItemSizeResult.layoutHeight'
    || item === 'measurements[].promptLayout.lineCount == get1DItemSizeResult.promptLayout.lineCount'
    || item === 'measurements[].promptLayout.lines.length == get1DItemSizeResult.promptLayout.lines.length'
    || item === 'measurements[].promptLayout.lines.length: int 0..Infinity'
    || item === 'measurements[].promptLayout.visibleHeight == get1DItemSizeResult.promptLayout.visibleHeight'
    || item === 'measurements[].promptLayout.width == get1DItemSizeResult.promptLayout.width'
}

function addSection(lines: string[], name: string, items: string[], indent = '') {
  if (items.length === 0) return
  lines.push(`${indent}${name}:`)
  for (const item of items) lines.push(`${indent}  ${item}`)
}

function displayFile(file: string) {
  if (file.startsWith(repoDir)) return file.slice(repoDir.length)
  if (file.startsWith(workspaceDir)) return `../${file.slice(workspaceDir.length)}`
  return file
}

async function runCliRegressionTests() {
  const explicitCheck = runFr(['check', 'patterns.ts', 'import-patterns.ts'])
  expectCli(explicitCheck.exitCode === 0, 'expected fr check <files> to pass', explicitCheck.output)
  expectCli(explicitCheck.output.includes('fr check: 2 files,'), 'expected explicit fr check summary to include file count', explicitCheck.output)
  expectCli(explicitCheck.output.includes('0 fail, 0 unknown'), 'expected explicit fr check summary to include clean counts', explicitCheck.output)

  await withCliFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }, null, 2),
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['check'], dir)
    expectCli(check.exitCode === 0, 'expected no-arg fr check to pass from tsconfig project', check.output)
    expectCli(check.output.includes('fr check: 1 files, 1 pass, 0 fail, 0 unknown'), 'expected no-arg fr check summary from tsconfig project', check.output)
  })

  await withCliFixture({
    'bad.ts': `/** @fit
 * return: 0..1
 */
function bad() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['check', 'bad.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr check to exit 1 on a failed claim', check.output)
    expectCli(check.output.includes('bad.ts:2'), 'expected fr check failure output to include the spec line', check.output)
    expectCli(check.output.includes('scope: bad'), 'expected fr check failure output to include the function scope', check.output)
    expectCli(check.output.includes('FAIL return: 0..1'), 'expected fr check failure output', check.output)
    expectCli(check.output.includes('next: run fr infer --function bad bad.ts'), 'expected fr check to point at infer next', check.output)
    expectCli(check.output.includes('fr check: 1 files, 0 pass, 1 fail, 0 unknown'), 'expected fr check failure summary', check.output)
  })

  await withCliFixture({
    'doctor.ts': `function h(
  value: number, // @fit 0..10
) {
  return value
}

function f() {
  return h(20)
}
`,
  }, dir => {
    const check = runFr(['doctor', 'doctor.ts'], dir)
    expectCli(check.exitCode === 1, 'expected fr doctor to exit 1 on a definite bad literal call', check.output)
    expectCli(check.output.includes('doctor.ts:8:f'), 'expected fr doctor failure output to include the call line', check.output)
    expectCli(check.output.includes('FAIL call h(20): requires value: 0..10'), 'expected fr doctor literal-call failure output', check.output)
    expectCli(check.output.includes('missing at call site: 20 <= 10'), 'expected fr doctor to print the caller-side missing obligation', check.output)
    expectCli(check.output.includes('fr doctor: 1 files,'), 'expected fr doctor summary', check.output)
    expectCli(check.output.includes('1 fail'), 'expected fr doctor summary to include one fail', check.output)

    const combined = runFr(['check', '--calls', 'doctor.ts'], dir)
    expectCli(combined.exitCode === 1, 'expected fr check --calls to fail on definite bad calls', combined.output)
    expectCli(combined.output.includes('FAIL call h(20): requires value: 0..10'), 'expected fr check --calls literal-call failure output', combined.output)
    expectCli(combined.output.includes('missing at call site: 20 <= 10'), 'expected fr check --calls to print the caller-side missing obligation', combined.output)
    expectCli(combined.output.includes('fr check --calls: 1 files,'), 'expected fr check --calls failure summary', combined.output)
  })

  await withCliFixture({
    'doctor.ts': `function h(
  value: number, // @fit 0..10
) {
  return value
}

function f(value: number) {
  return h(value)
}
`,
  }, dir => {
    const check = runFr(['doctor', 'doctor.ts'], dir)
    expectCli(check.exitCode === 0, 'expected fr doctor to exit 0 on inferred caller requirements', check.output)
    expectCli(check.output.includes('REQUIRES call h(value): requires value: 0..10'), 'expected fr doctor caller-requirement output', check.output)
    expectCli(check.output.includes('next: add a caller given, validate before this call, or run fr infer --function f doctor.ts to see caller facts'), 'expected fr doctor to point at caller infer next', check.output)
    expectCli(check.output.includes('fr doctor: 1 files,'), 'expected fr doctor requirement summary', check.output)
    expectCli(check.output.includes('0 fail, 1 requires, 0 unknown'), 'expected fr doctor summary to classify requires separately from fail', check.output)

    const combined = runFr(['check', '--calls', 'doctor.ts'], dir)
    expectCli(combined.exitCode === 0, 'expected fr check --calls to keep caller requirements non-fatal', combined.output)
    expectCli(combined.output.includes('fr check: 1 files,'), 'expected fr check --calls to print the claim summary', combined.output)
    expectCli(combined.output.includes('REQUIRES call h(value): requires value: 0..10'), 'expected fr check --calls to print callsite requirements', combined.output)
    expectCli(combined.output.includes('fr check --calls: 1 files,'), 'expected fr check --calls to print the call summary', combined.output)
  })

  await withCliFixture({
    'layout.ts': `/** @fit
 * return: 2
 */
function ok() {
  return 2
}
`,
  }, dir => {
    const check = runFr(['infer', 'layout.ts', '--function', 'ok'], dir)
    expectCli(check.exitCode === 0, 'expected fr infer to run from the main CLI', check.output)
    expectCli(check.output.includes('layout.ts:ok'), 'expected fr infer to print the function header', check.output)
    expectCli(check.output.includes('checked:'), 'expected fr infer to print checked claims', check.output)
    expectCli(check.output.includes('return: 2'), 'expected fr infer to print the checked return fact', check.output)
  })

  await withCliFixture({
    'scout.ts': `function cap(value: number, max: number) {
  return Math.min(value, max)
}

function f(value: number) {
  return cap(value, 10)
}
`,
  }, dir => {
    const check = runFr(['scout', 'scout.ts', '--function', 'cap'], dir)
    expectCli(check.exitCode === 0, 'expected fr scout to stay read-only', check.output)
    expectCli(check.output.includes('candidate return >= value'), 'expected fr scout candidate output', check.output)
    expectCli(check.output.includes('would require:'), 'expected fr scout requirement output', check.output)
    expectCli(check.output.includes('UNKNOWN call cap(value, 10): requires max >= value'), 'expected fr scout call obligation output', check.output)
    expectCli(check.output.includes('fr scout: 1 files, 2 candidates'), 'expected fr scout summary', check.output)
  })

  await withCliFixture({
    'helper.ts': `export function clamp(
  value: number,
  min: number, // @fit <= max
  max: number,
): number {
  // @fit >= min
  return Math.min(Math.max(value, min), max) // @fit <= max
}

const opacity = clamp(1.2, 0, 1) // @fit 0..1
`,
  }, dir => {
    const check = runFr(['check', 'helper.ts'], dir)
    expectCli(check.exitCode === 0, 'expected standalone helper call check to pass', check.output)
    expectCli(check.output.includes('fr check: 1 files, 6 pass, 0 fail, 0 unknown'), 'expected standalone helper call check summary', check.output)
  })

  await withCliFixture({
    'helper.ts.tmp': `/** @fit
 * given min <= max
 * return >= min
 * return <= max
 */
export function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Freerange catches this: the result can be 2.
const opacity = clamp(0, 10, 2) // @fit 0..1
`,
  }, dir => {
    const check = runFr(['check', 'helper.ts.tmp'], dir)
    expectCli(check.exitCode === 1, 'expected de-inlined clamp example to fail without crashing', check.output)
    expectCli(check.output.includes('FAIL opacity: 0..1'), 'expected de-inlined clamp example failure output', check.output)
    expectCli(check.output.includes('fr check: 1 files, 3 pass, 1 fail, 0 unknown'), 'expected de-inlined clamp example summary', check.output)
  })

  console.log('cli: 13 expected behaviors')
}

function runFr(args: string[], cwd = repoDir) {
  return runProcess([process.execPath, pathJoin(repoDir, 'fr.ts'), ...args], cwd)
}

function runProcess(cmd: string[], cwd = repoDir) {
  const decoder = new TextDecoder()
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  }
}

async function withCliFixture(files: Record<string, string>, run: (dir: string) => void | Promise<void>) {
  const dir = pathJoin('/tmp', `freerange-cli-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`)
  const mkdir = runProcess(['mkdir', '-p', dir])
  expectCli(mkdir.exitCode === 0, `expected to create ${dir}`, mkdir.output)
  try {
    for (const [file, text] of Object.entries(files)) {
      await Bun.write(pathJoin(dir, file), text)
    }
    await run(dir)
  } finally {
    const cleanup = runProcess(['rm', '-rf', dir])
    expectCli(cleanup.exitCode === 0, `expected to remove ${dir}`, cleanup.output)
  }
}

function expectCli(condition: boolean, message: string, output: string) {
  if (condition) return
  console.error(message)
  console.error(output.trimEnd())
  process.exitCode = 1
}

function pathJoin(first: string, ...rest: string[]) {
  let path = first.endsWith('/') ? first.slice(0, -1) : first
  for (const part of rest) path += '/' + part.replace(/^\/+/, '')
  return path
}
