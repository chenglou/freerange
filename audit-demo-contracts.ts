import {demoContractPaths} from './demo-contract-paths.ts'
import {inferFitFiles, type FitInferFunctionReport} from './src/check.ts'

type Counts = {
  functions: number
  trusted: number
  sourceProved: number
  notInferred: number
  redundant: number
  likelyRemovable: number
  publicLooking: number
  keepers: number
  loopTrusted: number
  loopSourceProved: number
  loopNotInferred: number
  loopRedundant: number
  loopLikelyRemovable: number
  loopPublicLooking: number
  loopKeepers: number
}

type RedundantItem = {
  file: string
  functionName: string
  text: string
  reason: string
  kind: 'function' | 'loop'
  recommendation: RedundantRecommendation
  line?: number
}

type RedundantRecommendation = 'likely-removable' | 'public-looking'

const report = inferFitFiles(demoContractPaths, {all: true})
const totals = emptyCounts()
const byFile = new Map<string, Counts>()
const notInferred: Array<{file: string; functionName: string; text: string; reason?: string}> = []
const keepers: Array<{file: string; functionName: string; text: string}> = []
const redundantItems: RedundantItem[] = []

for (const fn of report.functions) {
  const counts = byFile.get(fn.file) ?? emptyCounts()
  addFunction(counts, fn)
  addFunction(totals, fn)
  byFile.set(fn.file, counts)

  const redundant = new Set(fn.redundant.map(spec => spec.text))
  for (const spec of fn.redundant) {
    redundantItems.push({
      file: fn.file,
      functionName: fn.functionName,
      text: spec.text,
      reason: spec.reason,
      kind: 'function',
      recommendation: redundantRecommendation(spec.text, spec.reason),
    })
  }
  for (const loop of fn.loops) {
    for (const spec of loop.redundant) {
      redundantItems.push({
        file: fn.file,
        functionName: fn.functionName,
        text: spec.text,
        reason: spec.reason,
        kind: 'loop',
        line: loop.line,
        recommendation: redundantRecommendation(spec.text, spec.reason),
      })
    }
  }
  for (const spec of fn.specs) {
    if (spec.status === 'not-inferred') {
      notInferred.push({
        file: fn.file,
        functionName: fn.functionName,
        text: spec.text,
        ...(spec.reason == null ? {} : {reason: spec.reason}),
      })
    }
    if (spec.status === 'source-proved' && !redundant.has(spec.text)) keepers.push({file: fn.file, functionName: fn.functionName, text: spec.text})
  }
}

console.log(`demo functions: ${totals.functions}`)
console.log(`function specs: ${totals.sourceProved} source-proved, ${totals.trusted} trusted, ${totals.notInferred} not-inferred`)
console.log(`function redundancy: ${totals.redundant} redundant (${totals.likelyRemovable} likely removable, ${totals.publicLooking} public-looking), ${totals.keepers} source-proved keepers`)
console.log(`loop specs: ${totals.loopSourceProved} source-proved, ${totals.loopTrusted} trusted, ${totals.loopNotInferred} not-inferred`)
console.log(`loop redundancy: ${totals.loopRedundant} redundant (${totals.loopLikelyRemovable} likely removable, ${totals.loopPublicLooking} public-looking), ${totals.loopKeepers} source-proved keepers`)
console.log()

