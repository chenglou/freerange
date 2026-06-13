import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {resolveCallTarget} from './call-targets.ts'
import {isAssignmentOperator, unwrapExpression} from './source-syntax.ts'

// What a call can change in its caller's world, beyond returning a value.
// `mutatesParams` holds parameter indexes whose argument may be written through,
// or stored somewhere that outlives the call; the caller forgets the argument's
// roots either way, because facts cannot be re-established through an alias it
// no longer sees. `writesOuter` holds module-scope roots the function (or
// anything it calls) writes, qualified by source id so same-named roots in
// other modules stay untouched.
// The first three fields are what a call changes in its caller's world; the
// interpreter's fact-forgetting reads only those. The last three extend the
// summary to the stricter notion a `pure` annotation needs: a pure function not
// only writes nothing observable, it also reads no mutable outside state, never
// observes or affects the environment (I/O, the clock, randomness), and calls
// nothing it cannot see into. Purity is derived from these (see isFunctionPure),
// never stored separately.
export type FunctionEffects = {
  writesOuter: Set<string>
  mutatesParams: Set<number>
  mutatesThis: boolean
  // reads a module-level `let`/`var`, or a `const` object/array's fields — a
  // value that some other code can change, so the result is not deterministic
  readsMutableOuter: boolean
  // calls console.*, Date.now, performance.now, or Math.random: I/O or a value
  // that differs across runs with the same inputs
  observesEnvironment: boolean
  // calls something the analysis cannot resolve to a known function or method,
  // so it could do anything — the unknown-means-impure default
  callsUnknown: boolean
}

const noEffects = (): FunctionEffects => ({
  writesOuter: new Set(),
  mutatesParams: new Set(),
  mutatesThis: false,
  readsMutableOuter: false,
  observesEnvironment: false,
  callsUnknown: false,
})

// A function is pure when it changes nothing observable, reads no mutable
// outside state, observes no environment, and calls nothing unanalyzable. Local
// mutation, allocation, throwing, and reading module-level `const` primitives
// are all fine. A definite effect (mutation, an outer write, an environment
// observation, a mutable read) is `certain` — the function is provably impure.
// An unanalyzable call is not certain: the callee could be pure or not, so the
// claim is unproven rather than disproven. Derived from the effect summary, so
// there is one source of truth.
export type Purity =
  | {pure: true}
  | {pure: false; certain: boolean; reason: string}

export function functionPurity(node: FunctionLikeNode, program: Program): Purity {
  const effects = functionEffects(node, program)
  const mutatedParam = [...effects.mutatesParams][0]
  if (mutatedParam != null) {
    const parameter = node.parameters[mutatedParam]?.name
    const name = parameter != null && ts.isIdentifier(parameter) ? parameter.text : null
    return {pure: false, certain: true, reason: name == null ? 'mutates a parameter' : `mutates parameter \`${name}\``}
  }
  if (effects.mutatesThis) return {pure: false, certain: true, reason: 'mutates `this`'}
  const writtenOuter = [...effects.writesOuter][0]
  if (writtenOuter != null) {
    const root = writtenOuter.slice(writtenOuter.indexOf('#') + 1)
    return {pure: false, certain: true, reason: `writes outside state \`${root}\``}
  }
  if (effects.readsMutableOuter) return {pure: false, certain: true, reason: 'reads mutable outside state'}
  if (effects.observesEnvironment) return {pure: false, certain: true, reason: 'observes the environment (I/O, the clock, or randomness)'}
  if (effects.callsUnknown) return {pure: false, certain: false, reason: 'calls a function whose body cannot be analyzed'}
  return {pure: true}
}

export type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

export function outerWriteKey(sourceId: string, root: string) {
  return `${sourceId}#${root}`
}

export function outerWriteRoot(key: string, sourceId: string): string | null {
  return key.startsWith(`${sourceId}#`) ? key.slice(sourceId.length + 1) : null
}

