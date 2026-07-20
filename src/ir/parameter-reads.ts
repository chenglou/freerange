import type {ValueID} from './ids.ts'
import {forEachOperand, type EdgeIR} from './instructions.ts'
import type {DeclaredKind, FiniteInputIR, FunctionIR} from './program.ts'

type ReadableFunction = Pick<FunctionIR, 'parameters' | 'blocks'>
type ParameterRead = {parameter: number; properties: string[]}
export type BlockUsage = {instructions: number; terminator: boolean; edges: EdgeIR[]}
export type ForwardedInputRead = {value: ValueID; properties: string[]}

export function addForwardedInputRead(reads: ForwardedInputRead[], candidate: ForwardedInputRead): void {
  if (!reads.some(read => read.value === candidate.value && samePath(read.properties, candidate.properties))) {
    reads.push(candidate)
  }
}

// Which paths from each parameter the function consumes. A property projection extends
// the path; any other use consumes it. When a value escapes or crosses a block parameter,
// the current path stands for everything below it, which errs toward reporting too much
// boundary trust rather than hiding trust that a result depends on.
export function parameterReadPaths(fn: ReadableFunction, usage?: Array<BlockUsage | null>): string[][][] {
  const tracked: Array<ParameterRead | undefined> = []
  for (let index = 0; index < fn.parameters.length; index++) {
    tracked[fn.parameters[index]!.value] = {parameter: index, properties: []}
  }
  let changed = true
  while (changed) {
    changed = false
    for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
      const block = fn.blocks[blockIndex]!
      const used = usage?.[blockIndex]
      if (usage != null && used == null) continue
      const instructionCount = used?.instructions ?? block.instructions.length
      for (let index = 0; index < instructionCount; index++) {
        const instruction = block.instructions[index]!
        if (instruction.kind !== 'property' || tracked[instruction.result] != null) continue
        const base = tracked[instruction.object]
        if (base == null) continue
        tracked[instruction.result] = {
          parameter: base.parameter,
          properties: [...base.properties, instruction.property],
        }
        changed = true
      }
    }
  }

  const reads: string[][][] = fn.parameters.map(() => [])
  const mark = (value: ValueID): void => {
    const read = tracked[value]
    if (read != null) reads[read.parameter]!.push(read.properties)
  }
  for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
    const block = fn.blocks[blockIndex]!
    const used = usage?.[blockIndex]
    if (usage != null && used == null) continue
    const instructionCount = used?.instructions ?? block.instructions.length
    for (let index = 0; index < instructionCount; index++) {
      const instruction = block.instructions[index]!
      switch (instruction.kind) {
        case 'property':
        case 'tagCheck':
          break
        default:
          forEachOperand(instruction, mark)
      }
    }
    if (used?.terminator === false) continue
    const terminator = block.terminator
    switch (terminator.kind) {
      case 'return':
        if (terminator.value != null) mark(terminator.value)
        break
      case 'jump':
        for (const argument of terminator.target.arguments) mark(argument)
        break
      case 'branch':
        mark(terminator.condition)
        for (const argument of terminator.whenTrue.arguments) mark(argument)
        for (const argument of terminator.whenFalse.arguments) mark(argument)
        break
      case 'stop':
      case 'thrown':
        break
    }
  }
  return reads
}

// Reading either side of a path boundary keeps the declared condition: reading `box`
// may consume `box.width`, while reading `box.width` rests on the shape of `box`.
export function pathWasRead(reads: string[][], properties: string[]): boolean {
  return reads.some(read => {
    const shared = Math.min(read.length, properties.length)
    for (let index = 0; index < shared; index++) {
      if (read[index] !== properties[index]) return false
    }
    return true
  })
}

// Plain numbers and required fields of fixed records become caller requirements when
// consumed. Literal-number types are already finite. Arrays, tuples, nullable values,
// and tagged unions retain their existing assumptions because one unconditional property
// path cannot describe their numeric leaves honestly.
export function finiteInputPaths(
  fn: ReadableFunction,
  usage?: Array<BlockUsage | null>,
  forwardedReads: ForwardedInputRead[] = [],
): FiniteInputIR[] {
  const candidates: FiniteInputIR[] = []
  const visit = (parameter: number, declared: DeclaredKind, properties: string[]): void => {
    switch (declared.kind) {
      case 'number':
        if (declared.interval == null) candidates.push({
          parameter,
          properties,
          site: fn.parameters[parameter]!.site,
        })
        return
      case 'record':
        for (const property of declared.properties) {
          visit(parameter, property.declared, [...properties, property.name])
        }
        return
      case 'boolean':
      case 'opaque':
      case 'nullish':
      case 'tuple':
      case 'array':
      case 'taggedUnion':
        return
    }
  }
  for (let parameter = 0; parameter < fn.parameters.length; parameter++) {
    visit(parameter, fn.parameters[parameter]!.type, [])
  }
  if (usage == null) return candidates
  return consumedFiniteInputs(fn, usage, candidates, forwardedReads)
}

