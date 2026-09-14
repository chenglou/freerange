// The runtime check behind "can be false (counterexample checked by running it)" and behind soundness violations. An
// example input is run through an instrumented copy of the unit (asserts.ts instrumentForRuntime) in a child process
// (runtime-child.ts). The recorded events decide whether the target assert failed inside a call of its function whose
// leading asserts all held and whose numeric parameters were all finite: Freerange assumes both inside the function
// (current-decisions.md "How does console.assert work?", README "Things Worth Asserting"), so only such a firing
// contradicts a proof.
import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {instrumentForRuntime} from './asserts.ts'
import {runMeasured} from './process.ts'

export type RuntimeEvent =
  | {kind: 'enter'; name: string; finite: boolean | null}
  | {kind: 'assert'; id: string; ok: boolean}

export type RuntimeRequest = {
  modulePath: string
  entry: string
  argsModulePath: string
  outputPath: string
  maxEvents: number
  maxFiniteValues: number
}

export type RuntimeResult = {
  events: RuntimeEvent[]
  overflow: boolean
  thrown: string | null
  setupError: string | null
}

export type ExampleOutcome =
  | {status: 'fires-in-domain'}
  | {status: 'fires-out-of-domain'; why: string}
  | {status: 'holds'}
  | {status: 'not-run'; why: string}

export const maxRuntimeEvents = 200_000
export const maxFiniteValues = 10_000

// Whether every number reachable from the value, through arrays and plain objects, is finite. Null means the walk hit its
// budget or met a value it doesn't look inside, so finiteness is unknown and the firing can't be called in-domain.
export function allFinite(value: unknown, budget = maxFiniteValues): boolean | null {
  const stack: unknown[] = [value]
  let visited = 0
  while (stack.length > 0) {
    if (visited >= budget) return null
    visited++
    const current = stack.pop()
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false
    } else if (Array.isArray(current)) {
      for (const element of current) stack.push(element)
    } else if (current != null && typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current) as unknown
      if (prototype !== Object.prototype && prototype !== null) return null
      for (const element of Object.values(current)) stack.push(element)
    }
  }
  return true
}

export function classifyEvents(result: RuntimeResult, targetID: string, functionName: string | null, leadingIDs: ReadonlySet<string>): ExampleOutcome {
  if (result.setupError != null) return {status: 'not-run', why: result.setupError}
  let call: {finite: boolean | null; leadingHeld: boolean} | null = null
  let firstOutOfDomain: string | null = null
  for (const event of result.events) {
    if (event.kind === 'enter') {
      if (event.name === functionName) call = {finite: event.finite, leadingHeld: true}
      continue
    }
    if (leadingIDs.has(event.id)) {
      if (!event.ok && call != null) call.leadingHeld = false
      continue
    }
    if (event.id !== targetID || event.ok) continue
    if (call == null) {
      firstOutOfDomain ??= `no call of ${functionName ?? '(no top-level function)'} was recorded before the firing`
    } else if (call.finite !== true) {
      firstOutOfDomain ??= call.finite === false ? 'a numeric input of the function was not finite' : 'the inputs could not be checked for finiteness'
    } else if (!call.leadingHeld) {
      firstOutOfDomain ??= 'a leading console.assert of the function failed in the same call'
    } else {
      return {status: 'fires-in-domain'}
    }
  }
  if (firstOutOfDomain != null) return {status: 'fires-out-of-domain', why: firstOutOfDomain}
  if (result.overflow) return {status: 'not-run', why: `event cap of ${result.events.length} reached before the assert fired`}
  return {status: 'holds'}
}

export type ExampleCandidate = {siteKey: string; exampleIndex: number}

// Chooses which examples to run: at most perSite per site, in stored order, and at most total over the whole run.
export function selectExamples(sites: Array<{key: string; exampleCount: number}>, perSite: number, total: number): {selected: ExampleCandidate[]; skipped: number} {
  const selected: ExampleCandidate[] = []
  let skipped = 0
  for (const site of sites) {
    const wanted = Math.min(site.exampleCount, perSite)
    for (let exampleIndex = 0; exampleIndex < wanted; exampleIndex++) {
      if (selected.length >= total) {
        skipped++
        continue
      }
      selected.push({siteKey: site.key, exampleIndex})
    }
  }
  return {selected, skipped}
}

// Copies a unit tree and rewrites the analyzed files for the runtime check; other files stay verbatim.
export function writeRuntimeTree(sourceRoot: string, destinationRoot: string, instrumented: string[]): void {
  mkdirSync(destinationRoot, {recursive: true})
  cpSync(sourceRoot, destinationRoot, {recursive: true, verbatimSymlinks: true})
  for (const file of instrumented) {
    const path = join(destinationRoot, file)
    writeFileSync(path, instrumentForRuntime(file, readFileSync(path, 'utf8')))
  }
}

export async function runExample(options: {runtimeRoot: string; entryFile: string; entry: string; args: string; workDirectory: string; label: string; timeoutMs: number}): Promise<RuntimeResult> {
  const requestPath = join(options.workDirectory, `${options.label}.request.json`)
  const outputPath = join(options.workDirectory, `${options.label}.result.json`)
  const argsModulePath = join(options.workDirectory, `${options.label}.args.ts`)
  writeFileSync(argsModulePath, `export default ${options.args}\n`)
  const request: RuntimeRequest = {
    modulePath: join(options.runtimeRoot, options.entryFile),
    entry: options.entry,
    argsModulePath,
    outputPath,
    maxEvents: maxRuntimeEvents,
    maxFiniteValues,
  }
  writeFileSync(requestPath, JSON.stringify(request))
  const child = new URL('./runtime-child.ts', import.meta.url).pathname
  const run = await runMeasured(['bun', child, requestPath], options.runtimeRoot, {timeoutMs: options.timeoutMs, maxOutputBytes: 64_000}, false)
  if (run.timedOut) return {events: [], overflow: false, thrown: null, setupError: `timeout after ${Math.round(options.timeoutMs / 1000)} s`}
  try {
    return JSON.parse(readFileSync(outputPath, 'utf8')) as unknown as RuntimeResult
  } catch {
    const detail = run.stderr.split('\n').find(line => line.trim().length > 0) ?? `exit ${run.exitCode ?? 'none'}`
    return {events: [], overflow: false, thrown: null, setupError: `the child wrote no result: ${detail}`}
  }
}
