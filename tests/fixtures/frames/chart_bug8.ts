// A streaming chart shows the last `capacity` samples. While the pointer hovers a sample the view stops following new
// samples, so the hovered sample stays under the pointer.
type Chart = {times: number[]; capacity: number; width: number; viewStart: number; viewEnd: number; hovered: number}
type ChartEvent = {kind: 'sample'; gap: number} | {kind: 'pointer'; x: number} | {kind: 'leave'}

function xOf(chart: Chart, time: number): number {
  return ((time - chart.viewStart) / (chart.viewEnd - chart.viewStart)) * chart.width
}

function initChart(capacity: number, width: number): Chart {
  const chart = {times: [0], capacity, width, viewStart: 0, viewEnd: 1, hovered: -1}
  return chart
}

function addSample(prev: Chart, gap: number): Chart {
  console.assert(gap >= 0.25)
  console.assert(gap <= 100)
  const last = prev.times[prev.times.length - 1]!
  const appended = prev.times.concat([last + gap])
  const dropped = appended.length > prev.capacity ? 1 : 0
  const times = appended.slice(dropped)
  // Bug: when the oldest sample is dropped, the hovered index keeps pointing at the same slot, now a newer sample.
  const hovered = prev.hovered < 0 ? -1 : prev.hovered
  const hovering = hovered >= 0
  const viewStart = hovering ? prev.viewStart : times[0]!
  const viewEnd = hovering ? prev.viewEnd : Math.max(times[times.length - 1]!, times[0]! + 1)
  const next = {times, capacity: prev.capacity, width: prev.width, viewStart, viewEnd, hovered}
  return next
}

function hover(prev: Chart, x: number): Chart {
  console.assert(x >= 0)
  console.assert(x <= 2000)
  let hovered = -1
  for (let index = 0; index < prev.times.length; index++) {
    if (Math.abs(xOf(prev, prev.times[index]!) - x) <= 8) hovered = index
  }
  const next = {times: prev.times, capacity: prev.capacity, width: prev.width, viewStart: prev.viewStart, viewEnd: prev.viewEnd, hovered}
  return next
}

function leave(prev: Chart): Chart {
  const times = prev.times
  const next = {times, capacity: prev.capacity, width: prev.width, viewStart: times[0]!, viewEnd: Math.max(times[times.length - 1]!, times[0]! + 1), hovered: -1}
  return next
}

function stepChart(prev: Chart, event: ChartEvent): Chart {
  switch (event.kind) {
    case 'sample': return addSample(prev, event.gap)
    case 'pointer': return hover(prev, event.x)
    case 'leave': return leave(prev)
  }
}

export function chartFrames(capacity: number, width: number, events: ChartEvent[]): void {
  console.assert(Number.isInteger(capacity))
  console.assert(capacity >= 8)
  console.assert(capacity <= 32)
  console.assert(width >= 200)
  console.assert(width <= 1600)
  let chart = initChart(capacity, width)
  for (const event of events) {
    const before = chart
    chart = stepChart(chart, event)
    if (event.kind === 'sample' && before.hovered >= 0 && chart.hovered >= 0) {
      const drift = Math.abs(xOf(chart, chart.times[chart.hovered]!) - xOf(before, before.times[before.hovered]!))
      console.assert(drift <= 0.5)
    }
  }
}
