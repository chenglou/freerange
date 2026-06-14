import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {
  classAccessorFunctionForPropertyAccessInProgram,
  classDeclarationForNewExpression,
  classMemberFunctionForPropertyAccessInProgram,
  constructorFunctionForNewExpression,
  isDefaultLibraryMemberAccess,
  isDefaultLibrarySymbol,
  resolveCallTarget,
} from './call-targets.ts'
import {
  isFunctionImplementation,
  type FunctionImplementationRef,
  type FunctionImplementationNode,
} from '../function-shape.ts'
import {isAssignmentOperator, unwrapExpression} from './source-syntax.ts'

// What a call can change in its caller's world, beyond returning a value.
// `paramIndexes` holds parameters whose argument may be written through or
// stored somewhere that outlives the call. The caller forgets the argument's
// roots either way because facts cannot be re-established through an alias it
// no longer sees. Outside bindings retain TypeScript identity until the caller
// asks for the root names from one source.
// The mutation fields are what the interpreter uses to forget caller facts.
// The remaining fields extend the summary to the stricter notion a `pure`
// annotation needs: a pure function also reads no mutable outside state, never
// observes or affects the environment (I/O, the clock, randomness), and calls
// nothing it cannot analyze. Purity is derived from this summary, never stored
// separately.
type MutationTargets = {
  outerBindings: Map<BindingKey, OuterBinding>
  paramIndexes: Set<number>
  thisValue: boolean
}

export type FunctionEffects = {
  mutations: {
    certain: MutationTargets
    // A call whose body is unavailable may mutate these targets. The
    // interpreter forgets their facts, while `pure` reports the call as unknown
    // instead of claiming that the mutation definitely occurs.
    uncertain: MutationTargets
  }
  // Module-level `let`/`var` reads, and reads through `const` objects/arrays.
  // Keep the bindings so callers can reclassify captured locals correctly.
  mutableOuterReads: Map<BindingKey, OuterBinding>
  // calls console.*, Date.now, performance.now, or Math.random: I/O or a value
  // that differs across runs with the same inputs
  observesEnvironment: boolean
  // calls something the analysis cannot resolve to a known function or method,
  // so it could do anything and the function cannot be proved pure
  callsUnknown: boolean
}

const noMutationTargets = (): MutationTargets => ({
  outerBindings: new Map(),
  paramIndexes: new Set(),
  thisValue: false,
})

const noEffects = (): FunctionEffects => ({
  mutations: {
    certain: noMutationTargets(),
    uncertain: noMutationTargets(),
  },
  mutableOuterReads: new Map(),
  observesEnvironment: false,
  callsUnknown: false,
})

// A function is pure when it changes nothing observable, reads no mutable
// outside state, observes no environment, and calls nothing unanalyzable. Local
// mutation, allocation, throwing, and reading module-level `const` primitives
// are all fine. A definite effect makes the function impure. An unanalyzable
// call leaves the claim unknown because the callee could be pure or not. This
// result is derived from the effect summary, so there is one source of truth.
export type Purity =
  | {kind: 'pure'}
  | {kind: 'impure'; reason: string}
  | {kind: 'unknown'; reason: string}

export function functionPurity(node: FunctionImplementationNode, program: Program): Purity {
  const effects = functionEffects(node, program)
  const mutatedParam = effects.mutations.certain.paramIndexes.values().next().value
  if (mutatedParam != null) {
    const parameter = node.parameters[mutatedParam]?.name
    const name = parameter != null && ts.isIdentifier(parameter) ? parameter.text : null
    return {kind: 'impure', reason: name == null ? 'mutates a parameter' : `mutates parameter \`${name}\``}
  }
  if (effects.mutations.certain.thisValue) return {kind: 'impure', reason: 'mutates `this`'}
  const writtenOuter = firstOuterRoot(effects.mutations.certain)
  if (writtenOuter != null) {
    return {kind: 'impure', reason: `writes outside state \`${writtenOuter}\``}
  }
  if (effects.mutableOuterReads.size > 0) return {kind: 'impure', reason: 'reads mutable outside state'}
  if (effects.observesEnvironment) return {kind: 'impure', reason: 'observes the environment (I/O, the clock, or randomness)'}
  if (effects.callsUnknown) return {kind: 'unknown', reason: 'calls a function whose body cannot be analyzed'}
  return {kind: 'pure'}
}

