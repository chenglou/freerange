// Replay adapter for the frames family: turns an input recorded by the dense sweep (S/experiments/frames/sweep.ts), which
// records each evaluation as a flat argument list per sweep family, into an entry call. It is used only to replay recorded
// catches this run missed; no input the lattice generates passes through it.
//   pageframe-small ['galleryFilterHandoffScrollTop', rowTop, rowHeight, bottom]  galleryFilterHandoffScrollTop(rowTop, rowHeight, bottom)
//   mobile          [x, y, h]                                                   mobilePageFrame(x, y, h)
//   composer        [h, s]                                                      mobileComposerGeometry({inputBarHeight: h, safeAreaBottom: s})
//   app             [x, y, banner, layout, options]                             appLayoutGeometry({x, y}, banner, layout, options)
//   sidebar         ['open', alignment, shrink, x, y, nav, gapTop, innerX, innerSizeX, w, h, reserve, inset]
//                                                                               sidebarPageFrameOpen(x, …, inset, alignment, shrink)
//                   ['closed' | 'hovering', x, y, nav, gapTop, innerX, innerSizeX, w, h, reserve, inset]
//                                                                               sidebarPageFrameClosed(…) or sidebarPageFrameHovering(…)
//   field           ['field', insetX, maxWidth, ...one of the sidebar lists above]
//                                                                               sidebarInputFieldHorizontalLayout(frame, insetX, maxWidth), where
//                                                                               the frame is what that sidebar call returns
//                   ['field', insetX, maxWidth, 'direct', contentLeft, contentRight, topSidebarLeft]
//                                                                               the same, on the sweep's direct frame
import type {Value} from './domain.ts'

// `frameFrom`: the sidebar call whose return value replaces args[0] before the replay; null when args are complete.
export type FramesCall = {entry: string; args: Value[]; frameFrom: {entry: string; args: Value[]} | null}

function sidebarCall(example: Value[]): {entry: string; args: Value[]} {
  const [state, ...rest] = example
  switch (state) {
    case 'open': {
      const [alignment, shrink, ...positional] = rest
      return {entry: 'sidebarPageFrameOpen', args: [...positional, alignment, shrink]}
    }
    case 'closed': return {entry: 'sidebarPageFrameClosed', args: rest}
    case 'hovering': return {entry: 'sidebarPageFrameHovering', args: rest}
    default: throw new Error(`no sidebar frame call for the recorded input ${JSON.stringify(example)}`)
  }
}

function rect(left: Value, right: Value): Value {
  return {left, right, top: 0, bottom: 0}
}

/** The entry a recorded sweep input drives, and its arguments. `family` is the sweep block's family, e.g. `composer`. */
export function framesHarnessCall(family: string, example: Value[]): FramesCall {
  if (example[0] === 'field') {
    const [, insetX, maxWidth, ...context] = example
    if (context[0] !== 'direct') return {entry: 'sidebarInputFieldHorizontalLayout', args: [null, insetX, maxWidth], frameFrom: sidebarCall(context)}
    const [, contentLeft, contentRight, topSidebarLeft] = context
    const zero = rect(0, 0)
    const frame: Value = {state: 'sidebar-closed', nav: zero, input: zero, topSidebar: rect(topSidebarLeft, topSidebarLeft), inputTray: zero, content: rect(contentLeft, contentRight), sidebar: zero, rightStrip: zero}
    return {entry: 'sidebarInputFieldHorizontalLayout', args: [frame, insetX, maxWidth], frameFrom: null}
  }
  const head = example[0]
  switch (family) {
    case 'pageframe-small':
      if (typeof head !== 'string') throw new Error(`a pageframe-small input starts with its helper's name: ${JSON.stringify(example)}`)
      return {entry: head, args: example.slice(1), frameFrom: null}
    case 'mobile': return {entry: 'mobilePageFrame', args: example, frameFrom: null}
    case 'composer': return {entry: 'mobileComposerGeometry', args: [{inputBarHeight: example[0], safeAreaBottom: example[1]}], frameFrom: null}
    case 'app': return {entry: 'appLayoutGeometry', args: [{x: example[0], y: example[1]}, example[2], example[3], example[4]], frameFrom: null}
    case 'sidebar': return {...sidebarCall(example), frameFrom: null}
    default: throw new Error(`no harness adapter for the sweep family ${family}`)
  }
}
