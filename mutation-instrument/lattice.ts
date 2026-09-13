// lattice@v1: the input sequence of one entry, addressable by index. Forked from the replay input-range prototype's
// phases (cli.ts `inputs`) and structured generation (domain.ts `generate`), with a small-scope phase in front:
//   P0 inputs 0 .. p0-1: every number leaf from its small values, e.g. {0, 1, 2}
//   P1 every candidate of every leaf, the other leaves drawn
//   P2 the full candidate product, when it's small and the domain has no union
//   P3 random draws
// Input i is generated from its own random stream, so the parent and every child regenerate identical inputs.
import {drawNumber, numberInDomain, numberSources, type Comparison, type Domain, type NumberDomain, type NumberSources, type Scalar, type TupleDomain, type Value} from './domain.ts'
import {inputRandom, nextDown, nextIndex, nextUp, type Random} from './random.ts'
import type {EntryPlan, LatticeSettings, Path} from './types.ts'

// Leaves are numbered depth-first: numbers, choices and arrays (an array's leaf is its length). Array elements are
// never fixed, so their nodes carry leaf -1.
type GenNode =
  | {kind: 'number'; leaf: number; domain: NumberDomain; sources: NumberSources}
  | {kind: 'choice'; leaf: number; values: Scalar[]}
  | {kind: 'array'; leaf: number; element: GenNode; maxLength: number}
  | {kind: 'record'; fields: {name: string; node: GenNode}[]}
  | {kind: 'tuple'; elements: GenNode[]}
  | {kind: 'union'; members: GenNode[]; memberLeafStarts: number[]; memberLeafEnds: number[]}

type Relation = {left: Path; op: Comparison; right: Path; leftDomains: NumberDomain[]; rightDomains: NumberDomain[]}

export type Lattice = {
  ordinal: number
  settings: LatticeSettings
  root: GenNode
  leafCounts: number[] // candidates per leaf
  relations: Relation[]
  phases: {p0: number; p1: number; p2: number}
  fixed: Int32Array // scratch: the fixed candidate per leaf for the input being generated, -1 when drawn
}

function compile(domain: Domain, counter: {leaf: number}, inArray: boolean): GenNode {
  switch (domain.kind) {
    case 'number': return {kind: 'number', leaf: inArray ? -1 : counter.leaf++, domain, sources: numberSources(domain)}
    case 'choice': return {kind: 'choice', leaf: inArray ? -1 : counter.leaf++, values: domain.values}
    case 'array': {
      const leaf = inArray ? -1 : counter.leaf++
      return {kind: 'array', leaf, element: compile(domain.element, {leaf: 0}, true), maxLength: domain.maxLength}
    }
    case 'record': return {kind: 'record', fields: domain.fields.map((field) => ({name: field.name, node: compile(field.domain, counter, inArray)}))}
    case 'tuple': return {kind: 'tuple', elements: domain.elements.map((element) => compile(element, counter, inArray))}
    case 'union': {
      const members: GenNode[] = []
      const memberLeafStarts: number[] = []
      const memberLeafEnds: number[] = []
      for (const member of domain.members) {
        memberLeafStarts.push(counter.leaf)
        members.push(compile(member, counter, inArray))
        memberLeafEnds.push(counter.leaf)
      }
      return {kind: 'union', members, memberLeafStarts, memberLeafEnds}
    }
  }
}

function collectLeafCounts(node: GenNode, output: number[]) {
  switch (node.kind) {
    case 'number': if (node.leaf >= 0) output[node.leaf] = node.sources.candidates.length; break
    case 'choice': if (node.leaf >= 0) output[node.leaf] = node.values.length; break
    case 'array': if (node.leaf >= 0) output[node.leaf] = node.maxLength + 1; break
    case 'record': for (const field of node.fields) collectLeafCounts(field.node, output); break
    case 'tuple': for (const element of node.elements) collectLeafCounts(element, output); break
    case 'union': for (const member of node.members) collectLeafCounts(member, output); break
  }
}