// Real platform globals whose listed members neither mutate their arguments nor
// reach back into user module state. Anything not listed is treated as an
// unknown call. Object.assign is deliberately absent: it mutates its target.
const pureGlobalMembers = new Map<string, 'all' | Set<string>>([
  ['Math', 'all'],
  ['JSON', 'all'],
  ['console', 'all'],
  ['Number', 'all'],
  ['String', 'all'],
  ['Boolean', 'all'],
  ['Date', new Set(['now', 'parse', 'UTC'])],
  ['performance', new Set(['now'])],
  ['Object', new Set(['keys', 'values', 'entries', 'freeze', 'isFrozen', 'getOwnPropertyNames'])],
  ['Array', new Set(['isArray', 'of', 'from'])],
])

export function isPureGlobalMemberCall(base: string, member: string): boolean {
  const members = pureGlobalMembers.get(base)
  if (members == null) return false
  return members === 'all' || members.has(member)
}

// Globals that do not mutate caller state but still break purity: console writes
// to the outside world (I/O), and the clock and randomness return a different
// value each run with the same inputs (nondeterminism). They stay in
// pureGlobalMembers (they corrupt no facts) but make a calling function impure.
const environmentObservingMembers = new Map<string, 'all' | Set<string>>([
  ['console', 'all'], // every console method writes to the outside world
  ['Date', new Set(['now'])], // parse/UTC are deterministic given their arguments
  ['performance', new Set(['now'])],
  ['Math', new Set(['random'])], // every other Math member is deterministic
])

function isEnvironmentObservingCall(base: string, member: string): boolean {
  const members = environmentObservingMembers.get(base)
  if (members == null) return false
  return members === 'all' || members.has(member)
}

// Methods known to mutate their receiver in place (rather than returning a new
// value). On a local the function created this is fine; on a parameter, `this`,
// or a module root it is a caller-visible write — both handled by the receiver
// classification. What matters for purity is that these are *known*: a method
// not listed here and not in nonMutatingMethodNames is unanalyzable, so calling
// it is treated as an unknown call.
const knownMutatingMethodNames = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  'set', 'add', 'delete', 'clear',
])

// Methods that do not mutate their receiver. Mutation through their callback's
// parameters is accounted for separately (a callback that writes its parameters
// can reach the receiver's elements).
const nonMutatingMethodNames = new Set([
  'at', 'map', 'filter', 'every', 'some', 'forEach', 'reduce', 'reduceRight',
  'slice', 'indexOf', 'lastIndexOf', 'includes', 'join', 'concat',
  'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap',
  'keys', 'values', 'entries', 'toString', 'toLocaleString',
  'toReversed', 'toSorted', 'toSpliced', 'with',
])

type RootKind =
  | {kind: 'param'; index: number}
  | {kind: 'outer'; key: string}
  | {kind: 'this'}

type CallEdge = {
  callee: FunctionLikeNode
  // classified roots per caller argument position; `null` marks a spread
  // argument whose positions cannot be mapped
  argumentRoots: (RootKind[] | null)[]
  receiverRoots: RootKind[]
  // a callback whose own parameter mutations must spill onto these roots
  callbackSpill: RootKind[] | null
}

type MemberInfo = {
  effects: FunctionEffects
  edges: CallEdge[]
}

const effectsCache = new WeakMap<ts.Node, FunctionEffects>()

export function functionEffects(node: FunctionLikeNode, program: Program): FunctionEffects {
  const cached = effectsCache.get(node)
  if (cached != null) return cached
  const members = new Map<FunctionLikeNode, MemberInfo>()
  collectMember(node, program, members)
  for (let changed = true; changed;) {
    changed = false
    for (const member of members.values()) {
      for (const edge of member.edges) {
        const callee = effectsCache.get(edge.callee) ?? members.get(edge.callee)?.effects
        if (callee == null) continue
        if (composeEdge(member.effects, edge, callee)) changed = true
      }
    }
  }
  for (const [memberNode, member] of members) effectsCache.set(memberNode, member.effects)
  return members.get(node)!.effects
}