function firstOuterRoot(targets: MutationTargets): string | null {
  return targets.outerBindings.values().next().value?.root ?? null
}

export function mutationOuterRoots(targets: MutationTargets, sourceId: string): string[] {
  const roots = new Set<string>()
  for (const binding of targets.outerBindings.values()) {
    if (binding.sourceId === sourceId) roots.add(binding.root)
  }
  return [...roots]
}

// Real platform globals whose listed members neither mutate their arguments nor
// reach back into user module state. Anything not listed is treated as an
// unknown call. Object.assign is deliberately absent: it mutates its target.
const factPreservingGlobalMembers = new Map<string, 'all' | Set<string>>([
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

export function isFactPreservingGlobalMemberCall(base: string, member: string): boolean {
  const members = factPreservingGlobalMembers.get(base)
  if (members == null) return false
  return members === 'all' || members.has(member)
}

// Globals that do not mutate caller state but still break purity: console writes
// to the outside world (I/O), and the clock and randomness return a different
// value each run with the same inputs (nondeterminism). They stay in
// factPreservingGlobalMembers (they corrupt no facts) but make a calling
// function impure.
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

const callbackInvokingMethodNames = new Set([
  'map', 'filter', 'every', 'some', 'forEach', 'reduce', 'reduceRight',
  'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap',
])

type RootKind =
  | {kind: 'param'; index: number}
  | {kind: 'outer'; binding: OuterBinding}
  | {kind: 'this'}

type BindingKey = ts.Symbol | string

type OuterBinding = {
  key: BindingKey
  sourceId: string
  root: string
}

type CallEdge = {
  callee: FunctionImplementationNode
  // classified roots per caller argument position; `null` marks a spread
  // argument whose positions cannot be mapped
  argumentRoots: (RootKind[] | null)[]
  receiverRoots: RootKind[]
  // a callback whose own parameter mutations must spill onto these roots
  callbackSpill: RootKind[] | null
  classifyBinding: Classifier
}

type MemberInfo = {
  effects: FunctionEffects
  edges: CallEdge[]
}

const effectsCache = new WeakMap<ts.Node, FunctionEffects>()

export function functionEffects(node: FunctionImplementationNode, program: Program): FunctionEffects {
  const cached = effectsCache.get(node)
  if (cached != null) return cached
  const members = new Map<FunctionImplementationNode, MemberInfo>()
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
  const add = (targets: MutationTargets, roots: RootKind[]) => {
    if (addMutationRoots(targets, roots)) changed = true
  }
  for (const binding of callee.mutations.certain.outerBindings.values()) {
    add(into.mutations.certain, edge.classifyBinding(binding.key))
  }
  for (const binding of callee.mutations.uncertain.outerBindings.values()) {
    add(into.mutations.uncertain, edge.classifyBinding(binding.key))
  }
  // These three describe the callee itself, not anything it does through this
  // edge's arguments, so they propagate to every caller unconditionally: calling
  // an impure function is impure.
  for (const binding of callee.mutableOuterReads.values()) {
    for (const root of edge.classifyBinding(binding.key)) {
      if (root.kind !== 'outer') continue
      if (addMutableOuterRead(into, root.binding)) changed = true
    }
  }
  if (callee.observesEnvironment && !into.observesEnvironment) {
    into.observesEnvironment = true
    changed = true
  }
  if (callee.callsUnknown && !into.callsUnknown) {
    into.callsUnknown = true
    changed = true
  }
  if (callee.mutations.certain.thisValue) add(into.mutations.certain, edge.receiverRoots)
  if (callee.mutations.certain.paramIndexes.size > 0) {
    const hasSpread = edge.argumentRoots.some(roots => roots == null)
    for (const index of callee.mutations.certain.paramIndexes) {
      const rest = edge.callee.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) add(into.mutations.certain, roots ?? [])
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) add(into.mutations.certain, roots ?? [])
      } else {
        add(into.mutations.certain, edge.argumentRoots[index] ?? [])
      }
    }
    if (edge.callbackSpill != null) add(into.mutations.certain, edge.callbackSpill)
  }
  if (callee.mutations.uncertain.thisValue) add(into.mutations.uncertain, edge.receiverRoots)
  if (callee.mutations.uncertain.paramIndexes.size > 0) {
    const hasSpread = edge.argumentRoots.some(roots => roots == null)
    for (const index of callee.mutations.uncertain.paramIndexes) {
      const rest = edge.callee.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) add(into.mutations.uncertain, roots ?? [])
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) add(into.mutations.uncertain, roots ?? [])
      } else {
        add(into.mutations.uncertain, edge.argumentRoots[index] ?? [])
      }
    }
    if (edge.callbackSpill != null) add(into.mutations.uncertain, edge.callbackSpill)
  }
  return changed
}