function hasUnion(domain: Domain): boolean {
  switch (domain.kind) {
    case 'union': return true
    case 'record': return domain.fields.some((field) => hasUnion(field.domain))
    case 'tuple': return domain.elements.some(hasUnion)
    case 'number': case 'choice': case 'array': return false
  }
}

function leafDomains(domain: Domain, path: Path): Domain[] {
  if (path.length === 0) return [domain]
  const [head, ...rest] = path
  switch (domain.kind) {
    case 'union': return domain.members.flatMap((member) => leafDomains(member, path))
    case 'record': {
      const field = domain.fields.find((candidate) => candidate.name === head)
      return field == null ? [] : leafDomains(field.domain, rest)
    }
    case 'tuple': {
      const element = typeof head === 'number' ? domain.elements[head] : undefined
      return element == null ? [] : leafDomains(element, rest)
    }
    case 'number': case 'choice': case 'array': return []
  }
}

export function numberLeaves(args: TupleDomain, path: Path): NumberDomain[] {
  return leafDomains(args, path).filter((domain): domain is NumberDomain => domain.kind === 'number')
}

export function compileLattice(entry: EntryPlan, settings: LatticeSettings): Lattice {
  const counter = {leaf: 0}
  const root = compile(entry.args, counter, false)
  const leafCounts: number[] = []
  collectLeafCounts(root, leafCounts)
  const p0 = Math.min(settings.p0Inputs, settings.budget)
  let p1 = 0
  for (const count of leafCounts) p1 += count
  p1 = Math.min(p1, settings.budget - p0)
  let product = 1
  for (const count of leafCounts) product *= count
  const p2 = !hasUnion(entry.args) && product <= settings.p2ProductMax ? Math.min(product, settings.budget - p0 - p1) : 0
  const relations = entry.relations.map((relation) => ({...relation, leftDomains: numberLeaves(entry.args, relation.left), rightDomains: numberLeaves(entry.args, relation.right)}))
  return {ordinal: entry.ordinal, settings, root, leafCounts, relations, phases: {p0, p1, p2}, fixed: new Int32Array(leafCounts.length)}
}

function generate(random: Random, node: GenNode, fixed: Int32Array, small: boolean): Value {
  switch (node.kind) {
    case 'number': {
      const candidate = node.leaf >= 0 ? fixed[node.leaf]! : -1
      if (candidate >= 0) return node.sources.candidates[candidate]!
      if (small) return node.sources.small[nextIndex(random, node.sources.small.length)]!
      return drawNumber(random, node.domain, node.sources)
    }
    case 'choice': {
      const candidate = node.leaf >= 0 ? fixed[node.leaf]! : -1
      return node.values[candidate >= 0 ? candidate : nextIndex(random, node.values.length)]
    }
    case 'array': {
      const candidate = node.leaf >= 0 ? fixed[node.leaf]! : -1
      const length = candidate >= 0 ? candidate : nextIndex(random, small ? Math.min(3, node.maxLength + 1) : node.maxLength + 1)
      const result: Value[] = []
      for (let index = 0; index < length; index++) result.push(generate(random, node.element, fixed, small))
      return result
    }
    case 'record': {
      const result: Record<string, Value> = {}
      for (const field of node.fields) result[field.name] = generate(random, field.node, fixed, small)
      return result
    }
    case 'tuple': {
      const result: Value[] = []
      for (const element of node.elements) result.push(generate(random, element, fixed, small))
      return result
    }
    case 'union': {
      // The member that owns a fixed leaf, else a random member.
      let chosen = nextIndex(random, node.members.length)
      for (let member = 0; member < node.members.length; member++) {
        for (let leaf = node.memberLeafStarts[member]!; leaf < node.memberLeafEnds[member]!; leaf++) if (fixed[leaf]! >= 0) chosen = member
      }
      return generate(random, node.members[chosen]!, fixed, small)
    }
  }
}

export type Input = {producer: number; args: Value[]}