function composeEdge(into: FunctionEffects, edge: CallEdge, callee: FunctionEffects): boolean {
  let changed = false
  const add = (roots: RootKind[]) => {
    for (const root of roots) {
      if (root.kind === 'param' && !into.mutatesParams.has(root.index)) {
        into.mutatesParams.add(root.index)
        changed = true
      }
      if (root.kind === 'outer' && !into.writesOuter.has(root.key)) {
        into.writesOuter.add(root.key)
        changed = true
      }
      if (root.kind === 'this' && !into.mutatesThis) {
        into.mutatesThis = true
        changed = true
      }
    }
  }
  for (const key of callee.writesOuter) {
    if (!into.writesOuter.has(key)) {
      into.writesOuter.add(key)
      changed = true
    }
  }
  // These three describe the callee itself, not anything it does through this
  // edge's arguments, so they propagate to every caller unconditionally: calling
  // an impure function is impure.
  if (callee.readsMutableOuter && !into.readsMutableOuter) {
    into.readsMutableOuter = true
    changed = true
  }
  if (callee.observesEnvironment && !into.observesEnvironment) {
    into.observesEnvironment = true
    changed = true
  }
  if (callee.callsUnknown && !into.callsUnknown) {
    into.callsUnknown = true
    changed = true
  }
  if (callee.mutatesThis) add(edge.receiverRoots)
  if (callee.mutatesParams.size > 0) {
    const hasSpread = edge.argumentRoots.some(roots => roots == null)
    for (const index of callee.mutatesParams) {
      const rest = edge.callee.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) add(roots ?? [])
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) add(roots ?? [])
      } else {
        add(edge.argumentRoots[index] ?? [])
      }
    }
    if (edge.callbackSpill != null) add(edge.callbackSpill)
  }
  return changed
}

function collectMember(node: FunctionLikeNode, program: Program, members: Map<FunctionLikeNode, MemberInfo>) {
  if (members.has(node) || effectsCache.has(node)) return
  const member: MemberInfo = {
    effects: noEffects(),
    edges: [],
  }
  members.set(node, member)
  const scope = buildScope(node, program)
  const classifiers = makeClassifiers(scope, program)
  collectWrites(node, program, member, classifiers, members)
}

type Scope = {
  paramIndexByName: Map<string, number>
  declaredNames: Set<string>
  // ys = xs: ys IS the same container; mutating ys mutates xs.
  containerSources: Map<string, Set<string>>
  // ys.push(box), obj.field = box: box is reachable FROM the container; only a
  // later write through the container can hit it, mutating the container's own
  // shape (push, sort) cannot.
  reachableSources: Map<string, Set<string>>
}

// Methods that store their arguments inside the receiver.
const retainingMethodNames = new Set(['push', 'unshift', 'splice', 'fill'])

