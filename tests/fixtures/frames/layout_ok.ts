// A text column layout caches its measurement, keyed on the font size and width it was measured for. A frame whose
// inputs didn't change must return the same layout object, so nothing downstream re-renders.
type Layout = {fontSize: number; width: number; measuredFontSize: number; measuredWidth: number; columns: number; version: number}
type LayoutEvent = {kind: 'resize'; width: number} | {kind: 'font'; size: number} | {kind: 'idle'}

function measure(prev: Layout): Layout {
  if (prev.fontSize === prev.measuredFontSize && prev.width === prev.measuredWidth) return prev
  const columns = Math.max(1, Math.floor(prev.width / (prev.fontSize * 30)))
  const next = {fontSize: prev.fontSize, width: prev.width, measuredFontSize: prev.fontSize, measuredWidth: prev.width, columns, version: prev.version + 1}
  return next
}

function resize(prev: Layout, width: number): Layout {
  console.assert(width >= 320)
  console.assert(width <= 3840)
  return measure({fontSize: prev.fontSize, width, measuredFontSize: prev.measuredFontSize, measuredWidth: prev.measuredWidth, columns: prev.columns, version: prev.version})
}

function font(prev: Layout, size: number): Layout {
  console.assert(size >= 8)
  console.assert(size <= 72)
  return measure({fontSize: size, width: prev.width, measuredFontSize: prev.measuredFontSize, measuredWidth: prev.measuredWidth, columns: prev.columns, version: prev.version})
}

function stepLayout(prev: Layout, event: LayoutEvent): Layout {
  switch (event.kind) {
    case 'resize': return resize(prev, event.width)
    case 'font': return font(prev, event.size)
    case 'idle': return measure(prev)
  }
}

export function layoutFrames(width: number, events: LayoutEvent[]): void {
  console.assert(width >= 320)
  console.assert(width <= 3840)
  let layout: Layout = {fontSize: 16, width, measuredFontSize: 16, measuredWidth: width, columns: Math.max(1, Math.floor(width / 480)), version: 0}
  for (const event of events) {
    const before = layout
    layout = stepLayout(layout, event)
    // Nothing re-renders on a frame whose inputs didn't change.
    if (event.kind === 'idle') console.assert(layout === before)
  }
}