/** Input `index` of the entry: the producer (0-3 for P0-P3) and the arguments, after relation repair. */
export function inputAt(lattice: Lattice, index: number): Input {
  const {phases, fixed, leafCounts} = lattice
  const random = inputRandom(lattice.settings.seed, lattice.ordinal, index)
  fixed.fill(-1)
  let producer: number
  if (index < phases.p0) {
    producer = 0
  } else if (index < phases.p0 + phases.p1) {
    producer = 1
    let rest = index - phases.p0
    for (let leaf = 0; leaf < leafCounts.length; leaf++) {
      if (rest < leafCounts[leaf]!) {
        fixed[leaf] = rest
        break
      }
      rest -= leafCounts[leaf]!
    }
  } else if (index < phases.p0 + phases.p1 + phases.p2) {
    producer = 2
    let rest = index - phases.p0 - phases.p1
    for (let leaf = 0; leaf < leafCounts.length; leaf++) {
      fixed[leaf] = rest % leafCounts[leaf]!
      rest = Math.floor(rest / leafCounts[leaf]!)
    }
  } else {
    producer = 3
  }
  const args = generate(random, lattice.root, fixed, producer === 0) as Value[]
  repairRelations(args, lattice.relations)
  return {producer, args}
}

// -- Relation repair (input-range analyze.ts, unchanged) ---------------------

function readPath(args: Value[], path: Path): Value {
  let value: Value = args
  for (const segment of path) {
    if (value == null || typeof value !== 'object') return undefined
    value = (value as Record<string | number, Value>)[segment]
  }
  return value
}

function writePath(args: Value[], path: Path, next: number) {
  let value: Value = args
  for (const segment of path.slice(0, -1)) value = (value as Record<string | number, Value>)[segment]
  ;(value as Record<string | number, Value>)[path[path.length - 1]!] = next
}

function holds(left: number, op: Comparison, right: number) {
  switch (op) {
    case '<': return left < right
    case '<=': return left <= right
    case '>': return left > right
    case '>=': return left >= right
    case '===': return left === right
    case '!==': return left !== right
  }
}

function fits(domains: NumberDomain[], value: number) {
  return domains.some((domain) => numberInDomain(domain, value))
}

/** Moves a drawn input toward satisfying `a <= b`-style leading asserts: swap, or copy one side into the other. */
function repairRelations(args: Value[], relations: Relation[]) {
  for (const relation of relations) {
    const left = readPath(args, relation.left)
    const right = readPath(args, relation.right)
    if (typeof left !== 'number' || typeof right !== 'number' || holds(left, relation.op, right)) continue
    const attempts: [number, number][] = [[right, left], [right, right], [left, left]]
    if (relation.op === '<' || relation.op === '>') attempts.push([nextDown(right), right], [left, nextUp(left)])
    for (const [nextLeft, nextRight] of attempts) {
      if (holds(nextLeft, relation.op, nextRight) && fits(relation.leftDomains, nextLeft) && fits(relation.rightDomains, nextRight)) {
        writePath(args, relation.left, nextLeft)
        writePath(args, relation.right, nextRight)
        break
      }
    }
  }
}

// -- Digest -----------------------------------------------------------------

const digestFloat = new Float64Array(1)
const digestWords = new Uint32Array(digestFloat.buffer)

function mix(digest: number, word: number) {
  return Math.imul(digest ^ word, 16777619) >>> 0
}

/** Folds a value into a running FNV-style digest; identical values in any process give identical digests. */
export function digestValue(digest: number, value: Value): number {
  if (typeof value === 'number') {
    digestFloat[0] = value
    return mix(mix(mix(digest, 1), digestWords[0]!), digestWords[1]!)
  }
  if (typeof value === 'boolean') return mix(digest, value ? 2 : 3)
  if (value === null) return mix(digest, 4)
  if (value === undefined) return mix(digest, 5)
  if (typeof value === 'string') {
    let result = mix(digest, 6)
    for (let index = 0; index < value.length; index++) result = mix(result, value.charCodeAt(index))
    return result
  }
  if (Array.isArray(value)) {
    let result = mix(mix(digest, 7), value.length)
    for (const element of value) result = digestValue(result, element)
    return result
  }
  let result = mix(digest, 8)
  for (const key of Object.keys(value)) result = digestValue(digestValue(result, key), value[key])
  return result
}

export const DIGEST_START = 2166136261
