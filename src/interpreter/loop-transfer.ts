import * as ts from 'typescript'
import {
  additionIsExact,
  addNumbers,
  gridJoin,
  maxArrayLength,
  gridOfNumber,
  integerValued,
  joinValues,
  linearNameForExpression,
  mergeArraySummary,
  mergeAssumptions,
  mergeElementValue,
  multiplyNumbers,
  negateNumber,
  numberValue,
  subtractNumbers,
  unknown,
  type ArrayValue,
  type ArraySummary,
  type LinearConstraint,
  type NumberValue,
  type SequenceRelation,
  type Value,
} from '../domain.ts'
import {filterOrigin, mapOrigin} from '../array-summary.ts'
import {
  cleanLinear,
  isZeroLinear,
  linearAdd,
  linearConstant,
  linearScaleExact,
  linearSubtract,
  linearVariable,
  sameLinear,
  singleUnitAtom,
  type LinearExpr,
} from '../linear.ts'
import {
  conditionalPushLength,
  conditionalRunningSumNumber,
  nonEmptyLoopEnd,
  runningExtremumNumber,
  runningSumNumber,
} from '../loop-summary.ts'
import {fitExpressionParsed, parseExpression, type ParsedFitExpression} from '../parser.ts'
import {comparisonConstraint, provableBounds, proveComparison, runningSumFacts} from '../proof.ts'
import {
  rationalAdd,
  rationalEquals,
  rationalFromNumber,
  rationalIsExactNumber,
  rationalIsNegative,
  rationalIsZero,
  rationalMultiply,
  rationalNegate,
  rationalOne,
  rationalZero,
  rationalToNumber,
  rationalToNumberCeil,
  rationalToNumberFloor,
  type Rational,
} from '../rational.ts'
import {noteUnsupported, type InterpreterFlow, type InterpreterFrame, type InterpreterLoopClaim, type LoopFrame} from './context.ts'
import {forgetRoot} from './forgettable-loop.ts'
import {
  isAssignmentOperator,
  isIdentifierNamed,
  isPushCallExpression,
  isSideEffectFreeExpression,
  referencesIdentifier,
  scalarUpdateFromExpression,
  unwrapExpression,
} from './source-syntax.ts'
import {blockScopedNames, restoreScopedValues, saveScopedValues} from './scope.ts'
import {writeMutationPath} from './value-path.ts'

// The loop analysis evaluates the body on a generalized iteration instead of
// recognizing statement shapes. Every variable the body writes starts the
// iteration as an unbounded pre-state symbol, so any bound the evaluator
// derives holds at every iteration, not just the first. Body control flow is
// enumerated path by path; each variable's per-iteration effect must land in a
// small closed algebra (unchanged, += delta, min/max with a candidate, or a
// plain rebind) and anything outside it makes that one variable unknown, not
// the whole loop. Sequence facts for pushed arrays come from comparing the
// linear forms of consecutive pushed elements, never from source text.

export type SymbolicLoop = {
  claim: InterpreterLoopClaim
  body: ts.Block
  source: ArrayValue
  sourceExpr: string
  sourceRoot: string | null
  // 'collection' iterates a real array; 'count' only repeats a number of
  // times, so pushed arrays cannot claim to follow anything by index.
  sourceKind: 'collection' | 'count'
  count: NumberValue
  bindIteration: (frame: InterpreterFrame) => void
  iterationRoots: string[]
}

export type LoopAnalysisContext = {
  evaluateExpression: (expression: ts.Expression, frame: InterpreterFrame) => Value
  evaluateStatement: (statement: ts.Statement, frame: InterpreterFrame) => InterpreterFlow
  conditionTruth: (condition: ts.Expression, frame: InterpreterFrame) => boolean | null
  refinedBranchFrame: (frame: InterpreterFrame, condition: ts.Expression, truth: boolean, name: string) => InterpreterFrame
}

export type LoopOutcome = {kind: 'done'} | {kind: 'function-unknown'; value: Value}

const pathCap = 32
const narrowingRoundCap = 3

// Names minted across all analyses stay globally unique: facts published by
// two different loops must never share an internal symbol, or the proof layer
// would couple unrelated quantities.
let mintGeneration = 0

// One scalar's net effect over a single iteration along one path.
type ScalarEffect =
  | {kind: 'unchanged'}
  | {kind: 'add'; delta: NumberValue}
  | {kind: 'extremum'; extremum: 'min' | 'max'; candidate: NumberValue}
  | {kind: 'rebind'; value: Value}
  | {kind: 'opaque'; reason: string}

type PathState = {
  frame: InterpreterFrame
  loop: LoopFrame
  effects: Map<string, ScalarEffect>
  declaredLocals: Set<string>
  ended: boolean
}

type WalkResult =
  | {kind: 'paths'; paths: PathState[]; restartRoots: Set<string>}
  | {kind: 'abort'; reason: string; node: ts.Node | undefined}

type Analysis = {
  loop: SymbolicLoop
  context: LoopAnalysisContext
  realFrame: InterpreterFrame
  writeSet: Set<string>
  prefix: string
  preNames: Map<string, string>
  preRoots: Map<string, string>
  mintedValues: Map<string, NumberValue>
  iterationNames: Map<string, NumberValue>
  invariantCache: Map<string, boolean>
  iterationFrame: InterpreterFrame | null
  mintCounter: number
}

// Per-variable summary joined across all body paths.
type ScalarSummary =
  | {kind: 'unchanged'}
  | {kind: 'add'; delta: NumberValue; canSkip: boolean}
  | {kind: 'extremum'; extremum: 'min' | 'max'; candidate: NumberValue; canSkip: boolean}
  | {kind: 'hull'; rebinds: Value[]; lows: NumberValue[]; highs: NumberValue[]}
  | {kind: 'opaque'; reason: string}

type LoopResult = {
  paths: PathState[]
  summaries: Map<string, ScalarSummary>
}

export function evaluateSymbolicLoop(loop: SymbolicLoop, frame: InterpreterFrame, context: LoopAnalysisContext): LoopOutcome {
  const analysis: Analysis = {
    loop,
    context,
    realFrame: frame,
    writeSet: syntacticWriteSeed(loop.body),
    prefix: `loop${mintGeneration++}`,
    preNames: new Map(),
    preRoots: new Map(),
    mintedValues: new Map(),
    iterationNames: new Map(),
    invariantCache: new Map(),
    iterationFrame: null,
    mintCounter: 0,
  }

  // Restarts terminate without a cap: every restart root is an env name not
  // yet in the write set, and the write set only grows.
  let first: LoopResult | null = null
  while (first == null) {
    if (loop.iterationRoots.some(root => analysis.writeSet.has(root))) {
      return {kind: 'function-unknown', value: noteUnsupported(frame, 'Loop item/index is reassigned in the body', loop.body)}
    }
    if (loop.sourceRoot != null && analysis.writeSet.has(loop.sourceRoot)) {
      return {kind: 'function-unknown', value: noteUnsupported(frame, 'Loop body mutates its own source array', loop.body)}
    }
    const walked = runBodyPaths(analysis, null)
    if (walked.kind === 'abort') {
      return {kind: 'function-unknown', value: noteUnsupported(frame, walked.reason, walked.node)}
    }
    if (walked.restartRoots.size === 0) {
      normalizeEffects(walked.paths, analysis)
      first = {paths: walked.paths, summaries: summarizeScalars(walked.paths, analysis)}
      break
    }
    for (const root of walked.restartRoots) analysis.writeSet.add(root)
  }

  // Narrowing rounds: rerun with pre-states bounded by the proven hulls.
  // Sound because a variable's pre-state at any iteration lies in the hull of
  // its start and its value after count - 1 iterations (the full-count hull
  // only bounds the post-loop value). Each round can anchor quantities the
  // previous one could not — a max-accumulator's floor only appears once its
  // pre-state stops being unbounded — so iterate to a small fixpoint.
  let result = first
  let postHulls = lifetimeHulls(first.summaries, analysis, loop.count)
  let preHulls = lifetimeHulls(first.summaries, analysis, countMinusOne(loop.count))
  for (let round = 0; round < narrowingRoundCap; round++) {
    const narrowed = runBodyPaths(analysis, preHulls)
    if (narrowed.kind !== 'paths' || narrowed.restartRoots.size > 0) break
    normalizeEffects(narrowed.paths, analysis)
    const candidate: LoopResult = {paths: narrowed.paths, summaries: summarizeScalars(narrowed.paths, analysis)}
    if (!narrowedResultInsideHulls(candidate, postHulls, analysis)) break
    result = candidate
    postHulls = lifetimeHulls(result.summaries, analysis, loop.count)
    const nextPreHulls = lifetimeHulls(result.summaries, analysis, countMinusOne(loop.count))
    if (sameHulls(preHulls, nextPreHulls)) break
    preHulls = nextPreHulls
  }

  runReportingPass(analysis, preHulls)
  finalizeArrays(result, analysis)
  finalizeScalars(result, analysis)

  for (const root of analysis.writeSet) loop.claim.factRoots.add(root)
  return {kind: 'done'}
}

// ——— write-set discovery

// Syntactic seed: every identifier root that any statement assigns, updates,
// or pushes into. The walk's per-statement identity diff is the safety net
// that catches the rest (writes through calls, paths, and aliases) and
// restarts the analysis with those roots included.
function syntacticWriteSeed(body: ts.Block): Set<string> {
  const roots = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const root = assignmentTargetRoot(node.left)
      if (root != null) roots.add(root)
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      const root = assignmentTargetRoot(node.operand)
      if (root != null) roots.add(root)
    }
    if (ts.isCallExpression(node) && isPushCallExpression(node)) {
      const root = assignmentTargetRoot(node.expression.expression)
      if (root != null) roots.add(root)
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return roots
}

function assignmentTargetRoot(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return current.text
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) return assignmentTargetRoot(current.expression)
  return null
}

// ——— generalized iteration runs