function buildScope(node: FunctionLikeNode, program: Program): Scope {
  const paramIndexByName = new Map<string, number>()
  node.parameters.forEach((parameter, index) => {
    for (const name of bindingNames(parameter.name)) paramIndexByName.set(name, index)
  })
  const declaredNames = new Set<string>()
  const containerEdges: {target: string; sourceRoots: string[]}[] = []
  const reachableEdges: {target: string; sourceRoots: string[]}[] = []
  const visit = (current: ts.Node) => {
    if (ts.isVariableDeclaration(current)) {
      const names = bindingNames(current.name)
      for (const name of names) declaredNames.add(name)
      if (current.initializer != null) {
        const sourceRoots = expressionRoots(current.initializer, program)
        for (const name of names) containerEdges.push({target: name, sourceRoots})
      }
    }
    if (ts.isFunctionDeclaration(current) && current.name != null) declaredNames.add(current.name.text)
    if (ts.isClassDeclaration(current) && current.name != null) declaredNames.add(current.name.text)
    if (current !== node && isFunctionLike(current)) {
      for (const parameter of current.parameters) {
        for (const name of bindingNames(parameter.name)) declaredNames.add(name)
      }
    }
    if (ts.isCatchClause(current) && current.variableDeclaration != null) {
      for (const name of bindingNames(current.variableDeclaration.name)) declaredNames.add(name)
    }
    if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
      const target = unwrapExpression(current.left)
      if (ts.isIdentifier(target)) {
        containerEdges.push({target: target.text, sourceRoots: expressionRoots(current.right, program)})
      } else {
        const base = pathWriteBaseRoot(target)
        if (base != null) reachableEdges.push({target: base, sourceRoots: expressionRoots(current.right, program)})
      }
    }
    if (ts.isCallExpression(current)) {
      const target = unwrapExpression(current.expression)
      if (ts.isPropertyAccessExpression(target) && retainingMethodNames.has(target.name.text)) {
        const base = pathWriteBaseRoot(target.expression)
        if (base != null) {
          for (const argument of current.arguments) {
            const expression = ts.isSpreadElement(argument) ? argument.expression : argument
            reachableEdges.push({target: base, sourceRoots: expressionRoots(expression, program)})
          }
        }
      }
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(node, visit)

  // Container aliasing is symmetric (both names hold the same object), so a
  // write through either name must see what was retained through the other.
  const symmetricContainerEdges = [
    ...containerEdges,
    ...containerEdges.flatMap(edge => edge.sourceRoots.map(root => ({target: root, sourceRoots: [edge.target]}))),
  ]
  return {
    paramIndexByName,
    declaredNames,
    containerSources: closeSourceEdges(symmetricContainerEdges),
    reachableSources: closeSourceEdges(reachableEdges),
  }
}

// Flow-insensitive closure: a name that ever received a root carries that
// root's own sources transitively.
function closeSourceEdges(edges: {target: string; sourceRoots: string[]}[]): Map<string, Set<string>> {
  const sources = new Map<string, Set<string>>()
  for (let changed = true; changed;) {
    changed = false
    for (const {target, sourceRoots} of edges) {
      let targetSources = sources.get(target)
      for (const root of sourceRoots) {
        const additions = [root, ...(sources.get(root) ?? [])]
        for (const addition of additions) {
          if (addition === target) continue
          if (targetSources == null) {
            targetSources = new Set()
            sources.set(target, targetSources)
          }
          if (!targetSources.has(addition)) {
            targetSources.add(addition)
            changed = true
          }
        }
      }
    }
  }
  return sources
}

function pathWriteBaseRoot(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return current.text
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) return pathWriteBaseRoot(current.expression)
  return null
}

type Classifier = (rootName: string) => RootKind[]

type Classifiers = {
  // mutations of the container itself: the root plus everything it container-aliases
  container: Classifier
  // writes through the container: additionally everything retained inside it
  reach: Classifier
}

function makeClassifiers(scope: Scope, program: Program): Classifiers {
  const classifyDirect = (rootName: string, seen: Set<string>, includeReachable: boolean): RootKind[] => {
    const result: RootKind[] = []
    if (rootName === 'this') {
      result.push({kind: 'this'})
    } else {
      const paramIndex = scope.paramIndexByName.get(rootName)
      if (paramIndex != null) result.push({kind: 'param', index: paramIndex})
      else if (!scope.declaredNames.has(rootName)) result.push({kind: 'outer', key: outerWriteKey(program.sourceId, rootName)})
    }
    const sources = [
      ...(scope.containerSources.get(rootName) ?? []),
      ...(includeReachable ? scope.reachableSources.get(rootName) ?? [] : []),
    ]
    for (const source of sources) {
      if (seen.has(source)) continue
      seen.add(source)
      result.push(...classifyDirect(source, seen, includeReachable))
    }
    return result
  }
  return {
    container: rootName => classifyDirect(rootName, new Set([rootName]), false),
    reach: rootName => classifyDirect(rootName, new Set([rootName]), true),
  }
}

// Whether an identifier reads a module binding that some other code could
// change — a `let`/`var`, or a `const` whose object/array fields are mutable.
// Reading such a value makes a function non-deterministic. Property names
// (`obj.field`) are not binding reads; builtin namespaces (Math, JSON, ...),
// functions, classes, types, and `const` primitives are immutable references.
// Uncertain cases resolve to true (impure) — the safe direction for a guarantee.
function readsMutableOuter(id: ts.Identifier, classifiers: Classifiers, program: Program): boolean {
  const parent = id.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false
  if (ts.isQualifiedName(parent) && parent.right === id) return false
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isEnumMember(parent)) && parent.name === id) return false
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false
  // Identifiers in a type position (a parameter name inside `(n: number) => T`,
  // a type reference) are not value reads.
  if (isInTypeContext(id)) return false
  // Only outer bindings matter; params and locals are not outside state.
  if (!classifiers.container(id.text).some(root => root.kind === 'outer')) return false
  return !isSafeOuterRead(id, program)
}