for (const [file, counts] of [...byFile.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  if (counts.sourceProved === 0 && counts.trusted === 0 && counts.loopSourceProved === 0 && counts.loopTrusted === 0) continue
  console.log(`${file}:`)
  console.log(`  functions: ${counts.sourceProved} source-proved, ${counts.trusted} trusted, ${counts.redundant} redundant (${counts.likelyRemovable} likely removable, ${counts.publicLooking} public-looking), ${counts.keepers} keepers`)
  if (counts.loopSourceProved > 0 || counts.loopTrusted > 0 || counts.loopRedundant > 0) {
    console.log(`  loops: ${counts.loopSourceProved} source-proved, ${counts.loopTrusted} trusted, ${counts.loopRedundant} redundant (${counts.loopLikelyRemovable} likely removable, ${counts.loopPublicLooking} public-looking), ${counts.loopKeepers} keepers`)
  }
}

if (notInferred.length > 0) {
  console.log()
  console.log('not-inferred:')
  for (const item of notInferred) {
    console.log(`  ${item.file}:${item.functionName}: ${item.text}${item.reason == null ? '' : ` (${item.reason})`}`)
  }
}

const likelyRemovable = redundantItems.filter(item => item.recommendation === 'likely-removable')
if (likelyRemovable.length > 0) {
  console.log()
  console.log('likely removable redundant specs:')
  for (const item of likelyRemovable.slice(0, 40)) {
    console.log(`  ${redundantItemLabel(item)}: ${item.text} (covered by ${item.reason})`)
  }
  if (likelyRemovable.length > 40) console.log(`  ... ${likelyRemovable.length - 40} more`)
}

const publicLooking = redundantItems.filter(item => item.recommendation === 'public-looking')
if (publicLooking.length > 0) {
  console.log()
  console.log('public-looking redundant specs:')
  for (const item of publicLooking.slice(0, 40)) {
    console.log(`  ${redundantItemLabel(item)}: ${item.text} (covered by ${item.reason})`)
  }
  if (publicLooking.length > 40) console.log(`  ... ${publicLooking.length - 40} more`)
}

if (keepers.length > 0) {
  console.log()
  console.log('source-proved keepers:')
  for (const item of keepers.slice(0, 40)) {
    console.log(`  ${item.file}:${item.functionName}: ${item.text}`)
  }
  if (keepers.length > 40) console.log(`  ... ${keepers.length - 40} more`)
}

function emptyCounts(): Counts {
  return {
    functions: 0,
    trusted: 0,
    sourceProved: 0,
    notInferred: 0,
    redundant: 0,
    likelyRemovable: 0,
    publicLooking: 0,
    keepers: 0,
    loopTrusted: 0,
    loopSourceProved: 0,
    loopNotInferred: 0,
    loopRedundant: 0,
    loopLikelyRemovable: 0,
    loopPublicLooking: 0,
    loopKeepers: 0,
  }
}

function addFunction(counts: Counts, fn: FitInferFunctionReport) {
  counts.functions++
  const redundant = new Set(fn.redundant.map(spec => spec.text))
  for (const spec of fn.specs) {
    if (spec.status === 'trusted') counts.trusted++
    if (spec.status === 'source-proved') counts.sourceProved++
    if (spec.status === 'not-inferred') counts.notInferred++
    if (spec.status === 'source-proved' && !redundant.has(spec.text)) counts.keepers++
  }
  counts.redundant += fn.redundant.length
  for (const spec of fn.redundant) {
    const recommendation = redundantRecommendation(spec.text, spec.reason)
    if (recommendation === 'likely-removable') counts.likelyRemovable++
    else counts.publicLooking++
  }

  for (const loop of fn.loops) {
    const loopRedundant = new Set(loop.redundant.map(spec => spec.text))
    for (const spec of loop.specs) {
      if (spec.status === 'trusted') counts.loopTrusted++
      if (spec.status === 'source-proved') counts.loopSourceProved++
      if (spec.status === 'not-inferred') counts.loopNotInferred++
      if (spec.status === 'source-proved' && !loopRedundant.has(spec.text)) counts.loopKeepers++
    }
    counts.loopRedundant += loop.redundant.length
    for (const spec of loop.redundant) {
      const recommendation = redundantRecommendation(spec.text, spec.reason)
      if (recommendation === 'likely-removable') counts.loopLikelyRemovable++
      else counts.loopPublicLooking++
    }
  }
}

function redundantRecommendation(text: string, reason: string): RedundantRecommendation {
  if (isNonNegativeBoundCoveredByRange(text, reason)) return 'likely-removable'
  return 'public-looking'
}

function isNonNegativeBoundCoveredByRange(text: string, reason: string) {
  return /\s>=\s0$/.test(text) && reason.includes(':')
}

function redundantItemLabel(item: RedundantItem) {
  const base = `${item.file}:${item.functionName}`
  return item.kind === 'loop' ? `${base}:loop ${item.line}` : base
}