function runBodyPaths(analysis: Analysis, hulls: Map<string, Value> | null): WalkResult {
  analysis.preNames.clear()
  analysis.preRoots.clear()
  analysis.mintedValues.clear()
  analysis.iterationNames.clear()
  analysis.invariantCache.clear()

  const env = generalizedEnv(analysis, hulls)
  const frame = pathFrame(analysis.realFrame, env)
  analysis.loop.bindIteration(frame)
  registerIterationNames(analysis, frame)
  analysis.iterationFrame = frame

  const root: PathState = {
    frame,
    loop: {source: analysis.loop.source, sourceExpr: analysis.loop.sourceExpr, mode: 'symbolic', appends: []},
    effects: new Map(),
    declaredLocals: new Set(),
    ended: false,
  }
  frame.loopStack.push(root.loop)
  const restartRoots = new Set<string>()
  return walkStatements([...analysis.loop.body.statements], [root], restartRoots, analysis)
}

function generalizedEnv(analysis: Analysis, hulls: Map<string, Value> | null): Map<string, Value> {
  const env = new Map(analysis.realFrame.env)
  for (const root of analysis.writeSet) {
    const current = env.get(root)
    if (current == null) continue
    env.set(root, generalizedRootValue(root, current, hulls?.get(root) ?? null, analysis))
  }
  return env
}

function generalizedRootValue(root: string, current: Value, hull: Value | null, analysis: Analysis): Value {
  if (current.kind === 'number') {
    const bounds = hull?.kind === 'number' ? hull : null
    return numberValue(bounds?.min ?? -Infinity, bounds?.max ?? Infinity, bounds?.grid ?? null, root, linearVariable(preName(root, analysis)))
  }
  if (current.kind === 'array') {
    return {
      ...current,
      length: numberValue(Math.max(0, current.length.min), maxArrayLength, 0, `${root}.length`, linearVariable(preName(`${root}.length`, analysis))),
      elements: null,
      element: current.element,
      summary: null,
    }
  }
  return unknown(`${root} varies across loop iterations`)
}

function preName(root: string, analysis: Analysis): string {
  const existing = analysis.preNames.get(root)
  if (existing != null) return existing
  const name = `${root}@${analysis.prefix}`
  analysis.preNames.set(root, name)
  analysis.preRoots.set(name, root)
  return name
}

function pathFrame(parent: InterpreterFrame, env: Map<string, Value>): InterpreterFrame {
  const hooks = parent.hooks == null ? null : claimSilentHooks(parent.hooks)
  return {
    program: parent.program,
    env,
    issues: [],
    effects: [],
    audits: [],
    stack: parent.stack,
    activeCalls: new Set(parent.activeCalls),
    localBindings: new Set(parent.localBindings),
    loopStack: [...parent.loopStack],
    conditionalDepth: parent.conditionalDepth,
    assumptions: [...parent.assumptions],
    containedRoots: parent.containedRoots,
    ...(hooks == null ? {} : {hooks}),
    suppressChecks: true,
  }
}

// Path runs keep call and path interception (value semantics) but drop claim
// and loop reporting; the single reporting pass fires those once.
function claimSilentHooks(hooks: NonNullable<InterpreterFrame['hooks']>): NonNullable<InterpreterFrame['hooks']> {
  const silent: NonNullable<InterpreterFrame['hooks']> = {}
  if (hooks.evaluateCall != null) silent.evaluateCall = hooks.evaluateCall
  if (hooks.evaluatePath != null) silent.evaluatePath = hooks.evaluatePath
  return silent
}

function forkPath(path: PathState, frame: InterpreterFrame): PathState {
  frame.loopStack = [...frame.loopStack]
  const loop: LoopFrame = {...path.loop, appends: [...path.loop.appends]}
  frame.loopStack[frame.loopStack.length - 1] = loop
  return {
    frame,
    loop,
    effects: new Map(path.effects),
    declaredLocals: new Set(path.declaredLocals),
    ended: path.ended,
  }
}

function registerIterationNames(analysis: Analysis, frame: InterpreterFrame) {
  for (const root of analysis.loop.iterationRoots) {
    const value = frame.env.get(root)
    if (value != null) collectNumericLeafNames(value, analysis.iterationNames)
  }
}

function collectNumericLeafNames(value: Value, names: Map<string, NumberValue>) {
  if (value.kind === 'number') {
    if (value.linear != null) {
      for (const name of value.linear.terms.keys()) names.set(name, value)
    } else if (value.expr != null) {
      names.set(linearNameForExpression(value.expr), value)
    }
    return
  }
  if (value.kind === 'object') {
    for (const prop of value.props.values()) collectNumericLeafNames(prop, names)
    return
  }
  if (value.kind === 'array') {
    names.set(linearNameForExpression(`${value.expr ?? 'items'}.length`), value.length)
    if (value.element != null) collectNumericLeafNames(value.element, names)
    for (const element of value.elements ?? []) collectNumericLeafNames(element, names)
    return
  }
  if (value.kind === 'nullable') collectNumericLeafNames(value.present, names)
}

// ——— the path walk

function walkStatements(statements: ts.Statement[], paths: PathState[], restartRoots: Set<string>, analysis: Analysis): WalkResult {
  let current = paths
  for (const statement of statements) {
    const next: PathState[] = []
    for (const path of current) {
      if (path.ended) {
        next.push(path)
        continue
      }
      const stepped = walkStatement(statement, path, restartRoots, analysis)
      if (stepped.kind === 'abort') return stepped
      next.push(...stepped.paths)
    }
    if (next.length > pathCap) {
      return {kind: 'abort', reason: `Loop body has more than ${pathCap} branch combinations`, node: statement}
    }
    current = next
  }
  return {kind: 'paths', paths: current, restartRoots}
}

function walkStatement(statement: ts.Statement, path: PathState, restartRoots: Set<string>, analysis: Analysis): WalkResult {
  if (ts.isIfStatement(statement)) return walkIfStatement(statement, path, restartRoots, analysis)
  if (ts.isBlock(statement)) return walkBlock(statement, path, restartRoots, analysis)
  if (ts.isContinueStatement(statement) && statement.label == null) {
    path.ended = true
    return {kind: 'paths', paths: [path], restartRoots}
  }

  if (ts.isVariableStatement(statement)) {
    const before = snapshotRoots(path, analysis)
    const flow = analysis.context.evaluateStatement(statement, path.frame)
    if (flow.kind !== 'fallthrough') return delegatedFlowAbort(statement)
    for (const declaration of statement.declarationList.declarations) {
      collectDeclaredNames(declaration.name, path.declaredLocals)
      if (ts.isIdentifier(declaration.name)) mintOpaqueBinding(declaration.name.text, path, analysis)
    }
    diffRoots(before, statement, path, restartRoots, analysis)
    return {kind: 'paths', paths: [path], restartRoots}
  }

  if (ts.isExpressionStatement(statement)) return walkExpressionStatement(statement, path, restartRoots, analysis)

  // Anything else (nested loops, switch, try, ...) is delegated wholesale; the
  // identity diff turns its writes into per-variable opacity.
  const before = snapshotRoots(path, analysis)
  const flow = analysis.context.evaluateStatement(statement, path.frame)
  if (flow.kind !== 'fallthrough') return delegatedFlowAbort(statement)
  diffRoots(before, statement, path, restartRoots, analysis)
  return {kind: 'paths', paths: [path], restartRoots}
}

function delegatedFlowAbort(statement: ts.Statement): WalkResult {
  return {kind: 'abort', reason: `Loop control flow is unsupported: ${statement.getText()}`, node: statement}
}

function walkBlock(block: ts.Block, path: PathState, restartRoots: Set<string>, analysis: Analysis): WalkResult {
  const saved = saveScopedValues(path.frame.env, blockScopedNames(block))
  const walked = walkStatements([...block.statements], [path], restartRoots, analysis)
  if (walked.kind === 'abort') return walked
  for (const resultPath of walked.paths) restoreScopedValues(resultPath.frame.env, saved)
  return walked
}

function walkIfStatement(statement: ts.IfStatement, path: PathState, restartRoots: Set<string>, analysis: Analysis): WalkResult {
  const sideEffectFree = isSideEffectFreeExpression(statement.expression)
  if (!sideEffectFree) {
    const before = snapshotRoots(path, analysis)
    analysis.context.evaluateExpression(statement.expression, path.frame)
    diffRoots(before, statement, path, restartRoots, analysis)
  }
  const truth = sideEffectFree ? analysis.context.conditionTruth(statement.expression, path.frame) : null

  const branches: {statement: ts.Statement | null; truth: boolean}[] = []
  if (truth !== false) branches.push({statement: statement.thenStatement, truth: true})
  if (truth !== true) branches.push({statement: statement.elseStatement ?? null, truth: false})

  const outcomes: PathState[] = []
  for (const branch of branches) {
    const fork = branches.length === 1
      ? path
      : forkPath(path, sideEffectFree
        ? analysis.context.refinedBranchFrame(path.frame, statement.expression, branch.truth, branch.truth ? '<loop-if-true>' : '<loop-if-false>')
        : pathFrame(path.frame, new Map(path.frame.env)))
    if (branch.statement == null) {
      outcomes.push(fork)
      continue
    }
    const walked = walkStatements([branch.statement], [fork], restartRoots, analysis)
    if (walked.kind === 'abort') return walked
    outcomes.push(...walked.paths)
  }
  return {kind: 'paths', paths: outcomes, restartRoots}
}

function walkExpressionStatement(statement: ts.ExpressionStatement, path: PathState, restartRoots: Set<string>, analysis: Analysis): WalkResult {
  const expression = unwrapExpression(statement.expression)

  const tracked = trackedScalarTarget(expression, path, analysis)
  if (tracked != null) return walkTrackedScalarUpdate(statement, expression, tracked, path, restartRoots, analysis)

  const before = snapshotRoots(path, analysis)
  const flow = analysis.context.evaluateStatement(statement, path.frame)
  if (flow.kind !== 'fallthrough') return delegatedFlowAbort(statement)
  const pushTarget = isPushCallExpression(expression) ? unwrapExpression(expression.expression.expression) : null
  const expected = pushTarget != null && ts.isIdentifier(pushTarget) ? new Set([pushTarget.text]) : undefined
  diffRoots(before, statement, path, restartRoots, analysis, expected)
  return {kind: 'paths', paths: [path], restartRoots}
}

