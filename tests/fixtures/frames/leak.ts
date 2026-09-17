// Adversarial: module state that is correct for one page load but leaks between generated sequences run in one process.
type Counter = {frames: number}
type Tick = {kind: 'tick'} | {kind: 'pause'}

let initialized = false

function initCounter(): Counter {
  const firstInit = !initialized
  initialized = true
  console.assert(firstInit)
  const counter = {frames: 0}
  return counter
}

function stepCounter(prev: Counter, event: Tick): Counter {
  const next = {frames: event.kind === 'tick' ? prev.frames + 1 : prev.frames}
  return next
}

export function counterFrames(events: Tick[]): void {
  let counter = initCounter()
  for (const event of events) {
    counter = stepCounter(counter, event)
  }
}