// Unlike assumption reporting, hard requirements cannot conservatively count escapes as
// reads. Start at calculations and exact fields consumed by calls, then walk backward
// through property reads, fresh objects, and only the block edges the evaluator took.
// Repeated syntax in a loop is visited once per walk, so recursive object shapes cannot
// manufacture ever-longer paths during analysis.
function consumedFiniteInputs(
  fn: ReadableFunction,
  usage: Array<BlockUsage | null>,
  candidates: FiniteInputIR[],
  forwardedReads: ForwardedInputRead[],
): FiniteInputIR[] {
  const parameterByValue: Array<number | undefined> = []
  for (let parameter = 0; parameter < fn.parameters.length; parameter++) {
    parameterByValue[fn.parameters[parameter]!.value] = parameter
  }
  const instructionByValue: Array<FunctionIR['blocks'][number]['instructions'][number] | undefined> = []
  const incomingByValue: Array<ValueID[] | undefined> = []
  for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
    const block = fn.blocks[blockIndex]!
    for (const instruction of block.instructions) instructionByValue[instruction.result] = instruction
    const used = usage[blockIndex]
    if (used == null) continue
    for (const edge of used.edges) {
      const target = fn.blocks[edge.block]
      if (target == null || target.parameters.length !== edge.arguments.length) continue
      for (let index = 0; index < edge.arguments.length; index++) {
        const parameter = target.parameters[index]!
        incomingByValue[parameter] = [...(incomingByValue[parameter] ?? []), edge.arguments[index]!]
      }
    }
  }

  const consumed: boolean[] = []
  const depthByValue: Array<number | undefined> = []
  const propertyDepth = (value: ValueID): number => {
    const known = depthByValue[value]
    if (known != null) return known
    const producer = instructionByValue[value]
    const depth = producer?.kind === 'property' ? 1 + propertyDepth(producer.object) : 0
    depthByValue[value] = depth
    return depth
  }
  let maximumPathLength = 0
  for (const candidate of candidates) maximumPathLength = Math.max(maximumPathLength, candidate.properties.length)
  for (const read of forwardedReads) maximumPathLength = Math.max(maximumPathLength, read.properties.length)
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      maximumPathLength = Math.max(maximumPathLength, propertyDepth(instruction.result))
    }
  }

  const markPath = (value: ValueID, properties: string[], visiting = new Set<string>()): void => {
    if (properties.length > maximumPathLength) return
    const key = `${value}:${JSON.stringify(properties)}`
    if (visiting.has(key)) return
    const parameter = parameterByValue[value]
    if (parameter != null) {
      for (let candidate = 0; candidate < candidates.length; candidate++) {
        const input = candidates[candidate]!
        if (input.parameter === parameter && samePath(input.properties, properties)) consumed[candidate] = true
      }
      return
    }
    const nextVisiting = new Set(visiting)
    nextVisiting.add(key)
    for (const incoming of incomingByValue[value] ?? []) markPath(incoming, properties, nextVisiting)
    const producer = instructionByValue[value]
    if (producer?.kind === 'moduleWrite') {
      markPath(producer.value, properties, nextVisiting)
      return
    }
    if (producer?.kind === 'property') {
      markPath(producer.object, [producer.property, ...properties], nextVisiting)
      return
    }
    if (producer?.kind === 'object') {
      const [property, ...rest] = properties
      if (property == null) return
      const field = producer.properties.find(candidate => candidate.name === property)
      if (field != null) markPath(field.value, rest, nextVisiting)
    }
  }
  const mark = (value: ValueID): void => markPath(value, [])
  for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
    const block = fn.blocks[blockIndex]!
    const used = usage[blockIndex]
    if (used == null) continue
    for (let index = 0; index < used.instructions; index++) {
      const instruction = block.instructions[index]!
      switch (instruction.kind) {
        case 'property':
        case 'tagCheck':
        case 'call':
        case 'object':
          break
        default:
          forEachOperand(instruction, mark)
      }
    }
    if (!used.terminator) continue
    const terminator = block.terminator
    if (terminator.kind === 'return' && terminator.value != null) mark(terminator.value)
    if (terminator.kind === 'branch') mark(terminator.condition)
  }
  for (const read of forwardedReads) markPath(read.value, read.properties)
  return candidates.filter((_, index) => consumed[index] === true)
}

export function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}