function walkTrackedScalarUpdate(
  statement: ts.ExpressionStatement,
  expression: ts.Expression,
  tracked: string,
  path: PathState,
  restartRoots: Set<string>,
  analysis: Analysis,
): WalkResult {
  const expected = new Set([tracked])
  const update = scalarUpdateFromExpression(expression)
  if (update != null && update.targetName === tracked) {
    const before = snapshotRoots(path, analysis)
    let delta: NumberValue | null = null
    let unresolvedTerm = false
    for (const term of update.terms) {
      const value = 'constant' in term
        ? numberValue(term.constant, term.constant, gridOfNumber(term.constant), `${term.constant}`, linearConstant(term.constant))
        : signedTermNumber(term.expression, term.negate, path, analysis)
      if (value == null) {
        unresolvedTerm = true
        break
      }
      delta = delta == null ? value : addNumbers(delta, value)
    }
    if (!unresolvedTerm) delta ??= numberValue(0, 0, 0, '0', linearConstant(0))
    if (unresolvedTerm || delta == null) {
      composeEffect(path, tracked, {kind: 'opaque', reason: `updated by ${statement.getText()}`})
      forgetRoot(path.frame.env, tracked)
    } else {
      composeEffect(path, tracked, {kind: 'add', delta})
      const current = path.frame.env.get(tracked)
      if (current?.kind === 'number') path.frame.env.set(tracked, addNumbers(current, delta))
    }
    diffRoots(before, statement, path, restartRoots, analysis, expected)
    return {kind: 'paths', paths: [path], restartRoots}
  }

  const extremum = extremumUpdate(expression, tracked)
  if (extremum != null) {
    const before = snapshotRoots(path, analysis)
    let candidate: NumberValue | null = null
    for (const expressionCandidate of extremum.candidates) {
      const value = analysis.context.evaluateExpression(expressionCandidate, path.frame)
      if (value.kind !== 'number') {
        candidate = null
        break
      }
      candidate = candidate == null ? value : extremumPair(extremum.extremum, candidate, value)
    }
    const result = analysis.context.evaluateExpression(extremum.call, path.frame)
    if (candidate == null || result.kind !== 'number') {
      composeEffect(path, tracked, {kind: 'opaque', reason: `updated by ${statement.getText()}`})
      forgetRoot(path.frame.env, tracked)
    } else {
      composeEffect(path, tracked, {kind: 'extremum', extremum: extremum.extremum, candidate})
      path.frame.env.set(tracked, mintNumber(result, tracked, analysis))
    }
    diffRoots(before, statement, path, restartRoots, analysis, expected)
    return {kind: 'paths', paths: [path], restartRoots}
  }

  // Any other assignment to a tracked scalar is a plain rebind: delegate for
  // exact value semantics, then record the post value.
  const before = snapshotRoots(path, analysis)
  const flow = analysis.context.evaluateStatement(statement, path.frame)
  if (flow.kind !== 'fallthrough') return delegatedFlowAbort(statement)
  const after = path.frame.env.get(tracked)
  if (after == null) {
    composeEffect(path, tracked, {kind: 'opaque', reason: `updated by ${statement.getText()}`})
  } else {
    const minted = after.kind === 'number' ? mintNumber(after, tracked, analysis) : after
    path.frame.env.set(tracked, minted)
    composeEffect(path, tracked, {kind: 'rebind', value: minted})
  }
  diffRoots(before, statement, path, restartRoots, analysis, expected)
  return {kind: 'paths', paths: [path], restartRoots}
}

function trackedScalarTarget(expression: ts.Expression, path: PathState, analysis: Analysis): string | null {
  let target: ts.Expression | null = null
  if (ts.isBinaryExpression(expression) && isAssignmentOperator(expression.operatorToken.kind)) target = expression.left
  if ((ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression))
    && (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken)) target = expression.operand
  if (target == null) return null
  const current = unwrapExpression(target)
  if (!ts.isIdentifier(current)) return null
  const name = current.text
  if (path.declaredLocals.has(name) || !analysis.writeSet.has(name)) return null
  return name
}

function signedTermNumber(expression: ts.Expression, negate: boolean, path: PathState, analysis: Analysis): NumberValue | null {
  const value = analysis.context.evaluateExpression(expression, path.frame)
  if (value.kind !== 'number') return null
  return negate ? negateNumber(value, `-(${value.expr ?? expression.getText()})`) : value
}

// `x = Math.max(...)` / `Math.min(...)` with x exactly once among the
// arguments, in any position; the remaining arguments are the candidates.
function extremumUpdate(expression: ts.Expression, target: string): {extremum: 'min' | 'max'; candidates: ts.Expression[]; call: ts.Expression} | null {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const call = unwrapExpression(expression.right)
  if (!ts.isCallExpression(call)) return null
  const callee = unwrapExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'Math') return null
  if (callee.name.text !== 'min' && callee.name.text !== 'max') return null
  if (call.arguments.some(argument => ts.isSpreadElement(argument))) return null
  const targetArguments = call.arguments.filter(argument => isIdentifierNamed(argument, target))
  const candidates = call.arguments.filter(argument => !isIdentifierNamed(argument, target))
  if (targetArguments.length !== 1 || candidates.length === 0) return null
  if (candidates.some(argument => referencesIdentifier(argument, target))) return null
  return {extremum: callee.name.text, candidates, call: expression.right}
}

function extremumPair(kind: 'min' | 'max', left: NumberValue, right: NumberValue): NumberValue {
  return kind === 'min'
    ? numberValue(Math.min(left.min, right.min), Math.min(left.max, right.max), gridJoin(left.grid, right.grid), null)
    : numberValue(Math.max(left.min, right.min), Math.max(left.max, right.max), gridJoin(left.grid, right.grid), null)
}

// Values produced past the linear layer's reach (Math.max results and the
// like) get a fresh per-iteration symbol, so same-iteration reuse stays
// recognizable in pushed-element and cursor forms. Fallback names the
// evaluator coins from expression text (max(rowHeight, ...)) are re-minted
// too: the same text denotes different values once a mutated variable moves,
// so such a name must never join two separate reads.
function mintNumber(value: NumberValue, root: string, analysis: Analysis): NumberValue {
  if (value.linear != null && stableLinear(value.linear, analysis)) return value
  const name = `${root}#${analysis.mintCounter++}@${analysis.prefix}`
  const minted = numberValue(value.min, value.max, value.grid, value.expr ?? root, linearVariable(name), null, value.origin)
  analysis.mintedValues.set(name, minted)
  return minted
}

// A form is iteration-stable when every name in it denotes one well-defined
// quantity for the iteration: a pre-state symbol, a minted symbol, an
// item/index name, or a loop-invariant.
function stableLinear(linear: LinearExpr, analysis: Analysis): boolean {
  for (const name of linear.terms.keys()) {
    if (analysis.preRoots.has(name) || analysis.mintedValues.has(name) || analysis.iterationNames.has(name)) continue
    if (invariantLinearName(name, analysis)) continue
    // A rounded computation's atom is stable when each summed leaf is itself
    // a stable name (a written root read at push time, an item path, an
    // invariant): the structural matching in leafExprOverrides resolves the
    // leaves the same way.
    const leaves = sumAtomLeaves(unprimed(name))
    if (leaves == null) return false
    for (const leaf of leaves) {
      if (analysis.writeSet.has(leaf.name) || analysis.iterationNames.has(leaf.name) || analysis.mintedValues.has(leaf.name)) continue
      if (!invariantLinearName(leaf.name, analysis)) return false
    }
  }
  return true
}

function mintOpaqueBinding(name: string, path: PathState, analysis: Analysis) {
  const value = path.frame.env.get(name)
  if (value == null) return
  const minted = mintValueLeaves(value, name, analysis)
  if (minted !== value) path.frame.env.set(name, minted)
}

// Numeric leaves of a fresh local that arrived without linear forms (element
// access results, Math call results) each get a symbol, so reusing the local
// in a push and in a cursor update stays recognizably the same quantity.
function mintValueLeaves(value: Value, root: string, analysis: Analysis): Value {
  if (value.kind === 'number') return value.linear == null ? mintNumber(value, root, analysis) : value
  if (value.kind === 'object') {
    let changed = false
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) {
      const minted = mintValueLeaves(prop, `${root}.${name}`, analysis)
      changed = changed || minted !== prop
      props.set(name, minted)
    }
    return changed ? {...value, props} : value
  }
  return value
}

function collectDeclaredNames(name: ts.BindingName, into: Set<string>) {
  if (ts.isIdentifier(name)) {
    into.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    collectDeclaredNames(element.name, into)
  }
}

function snapshotRoots(path: PathState, analysis: Analysis): Map<string, Value> {
  const snapshot = new Map<string, Value>()
  for (const [name, value] of path.frame.env) {
    if (path.declaredLocals.has(name) || analysis.loop.iterationRoots.includes(name)) continue
    snapshot.set(name, value)
  }
  return snapshot
}

function diffRoots(
  before: Map<string, Value>,
  statement: ts.Statement,
  path: PathState,
  restartRoots: Set<string>,
  analysis: Analysis,
  expected?: Set<string>,
) {
  for (const [name, value] of path.frame.env) {
    if (path.declaredLocals.has(name) || analysis.loop.iterationRoots.includes(name)) continue
    if (expected?.has(name) === true) continue
    if (!before.has(name) || before.get(name) === value) continue
    if (!analysis.writeSet.has(name)) {
      restartRoots.add(name)
      continue
    }
    composeEffect(path, name, {kind: 'opaque', reason: `updated by ${statement.getText()}`})
  }
}

// ——— the per-variable update algebra

function composeEffect(path: PathState, root: string, effect: ScalarEffect) {
  const current = path.effects.get(root) ?? {kind: 'unchanged'}
  path.effects.set(root, composeEffects(current, effect))
}

