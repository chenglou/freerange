import {inferFitFiles, type FitCheck, verifyFitFiles} from './src/check.ts'

const positiveFiles = ['patterns.ts', 'import-patterns.ts']
const negativeFiles = ['negative-patterns.ts', 'negative-import-patterns.ts']
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
const loopFunctionSpecStatuses = new Map(loopInferReport.functions[0]?.specs.map(spec => [spec.text, spec.status]) ?? [])
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
const expectedLoopFunctionSpecStatuses = [
  ['given items.length: int 1..50', 'trusted'],
  ['result.bottom >= top', 'source-proved'],
  ['result.rows.length == items.length', 'source-proved'],
] as const
const badLoopSpecStatuses = expectedLoopSpecStatuses.filter(([text, status]) => loopSpecStatuses.get(text) !== status)
const badLoopFunctionSpecStatuses = expectedLoopFunctionSpecStatuses.filter(([text, status]) => loopFunctionSpecStatuses.get(text) !== status)
if (missingLoopFacts.length > 0 || badLoopSpecStatuses.length > 0 || badLoopFunctionSpecStatuses.length > 0) {
  console.error('expected loop inferred facts changed')
  console.error(missingLoopFacts.map(fact => `missing: ${fact}`).join('\n'))
  console.error(badLoopSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  console.error(badLoopFunctionSpecStatuses.map(([text, status]) => `expected function ${text}: ${status}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer loops: ${expectedLoopFacts.length} expected facts`)
}

const redundantInferReport = inferFitFiles(['patterns.ts'], {functionName: 'scalarPushLoop'})
const redundantFunction = redundantInferReport.functions[0]
const redundantFacts = new Set(redundantFunction?.redundant ?? [])
const expectedRedundantFacts = [
  'result.length == items.length',
  'result[]: 0..3000',
]
const missingRedundantFacts = expectedRedundantFacts.filter(fact => !redundantFacts.has(fact))
const redundantSpecStatuses = new Map(redundantFunction?.specs.map(spec => [spec.text, spec.status]) ?? [])
const expectedRedundantSpecStatuses = [
  ['given items.length: int 0..50', 'trusted'],
  ['result.length == items.length', 'source-proved'],
  ['result[]: 0..3000', 'source-proved'],
] as const
const badRedundantSpecStatuses = expectedRedundantSpecStatuses.filter(([text, status]) => redundantSpecStatuses.get(text) !== status)
if (missingRedundantFacts.length > 0 || badRedundantSpecStatuses.length > 0) {
  console.error('expected function-level redundant facts changed')
  console.error(missingRedundantFacts.map(fact => `missing redundant: ${fact}`).join('\n'))
  console.error(badRedundantSpecStatuses.map(([text, status]) => `expected ${text}: ${status}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`infer redundant: ${expectedRedundantFacts.length} expected facts`)
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
  formatInferSnapshot(['../vibescript/demos/photo-gallery/layout.ts'], 'leftEdgeHitArea'),
  formatInferSnapshot(['../vibescript/demos/photo-gallery/layout.ts'], 'rightEdgeHitArea'),
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
  addSection(lines, 'result', snapshotItems(functionName, 'result', fn.facts.map(fact => fact.text)))
  addSection(lines, 'locals', snapshotItems(functionName, 'locals', fn.locals.map(fact => fact.text)))
  for (const loop of fn.loops) {
    lines.push(`loop ${loop.line}: ${loop.header}`)
    addSection(lines, 'inferred', loop.facts.map(fact => fact.text), '  ')
    addSection(lines, 'source-proved', loop.specs.filter(spec => spec.status === 'source-proved').map(spec => spec.text), '  ')
    addSection(lines, 'trusted', loop.specs.filter(spec => spec.status === 'trusted').map(spec => spec.text), '  ')
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
  if (item === 'result.items.length == layoutSources.length') return true
  if (item === 'result.items.length: int 0..Infinity') return true
  if (item === 'result.rowsTop.length == rowsTop.length') return true
  if (item === 'result.rowsTop.length: int 0..Infinity') return true
  if (section === 'result') {
    return item === 'result.items[].imageBox.sizeX == gridImageSizeXResult'
      || item === 'result.items[].layoutBox.sizeX == gridImageSizeXResult'
      || item.includes('result.items[].prompt.box.sizeX ==')
      || item.includes('result.items[].prompt.box.sizeY ==')
      || item.includes('result.items[].prompt.lines.length ==')
      || item === 'result.items[].prompt.lines.length: int 0..Infinity'
  }
  return item === 'rowsTop.length: int 0..Infinity'
    || item === 'rowHeights.length: int 0..Infinity'
    || item === 'measurements.length == layoutSources.length'
    || item === 'measurements.length: int 0..Infinity'
    || item === 'measurements[].imageSizeX == gridImageSizeXResult'
    || item.includes('measurements[].promptLayout.lineCount ==')
    || item.includes('measurements[].promptLayout.lines.length ==')
    || item === 'measurements[].promptLayout.lines.length: int 0..Infinity'
    || item.includes('measurements[].promptLayout.visibleHeight ==')
    || item.includes('measurements[].promptLayout.width ==')
}

function keepLineLayoutSnapshotItem(section: string, item: string) {
  if (item.includes('.fragments')) return false
  if (section === 'result') {
    return item === 'result.items.length == layoutSources.length'
      || item === 'result.items.length: int 0..Infinity'
      || item === 'result.items[].imageBox.sizeX == get1DItemSizeResult.imageSizeX'
      || item === 'result.items[].imageBox.sizeY == get1DItemSizeResult.imageSizeY'
      || item.includes('result.items[].prompt.box.sizeX ==')
      || item.includes('result.items[].prompt.box.sizeY ==')
      || item.includes('result.items[].prompt.lines.length ==')
      || item === 'result.items[].prompt.lines.length: int 0..Infinity'
      || item.includes('result.items[].prompt.lines[].width ==')
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
