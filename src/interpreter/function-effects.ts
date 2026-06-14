import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {
  defaultLibraryOwner,
  elementAccessHasSourceAccessor,
  isDefaultLibraryMemberAccess,
  isDefaultLibrarySymbol,
  propertyAccessHasSourceAccessor,
  resolveCallTarget,
} from './call-targets.ts'
import {
  assertFunctionImplementationReference,
  functionImplementationReference,
  isFunctionImplementation,
  type FunctionImplementationRef,
  type FunctionImplementationNode,
} from '../function-shape.ts'
import {isAssignmentOperator, unwrapExpression} from './source-syntax.ts'
import {
  isPlatformGlobalNamespace,
  platformGlobalEffect,
  platformMethodEffect,
  retainedArgumentIndexes,
  type PlatformCallbackEffect,
  type PlatformCallEffect,
  type PlatformValueSource,
} from './platform-effects.ts'

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

export function functionPurity(implementation: FunctionImplementationRef): Purity {
  const effects = functionEffects(implementation)
  const node = implementation.node
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

export function mutationRootsForProgram(targets: MutationTargets, program: Program): string[] {
  const roots = new Set<string>()
  for (const binding of targets.outerBindings.values()) {
    if (binding.sourceId === program.sourceId) roots.add(binding.root)
    for (const [localName, imported] of program.imports) {
      if (imported.kind !== 'resolved') continue
      if (imported.file.sourceId === binding.sourceId && imported.sourceName === binding.root) {
        roots.add(localName)
      }
    }
  }
  return [...roots]
}

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
  callee: FunctionImplementationRef
  // classified roots per caller argument position; `null` marks a spread
  // argument whose positions cannot be mapped
  argumentRoots: (RootKind[] | null)[]
  receiverRoots: RootKind[]
  classifyBinding: Classifier
}

type MemberInfo = {
  implementation: FunctionImplementationRef
  effects: FunctionEffects
  edges: CallEdge[]
}

type MemberIndex = Map<Program, Map<FunctionImplementationNode, MemberInfo>>

const effectsCache = new WeakMap<Program, WeakMap<FunctionImplementationNode, FunctionEffects>>()

export function functionEffects(implementation: FunctionImplementationRef): FunctionEffects {
  assertFunctionImplementationReference(implementation)
  const cached = cachedFunctionEffects(implementation)
  if (cached != null) return cached
  const members: MemberIndex = new Map()
  collectMember(implementation, members)
  for (let changed = true; changed;) {
    changed = false
    for (const programMembers of members.values()) {
      for (const member of programMembers.values()) {
        for (const edge of member.edges) {
          const callee = cachedFunctionEffects(edge.callee) ?? indexedMember(members, edge.callee)?.effects
          if (callee == null) continue
          if (composeEdge(member.effects, edge, callee)) changed = true
        }
      }
    }
  }
  for (const programMembers of members.values()) {
    for (const member of programMembers.values()) cacheFunctionEffects(member.implementation, member.effects)
  }
  return indexedMember(members, implementation)!.effects
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
      const rest = edge.callee.node.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) add(into.mutations.certain, roots ?? [])
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) add(into.mutations.certain, roots ?? [])
      } else {
        add(into.mutations.certain, edge.argumentRoots[index] ?? [])
      }
    }
  }
  if (callee.mutations.uncertain.thisValue) add(into.mutations.uncertain, edge.receiverRoots)
  if (callee.mutations.uncertain.paramIndexes.size > 0) {
    const hasSpread = edge.argumentRoots.some(roots => roots == null)
    for (const index of callee.mutations.uncertain.paramIndexes) {
      const rest = edge.callee.node.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) add(into.mutations.uncertain, roots ?? [])
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) add(into.mutations.uncertain, roots ?? [])
      } else {
        add(into.mutations.uncertain, edge.argumentRoots[index] ?? [])
      }
    }
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

function cachedFunctionEffects(implementation: FunctionImplementationRef): FunctionEffects | undefined {
  return effectsCache.get(implementation.program)?.get(implementation.node)
}

function cacheFunctionEffects(implementation: FunctionImplementationRef, effects: FunctionEffects) {
  let programCache = effectsCache.get(implementation.program)
  if (programCache == null) {
    programCache = new WeakMap()
    effectsCache.set(implementation.program, programCache)
  }
  programCache.set(implementation.node, effects)
}

