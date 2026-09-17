// A background job queue drains work in batches of 4, one batch per timer wake. Pending work must always have a wake
// scheduled, or it waits forever (a missing wake).
type Queue = {pending: number; wakeScheduled: boolean}
type QueueEvent = {kind: 'enqueue'; count: number} | {kind: 'wake'} | {kind: 'idle'}

function enqueue(prev: Queue, count: number): Queue {
  console.assert(Number.isInteger(count))
  console.assert(count >= 1)
  console.assert(count <= 10)
  const next = {pending: prev.pending + count, wakeScheduled: true}
  return next
}

function wake(prev: Queue): Queue {
  const pending = Math.max(0, prev.pending - 4)
  // Bug: re-arms only while a full batch remains.
  const next = {pending, wakeScheduled: pending >= 4}
  return next
}

function stepQueue(prev: Queue, event: QueueEvent): Queue {
  switch (event.kind) {
    case 'enqueue': return enqueue(prev, event.count)
    case 'wake': return wake(prev)
    case 'idle': return prev
  }
}

export function queueFrames(events: QueueEvent[]): void {
  let queue: Queue = {pending: 0, wakeScheduled: false}
  for (const event of events) {
    // The environment: a timer fires only when one was scheduled.
    if (event.kind === 'wake' && !queue.wakeScheduled) continue
    queue = stepQueue(queue, event)
    console.assert(queue.pending === 0 || queue.wakeScheduled)
  }
}