function addMutationRoots(targets: MutationTargets, roots: RootKind[]): boolean {
  let changed = false
  for (const root of roots) {
    switch (root.kind) {
      case 'param':
        if (!targets.paramIndexes.has(root.index)) {
          targets.paramIndexes.add(root.index)
          changed = true
        }
        break
      case 'outer': {
        if (addOuterBinding(targets, root.binding)) changed = true
        break
      }
      case 'this':
        if (!targets.thisValue) {
          targets.thisValue = true
          changed = true
        }
        break
    }
  }
  return changed
}

function addOuterBinding(targets: MutationTargets, binding: OuterBinding): boolean {
  if (targets.outerBindings.has(binding.key)) return false
  targets.outerBindings.set(binding.key, binding)
  return true
}

function addMutableOuterRead(effects: FunctionEffects, binding: OuterBinding): boolean {
  if (effects.mutableOuterReads.has(binding.key)) return false
  effects.mutableOuterReads.set(binding.key, binding)
  return true
}

function collectMember(node: FunctionImplementationNode, program: Program, members: Map<FunctionImplementationNode, MemberInfo>) {
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
  paramIndexByBinding: Map<BindingKey, number>
  localBindings: Set<BindingKey>
  // ys = xs: ys IS the same container; mutating ys mutates xs.
  containerSources: Map<BindingKey, Set<BindingKey>>
  // ys.push(box), obj.field = box: box is reachable FROM the container; only a
  // later write through the container can hit it, mutating the container's own
  // shape (push, sort) cannot.
  reachableSources: Map<BindingKey, Set<BindingKey>>
}

// Methods that store their arguments inside the receiver.
const retainingMethodNames = new Set(['push', 'unshift', 'splice', 'fill'])