function composeEffects(first: ScalarEffect, second: ScalarEffect): ScalarEffect {
  if (first.kind === 'opaque') return first
  if (second.kind === 'opaque') return second
  if (first.kind === 'unchanged') return second
  if (second.kind === 'unchanged') return first
  if (second.kind === 'rebind') return second
  switch (first.kind) {
    case 'add':
      return second.kind === 'add'
        ? {kind: 'add', delta: addNumbers(first.delta, second.delta)}
        : {kind: 'opaque', reason: 'mixes a running sum with an extremum update'}
    case 'extremum':
      return second.kind === 'extremum' && second.extremum === first.extremum
        ? {kind: 'extremum', extremum: first.extremum, candidate: extremumPair(first.extremum, first.candidate, second.candidate)}
        : {kind: 'opaque', reason: 'mixes extremum updates with other updates'}
    case 'rebind': {
      if (second.kind === 'add' && first.value.kind === 'number') return {kind: 'rebind', value: addNumbers(first.value, second.delta)}
      if (second.kind === 'extremum' && first.value.kind === 'number') return {kind: 'rebind', value: extremumPair(second.extremum, first.value, second.candidate)}
      return {kind: 'opaque', reason: 'mixes rebinding with other updates'}
    }
  }
}

function summarizeScalars(paths: PathState[], analysis: Analysis): Map<string, ScalarSummary> {
  const summaries = new Map<string, ScalarSummary>()
  for (const root of analysis.writeSet) {
    const startValue = analysis.realFrame.env.get(root)
    if (startValue == null || startValue.kind === 'array') continue
    const effects = paths.map(path => path.effects.get(root) ?? ({kind: 'unchanged'} as ScalarEffect))
    summaries.set(root, joinEffects(effects, startValue))
  }
  return summaries
}

// Settle every path's effects into their canonical algebra before transfers
// and summaries read them.
function normalizeEffects(paths: PathState[], analysis: Analysis) {
  for (const path of paths) {
    for (const [root, effect] of path.effects) {
      path.effects.set(root, tightenEffect(reclassifyAliasRebind(root, effect, analysis), analysis))
    }
  }
}

// `cursor = cursorAlias + size + gap` spelled through a local alias is still
// an additive step: the post value's linear form carries the pre-state symbol
// with coefficient one, and the rest is the delta.
function reclassifyAliasRebind(root: string, effect: ScalarEffect, analysis: Analysis): ScalarEffect {
  if (effect.kind !== 'rebind' || effect.value.kind !== 'number' || effect.value.linear == null) return effect
  const name = analysis.preNames.get(root)
  if (name == null) return effect
  const coefficient = effect.value.linear.terms.get(name)
  if (coefficient == null || !rationalEquals(coefficient, rationalOne)) return effect
  const deltaLinear = linearSubtract(effect.value.linear, linearVariable(name))
  if (deltaLinear == null || linearMentionsPre(deltaLinear, analysis)) return effect
  const bounds = residueBounds(deltaLinear, analysis)
  return {
    kind: 'add',
    delta: numberValue(bounds?.min ?? -Infinity, bounds?.max ?? Infinity, bounds?.isInteger === true ? 0 : null, null, deltaLinear),
  }
}

function linearMentionsPre(linear: LinearExpr, analysis: Analysis): boolean {
  for (const name of linear.terms.keys()) {
    if (analysis.preRoots.has(name)) return true
  }
  return false
}

// Interval arithmetic loses same-variable correlation (h + h - h spans
// [-h.max, 2 * h.max]); the exact linear form does not, so when every name in
// it has known bounds, those bounds win.
function tightenEffect(effect: ScalarEffect, analysis: Analysis): ScalarEffect {
  switch (effect.kind) {
    case 'add':
      return {kind: 'add', delta: tightenFromLinear(effect.delta, analysis)}
    case 'extremum':
      return {...effect, candidate: tightenFromLinear(effect.candidate, analysis)}
    case 'rebind':
      return effect.value.kind === 'number' ? {kind: 'rebind', value: tightenFromLinear(effect.value, analysis)} : effect
    case 'unchanged':
    case 'opaque':
      return effect
  }
}

function tightenFromLinear(value: NumberValue, analysis: Analysis): NumberValue {
  if (value.linear == null) return value
  const bounds = residueBounds(value.linear, analysis)
  if (bounds == null) return value
  const min = Math.max(value.min, bounds.min)
  const max = Math.min(value.max, bounds.max)
  if (min > max) return value
  if (min === value.min && max === value.max) return value
  return numberValue(min, max, value.grid, value.expr, value.linear, null, value.origin)
}

function joinEffects(effects: ScalarEffect[], startValue: Value): ScalarSummary {
  const opaque = effects.find((effect): effect is ScalarEffect & {kind: 'opaque'} => effect.kind === 'opaque')
  if (opaque != null) return opaque
  if (effects.every(effect => effect.kind === 'unchanged')) return {kind: 'unchanged'}
  if (startValue.kind !== 'number' && effects.some(effect => effect.kind === 'add' || effect.kind === 'extremum')) {
    return {kind: 'opaque', reason: 'a numeric update on a non-numeric start value'}
  }
  const canSkip = effects.some(effect => effect.kind === 'unchanged')

  if (effects.every(effect => effect.kind === 'add' || effect.kind === 'unchanged')) {
    // The delta describes the step on iterations where it fires; skipped
    // iterations are the count's business, not the step's.
    let delta: NumberValue | null = null
    for (const effect of effects) {
      if (effect.kind !== 'add') continue
      delta = delta == null ? effect.delta : joinNumbers(delta, effect.delta)
    }
    return delta == null ? {kind: 'unchanged'} : {kind: 'add', delta, canSkip}
  }

  const extrema = effects.filter((effect): effect is ScalarEffect & {kind: 'extremum'} => effect.kind === 'extremum')
  if (extrema.length + effects.filter(effect => effect.kind === 'unchanged').length === effects.length
    && extrema.every(effect => effect.extremum === extrema[0]!.extremum)) {
    let candidate: NumberValue | null = null
    for (const effect of extrema) candidate = candidate == null ? effect.candidate : joinNumbers(candidate, effect.candidate)
    return {kind: 'extremum', extremum: extrema[0]!.extremum, candidate: candidate!, canSkip}
  }

  if (effects.every(effect => effect.kind === 'rebind' || effect.kind === 'extremum' || effect.kind === 'unchanged')) {
    // Extremum candidates move one bound only: max(x, c) can raise the hull
    // but never lower it, and min(x, c) the reverse. Rebinds move both.
    const rebinds: Value[] = []
    const lows: NumberValue[] = []
    const highs: NumberValue[] = []
    for (const effect of effects) {
      if (effect.kind === 'rebind') rebinds.push(effect.value)
      if (effect.kind === 'extremum') (effect.extremum === 'min' ? lows : highs).push(effect.candidate)
    }
    return {kind: 'hull', rebinds, lows, highs}
  }

  return {kind: 'opaque', reason: 'mixes running sums with rebinding or extremum updates across branches'}
}

function joinNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const joined = joinValues(left, right)
  return joined.kind === 'number'
    ? joined
    : numberValue(Math.min(left.min, right.min), Math.max(left.max, right.max), gridJoin(left.grid, right.grid), null)
}

// ——— closed forms

function lifetimeHulls(summaries: Map<string, ScalarSummary>, analysis: Analysis, count: NumberValue): Map<string, Value> {
  const hulls = new Map<string, Value>()
  for (const [root, summary] of summaries) {
    const start = provedStart(analysis.realFrame.env.get(root), analysis)
    if (start == null) continue
    const final = closedFormValue(root, summary, start, analysis, count)
    if (final == null) continue
    hulls.set(root, joinValues(start, final))
  }
  return hulls
}

// A start like submissionHeight - scrollTopCap has unbounded interval ends
// even when the given facts pin it down; the proof layer's best provable
// constant bounds anchor the hull.
// A rounded start's algebra lives in its facts (an opaque difference with a
// recorded `>= 0`), so the polytope can tighten even a finite hull — but only
// single-atom or unbounded starts have anything to gain, and the simplex is
// not free.
function provedStart(start: Value | undefined, analysis: Analysis): Value | undefined {
  if (start?.kind !== 'number' || start.linear == null) return start
  const bothFinite = Number.isFinite(start.min) && Number.isFinite(start.max)
  if (bothFinite && singleUnitAtom(start.linear) == null) return start
  const bounds = provableBounds(start, analysis.realFrame.assumptions)
  if (bounds.min === start.min && bounds.max === start.max) return start
  return numberValue(bounds.min, bounds.max, start.grid, start.expr, start.linear, null, start.origin)
}

function sameHulls(left: Map<string, Value>, right: Map<string, Value>): boolean {
  if (left.size !== right.size) return false
  for (const [root, value] of left) {
    const other = right.get(root)
    if (other == null) return false
    if (value.kind === 'number' && other.kind === 'number') {
      if (value.min !== other.min || value.max !== other.max || value.grid !== other.grid) return false
      continue
    }
    if (value.kind !== other.kind) return false
  }
  return true
}

function countMinusOne(count: NumberValue): NumberValue {
  return numberValue(Math.max(0, count.min - 1), Math.max(0, count.max - 1), count.grid, null)
}

function closedFormValue(root: string, summary: ScalarSummary, start: Value, analysis: Analysis, count = analysis.loop.count): Value | null {
  switch (summary.kind) {
    case 'unchanged':
      return start
    case 'add': {
      if (start.kind !== 'number') return null
      return summary.canSkip
        ? conditionalRunningSumNumber(root, start, count, summary.delta)
        : runningSumNumber(root, start, count, summary.delta)
    }
    case 'extremum': {
      if (start.kind !== 'number') return null
      const factCount = summary.canSkip ? {...count, min: 0} : count
      return runningExtremumNumber(summary.extremum, root, start, factCount, summary.candidate)
    }
    case 'hull': {
      let result: Value = start
      for (const value of summary.rebinds) result = joinValues(result, value)
      if (result.kind === 'number') {
        const min = Math.min(result.min, ...summary.lows.map(candidate => candidate.min))
        const max = Math.max(result.max, ...summary.highs.map(candidate => candidate.max))
        const grid = [...summary.lows, ...summary.highs].reduce<number | null>((joined, candidate) => gridJoin(joined, candidate.grid), result.grid)
        // The rebind join's linear no longer describes the widened hull.
        result = numberValue(min, max, grid, result.expr, null, null, result.origin)
      } else if (summary.lows.length > 0 || summary.highs.length > 0) {
        return null
      }
      return localizeHullValue(result, root)
    }
    case 'opaque':
      return null
  }
}

function localizeHullValue(value: Value, root: string): Value {
  if (value.kind === 'number') {
    return numberValue(value.min, value.max, value.grid, root, linearVariable(linearNameForExpression(root)), null, value.origin)
  }
  return value
}

