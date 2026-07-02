import type {BlockID, SiteID, ValueID} from './ids.ts'
import type {InstructionIR, TerminatorIR} from './instructions.ts'

type ParameterIR = {
  value: ValueID
  name: string
  type: ValueTypeIR
}

export type ValueTypeIR =
  | {kind: 'number'}
  | {kind: 'object'; properties: string[]}

// UTF-16 offsets into the analyzed source, from ts.Node.getStart/getEnd. Line and column
// are computed only at message-formatting time. Spans may repeat across sites (the constant 1
// and the add that `count++` lowers to share a span); identity is the SiteID, never the span.
export type SourceSpan = {
  start: number
  end: number
}

export type BlockIR = {
  // Non-null exactly on loop headers. The site spans the whole loop statement, so a
  // non-converging analysis is reported on the loop, not on a back-edge jump.
  loopHeader: SiteID | null
  parameters: ValueID[]
  instructions: InstructionIR[]
  terminator: TerminatorIR
}

export type FunctionIR = {
  name: string
  parameters: ParameterIR[]
  entry: BlockID
  blocks: BlockIR[]
}

export type ProgramIR = {
  file: string
  // Offset of each line's first character, copied from ts.SourceFile.getLineStarts(), so
  // locations can be formatted after the TypeScript objects are gone (analyzeSource inputs
  // never exist on disk, so re-reading the file is not an option).
  lineStarts: number[]
  // Indexed by SiteID. Push-only during lowering, immutable afterward.
  sites: SourceSpan[]
  functions: FunctionIR[]
}

// 1-based line and column of a site's start offset.
export function siteLocation(program: ProgramIR, site: SiteID): {line: number; column: number} {
  const span = program.sites[site]
  if (span == null) throw new Error(`Unknown site ${site}`)
  const lineStarts = program.lineStarts
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (lineStarts[middle]! <= span.start) low = middle
    else high = middle - 1
  }
  return {line: low + 1, column: span.start - lineStarts[low]! + 1}
}
