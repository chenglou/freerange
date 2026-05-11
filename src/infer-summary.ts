import type {
  FitInferFunctionReport,
  FitInferSummary,
  FitInferSummaryFunction,
  FitInferSummaryReason,
} from './check-types.ts'

type MutableInferSummary = Omit<FitInferSummary, 'unsupported'> & {
  unsupported: {
    stops: number
    noisiest: FitInferSummaryFunction[]
    reasonCounts: Map<string, number>
  }
}

export function createInferSummary(files: string[]): MutableInferSummary {
  return {
    files,
    functions: 0,
    facts: {return: 0, locals: 0, loop: 0},
    specs: {checked: 0, assumptions: 0, notInferred: 0, redundant: 0},
    unsupported: {stops: 0, noisiest: [], reasonCounts: new Map()},
  }
}

export function addInferFunctionToSummary(summary: MutableInferSummary, fn: FitInferFunctionReport) {
  summary.functions += 1
  summary.facts.return += fn.facts.length
  summary.facts.locals += fn.locals.length
  summary.facts.loop += fn.loops.reduce((total, loop) => total + loop.facts.length, 0)
  summary.specs.checked += fn.specs.filter(spec => spec.status === 'checked').length
  summary.specs.assumptions += fn.specs.filter(spec => spec.status === 'assumed').length
  summary.specs.notInferred += fn.specs.filter(spec => spec.status === 'not-inferred').length
  summary.specs.redundant += fn.redundant.length

  const unsupportedCount = fn.unsupported.length + fn.loops.reduce((total, loop) => total + loop.unsupported.length, 0)
  summary.unsupported.stops += unsupportedCount
  if (unsupportedCount > 0) {
    summary.unsupported.noisiest.push({file: fn.file, functionName: fn.functionName, count: unsupportedCount})
  }
  for (const reason of fn.unsupported) countReason(summary.unsupported.reasonCounts, reason)
  for (const loop of fn.loops) {
    for (const reason of loop.unsupported) countReason(summary.unsupported.reasonCounts, reason)
  }
}

export function finishInferSummary(summary: MutableInferSummary): FitInferSummary {
  return {
    files: summary.files,
    functions: summary.functions,
    facts: summary.facts,
    specs: summary.specs,
    unsupported: {
      stops: summary.unsupported.stops,
      noisiest: topNoisiestFunctions(summary.unsupported.noisiest),
      topReasons: topUnsupportedReasons(summary.unsupported.reasonCounts),
    },
  }
}

function topNoisiestFunctions(functions: FitInferSummaryFunction[]) {
  return [...functions]
    .sort((left, right) => right.count - left.count || left.file.localeCompare(right.file) || left.functionName.localeCompare(right.functionName))
    .slice(0, 5)
}

function topUnsupportedReasons(counts: Map<string, number>): FitInferSummaryReason[] {
  return [...counts]
    .map(([reason, count]) => ({reason, count}))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, 8)
}

function countReason(counts: Map<string, number>, reason: string) {
  const firstLine = reason.split('\n')[0]?.trim()
  if (firstLine == null || firstLine.length === 0) return
  const normalized = firstLine.match(/^unsupported .* line \d+: (.*)$/)?.[1] ?? firstLine
  counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
}