function narrowedResultInsideHulls(result: LoopResult, hulls: Map<string, Value>, analysis: Analysis): boolean {
  for (const [root, summary] of result.summaries) {
    const start = provedStart(analysis.realFrame.env.get(root), analysis)
    if (start == null) continue
    const final = closedFormValue(root, summary, start, analysis)
    const hull = hulls.get(root)
    if (final == null || hull == null) continue
    if (final.kind === 'number' && hull.kind === 'number' && (final.min < hull.min || final.max > hull.max)) return false
  }
  return true
}

// One full-hook evaluation of the body against the lifetime hulls: inline
// claims, audits, and effect notes fire exactly once, and every claim is
// checked against values that hold at every iteration.
function runReportingPass(analysis: Analysis, hulls: Map<string, Value>) {
  const parent = analysis.realFrame
  const frame: InterpreterFrame = {
    program: parent.program,
    env: generalizedEnv(analysis, hulls),
    issues: parent.issues,
    effects: parent.effects,
    audits: parent.audits,
    stack: parent.stack,
    activeCalls: new Set(parent.activeCalls),
    localBindings: new Set(parent.localBindings),
    loopStack: [...parent.loopStack, {source: analysis.loop.source, sourceExpr: analysis.loop.sourceExpr, mode: 'symbolic', appends: []}],
    conditionalDepth: parent.conditionalDepth,
    assumptions: [...parent.assumptions],
    containedRoots: parent.containedRoots,
    ...(parent.hooks == null ? {} : {hooks: parent.hooks}),
  }
  analysis.loop.bindIteration(frame)
  for (const statement of analysis.loop.body.statements) {
    const flow = analysis.context.evaluateStatement(statement, frame)
    if (flow.kind !== 'fallthrough') break
  }
}

function finalizeScalars(result: LoopResult, analysis: Analysis) {
  const frame = analysis.realFrame
  for (const [root, summary] of result.summaries) {
    const start = frame.env.get(root)
    if (start == null) continue
    if (summary.kind === 'opaque') {
      noteUnsupported(frame, `Loop left ${root} unknown: ${summary.reason}`)
      forgetRoot(frame.env, root)
      continue
    }
    const final = closedFormValue(root, summary, start, analysis)
    if (final == null) {
      forgetRoot(frame.env, root)
      continue
    }
    frame.env.set(root, final)
    if (summary.kind === 'add' && start.kind === 'number' && final.kind === 'number') {
      const factCount = summary.canSkip ? {...analysis.loop.count, min: 0} : analysis.loop.count
      frame.assumptions = mergeAssumptions(frame.assumptions, runningSumFacts(final, start, factCount, summary.delta))
    }
  }
}

// ——— pushed arrays

function finalizeArrays(result: LoopResult, analysis: Analysis) {
  const frame = analysis.realFrame
  const arrayNames = new Set<string>()
  for (const path of result.paths) {
    for (const append of path.loop.appends) arrayNames.add(append.arrayName)
  }

  for (const arrayName of arrayNames) {
    const base = frame.env.get(arrayName)
    if (base?.kind !== 'array') continue
    const mutatedBeyondPush = result.paths.some(path => (path.effects.get(arrayName) ?? {kind: 'unchanged'}).kind !== 'unchanged')
    if (mutatedBeyondPush) {
      noteUnsupported(frame, `Loop left ${arrayName} unknown: it is mutated beyond push`)
      forgetRoot(frame.env, arrayName)
      continue
    }

    const counts = result.paths.map(path => path.loop.appends.filter(append => append.arrayName === arrayName).length)
    const minPerIteration = Math.min(...counts)
    const maxPerIteration = Math.max(...counts)
    const count = analysis.loop.count

    const sites = result.paths.map(path => path.loop.appends
      .filter(append => append.arrayName === arrayName)
      .map(append => append.element))

    const startedEmpty = base.length.min === 0 && base.length.max === 0
    const leafForms = uniformLeafForms(sites, analysis)
    const renames = new Map<string, LinearExpr>()
    const exprOverrides = startedEmpty ? leafExprOverrides(arrayName, leafForms, analysis) : new Map<string, string>()
    let element = base.element
    for (const pathSites of sites) {
      for (const pushed of pathSites) {
        if (pushed == null) continue
        element = mergeElementValue(element, rebaseElementValue(pushed, arrayName, [], exprOverrides))
      }
    }

    const length = pushLengthValue(arrayName, base, count, minPerIteration, maxPerIteration)
    const conditional = minPerIteration !== maxPerIteration || minPerIteration === 0
    const origin = analysis.loop.sourceKind === 'count'
      ? null
      : conditional ? filterOrigin(analysis.loop.source, analysis.loop.sourceExpr) : mapOrigin(analysis.loop.source, analysis.loop.sourceExpr)

    let summary: ArraySummary | null = base.summary
    if (startedEmpty) {
      const derived = derivePushSummary(arrayName, sites, result, analysis)
      summary = {...mergeArraySummary({relations: [], advances: [], lastEnd: null, extentEnds: []}, derived)!, origin}
      publishElementFormFacts(arrayName, leafForms, renames, exprOverrides, analysis)
      liftElementAssumptions(renames, analysis)
    }

    writeMutationPath({root: arrayName, segments: []}, {
      ...base,
      length,
      elements: null,
      element,
      summary,
    }, frame)

    if (startedEmpty && maxPerIteration <= 1 && conditional) {
      const fact = comparisonConstraint(length, '<=', count, `${length.expr ?? arrayName + '.length'} <= ${count.expr ?? 'loop length'}`)
      if (fact != null) frame.assumptions = mergeAssumptions(frame.assumptions, [fact])
    }
    analysis.loop.claim.factRoots.add(arrayName)
  }

  // Mutated roots with no scalar summary and no push analysis (objects,
  // arrays written through element or method calls) end the loop unknown.
  for (const root of analysis.writeSet) {
    if (result.summaries.has(root) || arrayNames.has(root)) continue
    const start = frame.env.get(root)
    if (start == null) continue
    forgetRoot(frame.env, root)
  }
}

function pushLengthValue(arrayName: string, base: ArrayValue, count: NumberValue, minPerIteration: number, maxPerIteration: number): NumberValue {
  const startedEmpty = base.length.min === 0 && base.length.max === 0
  if (startedEmpty && minPerIteration === 1 && maxPerIteration === 1) return count
  if (minPerIteration === maxPerIteration) {
    const total = addNumbers(base.length, multiplyCount(count, minPerIteration))
    return numberValue(Math.max(0, total.min), Math.max(0, total.max), 0, `${arrayName}.length`, total.linear)
  }
  if (minPerIteration === 0 && maxPerIteration === 1) return conditionalPushLength(arrayName, count, base.length)
  const low = base.length.min + count.min * minPerIteration
  const high = base.length.max + count.max * maxPerIteration
  return numberValue(low, high, 0, `${arrayName}.length`, linearVariable(linearNameForExpression(`${arrayName}.length`)))
}

function multiplyCount(count: NumberValue, factor: number): NumberValue {
  if (factor === 1) return count
  return multiplyNumbers(count, numberValue(factor, factor, gridOfNumber(factor), `${factor}`, linearConstant(factor)))
}

// Rewrites a pushed element's numeric leaves onto the array's element paths:
// canonical path exprs and linear names, bounds kept. The bounds hold for
// every iteration because the narrowed run computed them against lifetime
// hulls; the leaves' internal forms surface separately as published
// equalities over the canonical names.
function rebaseElementValue(value: Value, arrayName: string, path: string[], exprOverrides: Map<string, string>): Value {
  if (value.kind === 'number') {
    const expr = exprOverrides.get(path.join('.')) ?? elementPathExpression(arrayName, path)
    return numberValue(value.min, value.max, value.grid, expr, linearVariable(linearNameForExpression(elementPathExpression(arrayName, path))), null, value.origin)
  }
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, rebaseElementValue(prop, arrayName, [...path, name], exprOverrides))
    return {...value, props, expr: elementPathExpression(arrayName, path)}
  }
  if (value.kind === 'array') {
    return {
      ...value,
      expr: elementPathExpression(arrayName, path),
      elements: value.elements == null ? null : value.elements.map(item => rebaseElementValue(item, arrayName, [...path, '[]'], exprOverrides)),
      element: value.element == null ? null : rebaseElementValue(value.element, arrayName, [...path, '[]'], exprOverrides),
    }
  }
  if (value.kind === 'nullable') return {...value, present: rebaseElementValue(value.present, arrayName, path, exprOverrides)}
  return value
}

// The element fields whose linear form is the same on every path and push
// site; only those describe every pushed element.
function uniformLeafForms(sites: (Value | null)[][], analysis: Analysis): Map<string, LinearExpr> {
  const formsByLeaf = new Map<string, {form: LinearExpr | null; uniform: boolean; count: number}>()
  let siteTotal = 0
  for (const pathSites of sites) {
    for (const pushed of pathSites) {
      if (pushed == null) continue
      siteTotal++
      for (const field of elementFieldForms(pushed, analysis)) {
        const key = field.path.join('.')
        const current = formsByLeaf.get(key)
        if (current == null) {
          formsByLeaf.set(key, {form: field.form, uniform: true, count: 1})
          continue
        }
        current.count++
        if (current.form == null || field.form == null || !sameLinear(current.form, field.form)) current.uniform = false
      }
    }
  }
  const uniform = new Map<string, LinearExpr>()
  for (const [key, leaf] of formsByLeaf) {
    if (leaf.uniform && leaf.form != null && leaf.count === siteTotal) uniform.set(key, leaf.form)
  }
  return uniform
}

