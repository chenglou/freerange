// Replay adapter for the packing family: turns an input recorded by the dense sweep (S/experiments/packing/sweep/sweep.ts),
// which records each evaluation as a named record per sweep section, into an entry call. It is used only to replay
// recorded catches this run missed; no input the lattice generates passes through it. Both copies share these signatures.
//   clamp    {origin, size, nearEdge, farEdge}                          clampOrigin(origin, size, nearEdge, farEdge)
//   rows     {width, gapX, gapY, sizes}                                 packRows(sizes, width, gapX, gapY)
//   grid     {fn: 'equalColumnWidth', width, columns, gap}              equalColumnWidth(width, columns, gap)
//            {fn: 'gridLayout', itemCount, columns, cellWidth, cellHeight, gap}
//            {fn: 'gridHeight', itemCount, columns, cellHeight, gap}
//   card     {fn: 'masonryCardHeight', columnWidth, jobWidth, jobHeight}
//            {fn: 'masonryStyleCardHeight', columnWidth, jobWidth, jobHeight, infoHeight}
//   masonry  {fn: 'masonryColumnCount', styleTab, mobile, containerInnerSizeX, documentSizeX}
//                                                                       masonryColumnCount(styleTab, mobile, W, W, documentSizeX)
//            {fn: 'packMasonry', cols, containerInnerX, containerInnerSizeX, gap, scrollY, containerSizeY, mobile, items}
//                                                                       packMasonry(items, cols, x0, W, gap, 64, scrollY, containerSizeY, mobile)
// The sweep passes the container width as naturalInnerSizeX too, and imagesGapTop 64 (sweep.ts:302, :324).
import type {Value} from './domain.ts'

const SWEEP_IMAGES_GAP_TOP = 64

function field(input: Record<string, Value>, name: string): Value {
  if (!(name in input)) throw new Error(`recorded input has no field ${name}: ${JSON.stringify(input)}`)
  return input[name]
}

/** The entry a recorded sweep input drives, and its arguments. `section` is the sweep section, e.g. `grid`. */
export function packingHarnessCall(section: string, input: Record<string, Value>): {entry: string; args: Value[]} {
  const get = (name: string) => field(input, name)
  if (section === 'clamp') return {entry: 'clampOrigin', args: [get('origin'), get('size'), get('nearEdge'), get('farEdge')]}
  if (section === 'rows') return {entry: 'packRows', args: [get('sizes'), get('width'), get('gapX'), get('gapY')]}
  const helper = get('fn')
  switch (helper) {
    case 'equalColumnWidth': return {entry: helper, args: [get('width'), get('columns'), get('gap')]}
    case 'gridLayout': return {entry: helper, args: [get('itemCount'), get('columns'), get('cellWidth'), get('cellHeight'), get('gap')]}
    case 'gridHeight': return {entry: helper, args: [get('itemCount'), get('columns'), get('cellHeight'), get('gap')]}
    case 'masonryCardHeight': return {entry: helper, args: [get('columnWidth'), get('jobWidth'), get('jobHeight')]}
    case 'masonryStyleCardHeight': return {entry: helper, args: [get('columnWidth'), get('jobWidth'), get('jobHeight'), get('infoHeight')]}
    case 'masonryColumnCount': return {entry: helper, args: [get('styleTab'), get('mobile'), get('containerInnerSizeX'), get('containerInnerSizeX'), get('documentSizeX')]}
    case 'packMasonry': return {entry: helper, args: [get('items'), get('cols'), get('containerInnerX'), get('containerInnerSizeX'), get('gap'), SWEEP_IMAGES_GAP_TOP, get('scrollY'), get('containerSizeY'), get('mobile')]}
    default: throw new Error(`no packing harness adapter for section ${section}, helper ${JSON.stringify(helper)}`)
  }
}
