import type * as ts from 'typescript'
import type {
  BlockID,
  FunctionID,
  SiteID,
  ValueID,
} from '../ir/ids.ts'
import type {InstructionIR, TerminatorIR} from '../ir/instructions.ts'
import type {FunctionIR, SourceSpan, UnsupportedReason} from '../ir/program.ts'

export type MutableBlock = {
  loopHeader: SiteID | null
  parameters: ValueID[]
  instructions: InstructionIR[]
  terminator: TerminatorIR | null
}

export type FunctionContext = {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
  functionsBySymbol: Map<ts.Symbol, FunctionID>
  // The ProgramIR.sites table, shared across all function lowerings; pushing assigns the
  // next dense SiteID.
  sites: SourceSpan[]
  nextValue: number
  currentBlock: MutableBlock
  blocks: MutableBlock[]
  bindings: Map<ts.Symbol, ValueID>
  parameters: FunctionIR['parameters']
}

export function addSite(context: FunctionContext, node: ts.Node): SiteID {
  context.sites.push({start: node.getStart(context.sourceFile), end: node.getEnd()})
  return context.sites.length - 1
}

type WithoutResultAndSite<T> = T extends unknown ? Omit<T, 'result' | 'site'> : never
type InstructionInput = WithoutResultAndSite<InstructionIR>

// Every caller passes the AST node the instruction was lowered from. Desugared helpers
// (the constant 0 in `-x`, the constant 1 in `count++`) pass the enclosing node:
// distinct SiteIDs, shared span.
export function addInstruction(context: FunctionContext, node: ts.Node, instruction: InstructionInput): ValueID {
  const result = context.nextValue++
  const site = addSite(context, node)
  context.currentBlock.instructions.push({...instruction, result, site} as InstructionIR)
  return result
}

export function createBlock(context: FunctionContext, parameterCount = 0, loopHeader: SiteID | null = null): BlockID {
  const parameters: ValueID[] = []
  for (let index = 0; index < parameterCount; index++) parameters.push(context.nextValue++)
  const block: MutableBlock = {loopHeader, parameters, instructions: [], terminator: null}
  context.blocks.push(block)
  return context.blocks.length - 1
}

export function terminate(block: MutableBlock, terminator: TerminatorIR): void {
  if (block.terminator != null) throw new Error('IR block already has a terminator')
  block.terminator = terminator
}

export function requiredSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol {
  const symbol = checker.getSymbolAtLocation(node)
  if (symbol == null) throw unsupported(node, {kind: 'missingSymbol'})
  return symbol
}

export function requiredBinding(symbol: ts.Symbol, node: ts.Identifier, context: FunctionContext): ValueID {
  const value = context.bindings.get(symbol)
  if (value == null) throw unsupported(node, {kind: 'unknownIdentifier', name: node.text})
  return value
}

export function changedBindings(
  before: Map<ts.Symbol, ValueID>,
  whenTrue: Map<ts.Symbol, ValueID>,
  whenFalse: Map<ts.Symbol, ValueID>,
): ts.Symbol[] {
  const changed: ts.Symbol[] = []
  for (const [symbol, value] of before) {
    if (requiredBranchBinding(symbol, whenTrue) !== value || requiredBranchBinding(symbol, whenFalse) !== value) {
      changed.push(symbol)
    }
  }
  return changed
}

export function bindingsVisibleAfterBranch(
  before: Map<ts.Symbol, ValueID>,
  branch: Map<ts.Symbol, ValueID>,
): Map<ts.Symbol, ValueID> {
  const visible = new Map(before)
  for (const symbol of before.keys()) visible.set(symbol, requiredBranchBinding(symbol, branch))
  return visible
}

export function requiredBranchBinding(symbol: ts.Symbol, bindings: Map<ts.Symbol, ValueID>): ValueID {
  const value = bindings.get(symbol)
  if (value == null) throw new Error(`Missing binding ${symbol.name} after branch`)
  return value
}

// Thrown when lowering meets a construct outside the accepted subset. Caught at exactly one
// place — the per-function loop in lowerSource — which discards the whole in-progress
// FunctionContext and records an UnsupportedFunctionIR. No other try/catch may exist under
// src/lower (a mid-lowering catch would silently truncate bodies), and nothing outside
// src/lower may see this class. Extends Error only so an accidentally escaping stop has a
// stack trace; the message is never parsed or matched.
export class LoweringStop extends Error {
  readonly node: ts.Node
  readonly reason: UnsupportedReason

  constructor(node: ts.Node, reason: UnsupportedReason) {
    super(`Lowering stopped: ${reason.kind}`)
    this.node = node
    this.reason = reason
  }
}

// Carrying the node (not a minted SiteID) means throw sites without a FunctionContext, like
// requiredSymbol, need no plumbing; the SiteID is minted at the catch in lowerSource.
export function unsupported(node: ts.Node, reason: UnsupportedReason): LoweringStop {
  return new LoweringStop(node, reason)
}