function buildScope(node: FunctionImplementationNode, program: Program): Scope {
  const paramIndexByBinding = new Map<BindingKey, number>()
  node.parameters.forEach((parameter, index) => {
    for (const binding of bindingKeys(parameter.name, program)) paramIndexByBinding.set(binding, index)
  })
  const localBindings = new Set<BindingKey>()
  const containerEdges: {target: BindingKey; sourceRoots: BindingKey[]}[] = []
  const reachableEdges: {target: BindingKey; sourceRoots: BindingKey[]}[] = []
  const visit = (current: ts.Node) => {
    if (ts.isVariableDeclaration(current)) {
      const bindings = bindingKeys(current.name, program)
      for (const binding of bindings) localBindings.add(binding)
      if (current.initializer != null) {
        const sourceRoots = expressionRootBindings(current.initializer, program)
        for (const binding of bindings) containerEdges.push({target: binding, sourceRoots})
      }
    }
    if (ts.isFunctionDeclaration(current) && current.name != null) {
      localBindings.add(bindingKey(current.name, program))
      return
    }
    if (ts.isClassDeclaration(current) && current.name != null) {
      localBindings.add(bindingKey(current.name, program))
    }
    if (current !== node && isFunctionImplementation(current)) return
    if (ts.isCatchClause(current) && current.variableDeclaration != null) {
      for (const binding of bindingKeys(current.variableDeclaration.name, program)) localBindings.add(binding)
    }
    if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
      const target = unwrapExpression(current.left)
      if (ts.isIdentifier(target)) {
        containerEdges.push({target: bindingKey(target, program), sourceRoots: expressionRootBindings(current.right, program)})
      } else {
        const base = pathWriteBaseBinding(target, program)
        if (base != null) reachableEdges.push({target: base, sourceRoots: expressionRootBindings(current.right, program)})
      }
    }
    if (ts.isCallExpression(current)) {
      const target = unwrapExpression(current.expression)
      if (ts.isPropertyAccessExpression(target) && retainingMethodNames.has(target.name.text)) {
        const base = pathWriteBaseBinding(target.expression, program)
        if (base != null) {
          for (const argument of current.arguments) {
            const expression = ts.isSpreadElement(argument) ? argument.expression : argument
            reachableEdges.push({target: base, sourceRoots: expressionRootBindings(expression, program)})
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
    paramIndexByBinding,
    localBindings,
    containerSources: closeSourceEdges(symmetricContainerEdges),
    reachableSources: closeSourceEdges(reachableEdges),
  }
}

// Flow-insensitive closure: a binding that ever received a root carries that
// root's own sources transitively.
function closeSourceEdges(edges: {target: BindingKey; sourceRoots: BindingKey[]}[]): Map<BindingKey, Set<BindingKey>> {
  const sources = new Map<BindingKey, Set<BindingKey>>()
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

function pathWriteBaseBinding(expression: ts.Expression, program: Program): BindingKey | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return bindingKey(current, program)
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return pathWriteBaseBinding(current.expression, program)
  }
  return null
}

type Classifier = (binding: BindingKey) => RootKind[]

type Classifiers = {
  // mutations of the container itself: the root plus everything it container-aliases
  container: Classifier
  // writes through the container: additionally everything retained inside it
  reach: Classifier
}

function makeClassifiers(scope: Scope, program: Program): Classifiers {
  const classifyDirect = (binding: BindingKey, seen: Set<BindingKey>, includeReachable: boolean): RootKind[] => {
    const result: RootKind[] = []
    if (binding === 'this') {
      result.push({kind: 'this'})
    } else {
      const paramIndex = scope.paramIndexByBinding.get(binding)
      if (paramIndex != null) result.push({kind: 'param', index: paramIndex})
      else if (!scope.localBindings.has(binding)) result.push({kind: 'outer', binding: outerBinding(binding, program)})
    }
    const sources = [
      ...(scope.containerSources.get(binding) ?? []),
      ...(includeReachable ? scope.reachableSources.get(binding) ?? [] : []),
    ]
    for (const source of sources) {
      if (seen.has(source)) continue
      seen.add(source)
      result.push(...classifyDirect(source, seen, includeReachable))
    }
    return result
  }
  return {
    container: binding => classifyDirect(binding, new Set([binding]), false),
    reach: binding => classifyDirect(binding, new Set([binding]), true),
  }
}

function bindingKey(identifier: ts.Identifier, program: Program): BindingKey {
  const checker = program.typeChecker
  if (checker == null) return `binding:${identifier.text}`
  let symbol = checker.getSymbolAtLocation(identifier)
  if (symbol == null) return `binding:${identifier.text}`
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
  return symbol
}

function bindingKeys(name: ts.BindingName, program: Program): BindingKey[] {
  if (ts.isIdentifier(name)) return [bindingKey(name, program)]
  const keys: BindingKey[] = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    keys.push(...bindingKeys(element.name, program))
  }
  return keys
}

function outerBinding(key: BindingKey, program: Program): OuterBinding {
  if (typeof key === 'string') {
    return {
      key,
      sourceId: program.sourceId,
      root: key.startsWith('binding:') ? key.slice('binding:'.length) : key,
    }
  }
  const declaration = key.valueDeclaration ?? key.declarations?.[0]
  const sourceFile = declaration?.getSourceFile()
  const projectFile = sourceFile == null ? null : program.project.filesBySourceFile.get(sourceFile)
  return {
    key,
    sourceId: projectFile?.sourceId ?? sourceFile?.fileName ?? program.sourceId,
    root: key.getName(),
  }
}

// Whether an identifier reads a module binding that some other code could
// change — a `let`/`var`, or a `const` whose object/array fields are mutable.
// Reading such a value makes a function non-deterministic. Property names
// (`obj.field`) are not binding reads; builtin namespaces (Math, JSON, ...),
// functions, classes, types, and `const` primitives are immutable references.
// Uncertain cases resolve to true (impure) — the safe direction for a guarantee.
function mutableOuterRead(id: ts.Identifier, classifiers: Classifiers, program: Program): OuterBinding | null {
  const parent = id.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return null
  if (ts.isQualifiedName(parent) && parent.right === id) return null
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isEnumMember(parent)) && parent.name === id) return null
  if (ts.isBindingElement(parent) && parent.propertyName === id) return null
  if (
    (
      ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent)
      || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent)
    )
    && parent.name === id
  ) return null
  // Identifiers in a type position (a parameter name inside `(n: number) => T`,
  // a type reference) are not value reads.
  if (isInTypeContext(id)) return null
  // Only outer bindings matter; params and locals are not outside state.
  const outer = classifiers.container(bindingKey(id, program)).find(root => root.kind === 'outer')
  if (outer == null || isSafeOuterRead(id, program)) return null
  return outer.binding
}

