import type {BlockID, ValueID} from '../ir/ids.ts'
import type {FunctionIR} from '../ir/program.ts'

// The static CFG facts join maintenance consults (static-relations mode), built once per
// evaluation. Every loop below visits each block or edge a fixed number of times, so the
// whole construction is linear in the function's blocks and edges, except the
// dominator-tree walks in `intersect`, which move strictly toward the entry.
export type JoinFlow = {
  // Every value's producing block (block parameters included); function parameters have none.
  blockOfValue: Array<BlockID | undefined>
  // The arguments of every static CFG edge into each block.
  incomingArguments: ValueID[][]
  // Per block, one argument list per static CFG edge into it, in parameter order.
  incomingEdges: ValueID[][][]
  // A block parameter's position in its block's parameter list; undefined for other values.
  blockParameterIndex: Array<number | undefined>
  // The function's own parameter values.
  functionParameters: ValueID[]
  // Every value the function defines, ascending: function parameters, block parameters and
  // instruction results.
  values: ValueID[]
  dominance: BlockDominance
  // Whether a block lies on a cycle of static CFG edges.
  cyclic: boolean[]
}

export function createJoinFlow(fn: FunctionIR, successors: BlockID[][]): JoinFlow {
  const blockOfValue: Array<BlockID | undefined> = []
  const incomingArguments: ValueID[][] = fn.blocks.map(() => [])
  const incomingEdges: ValueID[][][] = fn.blocks.map(() => [])
  const blockParameterIndex: Array<number | undefined> = []
  const functionParameters = fn.parameters.map(parameter => parameter.value)
  const values: ValueID[] = [...functionParameters]
  for (let blockID = 0; blockID < fn.blocks.length; blockID++) {
    const block = fn.blocks[blockID]!
    for (let index = 0; index < block.parameters.length; index++) {
      const parameter = block.parameters[index]!
      blockOfValue[parameter] = blockID
      blockParameterIndex[parameter] = index
      values.push(parameter)
    }
    for (const instruction of block.instructions) {
      blockOfValue[instruction.result] = blockID
      values.push(instruction.result)
    }
    switch (block.terminator.kind) {
      case 'jump':
        incomingArguments[block.terminator.target.block]!.push(...block.terminator.target.arguments)
        incomingEdges[block.terminator.target.block]!.push(block.terminator.target.arguments)
        break
      case 'branch':
        incomingArguments[block.terminator.whenTrue.block]!.push(...block.terminator.whenTrue.arguments)
        incomingArguments[block.terminator.whenFalse.block]!.push(...block.terminator.whenFalse.arguments)
        incomingEdges[block.terminator.whenTrue.block]!.push(block.terminator.whenTrue.arguments)
        incomingEdges[block.terminator.whenFalse.block]!.push(block.terminator.whenFalse.arguments)
        break
      case 'return':
      case 'stop':
      case 'thrown':
        break
    }
  }
  values.sort((left, right) => left - right)
  return {
    blockOfValue,
    incomingArguments,
    incomingEdges,
    blockParameterIndex,
    functionParameters,
    values,
    dominance: blockDominance(successors, fn.entry),
    cyclic: cyclicBlocks(successors),
  }
}

export type BlockDominance = {
  // Whether the graph is reducible: every edge into an earlier block in reverse postorder
  // targets a block that dominates the edge's source. Lowered structured code always is.
  reducible: boolean
  // Whether every path from the entry to `block` passes `dominator` (a block dominates
  // itself). False for a block the entry cannot reach. For an irreducible graph only the
  // entry and the block itself are reported, which is true but incomplete.
  dominates: (dominator: BlockID, block: BlockID) => boolean
}