function isInTypeContext(node: ts.Node): boolean {
  for (let current = node.parent; current != null; current = current.parent) {
    if (ts.isTypeNode(current)) return true
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false
  }
  return false
}

function isSafeOuterRead(id: ts.Identifier, program: Program): boolean {
  if (pureGlobalMembers.has(id.text)) return true
  const checker = program.typeChecker
  if (checker == null) return false
  let symbol = checker.getSymbolAtLocation(id)
  if (symbol == null) return false
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration == null) return true
  if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isEnumDeclaration(declaration)
    || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isTypeParameterDeclaration(declaration)) return true
  if (ts.isVariableDeclaration(declaration)) {
    const isConst = ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    if (!isConst) return false
    try {
      return !typeCanBeMutable(checker.getTypeAtLocation(id))
    } catch {
      return false
    }
  }
  return false
}

function collectWrites(
  node: FunctionLikeNode,
  program: Program,
  member: MemberInfo,
  classifiers: Classifiers,
  members: Map<FunctionLikeNode, MemberInfo>,
) {
  const addMutation = (roots: RootKind[]) => {
    for (const root of roots) {
      if (root.kind === 'param') member.effects.mutatesParams.add(root.index)
      if (root.kind === 'outer') member.effects.writesOuter.add(root.key)
      if (root.kind === 'this') member.effects.mutatesThis = true
    }
  }
  const classifyExpressionRoots = (expression: ts.Expression): RootKind[] =>
    expressionRoots(expression, program).flatMap(root => classifiers.reach(root))

  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current) && readsMutableOuter(current, classifiers, program)) {
      member.effects.readsMutableOuter = true
    }
    if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
      const targetRoots = writeTargetRoots(current.left, classifiers, program)
      addMutation(targetRoots)
      // Writing a value into caller-visible state lets the caller's world reach
      // it later; the value's own roots must be forgotten too (escape).
      if (targetRoots.length > 0) addMutation(classifyExpressionRoots(current.right))
    }
    if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
      && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)) {
      addMutation(writeTargetRoots(current.operand, classifiers, program))
    }
    if (ts.isDeleteExpression(current)) {
      addMutation(writeTargetRoots(current.expression, classifiers, program))
    }
    if (ts.isCallExpression(current)) collectCall(current)
    if (ts.isNewExpression(current)) collectNew(current)
    ts.forEachChild(current, visit)
  }

  const collectCall = (call: ts.CallExpression) => {
    const target = unwrapExpression(call.expression)
    if (ts.isPropertyAccessExpression(target)) {
      // A method or pure global invokes its callback arguments. An inline one is
      // analyzed by descent and a resolvable one through its edge, but a callback
      // we cannot resolve (a function passed in as a parameter) could do
      // anything, so invoking it is an unknown call.
      if (callsUnanalyzableCallback(call, program)) member.effects.callsUnknown = true
      const base = unwrapExpression(target.expression)
      if (ts.isIdentifier(base) && isPureGlobalMemberCall(base.text, target.name.text)) {
        if (isEnvironmentObservingCall(base.text, target.name.text)) member.effects.observesEnvironment = true
        collectFunctionArguments(call, [])
        return
      }
      if (!nonMutatingMethodNames.has(target.name.text)) {
        // Mutating the container itself touches its aliases; what it retains
        // is only reachable through later path writes (tracked in buildScope) —
        // unless the container is caller-visible, in which case retention is an
        // escape and the arguments must be forgotten now.
        const containerBase = pathWriteBaseRoot(target.expression)
        const containerRoots = containerBase != null
          ? classifiers.container(containerBase)
          : classifyExpressionRoots(target.expression)
        addMutation(containerRoots)
        if (!retainingMethodNames.has(target.name.text) || containerRoots.length > 0) {
          addMutation(mutableArgumentRoots(call, program, classifyExpressionRoots))
        }
        // A method that is neither a known mutator nor a known non-mutating one
        // could do anything (including I/O); treat it as an unknown call.
        if (!knownMutatingMethodNames.has(target.name.text)) member.effects.callsUnknown = true
      }
      collectFunctionArguments(call, classifyExpressionRoots(target.expression))
      return
    }
    const resolved = resolveCallTarget(target, program)
    if (resolved.kind === 'math') {
      if (resolved.name === 'random') member.effects.observesEnvironment = true
      return
    }
    if (resolved.kind === 'function') {
      member.edges.push({
        callee: resolved.fn.node,
        // Immutable-typed arguments cannot hand the callee a reference, so a
        // callee-side parameter mutation cannot reach their roots.
        argumentRoots: call.arguments.map(argument =>
          ts.isSpreadElement(argument)
            ? null
            : expressionHasMutableType(argument, program) ? classifyExpressionRoots(argument) : []),
        receiverRoots: [],
        callbackSpill: null,
      })
      collectMember(resolved.fn.node, resolved.program, members)
      collectFunctionArguments(call, [])
      return
    }
    // A call we cannot see: every mutable argument may be written or retained,
    // and the callee could do anything (write globals, I/O, nondeterminism).
    addMutation(mutableArgumentRoots(call, program, classifyExpressionRoots))
    member.effects.callsUnknown = true
    collectFunctionArguments(call, [])
  }

  // Function-valued arguments: their captured writes are collected by the
  // normal descent (literals live inside this body). What needs explicit
  // handling is a callback that mutates its own parameters — the values fed to
  // it come from the call's receiver and arguments, so the mutation spills onto
  // those roots.
  const collectFunctionArguments = (call: ts.CallExpression, receiverRoots: RootKind[]) => {
    for (const argument of call.arguments) {
      const fn = functionValuedArgument(argument, program)
      if (fn == null) continue
      const spill = [
        ...receiverRoots,
        ...mutableArgumentRoots(call, program, classifyExpressionRoots),
      ]
      member.edges.push({callee: fn.node, argumentRoots: [], receiverRoots: [], callbackSpill: spill})
      collectMember(fn.node, fn.program, members)
    }
  }

  const collectNew = (expression: ts.NewExpression) => {
    const name = ts.isIdentifier(expression.expression) ? expression.expression.text : null
    if (name != null && lengthBearingConstructorNames.has(name)) return
    if (expression.arguments == null) return
    for (const argument of expression.arguments) {
      if (expressionHasMutableType(argument, program)) addMutation(classifyExpressionRoots(argument))
    }
  }

  ts.forEachChild(node, visit)
}