// A field whose form is an item quantity, another field, or the sum of two
// other fields, gets that origin as its expression: rows[].height reads as
// items[].height and rows[].bottom as (rows[].y + rows[].height), which the
// infer layer reports as equalities.
function leafExprOverrides(arrayName: string, leafForms: Map<string, LinearExpr>, analysis: Analysis): Map<string, string> {
  const overrides = new Map<string, string>()
  const keys = [...leafForms.keys()]
  for (const key of keys) {
    const form = leafForms.get(key)!
    if (rationalIsZero(form.constant) && form.terms.size === 1) {
      const [name, coefficient] = [...form.terms.entries()][0]!
      // The provenance expr must stay meaningful after the loop: items[].height
      // does, a bare loop-local like the index name does not.
      const iterationExpr = analysis.iterationNames.get(name)?.expr ?? null
      if (rationalEquals(coefficient, rationalOne) && iterationExpr != null
        && !analysis.loop.iterationRoots.includes(iterationExpr) && !analysis.writeSet.has(iterationExpr)) {
        overrides.set(key, iterationExpr)
        continue
      }
    }
    for (const other of keys) {
      if (other === key) continue
      const single = linearSubtract(form, leafForms.get(other)!)
      if (single != null && isZeroLinear(single)) {
        overrides.set(key, leafPathExpression(arrayName, other))
        break
      }
    }
    if (overrides.has(key)) continue
    outer: for (let first = 0; first < keys.length; first++) {
      if (keys[first] === key) continue
      for (let second = first + 1; second < keys.length; second++) {
        if (keys[second] === key) continue
        const pair = linearSubtract(linearSubtract(form, leafForms.get(keys[first]!)!), leafForms.get(keys[second]!)!)
        if (pair != null && isZeroLinear(pair)) {
          overrides.set(key, `(${leafPathExpression(arrayName, keys[first]!)} + ${leafPathExpression(arrayName, keys[second]!)})`)
          break outer
        }
      }
    }
    if (overrides.has(key)) continue
    // A field computed as one rounded addition of two other fields (bottom =
    // cursor + size) keeps that single-op identity: the claim restating it
    // performs the same one addition on the same doubles. Leaf texts resolve
    // through the iteration's values so a source name reaches the same minted
    // symbol the other field's form carries.
    const atom = singleUnitAtom(form)
    const leaves = atom == null ? null : sumAtomLeaves(unprimed(atom))
    if (leaves != null && leaves.length === 2 && leaves.every(leaf => !leaf.negated)) {
      const leafMatchesForm = (leafName: string, otherForm: LinearExpr): boolean => {
        const formAtom = singleUnitAtom(otherForm)
        if (formAtom == null) return false
        if (formAtom === leafName) return true
        // A pre-state symbol's source root is how the leaf text names it at
        // push time.
        return analysis.preRoots.get(formAtom) === leafName
      }
      const first = keys.find(other => other !== key && leafMatchesForm(leaves[0]!.name, leafForms.get(other)!))
      const second = keys.find(other => other !== key && other !== first && leafMatchesForm(leaves[1]!.name, leafForms.get(other)!))
      if (first != null && second != null) {
        const firstExpr = overrides.get(first) ?? leafPathExpression(arrayName, first)
        const secondExpr = overrides.get(second) ?? leafPathExpression(arrayName, second)
        overrides.set(key, `(${firstExpr} + ${secondExpr})`)
      }
    }
  }
  return overrides
}

function leafPathExpression(arrayName: string, key: string): string {
  return key === '' ? `${arrayName}[]` : `${arrayName}[].${key}`
}

// Publishes what each element field IS in linear terms, over fresh
// loop-scoped symbols: rows[].bottom == rows[].y + rows[].height falls out of
// bottom = cursor + size and y = cursor.
function publishElementFormFacts(arrayName: string, leafForms: Map<string, LinearExpr>, renames: Map<string, LinearExpr>, overrides: Map<string, string>, analysis: Analysis) {
  const facts: LinearConstraint[] = []
  for (const [key, form] of leafForms) {
    const expr = leafPathExpression(arrayName, key)
    const canonical = linearVariable(linearNameForExpression(expr))
    const renamed = renamedElementLinear(form, arrayName, renames, analysis)
    if (renamed != null) {
      const diff = linearSubtract(canonical, renamed)
      if (diff != null) facts.push({diff: cleanLinear(diff), op: '==', source: 'code', leftExpr: expr})
    }
    // A leaf override names the same computation over the element's own
    // fields (bottom reads as rows[].y + rows[].height); the equality is the
    // determinism of one float op on the same doubles.
    const override = overrides.get(key)
    if (override != null) {
      const overrideDiff = linearSubtract(canonical, linearVariable(linearNameForExpression(override)))
      if (overrideDiff != null && !isZeroLinear(overrideDiff)) {
        facts.push({diff: cleanLinear(overrideDiff), op: '==', source: 'code', leftExpr: expr, rightExpr: override})
      }
    }
  }
  if (facts.length > 0) analysis.realFrame.assumptions = mergeAssumptions(analysis.realFrame.assumptions, facts)
}

function renamedElementLinear(linear: LinearExpr, arrayName: string, renames: Map<string, LinearExpr>, analysis: Analysis): LinearExpr | null {
  let result: LinearExpr | null = {constant: linear.constant, terms: new Map()}
  for (const [name, coefficient] of linear.terms) {
    let replacement = renames.get(name)
    if (replacement == null) {
      replacement = invariantLinearName(name, analysis)
        ? linearVariable(name)
        : linearVariable(`${name}@${arrayName}@${analysis.prefix}`)
      renames.set(name, replacement)
    }
    result = linearAdd(result, linearScaleExact(replacement, coefficient))
    if (result == null) return null
  }
  return cleanLinear(result)
}

// Per-iteration facts about quantities that became element fields hold for
// every pushed element: i < items.length lifts to rows[].index <
// items.length. A fact lifts when every non-invariant name it mentions is one
// the element renaming covers.
function liftElementAssumptions(renames: Map<string, LinearExpr>, analysis: Analysis) {
  const lifted: LinearConstraint[] = []
  for (const assumption of analysis.realFrame.assumptions) {
    if (assumption.diff == null) continue
    let touchesRename = false
    let liftable = true
    let diff: LinearExpr | null = {constant: assumption.diff.constant, terms: new Map()}
    for (const [name, coefficient] of assumption.diff.terms) {
      const replacement = renames.get(name)
      if (replacement != null) {
        touchesRename = true
        diff = linearAdd(diff, linearScaleExact(replacement, coefficient))
        continue
      }
      if (!invariantLinearName(name, analysis)) {
        liftable = false
        break
      }
      diff = linearAdd(diff, linearScaleExact(linearVariable(name), coefficient))
    }
    if (!touchesRename || !liftable || diff == null) continue
    lifted.push({
      diff: cleanLinear(diff),
      op: assumption.op,
      source: assumption.source,
      ...(assumption.integerStrict == null ? {} : {integerStrict: assumption.integerStrict}),
    })
  }
  if (lifted.length > 0) analysis.realFrame.assumptions = mergeAssumptions(analysis.realFrame.assumptions, lifted)
}

function elementPathExpression(arrayName: string, path: string[]): string {
  let expr = `${arrayName}[]`
  for (const part of path) expr += part === '[]' ? '[]' : `.${part}`
  return expr
}

// ——— sequence relations from linear forms

type FieldForm = {
  path: string[]
  form: LinearExpr | null
}

// One pre-state variable's per-iteration advance. `rounded` records that the
// runtime adds with rounding while the linear form is the real sum, so any
// relation built through it states the loop's computation, not an identity.
type TransferStep = {linear: LinearExpr | null; rounded: boolean}

type RelationPair = {
  prev: FieldForm[]
  next: FieldForm[]
  // null for two pushes inside one iteration; the previous path's per-variable
  // advance when the pair straddles an iteration boundary
  transfer: Map<string, TransferStep> | null
}

function derivePushSummary(arrayName: string, sites: (Value | null)[][], result: LoopResult, analysis: Analysis): ArraySummary | null {
  const pushingPaths: number[] = []
  const emptyPaths: number[] = []
  sites.forEach((pathSites, index) => (pathSites.length > 0 ? pushingPaths : emptyPaths).push(index))
  if (pushingPaths.length === 0) return null
  const siteCount = sites[pushingPaths[0]!]!.length
  if (!pushingPaths.every(index => sites[index]!.length === siteCount)) return null

  const fieldFormsByPath = pushingPaths.map(index => sites[index]!.map(site => elementFieldForms(site, analysis)))
  const fieldPaths = fieldFormsByPath[0]![0]!.map(field => field.path)
  if (fieldPaths.length === 0) return null
  const uniform = fieldFormsByPath.every(pathForms => pathForms.every(siteForms =>
    siteForms.length === fieldPaths.length && siteForms.every((field, index) => samePath(field.path, fieldPaths[index]!))))
  if (!uniform) return null

  // Pre-state roots read by element fields must stay frozen on non-pushing
  // paths, otherwise consecutive pushed elements straddle hidden cursor moves.
  const usedPreNames = new Set<string>()
  for (const pathForms of fieldFormsByPath) {
    for (const siteForms of pathForms) {
      for (const field of siteForms) {
        for (const name of field.form?.terms.keys() ?? []) {
          if (analysis.preRoots.has(name)) usedPreNames.add(name)
        }
      }
    }
  }
  for (const emptyIndex of emptyPaths) {
    const path = result.paths[emptyIndex]!
    for (const name of usedPreNames) {
      const effect = path.effects.get(analysis.preRoots.get(name)!) ?? {kind: 'unchanged'}
      if (effect.kind !== 'unchanged') return null
    }
  }

  const transfers = pushingPaths.map(index => pathTransfer(result.paths[index]!, analysis))
  const pairs: RelationPair[] = []
  for (const pathForms of fieldFormsByPath) {
    for (let site = 0; site + 1 < siteCount; site++) {
      pairs.push({prev: pathForms[site]!, next: pathForms[site + 1]!, transfer: null})
    }
  }
  for (let prevIndex = 0; prevIndex < pushingPaths.length; prevIndex++) {
    for (let nextIndex = 0; nextIndex < pushingPaths.length; nextIndex++) {
      pairs.push({
        prev: fieldFormsByPath[prevIndex]![siteCount - 1]!,
        next: fieldFormsByPath[nextIndex]![0]!,
        transfer: transfers[prevIndex]!,
      })
    }
  }

  const summary: ArraySummary = {relations: [], advances: [], lastEnd: null, extentEnds: []}
  for (let field = 0; field < fieldPaths.length; field++) {
    const candidates = relationCandidates(field, fieldPaths.length, pairs, analysis)
    const covered = new Set(candidates.map(candidate => candidate.terms.join(',')))
    for (const candidate of computationRelationCandidates(field, fieldPaths.length, pairs, analysis)) {
      if (!covered.has(candidate.terms.join(','))) candidates.push(candidate)
    }
    for (const candidate of candidates) {
      const relation = relationFromCandidate(fieldPaths, candidate)
      if (relation != null) summary.relations.push(relation)
    }
    deriveNondecreasing(field, fieldPaths, pairs, summary, analysis)
  }
  deriveAdvancesAndEnds(arrayName, fieldPaths, fieldFormsByPath, result, emptyPaths.length > 0, summary, analysis)
  return summary
}