function isInTypeContext(node: ts.Node): boolean {
  for (let current = node.parent; current != null; current = current.parent) {
    if (ts.isTypeNode(current)) return true
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false
  }
  return false
}

function isSafeOuterRead(id: ts.Identifier, program: Program): boolean {
  if (factPreservingGlobalMembers.has(id.text) && isDefaultLibrarySymbol(id, program)) return true
  if (isResolvedFunctionCallRead(id, program)) return true
  const checker = program.typeChecker
  if (checker == null) return false
  let symbol = checker.getSymbolAtLocation(id)
  if (symbol == null) return false
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration == null) return true
  if (ts.isClassDeclaration(declaration)) return isSafeClassOuterRead(id, checker)
  if (ts.isFunctionDeclaration(declaration) || ts.isEnumDeclaration(declaration)
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

function isResolvedFunctionCallRead(id: ts.Identifier, program: Program): boolean {
  const parent = id.parent
  if (ts.isCallExpression(parent) && parent.expression === id) {
    return resolveCallTarget(id, program).kind !== 'unresolved'
  }
  if (
    !ts.isPropertyAccessExpression(parent)
    || parent.expression !== id
    || !ts.isCallExpression(parent.parent)
    || parent.parent.expression !== parent
  ) return false
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(id)
  const namespaceImport = symbol?.declarations?.some(ts.isNamespaceImport) === true
  return namespaceImport && resolveCallTarget(parent, program).kind !== 'unresolved'
}

function isSafeClassOuterRead(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  let expression: ts.Expression = id
  while (
    (ts.isParenthesizedExpression(expression.parent)
      || ts.isNonNullExpression(expression.parent)
      || ts.isAsExpression(expression.parent)
      || ts.isTypeAssertionExpression(expression.parent)
      || ts.isSatisfiesExpression(expression.parent))
    && expression.parent.expression === expression
  ) {
    expression = expression.parent
  }

  const parent = expression.parent
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === expression) return true

  const access = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
    && parent.expression === expression
    ? parent
    : null
  if (access == null) return false

  const memberSymbol = ts.isPropertyAccessExpression(access)
    ? checker.getSymbolAtLocation(access.name)
    : classElementAccessSymbol(access, checker)
  const declaration = memberSymbol?.valueDeclaration ?? memberSymbol?.declarations?.[0]
  if (declaration == null) return false
  if (ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) return true
  if (!ts.isPropertyDeclaration(declaration) && !ts.isPropertySignature(declaration)) return false
  const readonly = ts.canHaveModifiers(declaration)
    && ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) === true
  if (!readonly) return false
  try {
    return !typeCanBeMutable(checker.getTypeAtLocation(access))
  } catch {
    return false
  }
}

function classElementAccessSymbol(access: ts.ElementAccessExpression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const argument = access.argumentExpression
  if (argument == null) return undefined
  if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
    return checker.getPropertyOfType(checker.getTypeAtLocation(access.expression), argument.text)
  }
  return checker.getSymbolAtLocation(argument)
}