// Mirrors the interpreter's length-bearing constructor support.
export const lengthBearingConstructorNames = new Set([
  'Array',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
])

function functionValuedArgument(argument: ts.Expression, program: Program): {node: FunctionLikeNode; program: Program} | null {
  const current = unwrapExpression(argument)
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return {node: current, program}
  if (ts.isIdentifier(current)) {
    const resolved = resolveCallTarget(current, program)
    if (resolved.kind === 'function') return {node: resolved.fn.node, program: resolved.program}
  }
  return null
}

// A callback argument the analysis can neither inline (an arrow/function
// expression, read by descent) nor resolve to a known function (whose effects
// arrive through an edge): a function value passed in from outside. Invoking it
// could do anything, so the receiving method or global is an unknown call.
function callsUnanalyzableCallback(call: ts.CallExpression, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return false
  for (const argument of call.arguments) {
    if (ts.isSpreadElement(argument)) continue
    const current = unwrapExpression(argument)
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) continue
    if (functionValuedArgument(argument, program) != null) continue
    try {
      if (checker.getTypeAtLocation(current).getCallSignatures().length > 0) return true
    } catch {
      // an unresolved type query is not evidence of a callback
    }
  }
  return false
}

function mutableArgumentRoots(
  call: ts.CallExpression,
  program: Program,
  classifyExpressionRoots: (expression: ts.Expression) => RootKind[],
): RootKind[] {
  const roots: RootKind[] = []
  for (const argument of call.arguments) {
    const expression = ts.isSpreadElement(argument) ? argument.expression : argument
    if (ts.isArrowFunction(unwrapExpression(expression)) || ts.isFunctionExpression(unwrapExpression(expression))) continue
    if (!expressionHasMutableType(expression, program)) continue
    roots.push(...classifyExpressionRoots(expression))
  }
  return roots
}

