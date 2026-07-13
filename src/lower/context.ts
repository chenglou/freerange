import type * as ts from 'typescript'
import type {
  BlockID,
  FunctionID,
  ModuleBindingID,
  SiteID,
  ValueID,
} from '../ir/ids.ts'
import type {InstructionIR, TerminatorIR} from '../ir/instructions.ts'
import {nodeSpan, type BlockIR, type FunctionIR, type SourceSpan, type UnsupportedReason} from '../ir/program.ts'
import type {StaticAnnotation} from './static-intrinsics.ts'

export type MutableBlock = {
  loopHeader: SiteID | null
  parameters: ValueID[]
  instructions: InstructionIR[]
  terminator: TerminatorIR | null
}

// A top-level function declaration and its index in ProgramIR.functions. The call arm
// keeps the declaration so omitted optional and literal-defaulted arguments can be filled
// before emitting the fixed-arity call instruction.
export type TopLevelFunction = {
  id: FunctionID
  declaration: ts.FunctionDeclaration
}

export type FunctionContext = {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>
  moduleBindingsBySymbol: Map<ts.Symbol, ModuleBindingID>
  staticAnnotations: StaticAnnotation[]
  // The ProgramIR.sites table, shared across all function lowerings; pushing assigns the
  // next dense SiteID.
  sites: SourceSpan[]
  nextValue: number
  currentBlock: MutableBlock
  blocks: MutableBlock[]
  bindings: Map<ts.Symbol, ValueID>
  parameters: FunctionIR['parameters']
  assertions: FunctionIR['assertions']
  // Innermost-last stack of enclosing loops, consulted by `continue`. A continue runs the
  // loop's advance step (a for loop's incrementor, the for-of counter bump; nothing for
  // while), then jumps to the header carrying the loop's carried bindings plus whatever
  // extra arguments the advance step returns (the for-of counter).
  loops: LoopTarget[]
}

export type LoopTarget = {
  header: BlockID
  carried: ts.Symbol[]
  advance: (context: FunctionContext) => ValueID[]
}

export function createFunctionContext(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  moduleBindingsBySymbol: Map<ts.Symbol, ModuleBindingID>,
  sites: SourceSpan[],
  staticAnnotations: StaticAnnotation[] = [],
): FunctionContext {
  const entry: MutableBlock = {loopHeader: null, parameters: [], instructions: [], terminator: null}
  return {
    sourceFile,
    checker,
    functionsBySymbol,
    moduleBindingsBySymbol,
    staticAnnotations,
    sites,
    nextValue: 0,
    currentBlock: entry,
    blocks: [entry],
    bindings: new Map(),
    parameters: [],
    assertions: [],
    loops: [],
  }
}

// The mutable lowering state a skipped initializer statement must roll back, kept beside
// the type so a future mutable field on FunctionContext is added to the snapshot in the
// same file. Two fields are deliberately not rolled back: sites (rolled-back sites would
// invalidate SiteIDs already recorded elsewhere) and nextValue (leaked ValueIDs are merely
// sparse).
export type LoweringSnapshot = {
  block: MutableBlock
  instructionCount: number
  blockCount: number
  bindings: Map<ts.Symbol, ValueID>
  assertionCount: number
  loopCount: number
}

export function snapshotLowering(context: FunctionContext): LoweringSnapshot {
  return {
    block: context.currentBlock,
    instructionCount: context.currentBlock.instructions.length,
    blockCount: context.blocks.length,
    bindings: new Map(context.bindings),
    assertionCount: context.assertions.length,
    loopCount: context.loops.length,
  }
}

export function restoreLowering(context: FunctionContext, snapshot: LoweringSnapshot): void {
  context.blocks.length = snapshot.blockCount
  snapshot.block.instructions.length = snapshot.instructionCount
  snapshot.block.terminator = null
  context.currentBlock = snapshot.block
  context.bindings = snapshot.bindings
  context.assertions.length = snapshot.assertionCount
  context.loops.length = snapshot.loopCount
}

export function addSite(context: FunctionContext, node: ts.Node): SiteID {
  context.sites.push(nodeSpan(context.sourceFile, node))
  return context.sites.length - 1
}

type WithoutResultAndSite<T> = T extends unknown ? Omit<T, 'result' | 'site'> : never
type InstructionInput = WithoutResultAndSite<InstructionIR>

// Every caller passes the AST node the instruction was lowered from. Desugared helpers
// (the constant 0 in `-x`, the constant 1 in `count++`) pass the enclosing node:
// distinct SiteIDs, shared span.
export function addInstruction(context: FunctionContext, node: ts.Node, instruction: InstructionInput): ValueID {
  const site = addSite(context, node)
  return addInstructionAtSite(context, site, instruction)
}

export function addInstructionAtSite(context: FunctionContext, site: SiteID, instruction: InstructionInput): ValueID {
  const result = context.nextValue++
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

// Copies finished lowering blocks into their immutable BlockIR form. A missing terminator
// here is a lowering bug — the statement protocol terminates every block it creates except
// the current one, which callers must handle before sealing — so it crashes as an invariant
// violation instead of masquerading as a user-facing missing-return reason.
export function sealBlocks(blocks: MutableBlock[], name: string): BlockIR[] {
  return blocks.map(block => {
    if (block.terminator == null) throw new Error(`Lowering left an unterminated block in ${name}`)
    return {
      loopHeader: block.loopHeader,
      parameters: block.parameters,
      instructions: block.instructions,
      terminator: block.terminator,
    }
  })
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

export function changedBindings(
  before: Map<ts.Symbol, ValueID>,
  branches: Array<Map<ts.Symbol, ValueID>>,
): ts.Symbol[] {
  const changed: ts.Symbol[] = []
  for (const [symbol, value] of before) {
    if (branches.some(branch => requiredBranchBinding(symbol, branch) !== value)) changed.push(symbol)
  }
  return changed
}

// Several branches continue past a statement (an if/else where both arms fall through, a
// switch with breaking bodies plus the no-match path): create the continuation block with
// one parameter per binding any branch changed, jump every branch to it carrying its own
// values, and rebind the changed symbols to the continuation's parameters. Callers handle
// the zero-continuing and one-continuing cases themselves — no merge is needed there.
export function mergeAtContinuation(
  exits: Array<{block: MutableBlock; bindings: Map<ts.Symbol, ValueID>}>,
  bindingsBefore: Map<ts.Symbol, ValueID>,
  statement: ts.Statement,
  context: FunctionContext,
): void {
  const changed = changedBindings(bindingsBefore, exits.map(exit => exit.bindings))
  const continuation = createBlock(context, changed.length)
  for (const exit of exits) {
    terminate(exit.block, {
      kind: 'jump',
      target: {block: continuation, arguments: changed.map(symbol => requiredBranchBinding(symbol, exit.bindings))},
      site: addSite(context, statement),
    })
  }
  context.currentBlock = context.blocks[continuation]!
  context.bindings = new Map(bindingsBefore)
  for (let index = 0; index < changed.length; index++) {
    context.bindings.set(changed[index]!, context.currentBlock.parameters[index]!)
  }
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

// Thrown when lowering meets a construct outside the accepted subset. Caught at exactly two
// places: the per-function loop in lowerSource, which discards the whole in-progress
// FunctionContext and records an UnsupportedFunctionIR, and the module initializer's
// statement loop in module.ts, which rolls the failed statement back and keeps lowering
// (a skip). No other try/catch may exist under src/lower (a mid-lowering catch would
// silently truncate bodies), and nothing outside src/lower may see this class.
// Extends Error only so an accidentally escaping stop has a stack trace; the message is
// never parsed or matched.
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