function indexedMember(members: MemberIndex, implementation: FunctionImplementationRef): MemberInfo | undefined {
  return members.get(implementation.program)?.get(implementation.node)
}

function indexMember(members: MemberIndex, member: MemberInfo) {
  let programMembers = members.get(member.implementation.program)
  if (programMembers == null) {
    programMembers = new Map()
    members.set(member.implementation.program, programMembers)
  }
  programMembers.set(member.implementation.node, member)
}

function collectMember(implementation: FunctionImplementationRef, members: MemberIndex) {
  if (indexedMember(members, implementation) != null || cachedFunctionEffects(implementation) != null) return
  const member: MemberInfo = {
    implementation,
    effects: noEffects(),
    edges: [],
  }
  indexMember(members, member)
  const {node, program} = implementation
  const scope = buildScope(node, program)
  const classifiers = makeClassifiers(scope, program)
  collectWrites(implementation, member, classifiers, members)
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

function buildScope(node: FunctionImplementationNode, program: Program): Scope {
  const paramIndexByBinding = new Map<BindingKey, number>()
  node.parameters.forEach((parameter, index) => {
    for (const binding of bindingKeys(parameter.name, program)) paramIndexByBinding.set(binding, index)
  })
  const localBindings = new Set<BindingKey>()
  const containerEdges: {target: BindingKey; sourceRoots: BindingKey[]}[] = []
  const reachableEdges: {target: BindingKey; sourceRoots: BindingKey[]}[] = []
  const addValueFlow = (targets: BindingKey[], value: ts.Expression) => {
    const retainedRoots = freshContainerRetainedRoots(value, program)
    const edges = retainedRoots == null ? containerEdges : reachableEdges
    const sourceRoots = retainedRoots ?? expressionRootBindings(value, program)
    for (const target of targets) edges.push({target, sourceRoots})
  }
  const visit = (current: ts.Node) => {
    if (ts.isVariableDeclaration(current)) {
      const bindings = bindingKeys(current.name, program)
      for (const binding of bindings) localBindings.add(binding)
      if (current.initializer != null) addValueFlow(bindings, current.initializer)
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
        addValueFlow([bindingKey(target, program)], current.right)
      } else {
        const base = pathWriteBaseBinding(target, program)
        if (base != null) reachableEdges.push({target: base, sourceRoots: expressionRootBindings(current.right, program)})
      }
    }
    if (ts.isCallExpression(current)) {
      const target = unwrapExpression(current.expression)
      const effect = ts.isPropertyAccessExpression(target) && isDefaultLibraryMemberAccess(target, program)
        ? platformMethodEffect(
          defaultLibraryOwner(target, program),
          target.name.text,
          current.arguments.length,
        )
        : null
      if (ts.isPropertyAccessExpression(target) && effect != null) {
        const base = pathWriteBaseBinding(target.expression, program)
        if (base != null) {
          for (const index of retainedArgumentIndexes(effect, current.arguments.length)) {
            const argument = current.arguments[index]
            if (argument == null) continue
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

function freshContainerRetainedRoots(expression: ts.Expression, program: Program): BindingKey[] | null {
  const current = unwrapExpression(expression)
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap(element =>
      expressionRootBindings(ts.isSpreadElement(element) ? element.expression : element, program))
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap(property => {
      if (ts.isSpreadAssignment(property)) return expressionRootBindings(property.expression, program)
      if (ts.isShorthandPropertyAssignment(property)) return [bindingKey(property.name, program)]
      if (ts.isPropertyAssignment(property)) return expressionRootBindings(property.initializer, program)
      return []
    })
  }
  if (ts.isNewExpression(current)) {
    return (current.arguments ?? []).flatMap(argument => expressionRootBindings(argument, program))
  }
  return null
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

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  let current = symbol
  const seen = new Set<ts.Symbol>()
  while (current != null && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current)
    current = checker.getAliasedSymbol(current)
  }
  return current
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
  if (isPlatformGlobalNamespace(id.text) && isDefaultLibrarySymbol(id, program)) return true
  if (isResolvedFunctionCallRead(id, program)) return true
  if (isSafeNamespacePrimitiveRead(id, program)) return true
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

function isSafeNamespacePrimitiveRead(id: ts.Identifier, program: Program): boolean {
  const access = id.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== id) return false
  const checker = program.typeChecker
  const namespace = program.imports.get(id.text)
  if (checker == null || namespace?.kind !== 'namespace') return false
  const symbol = resolvedSymbol(checker.getSymbolAtLocation(access.name), checker)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (!isConstVariableDeclaration(declaration)) return false
  try {
    return !typeCanBeMutable(checker.getTypeAtLocation(access))
  } catch {
    return false
  }
}

function isConstVariableDeclaration(declaration: ts.Declaration | undefined): declaration is ts.VariableDeclaration {
  return declaration != null
    && ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
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
  return false
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
  implementation: FunctionImplementationRef,
  member: MemberInfo,
  classifiers: Classifiers,
  members: MemberIndex,
) {
  const {node, program} = implementation
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
    const callee = functionImplementationReference(target.program, target.fn.node)
    member.edges.push({
      callee,
      argumentRoots: arguments_.map(argument =>
        ts.isSpreadElement(argument)
          ? null
          : expressionHasMutableType(argument, program) ? classifyExpressionRoots(argument) : []),
      receiverRoots,
      classifyBinding: classifiers.reach,
    })
    collectMember(callee, members)
  }
  const addCallbackEdge = (
    call: ts.CallExpression,
    callback: PlatformCallbackEffect,
    rootsForSource: (source: PlatformValueSource) => RootKind[],
  ) => {
    const argument = call.arguments[callback.argumentIndex]
    if (argument == null) return
    const fn = functionValuedArgument(argument, program)
    if (fn == null) {
      if (expressionMayBeCallable(argument, program)) member.effects.callsUnknown = true
      return
    }
    member.edges.push({
      callee: fn,
      argumentRoots: callback.parameterSources.map(sources => sources.flatMap(rootsForSource)),
      receiverRoots: callback.thisSource == null ? [] : rootsForSource(callback.thisSource),
      classifyBinding: classifiers.reach,
    })
    collectMember(fn, members)
  }
  const applyPlatformCallEffect = (
    call: ts.CallExpression,
    effect: PlatformCallEffect,
    receiverContainerRoots: RootKind[],
    rootsForSource: (source: PlatformValueSource) => RootKind[],
  ) => {
    if (effect.observesEnvironment) member.effects.observesEnvironment = true
    if (effect.mutatesReceiver) addMutation(receiverContainerRoots)
    for (const index of effect.mutatesArgumentIndexes) {
      const argument = call.arguments[index]
      if (argument != null && !ts.isSpreadElement(argument)) addMutation(classifyExpressionRoots(argument))
    }
    const retained = retainedArgumentIndexes(effect, call.arguments.length)
    if (receiverContainerRoots.length > 0) {
      for (const index of retained) {
        const argument = call.arguments[index]
        if (argument != null && !ts.isSpreadElement(argument)) addMutation(classifyExpressionRoots(argument))
      }
    }
    for (const callback of effect.callbacks) addCallbackEdge(call, callback, rootsForSource)
  }

  const visit = (current: ts.Node) => {
    if (isFunctionImplementation(current)) return
    if (ts.isIdentifier(current)) {
      const binding = mutableOuterRead(current, classifiers, program)
      if (binding != null) addMutableOuterRead(member.effects, binding)
    }
    if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
      const target = unwrapExpression(current.left)
      const setter = (ts.isPropertyAccessExpression(target) && propertyAccessHasSourceAccessor(target, 'set', program))
        || (ts.isElementAccessExpression(target) && elementAccessHasSourceAccessor(target, 'set', program))
      const targetRoots = setter ? [] : writeTargetRoots(current.left, classifiers, program)
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
        if (propertyAccessHasSourceAccessor(current, 'get', program)) {
          addUncertainMutation(classifyExpressionRoots(current.expression))
          member.effects.callsUnknown = true
        }
      }
      if (assignment != null || increment) {
        const value = assignment?.right
        if (propertyAccessHasSourceAccessor(current, 'set', program)) {
          addUncertainMutation(classifyExpressionRoots(current.expression))
          if (value != null && expressionHasMutableType(value, program)) addUncertainMutation(classifyExpressionRoots(value))
          member.effects.callsUnknown = true
        }
      }
    }
    if (ts.isElementAccessExpression(current)) {
      const parent = current.parent
      const assignment = ts.isBinaryExpression(parent) && parent.left === current && isAssignmentOperator(parent.operatorToken.kind)
        ? parent
        : null
      const increment = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
        && parent.operand === current
        && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      if (
        (assignment == null || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        && elementAccessHasSourceAccessor(current, 'get', program)
      ) {
        addUncertainMutation(classifyExpressionRoots(current.expression))
        member.effects.callsUnknown = true
      }
      if ((assignment != null || increment) && elementAccessHasSourceAccessor(current, 'set', program)) {
        addUncertainMutation(classifyExpressionRoots(current.expression))
        const value = assignment?.right
        if (value != null && expressionHasMutableType(value, program)) addUncertainMutation(classifyExpressionRoots(value))
        member.effects.callsUnknown = true
      }
    }
    if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
      && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)) {
      const target = unwrapExpression(current.operand)
      const setter = (ts.isPropertyAccessExpression(target) && propertyAccessHasSourceAccessor(target, 'set', program))
        || (ts.isElementAccessExpression(target) && elementAccessHasSourceAccessor(target, 'set', program))
      if (!setter) addMutation(writeTargetRoots(current.operand, classifiers, program))
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
      if (defaultLibraryGlobal) {
        const effect = platformGlobalEffect(base.text, target.name.text, call.arguments.length)
        if (effect == null) {
          addUncertainMutation(mutableArgumentRoots(call, program, classifyExpressionRoots))
          member.effects.callsUnknown = true
        } else {
          applyPlatformCallEffect(call, effect, [], source => {
            if (source.kind !== 'argument') return []
            const argument = call.arguments[source.index]
            return argument == null || ts.isSpreadElement(argument) ? [] : classifyExpressionRoots(argument)
          })
        }
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
      const receiverBase = pathWriteBaseBinding(target.expression, program)
      const receiverContainerRoots = receiverBase != null
        ? classifiers.container(receiverBase)
        : classifyExpressionRoots(target.expression)
      const receiverElementRoots = receiverBase != null
        ? classifiers.reach(receiverBase)
        : classifyExpressionRoots(target.expression)
      const effect = defaultLibraryMember
        ? platformMethodEffect(
          defaultLibraryOwner(target, program),
          target.name.text,
          call.arguments.length,
        )
        : null
      if (effect == null) {
        addUncertainMutation(receiverElementRoots)
        addUncertainMutation(mutableArgumentRoots(call, program, classifyExpressionRoots))
        member.effects.callsUnknown = true
      } else {
        applyPlatformCallEffect(call, effect, receiverContainerRoots, source => {
          switch (source.kind) {
            case 'receiver':
              return receiverContainerRoots
            case 'receiver-elements':
              return receiverElementRoots
            case 'argument': {
              const argument = call.arguments[source.index]
              return argument == null || ts.isSpreadElement(argument) ? [] : classifyExpressionRoots(argument)
            }
          }
        })
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

  const collectNew = (expression: ts.NewExpression) => {
    const name = ts.isIdentifier(expression.expression) ? expression.expression.text : null
    if (name === 'Date' && isDefaultLibrarySymbol(expression.expression, program)) {
      if ((expression.arguments?.length ?? 0) === 0) member.effects.observesEnvironment = true
      else member.effects.callsUnknown = true
      return
    }
    if (
      name != null
      && zeroArgumentCollectionConstructorNames.has(name)
      && isDefaultLibrarySymbol(expression.expression, program)
      && (expression.arguments?.length ?? 0) === 0
    ) return
    if (name != null && lengthBearingConstructorNames.has(name) && isDefaultLibrarySymbol(expression.expression, program)) return
    for (const argument of expression.arguments ?? []) {
      if (expressionHasMutableType(argument, program)) addUncertainMutation(classifyExpressionRoots(argument))
    }
    // A user-defined construction includes base constructors, instance field
    // initializers, and dynamic class behavior. Until those execute through one
    // complete model, source-backed and declaration-only classes share the same
    // conservative boundary.
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

const zeroArgumentCollectionConstructorNames = new Set([
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
])

function functionValuedArgument(argument: ts.Expression, program: Program): FunctionImplementationRef | null {
  const current = unwrapExpression(argument)
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    return functionImplementationReference(program, current)
  }
  if (ts.isIdentifier(current)) {
    const resolved = resolveCallTarget(current, program)
    if (resolved.kind === 'function') {
      return functionImplementationReference(resolved.program, resolved.fn.node)
    }
  }
  return null
}

function expressionMayBeCallable(expression: ts.Expression, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return false
  try {
    return checker.getTypeAtLocation(unwrapExpression(expression)).getCallSignatures().length > 0
  } catch {
    return false
  }
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