function elementFieldForms(element: Value | null, analysis: Analysis): FieldForm[] {
  const fields: FieldForm[] = []
  const walk = (value: Value, path: string[]) => {
    if (value.kind === 'number') {
      fields.push({path, form: value.linear != null && stableLinear(value.linear, analysis) ? value.linear : null})
      return
    }
    if (value.kind === 'object') {
      for (const [name, prop] of value.props) walk(prop, [...path, name])
    }
  }
  if (element != null) walk(element, [])
  return fields
}

function pathTransfer(path: PathState, analysis: Analysis): Map<string, TransferStep> {
  const transfer = new Map<string, TransferStep>()
  for (const [name, root] of analysis.preRoots) {
    const effect = path.effects.get(root) ?? {kind: 'unchanged'}
    if (effect.kind === 'unchanged') {
      transfer.set(name, {linear: linearVariable(name), rounded: false})
      continue
    }
    if (effect.kind !== 'add' || effect.delta.linear == null) {
      transfer.set(name, {linear: null, rounded: true})
      continue
    }
    const pre = analysis.mintedValues.get(name)
    const exact = pre != null && additionIsExact(pre, effect.delta)
    transfer.set(name, {linear: linearAdd(linearVariable(name), effect.delta.linear), rounded: !exact})
  }
  return transfer
}

type RelationCandidate = {field: number; terms: number[]; gamma: LinearExpr; rounded: boolean}

// Candidate relation shapes mirror the sequence grammar: next.f against one
// previous field, or against the previous f plus one other field. A candidate
// holds when every consecutive-pair difference leaves the same loop-invariant
// residue.
function relationCandidates(field: number, fieldCount: number, pairs: RelationPair[], analysis: Analysis): RelationCandidate[] {
  if (pairs.length === 0) return []
  const termSets: number[][] = []
  for (let other = 0; other < fieldCount; other++) termSets.push([other])
  for (let other = 0; other < fieldCount; other++) {
    if (other !== field) termSets.push([field, other])
  }

  const candidates: RelationCandidate[] = []
  for (const terms of termSets) {
    let gamma: LinearExpr | null = null
    let rounded = false
    let valid = true
    for (const pair of pairs) {
      const residue = pairResidue(field, terms, pair, analysis)
      if (residue == null || !invariantLinear(residue.linear, analysis) || (gamma != null && !sameLinear(gamma, residue.linear))) {
        valid = false
        break
      }
      gamma = residue.linear
      rounded = rounded || residue.rounded
    }
    // A gamma naming an arithmetic atom (e.g. `(step + gap)` minus `step`)
    // is an artifact of one opaque computation failing to cancel against
    // another; the computation candidates state that recurrence properly.
    if (valid && gamma != null && ![...gamma.terms.keys()].some(arithmeticAtomName)) {
      candidates.push({field, terms, gamma, rounded})
    }
  }
  return candidates
}

function arithmeticAtomName(name: string): boolean {
  try {
    const expression = unwrapExpression(fitExpressionParsed(name).expression)
    return ts.isBinaryExpression(expression)
  } catch {
    return false
  }
}

// A rounded cursor still advances by the computation the source wrote: when
// the consecutive-pair residue is one opaque sum atom, its parsed leaves are
// that computation. A positive leaf matching another pushed field cancels
// structurally, and the remaining loop-invariant leaves are the gamma. The
// relation states the code's own recurrence in whatever grouping it used,
// so it is always marked rounded.
function computationRelationCandidates(field: number, fieldCount: number, pairs: RelationPair[], analysis: Analysis): RelationCandidate[] {
  if (pairs.length === 0) return []
  const candidates: RelationCandidate[] = []
  for (let other = 0; other < fieldCount; other++) {
    if (other === field) continue
    let gamma: LinearExpr | null = null
    let valid = true
    for (const pair of pairs) {
      const residue = pairResidue(field, [field], pair, analysis)
      const atom = residue == null ? null : singleUnitAtom(residue.linear)
      const otherAtom = singleUnitAtom(pair.prev[other]?.form ?? null)
      if (atom == null || otherAtom == null) {
        valid = false
        break
      }
      const leaves = sumAtomLeaves(unprimed(atom))
      const matchIndex = leaves == null ? -1 : leaves.findIndex(leaf => !leaf.negated && leaf.name === otherAtom)
      if (leaves == null || matchIndex < 0) {
        valid = false
        break
      }
      let pairGamma: LinearExpr | null = {constant: rationalZero, terms: new Map()}
      for (let index = 0; index < leaves.length; index++) {
        if (index === matchIndex) continue
        const leaf = leaves[index]!
        if (!invariantLinearName(leaf.name, analysis)) {
          pairGamma = null
          break
        }
        const part = leaf.negated ? linearScaleExact(linearVariable(leaf.name), rationalNegate(rationalOne)) : linearVariable(leaf.name)
        pairGamma = linearAdd(pairGamma, part)
      }
      if (pairGamma == null || (gamma != null && !sameLinear(gamma, pairGamma))) {
        valid = false
        break
      }
      gamma = pairGamma
    }
    if (valid && gamma != null) candidates.push({field, terms: [field, other], gamma, rounded: true})
  }
  return candidates
}

// Sum-tree leaves of an opaque atom's computation text, sign included; null
// for shapes that are not pure sums (a product leaf would need its own
// rounding story).
function sumAtomLeaves(name: string): {name: string; negated: boolean}[] | null {
  let parsed: ParsedFitExpression
  try {
    parsed = fitExpressionParsed(name)
  } catch {
    return null
  }
  const leaves: {name: string; negated: boolean}[] = []
  const visit = (node: ts.Expression, negated: boolean): boolean => {
    const current = unwrapExpression(node)
    if (ts.isBinaryExpression(current)) {
      const op = current.operatorToken.kind
      if (op === ts.SyntaxKind.PlusToken) return visit(current.left, negated) && visit(current.right, negated)
      if (op === ts.SyntaxKind.MinusToken) return visit(current.left, negated) && visit(current.right, !negated)
      return false
    }
    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
      return visit(current.operand, !negated)
    }
    leaves.push({name: current.getText(), negated})
    return true
  }
  return visit(parsed.expression, false) && leaves.length > 1 ? leaves : null
}

function pairResidue(field: number, terms: number[], pair: RelationPair, analysis: Analysis): {linear: LinearExpr; rounded: boolean} | null {
  const nextForm = pair.next[field]?.form
  if (nextForm == null) return null
  const substituted = pair.transfer == null ? {linear: nextForm, rounded: false} : substituteNextForm(nextForm, pair.transfer, analysis)
  if (substituted == null) return null
  let residue: LinearExpr | null = substituted.linear
  for (const term of terms) {
    const prevForm = pair.prev[term]?.form
    if (prevForm == null) return null
    residue = linearSubtract(residue, prevForm)
  }
  return residue == null ? null : {linear: residue, rounded: substituted.rounded}
}

// Express the next pushed element over the previous iteration's symbols: each
// pre-state symbol advances by that path's transfer, and every per-iteration
// name is renamed apart so values from different iterations can never cancel.
function substituteNextForm(form: LinearExpr, transfer: Map<string, TransferStep>, analysis: Analysis): {linear: LinearExpr; rounded: boolean} | null {
  let result: LinearExpr | null = {constant: form.constant, terms: new Map()}
  let rounded = false
  for (const [name, coefficient] of form.terms) {
    let replacement: LinearExpr | null
    if (analysis.preRoots.has(name)) {
      const step = transfer.get(name) ?? null
      replacement = step?.linear ?? null
      rounded = rounded || (step?.rounded ?? true)
    } else if (invariantLinearName(name, analysis)) {
      replacement = linearVariable(name)
    } else {
      replacement = linearVariable(`${name}#next`)
    }
    result = replacement == null ? null : linearAdd(result, linearScaleExact(replacement, coefficient))
    if (result == null) return null
  }
  return {linear: cleanLinear(result), rounded}
}

// A residue is loop-invariant when every name in it denotes a value untouched
// by the iteration: not a pre-state symbol, not an item/index-derived name,
// not minted, and its source roots are outside the write set.
function invariantLinear(linear: LinearExpr, analysis: Analysis): boolean {
  for (const name of linear.terms.keys()) {
    if (!invariantLinearName(name, analysis)) return false
  }
  return true
}

function invariantLinearName(name: string, analysis: Analysis): boolean {
  const cached = analysis.invariantCache.get(name)
  if (cached != null) return cached
  const invariant = computeInvariantLinearName(name, analysis)
  analysis.invariantCache.set(name, invariant)
  return invariant
}

function computeInvariantLinearName(name: string, analysis: Analysis): boolean {
  if (analysis.preRoots.has(name) || analysis.mintedValues.has(name) || analysis.iterationNames.has(name)) return false
  if (name.endsWith('#next')) return false
  let parsed: ParsedFitExpression
  try {
    parsed = fitExpressionParsed(name)
  } catch {
    return false
  }
  // A name carrying a domain path (items[].height) denotes per-iteration
  // values, never a loop invariant.
  if (parsed.domainPaths.size > 0) return false
  for (const root of expressionIdentifierRoots(parsed.expression)) {
    if (analysis.writeSet.has(root) || analysis.loop.iterationRoots.includes(root)) return false
  }
  return true
}

// The identifiers a parsed canonical name reads from scope: property names
// after a dot do not count, everything else does.
function expressionIdentifierRoots(expression: ts.Expression): string[] {
  const roots: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      roots.push(node.text)
      return
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return roots
}

