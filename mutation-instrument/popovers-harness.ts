// Replay adapter for the popovers family: turns an input recorded by the dense sweep (S/experiments/popovers/sweep.ts),
// which names its inputs per helper, into the entry's argument list for one copy's signatures. It is used only to replay
// recorded catches this run missed; no input the lattice generates passes through it.
//   contracts/ and contracts+K7T5b: menuPosition(anchor, panel, viewport, placement, offset, mobile)
//   reshaped/:                      menuPosition(anchor, panel, viewport, placement, offset[0], offset[1], mobile)
import type {Value} from './domain.ts'

export type HarnessSignature = 'contracts' | 'reshaped'

type Recorded = Record<string, Value>

function field(input: Recorded, name: string): Value {
  if (!(name in input)) throw new Error(`recorded input has no field ${name}: ${JSON.stringify(input)}`)
  return input[name]
}

/** The entry a sweep helper drives, and its arguments. */
export function harnessCall(helper: string, signature: HarnessSignature, input: Recorded): {entry: string; args: Value[]} {
  const get = (name: string) => field(input, name)
  switch (helper) {
    case 'clampOrigin': return {entry: 'clampOrigin', args: [get('origin'), get('size'), get('near'), get('far')]}
    case 'menuPosition': {
      const offset = get('offset') as Value[]
      const common = [get('anchor'), get('panel'), get('viewport'), get('placement')]
      return {entry: 'menuPosition', args: signature === 'contracts' ? [...common, offset, get('mobile')] : [...common, offset[0], offset[1], get('mobile')]}
    }
    case 'menuHoverCorridor': return {entry: 'menuHoverCorridorProperties', args: [get('exit'), get('anchor'), get('panel'), get('t')]}
    case 'menuPanelWidth': return {entry: 'menuPanelWidth', args: [get('vw'), get('natural'), get('padding'), get('minimum'), get('maximum'), get('mobile')]}
    case 'menuItemColumns': return {entry: 'menuItemColumns', args: [get('rowWidth'), get('inset'), get('icon'), get('trailing'), get('gap')]}
    case 'menuRowHeight': return {entry: 'menuRowHeight', args: [get('minimum'), get('lineCount'), get('lineHeight'), get('descriptionLines'), get('descriptionLineHeight'), get('insetY')]}
    case 'menuScrollHeight': return {entry: 'menuScrollHeight', args: [get('vh'), get('natural'), get('maximum')]}
    // The sweep passes its input object itself; JSON dropped `anchor: undefined`, which reads the same.
    case 'tooltipPosition': return {entry: 'tooltipPosition', args: [input]}
    case 'personalizePopupFrame': return {entry: 'personalizePopupFrame', args: [get('viewport'), get('safeArea'), get('wide')]}
    case 'coachmarkLayout': return {entry: 'coachmarkLayout', args: [get('containerWidth')]}
    default: throw new Error(`no harness adapter for helper ${helper}`)
  }
}