function collectWrites(
  node: FunctionImplementationNode,
  program: Program,
  member: MemberInfo,
  classifiers: Classifiers,
  members: Map<FunctionImplementationNode, MemberInfo>,
) {
  const addMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.certain, roots)
  }
  const addUncertainMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.uncertain, roots)
  }
  const classifyExpressionRoots = (expression: ts.Expression): RootKind[] =>
    expressionRootBindings(expression, program).flatMap(root => classifiers.reach(root))
  const addResolvedEdge = (
    target: Extract<ReturnType<typeof resolveCallTarget>, {kind: 'function'}>,
    arguments_: readonly ts.Expression[],
    receiverRoots: RootKind[],
  ) => {
    member.edges.push({
      callee: target.fn.node,
      argumentRoots: arguments_.map(argument =>
        ts.isSpreadElement(argument)
          ? null
          : expressionHasMutableType(argument, program) ? classifyExpressionRoots(argument) : []),
      receiverRoots,
      callbackSpill: null,
      classifyBinding: classifiers.reach,
    })
    collectMember(target.fn.node, target.program, members)
  }

  const visit = (current: ts.Node) => {
    if (isFunctionImplementation(current)) return
    if (ts.isIdentifier(current)) {
      const binding = mutableOuterRead(current, classifiers, program)
      if (binding != null) addMutableOuterRead(member.effects, binding)
    }
    if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
      const target = unwrapExpression(current.left)
      const setter = ts.isPropertyAccessExpression(target)
        ? classAccessorFunctionForPropertyAccessInProgram(target, 'set', program)
        : null
      const targetRoots = setter == null ? writeTargetRoots(current.left, classifiers, program) : []
      addMutation(targetRoots)
      // Writing a value into caller-visible state lets the caller's world reach
      // it later; the value's own roots must be forgotten too (escape).
      if (targetRoots.length > 0) addMutation(classifyExpressionRoots(current.right))
    }
    if (ts.isPropertyAccessExpression(current)) {
      const parent = current.parent
      const assignment = ts.isBinaryExpression(parent) && parent.left === current && isAssignmentOperator(parent.operatorToken.kind)
        ? parent
        : null
      const increment = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
        && parent.operand === current
        && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      if (assignment == null || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        const getter = classAccessorFunctionForPropertyAccessInProgram(current, 'get', program)
        if (getter != null) addResolvedEdge(getter, [], classifyExpressionRoots(current.expression))
      }
      if (assignment != null || increment) {
        const setter = classAccessorFunctionForPropertyAccessInProgram(current, 'set', program)
        const value = assignment?.right
        if (setter != null) addResolvedEdge(setter, value == null ? [] : [value], classifyExpressionRoots(current.expression))
      }
    }
    if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
      && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)) {
      const target = unwrapExpression(current.operand)
      const setter = ts.isPropertyAccessExpression(target)
        ? classAccessorFunctionForPropertyAccessInProgram(target, 'set', program)
        : null
      if (setter == null) addMutation(writeTargetRoots(current.operand, classifiers, program))
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
      const base = unwrapExpression(target.expression)
      const defaultLibraryMember = isDefaultLibraryMemberAccess(target, program)
      const defaultLibraryGlobal = ts.isIdentifier(base)
        && isDefaultLibrarySymbol(base, program)
        && defaultLibraryMember
        && isFactPreservingGlobalMemberCall(base.text, target.name.text)
      if (defaultLibraryGlobal) {
        if (isEnvironmentObservingCall(base.text, target.name.text)) member.effects.observesEnvironment = true
        if (base.text === 'Object' && target.name.text === 'freeze' && call.arguments[0] != null) {
          addMutation(classifyExpressionRoots(call.arguments[0]))
        }
        if (base.text === 'Array' && target.name.text === 'from') collectInvokedFunctionArguments(call, [])
        return
      }
      const classMember = classMemberFunctionForPropertyAccessInProgram(target, program)
      if (classMember != null) {
        addResolvedEdge(classMember, call.arguments, classifyExpressionRoots(target.expression))
        return
      }
      const resolved = resolveCallTarget(target, program)
      if (resolved.kind === 'function') {
        addResolvedEdge(resolved, call.arguments, [])
        return
      }
      if (resolved.kind === 'math') {
        if (resolved.name === 'random') member.effects.observesEnvironment = true
        return
      }
      const knownNonMutating = defaultLibraryMember && nonMutatingMethodNames.has(target.name.text)
      const knownMutating = defaultLibraryMember && knownMutatingMethodNames.has(target.name.text)
      if (!knownNonMutating) {
        // Mutating the container itself touches its aliases; what it retains
        // is only reachable through later path writes (tracked in buildScope) —
        // unless the container is caller-visible, in which case retention is an
        // escape and the arguments must be forgotten now.
        const containerBase = pathWriteBaseBinding(target.expression, program)
        const containerRoots = containerBase != null
          ? classifiers.container(containerBase)
          : classifyExpressionRoots(target.expression)
        if (knownMutating) addMutation(containerRoots)
        else addUncertainMutation(containerRoots)
        const argumentRoots = mutableArgumentRoots(call, program, classifyExpressionRoots)
        if (!knownMutating || !retainingMethodNames.has(target.name.text) || containerRoots.length > 0) {
          if (knownMutating) addMutation(argumentRoots)
          else addUncertainMutation(argumentRoots)
        }
        // A method that is neither a known mutator nor a known non-mutating one
        // could do anything (including I/O); treat it as an unknown call.
        if (!knownMutating) member.effects.callsUnknown = true
      }
      if (defaultLibraryMember && callbackInvokingMethodNames.has(target.name.text)) {
        if (callsUnanalyzableCallback(call, program)) member.effects.callsUnknown = true
        collectInvokedFunctionArguments(call, classifyExpressionRoots(target.expression))
      }
      return
    }
    const resolved = resolveCallTarget(target, program)
    if (resolved.kind === 'math') {
      if (resolved.name === 'random') member.effects.observesEnvironment = true
      return
    }
    if (resolved.kind === 'function') {
      addResolvedEdge(resolved, call.arguments, [])
      return
    }
    // A call we cannot see: every mutable argument may be written or retained,
    // and the callee could do anything (write globals, I/O, nondeterminism).
    addUncertainMutation(mutableArgumentRoots(call, program, classifyExpressionRoots))
    member.effects.callsUnknown = true
  }

  // Function-valued arguments: their captured writes are collected by the
  // normal descent (literals live inside this body). What needs explicit
  // handling is a callback that mutates its own parameters — the values fed to
  // it come from the call's receiver and arguments, so the mutation spills onto
  // those roots.
  const collectInvokedFunctionArguments = (call: ts.CallExpression, receiverRoots: RootKind[]) => {
    for (const argument of call.arguments) {
      const fn = functionValuedArgument(argument, program)
      if (fn == null) continue
      const spill = [
        ...receiverRoots,
        ...mutableArgumentRoots(call, program, classifyExpressionRoots),
      ]
      member.edges.push({
        callee: fn.node,
        argumentRoots: [],
        receiverRoots: [],
        callbackSpill: spill,
        classifyBinding: classifiers.reach,
      })
      collectMember(fn.node, fn.program, members)
    }
  }

  const collectNew = (expression: ts.NewExpression) => {
    const name = ts.isIdentifier(expression.expression) ? expression.expression.text : null
    if (name === 'Date' && isDefaultLibrarySymbol(expression.expression, program)) {
      if ((expression.arguments?.length ?? 0) === 0) member.effects.observesEnvironment = true
      return
    }
    if (name != null && lengthBearingConstructorNames.has(name) && isDefaultLibrarySymbol(expression.expression, program)) return
    const constructor = constructorFunctionForNewExpression(expression, program)
    if (constructor != null) {
      addResolvedEdge(constructor, expression.arguments ?? [], [])
      return
    }
    const declaration = classDeclarationForNewExpression(expression, program)
    const declared = declaration != null
      && ts.canHaveModifiers(declaration)
      && ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true
    if (declaration != null && !declared && !declaration.getSourceFile().isDeclarationFile && declaration.heritageClauses == null) return
    for (const argument of expression.arguments ?? []) {
      if (expressionHasMutableType(argument, program)) addUncertainMutation(classifyExpressionRoots(argument))
    }
    member.effects.callsUnknown = true
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

function functionValuedArgument(argument: ts.Expression, program: Program): FunctionImplementationRef | null {
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
    return classifiers.container(bindingKey(current, program)).filter(root => root.kind === 'outer')
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return writeBaseRoots(current.expression, classifiers, program)
  }
  return expressionRootBindings(current, program).flatMap(root => classifiers.reach(root))
}

