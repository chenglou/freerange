// A code editor keeps the caret's line at the same place on screen while lines above it change height, e.g. when a font
// finishes loading, unless the user scrolled. The browser clamps scrollTop to the scrollable range and rounds it to whole
// pixels, so the value it keeps can differ from the value the editor wrote.
type Editor = {lineHeights: number[]; viewportHeight: number; caretLine: number; scrollTop: number}
type EditorEvent = {kind: 'reflow'; line: number; height: number} | {kind: 'scroll'; top: number} | {kind: 'idle'}

function lineTop(heights: number[], line: number): number {
  let top = 0
  for (let index = 0; index < line; index++) top += heights[index]!
  return top
}

// The environment model: what element.scrollTop reads back after the page writes `requested`.
function browserScrollTop(requested: number, heights: number[], viewportHeight: number): number {
  const max = Math.max(0, lineTop(heights, heights.length) - viewportHeight)
  return Math.round(Math.min(Math.max(requested, 0), max))
}

function initEditor(lineCount: number, caretLine: number, viewportHeight: number): Editor {
  const lineHeights: number[] = []
  for (let index = 0; index < lineCount; index++) lineHeights.push(20)
  const editor = {lineHeights, viewportHeight, caretLine, scrollTop: 0}
  return editor
}

function reflowLine(prev: Editor, line: number, height: number, scrollTop: number): Editor {
  console.assert(Number.isInteger(line))
  console.assert(line >= 0)
  console.assert(line <= 63)
  console.assert(line < prev.lineHeights.length)
  console.assert(height >= 1)
  console.assert(height <= 400)
  const lineHeights = prev.lineHeights.slice()
  const delta = height - lineHeights[line]!
  lineHeights[line] = height
  const next = {lineHeights, viewportHeight: prev.viewportHeight, caretLine: prev.caretLine, scrollTop: line < prev.caretLine ? scrollTop + delta : scrollTop}
  return next
}

// One frame. `reportedTop` is element.scrollTop read at the start of the frame; the returned scrollTop is written at its end.
function stepEditor(prev: Editor, event: EditorEvent, reportedTop: number): Editor {
  const scrollTop = reportedTop
  switch (event.kind) {
    case 'reflow': return reflowLine(prev, event.line, event.height, scrollTop)
    case 'scroll': return {lineHeights: prev.lineHeights, viewportHeight: prev.viewportHeight, caretLine: prev.caretLine, scrollTop: reportedTop}
    case 'idle': return {lineHeights: prev.lineHeights, viewportHeight: prev.viewportHeight, caretLine: prev.caretLine, scrollTop}
  }
}

export function editorFrames(lineCount: number, caretLine: number, viewportHeight: number, events: EditorEvent[]): void {
  console.assert(Number.isInteger(lineCount))
  console.assert(lineCount >= 1)
  console.assert(lineCount <= 64)
  console.assert(Number.isInteger(caretLine))
  console.assert(caretLine >= 0)
  console.assert(caretLine <= 63)
  console.assert(caretLine < lineCount)
  console.assert(viewportHeight >= 100)
  console.assert(viewportHeight <= 2000)
  let editor = initEditor(lineCount, caretLine, viewportHeight)
  let reported = 0
  for (const event of events) {
    // The environment: a reflow names a line that exists.
    if (event.kind === 'reflow' && event.line >= editor.lineHeights.length) continue
    const caretBefore = lineTop(editor.lineHeights, editor.caretLine) - reported
    // The environment: a user scroll lands where the browser clamps it.
    if (event.kind === 'scroll') reported = browserScrollTop(event.top, editor.lineHeights, editor.viewportHeight)
    editor = stepEditor(editor, event, reported)
    // The environment: the browser keeps a clamped, whole-pixel scrollTop for what the frame wrote.
    reported = browserScrollTop(editor.scrollTop, editor.lineHeights, editor.viewportHeight)
    const maxTop = lineTop(editor.lineHeights, editor.lineHeights.length) - editor.viewportHeight
    if (event.kind === 'reflow' && event.line < editor.caretLine && editor.scrollTop >= 0 && editor.scrollTop <= maxTop) {
      const drift = Math.abs(lineTop(editor.lineHeights, editor.caretLine) - reported - caretBefore)
      console.assert(drift <= 0.5)
    }
  }
}