function relationFromCandidate(fieldPaths: string[][], candidate: RelationCandidate): SequenceRelation | null {
  const addends: string[] = []
  if (!isZeroLinear(candidate.gamma)) {
    const rendered = renderLinear(candidate.gamma)
    if (rendered == null) return null
    addends.push(rendered)
  }
  return {
    kind: 'adjacent-comparison',
    left: {item: 'next', path: fieldPaths[candidate.field]!},
    op: '==',
    right: {
      terms: candidate.terms.map(term => ({item: 'previous' as const, path: fieldPaths[term]!})),
      addends,
    },
    ...(candidate.rounded ? {rounded: true as const} : {}),
  }
}

// Addends print as doubles and are later matched by resolved value. A
// coefficient that does not round-trip exactly (e.g. a third) has no faithful
// claim text, and a lossy print could match the wrong number; the relation is
// dropped instead.
function renderLinear(linear: LinearExpr): string | null {
  if (!rationalIsExactNumber(linear.constant)) return null
  const parts: string[] = []
  const constant = rationalToNumber(linear.constant)
  for (const [name, coefficient] of [...linear.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!rationalIsExactNumber(coefficient)) return null
    const value = rationalToNumber(coefficient)
    parts.push(value === 1 ? name : `${value} * (${name})`)
  }
  if (constant !== 0 || parts.length === 0) parts.push(`${constant}`)
  return parts.join(' + ')
}

function deriveNondecreasing(field: number, fieldPaths: string[][], pairs: RelationPair[], summary: ArraySummary, analysis: Analysis) {
  if (pairs.length === 0) return
  for (const pair of pairs) {
    const residue = pairResidue(field, [field], pair, analysis)
    if (residue == null || !provedNonnegativeResidue(residue.linear, analysis)) return
  }
  summary.relations.push({
    kind: 'adjacent-comparison',
    left: {item: 'next', path: fieldPaths[field]!},
    op: '>=',
    right: {terms: [{item: 'previous', path: fieldPaths[field]!}], addends: []},
  })
}

function provedNonnegativeResidue(residue: LinearExpr, analysis: Analysis): boolean {
  const bounds = residueBounds(residue, analysis)
  if (bounds != null && bounds.min >= 0) return true
  const value = numberValue(bounds?.min ?? -Infinity, bounds?.max ?? Infinity, null, null, residue)
  const zero = numberValue(0, 0, 0, '0', linearConstant(0))
  return proveComparison(value, '>=', zero, analysis.realFrame.assumptions).status === 'pass'
}

// Bounds accumulate in exact rationals: residue coefficients (e.g. thirds
// from a /3 step) are not representable doubles, and float accumulation here
// could tighten a bound past the true extremum. Converting out rounds
// outward. A null min/max means that side is unbounded.
function residueBounds(residue: LinearExpr, analysis: Analysis): {min: number; max: number; isInteger: boolean} | null {
  let min: Rational | null = residue.constant
  let max: Rational | null = residue.constant
  let isInteger = residue.constant.den === 1n
  for (const [name, coefficient] of residue.terms) {
    const value = residueNameValue(name, analysis)
    if (value == null) return null
    const negative = rationalIsNegative(coefficient)
    const lowEnd = negative ? value.max : value.min
    const highEnd = negative ? value.min : value.max
    // A value pinned at an infinite endpoint cannot contribute a finite bound
    // in either direction.
    if (lowEnd === Number.POSITIVE_INFINITY || highEnd === Number.NEGATIVE_INFINITY) return null
    if (min != null) {
      const low = rationalFromNumber(lowEnd)
      min = low == null ? null : rationalAdd(min, rationalMultiply(coefficient, low))
    }
    if (max != null) {
      const high = rationalFromNumber(highEnd)
      max = high == null ? null : rationalAdd(max, rationalMultiply(coefficient, high))
    }
    isInteger = isInteger && integerValued(value) && coefficient.den === 1n
  }
  if (min == null && max == null) return null
  return {
    min: min == null ? Number.NEGATIVE_INFINITY : rationalToNumberFloor(min),
    max: max == null ? Number.POSITIVE_INFINITY : rationalToNumberCeil(max),
    isInteger,
  }
}

function residueNameValue(name: string, analysis: Analysis): NumberValue | null {
  const iteration = analysis.iterationNames.get(name) ?? analysis.iterationNames.get(unprimed(name))
  if (iteration != null) return iteration
  const minted = analysis.mintedValues.get(name) ?? analysis.mintedValues.get(unprimed(name))
  if (minted != null) return minted
  const direct = analysis.realFrame.env.get(name)
  if (direct?.kind === 'number') return direct
  if (invariantLinearName(name, analysis)) return invariantNameValue(name, analysis)
  return iterationBoundNameValue(unprimed(name), analysis)
}

// A per-iteration name like items[i].height still has iteration-uniform
// bounds; resolve it by evaluating in the frame where the item and index are
// bound. Composite names can carry `items[].height`-style domain segments
// (an opaque sum atom keeps its operands' display paths), so parsing goes
// through the fit-expression parser, with each domain path bound to its
// per-iteration value.
function iterationBoundNameValue(name: string, analysis: Analysis): NumberValue | null {
  const baseFrame = analysis.iterationFrame ?? analysis.realFrame
  let parsed: ParsedFitExpression
  try {
    parsed = fitExpressionParsed(name)
  } catch {
    return null
  }
  const roots = expressionIdentifierRoots(parsed.expression)
  const env = new Map(baseFrame.env)
  for (const [syntheticName] of parsed.domainPaths) {
    const value = analysis.iterationNames.get(syntheticName) ?? analysis.mintedValues.get(syntheticName)
    if (value == null) return null
    env.set(syntheticName, value)
  }
  if (roots.some(root => analysis.writeSet.has(root) && !parsed.domainPaths.has(root))) return null
  const value = analysis.context.evaluateExpression(parsed.expression, pathFrame(baseFrame, env))
  return value.kind === 'number' ? value : null
}

// Resolves a loop-invariant canonical name (an identifier or a pure path like
// this.padding) back to its abstract value by evaluating it in a throwaway
// frame.
function invariantNameValue(name: string, analysis: Analysis): NumberValue | null {
  try {
    const expression = parseExpression(name)
    const value = analysis.context.evaluateExpression(expression, pathFrame(analysis.realFrame, new Map(analysis.realFrame.env)))
    return value.kind === 'number' ? value : null
  } catch {
    return null
  }
}

function unprimed(name: string): string {
  return name.endsWith('#next') ? name.slice(0, -'#next'.length) : name
}

function deriveAdvancesAndEnds(
  arrayName: string,
  fieldPaths: string[][],
  fieldFormsByPath: FieldForm[][][],
  result: LoopResult,
  conditional: boolean,
  summary: ArraySummary,
  analysis: Analysis,
) {
  for (let field = 0; field < fieldPaths.length; field++) {
    const cursorRoot = cursorRootForField(field, fieldFormsByPath, analysis)
    if (cursorRoot == null) continue
    const cursorSummary = result.summaries.get(cursorRoot)
    if (cursorSummary?.kind !== 'add') continue
    summary.advances.push({prop: fieldPaths[field]!.join('.'), value: cursorSummary.delta})

    if (conditional) continue
    const start = analysis.realFrame.env.get(cursorRoot)
    if (start?.kind !== 'number') continue

    for (const relation of summary.relations) {
      if (relation.op !== '==' || !samePath(relation.left.path, fieldPaths[field]!)) continue
      const sizeTerm = relationSizeTerm(relation, fieldPaths[field]!)
      if (sizeTerm == null) continue
      const gammaValue = addendsValue(relation.right.addends, analysis)
      if (gammaValue == null) continue
      // With count >= 1, the cursor's post-loop closed form IS the last end
      // plus gamma; reusing it keeps the linear identity that proves
      // `cursor == lastEnd(rows)` claims after the loop.
      const end = analysis.loop.count.min >= 1
        ? runningSumNumber(cursorRoot, start, analysis.loop.count, cursorSummary.delta)
        : nonEmptyLoopEnd(`lastEnd(${arrayName})`, start, cursorSummary.delta, analysis.loop.count)
      const lastEnd = gammaValue.min === 0 && gammaValue.max === 0 ? end : subtractNumbers(end, gammaValue)
      if (analysis.loop.count.min >= 1) {
        summary.lastEnd = {value: lastEnd, positionPath: fieldPaths[field]!, sizePath: sizeTerm}
      }
      if (start.expr != null) {
        summary.extentEnds.push({
          emptyExpr: start.expr,
          value: numberValue(
            Math.min(start.min, lastEnd.min),
            Math.max(start.max, lastEnd.max),
            gridJoin(start.grid, lastEnd.grid),
            `extentEnd(${arrayName}, ${start.expr})`,
          ),
          positionPath: fieldPaths[field]!,
          sizePath: sizeTerm,
        })
      }
      break
    }
  }
}

// The size side of a cursor relation: prev.position + prev.size (two terms,
// one of them the cursor field) or prev.end (one term, a different field).
function relationSizeTerm(relation: SequenceRelation, cursorPath: string[]): string[] | null {
  const terms = relation.right.terms
  if (terms.length === 2 && terms.some(term => samePath(term.path, cursorPath))) {
    return terms.find(term => !samePath(term.path, cursorPath))?.path ?? null
  }
  if (terms.length === 1 && !samePath(terms[0]!.path, cursorPath)) return terms[0]!.path
  return null
}

function cursorRootForField(field: number, fieldFormsByPath: FieldForm[][][], analysis: Analysis): string | null {
  let root: string | null = null
  for (const pathForms of fieldFormsByPath) {
    for (const siteForms of pathForms) {
      const form = siteForms[field]?.form
      if (form == null || !rationalIsZero(form.constant) || form.terms.size !== 1) return null
      const [name, coefficient] = [...form.terms.entries()][0]!
      if (!rationalEquals(coefficient, rationalOne)) return null
      const formRoot = analysis.preRoots.get(name)
      if (formRoot == null) return null
      if (root == null) root = formRoot
      else if (root !== formRoot) return null
    }
  }
  return root
}

function addendsValue(addends: string[], analysis: Analysis): NumberValue | null {
  let total: NumberValue | null = null
  for (const addend of addends) {
    const value = invariantNameValue(addend, analysis)
    if (value == null) return null
    total = total == null ? value : addNumbers(total, value)
  }
  return total ?? numberValue(0, 0, 0, '0', linearConstant(0))
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}