// The container a path write mutates: the base chain's root, everything that
// container aliases, and everything retained inside it — regardless of the
// written value's type. Index expressions are reads and stay out.
function writeBaseRoots(expression: ts.Expression, classifiers: Classifiers, program: Program): RootKind[] {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return classifiers.reach(bindingKey(current, program))
  if (current.kind === ts.SyntaxKind.ThisKeyword) return [{kind: 'this'}]
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return writeBaseRoots(current.expression, classifiers, program)
  }
  return expressionRootBindings(current, program).flatMap(root => classifiers.reach(root))
}

// Roots whose values could flow into this expression's value. A subtree of
// immutable type (number, string, boolean, ...) carries no references, so
// nothing flows out of it. Callee names are not values that flow (only their
// arguments and receiver are), and object literal property names are labels,
// not reads.
function expressionRootBindings(expression: ts.Expression, program: Program): BindingKey[] {
  const roots: BindingKey[] = []
  const visit = (current: ts.Node) => {
    // Type positions name types, not values; nothing flows through them.
    if (ts.isTypeNode(current)) return
    if (isFunctionImplementation(current)) return
    if (ts.isExpression(current) && !expressionHasMutableType(current, program)) return
    if (ts.isIdentifier(current)) {
      roots.push(bindingKey(current, program))
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
