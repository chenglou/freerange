// Child process for the runtime check: installs the hooks instrumentForRuntime's rewrite calls, imports the instrumented
// module, calls one exported function with the example's arguments, and writes the recorded events to a file. Examples
// are argument lists written as JavaScript array literals, e.g. `[[-1000000],[2],2]`; the parent writes each one as a
// module (`export default [...]`) that this process imports. The event list is capped; a run past the cap says so.
import {readFileSync, writeFileSync} from 'node:fs'
import {allFinite, type RuntimeEvent, type RuntimeRequest, type RuntimeResult} from './runtime.ts'

const requestText = readFileSync(process.argv[2]!, 'utf8')
const request = JSON.parse(requestText) as unknown as RuntimeRequest
const events: RuntimeEvent[] = []
let overflow = false
const record = (event: RuntimeEvent): void => {
  if (events.length >= request.maxEvents) {
    overflow = true
    return
  }
  events.push(event)
}
const opaque = Symbol('opaque parameter')
Object.assign(globalThis, {
  __evalAssert: (id: string, condition: unknown): void => {
    record({kind: 'assert', id, ok: Boolean(condition)})
  },
  __evalEnter: (name: string, parameters: unknown[]): void => {
    record({kind: 'enter', name, finite: parameters.includes(opaque) ? null : allFinite(parameters, request.maxFiniteValues)})
  },
  __evalOpaque: opaque,
})

let thrown: string | null = null
let setupError: string | null = null
try {
  const namespace = await import(request.modulePath) as unknown as Record<string, unknown>
  const entry = namespace[request.entry]
  const argumentsModule = await import(request.argsModulePath) as unknown as {default: unknown}
  const argumentList = argumentsModule.default
  if (typeof entry !== 'function') {
    setupError = `${request.entry} is not a function export of ${request.modulePath}`
  } else if (!Array.isArray(argumentList)) {
    setupError = `the example's arguments aren't an array (${request.argsModulePath})`
  } else {
    try {
      Reflect.apply(entry, undefined, argumentList)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
  }
} catch (error) {
  setupError = error instanceof Error ? error.message : String(error)
}
const result: RuntimeResult = {events, overflow, thrown, setupError}
writeFileSync(request.outputPath, JSON.stringify(result))