// Dominators in one pass, without a fixed-point iteration. Blocks are processed in reverse
// postorder, and each block's immediate dominator is the nearest common dominator-tree
// ancestor of its forward predecessors, those earlier in reverse postorder. That gives the
// dominators of the graph without its retreating edges. Those equal the full graph's
// dominators when every retreating edge u -> h has h dominating u: on any path that takes
// such an edge, the part before the edge already passed h, so cutting the cycle from h to h
// leaves a shorter path through a subset of the same blocks, and repeating that ends in a
// path with no retreating edge. When the check fails, only trivial dominance is reported.
export function blockDominance(successors: BlockID[][], entry: BlockID): BlockDominance {
  const order = depthFirstPostorder(successors, [entry]).reverse()
  const orderIndex: Array<number | undefined> = []
  for (let index = 0; index < order.length; index++) orderIndex[order[index]!] = index
  const predecessors: BlockID[][] = successors.map(() => [])
  for (const source of order) {
    for (const target of successors[source]!) predecessors[target]!.push(source)
  }
  const immediateDominator: BlockID[] = []
  immediateDominator[entry] = entry
  // A block's immediate dominator is earlier in reverse postorder than the block, so each
  // step of either inner loop strictly lowers an index.
  const intersect = (first: BlockID, second: BlockID): BlockID => {
    let left = first
    let right = second
    while (left !== right) {
      while (orderIndex[left]! > orderIndex[right]!) left = immediateDominator[left]!
      while (orderIndex[right]! > orderIndex[left]!) right = immediateDominator[right]!
    }
    return left
  }
  for (let index = 1; index < order.length; index++) {
    const block = order[index]!
    let dominator: BlockID | null = null
    for (const predecessor of predecessors[block]!) {
      if (orderIndex[predecessor]! >= index) continue
      dominator = dominator == null ? predecessor : intersect(predecessor, dominator)
    }
    // Every reachable block other than the entry has its depth-first tree parent as a
    // forward predecessor.
    immediateDominator[block] = dominator!
  }
  // Dominator-tree entry and exit times: `dominator` is an ancestor of `block` exactly when its
  // interval contains the block's.
  const children: BlockID[][] = successors.map(() => [])
  for (let index = 1; index < order.length; index++) children[immediateDominator[order[index]!]!]!.push(order[index]!)
  const entered: number[] = []
  const exited: number[] = []
  let clock = 0
  entered[entry] = clock++
  const stack: Array<{block: BlockID; next: number}> = [{block: entry, next: 0}]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    const child = children[top.block]![top.next]
    if (child != null) {
      top.next += 1
      entered[child] = clock++
      stack.push({block: child, next: 0})
    } else {
      exited[top.block] = clock++
      stack.pop()
    }
  }
  const treeAncestor = (dominator: BlockID, block: BlockID): boolean =>
    orderIndex[dominator] != null && orderIndex[block] != null
    && entered[dominator]! <= entered[block]! && exited[block]! <= exited[dominator]!
  let reducible = true
  for (const source of order) {
    for (const target of successors[source]!) {
      if (orderIndex[target]! <= orderIndex[source]! && !treeAncestor(target, source)) reducible = false
    }
  }
  return {
    reducible,
    dominates: reducible
      ? treeAncestor
      : (dominator, block) => orderIndex[block] != null && (dominator === entry || dominator === block),
  }
}

// Whether each block lies on a cycle: its strongly connected component has more than one
// block, or it has an edge to itself. Kosaraju's algorithm: a depth-first postorder over
// every block, then a search over reversed edges in reverse postorder, each block assigned once.
export function cyclicBlocks(successors: BlockID[][]): boolean[] {
  const postorder = depthFirstPostorder(successors, successors.map((_, block) => block))
  const predecessors: BlockID[][] = successors.map(() => [])
  for (let source = 0; source < successors.length; source++) {
    for (const target of successors[source]!) predecessors[target]!.push(source)
  }
  const component: Array<number | undefined> = []
  const componentSizes: number[] = []
  for (let index = postorder.length - 1; index >= 0; index--) {
    const start = postorder[index]!
    if (component[start] != null) continue
    const id = componentSizes.length
    componentSizes.push(0)
    component[start] = id
    const queue = [start]
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      componentSizes[id]! += 1
      for (const predecessor of predecessors[queue[queueIndex]!]!) {
        if (component[predecessor] != null) continue
        component[predecessor] = id
        queue.push(predecessor)
      }
    }
  }
  return successors.map((outgoing, block) => componentSizes[component[block]!]! > 1 || outgoing.includes(block))
}

// Postorder of every block reachable from `starts`, in start order, with an explicit stack:
// each block is pushed once and each of its edges is read once.
function depthFirstPostorder(successors: BlockID[][], starts: BlockID[]): BlockID[] {
  const postorder: BlockID[] = []
  const visited: boolean[] = []
  for (const start of starts) {
    if (visited[start] === true) continue
    visited[start] = true
    const stack: Array<{block: BlockID; next: number}> = [{block: start, next: 0}]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const successor = successors[top.block]![top.next]
      if (successor != null) {
        top.next += 1
        if (visited[successor] !== true) {
          visited[successor] = true
          stack.push({block: successor, next: 0})
        }
      } else {
        postorder.push(top.block)
        stack.pop()
      }
    }
  }
  return postorder
}