// Without a checker every argument is conservatively mutable. With one,
// numbers, strings, booleans, enums, null, and undefined cannot carry a
// reference back to caller state.
function expressionHasMutableType(expression: ts.Expression, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  try {
    return typeCanBeMutable(checker.getTypeAtLocation(expression))
  } catch {
    return true
  }
}

const immutableTypeFlags = ts.TypeFlags.NumberLike
  | ts.TypeFlags.StringLike
  | ts.TypeFlags.BooleanLike
  | ts.TypeFlags.EnumLike
  | ts.TypeFlags.BigIntLike
  | ts.TypeFlags.Null
  | ts.TypeFlags.Undefined
  | ts.TypeFlags.Void
  | ts.TypeFlags.Never

function typeCanBeMutable(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(typeCanBeMutable)
  return (type.flags & immutableTypeFlags) === 0
}

function writeTargetRoots(target: ts.Expression, classifiers: Classifiers, program: Program): RootKind[] {
  const current = unwrapExpression(target)
  if (ts.isIdentifier(current)) {
    // A bare rebind replaces the caller-invisible binding, except for outer
    // roots, whose binding the caller shares.
    return classifiers.container(current.text).filter(root => root.kind === 'outer')
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return writeBaseRoots(current.expression, classifiers, program)
  }
  return expressionRoots(current, program).flatMap(root => classifiers.reach(root))
}

// The container a path write mutates: the base chain's root, everything that
// container aliases, and everything retained inside it — regardless of the
// written value's type. Index expressions are reads and stay out.
function writeBaseRoots(expression: ts.Expression, classifiers: Classifiers, program: Program): RootKind[] {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return classifiers.reach(current.text)
  if (current.kind === ts.SyntaxKind.ThisKeyword) return [{kind: 'this'}]
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return writeBaseRoots(current.expression, classifiers, program)
  }
  return expressionRoots(current, program).flatMap(root => classifiers.reach(root))
}

// Roots whose values could flow into this expression's value. A subtree of
// immutable type (number, string, boolean, ...) carries no references, so
// nothing flows out of it. Callee names are not values that flow (only their
// arguments and receiver are), and object literal property names are labels,
// not reads.
function expressionRoots(expression: ts.Expression, program: Program): string[] {
  const roots: string[] = []
  const visit = (current: ts.Node) => {
    // Type positions name types, not values; nothing flows through them.
    if (ts.isTypeNode(current)) return
    if (ts.isExpression(current) && !expressionHasMutableType(current, program)) return
    if (ts.isIdentifier(current)) {
      roots.push(current.text)
      return
    }
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      roots.push('this')
      return
    }
    if (ts.isPropertyAccessExpression(current)) {
      visit(current.expression)
      return
    }
    if (ts.isCallExpression(current)) {
      // The call's value may alias anything reachable from its inputs.
      if (ts.isPropertyAccessExpression(current.expression) || ts.isElementAccessExpression(current.expression)) {
        visit(current.expression.expression)
      }
      for (const argument of current.arguments) visit(argument)
      return
    }
    if (ts.isNewExpression(current)) {
      for (const argument of current.arguments ?? []) visit(argument)
      return
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isPropertyAssignment(property)) visit(property.initializer)
        else if (ts.isShorthandPropertyAssignment(property)) visit(property.name)
        else if (ts.isSpreadAssignment(property)) visit(property.expression)
      }
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(expression)
  return [...new Set(roots)]
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    names.push(...bindingNames(element.name))
  }
  return names
}

function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}
