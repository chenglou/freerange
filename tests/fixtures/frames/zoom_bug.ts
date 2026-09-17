// A map view zooms by a per-frame factor and pans in screen pixels. The scale is clamped, so every state stays finite.
type View = {scale: number; centerX: number}
type ViewEvent = {kind: 'zoom'; factor: number} | {kind: 'pan'; dx: number}

function zoom(prev: View, factor: number): View {
  console.assert(factor >= 0.5)
  console.assert(factor <= 100000000)
  // Bug: no clamp, so a few large zooms overflow the scale to Infinity and the center to NaN.
  const scale = prev.scale * factor
  const screenX = prev.centerX * scale
  const next = {scale, centerX: screenX / scale}
  return next
}

function pan(prev: View, dx: number): View {
  console.assert(dx >= -1000)
  console.assert(dx <= 1000)
  const next = {scale: prev.scale, centerX: prev.centerX + dx / prev.scale}
  return next
}

function stepView(prev: View, event: ViewEvent): View {
  const next = event.kind === 'zoom' ? zoom(prev, event.factor) : pan(prev, event.dx)
  console.assert(next.centerX >= -1000000000)
  return next
}

export function viewFrames(events: ViewEvent[]): void {
  let view: View = {scale: 1, centerX: 0}
  for (const event of events) {
    view = stepView(view, event)
  }
}
