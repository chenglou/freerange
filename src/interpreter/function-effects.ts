import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {
  callTargetImplementation,
  defaultLibraryOwner,
  elementAccessHasSourceAccessor,
  elementAccessPropertySymbols,
  mutableFunctionBindingReason,
  isDefaultLibraryMemberAccess,
  isDefaultLibraryElementAccess,
  isDefaultLibrarySymbol,
  propertyAccessHasSourceAccessor,
  resolveCallTarget,
} from './call-targets.ts'
import {
  assertFunctionImplementationReference,
  isFunctionImplementation,
  type FunctionImplementationRef,
  type FunctionImplementationNode,
} from '../function-shape.ts'
import {isAssignmentOperator, unwrapExpression} from './source-syntax.ts'
import {
  callExpressionsForPosition,
  parameterValues,
  structuredCallArguments,
  type StructuredArgument,
} from './call-arguments.ts'
import {
  classifyPlatformGlobalCall,
  classifyPlatformMethodCall,
  isPlatformGlobalNamespace,
  type PlatformCallbackEffect,
  type PlatformCallClassification,
  type PlatformCallEffect,
  type PlatformResultEffect,
  type PlatformValueSource,
} from './platform-effects.ts'

// What a call can change in its caller's world, beyond returning a value.
// `paramIndexes` holds parameters whose argument may be written through.
// `retentions` separately records references stored somewhere that outlives
// the call. The interpreter forgets caller facts when it cannot represent the
// new alias. Outside bindings retain TypeScript identity until the caller asks
// for the root names from one source.
// The mutation fields are what the interpreter uses to forget caller facts.
// The remaining fields extend the summary to the stricter notion a `pure`
// annotation needs: a pure function also reads no mutable outside state, never
// observes or affects the environment (I/O, the clock, randomness), and calls
// nothing it cannot analyze. Purity is derived from this summary, never stored
// separately.
type DefinitionKey = {kind: 'definition'; node: ts.Node}
type AllocationKey = {kind: 'allocation'; node: ts.Node}
type BindingKey = ts.Symbol | string | DefinitionKey | AllocationKey

function isDefinitionKey(key: BindingKey): key is DefinitionKey {
  return typeof key === 'object' && 'kind' in key && key.kind === 'definition'
}

function isAllocationKey(key: BindingKey): key is AllocationKey {
  return typeof key === 'object' && 'kind' in key && key.kind === 'allocation'
}

type OuterBinding = {
  key: BindingKey
  sourceId: string
  root: string
}

type RootKind =
  | {kind: 'param'; index: number; contained: boolean}
  | {kind: 'outer'; binding: OuterBinding; contained: boolean}
  | {kind: 'fresh'}
  | {kind: 'this'}

type FunctionResult = {
  fresh: boolean
  argumentIndexes: readonly number[]
  outerBindings: readonly OuterBinding[]
  unknownReason: string | null
}

type MutationTargets = {
  outerBindings: Map<BindingKey, OuterBinding>
  containedOuterBindings: Map<BindingKey, OuterBinding>
  paramIndexes: Set<number>
  containedParamIndexes: Set<number>
  thisValue: boolean
}

type RetentionEffect = {
  destinations: MutationTargets
  values: MutationTargets
}

export type FunctionEffects = {
  mutations: {
    certain: MutationTargets
    // A call whose body is unavailable may mutate these targets. The
    // interpreter forgets their facts, while `pure` reports the call as unknown
    // instead of claiming that the mutation definitely occurs.
    uncertain: MutationTargets
  }
  // Reassigning a captured binding changes the local name, not the object the
  // name previously referred to. It remains observable only while that binding
  // is still outside the function being summarized.
  reassignedOuterBindings: Map<BindingKey, OuterBinding>
  // Existing references stored into a parameter or outside container. This is
  // not a mutation of the retained value. Keep both sides so callers can add
  // the alias when the destination is local, or conservatively forget facts
  // when the interpreter cannot represent the alias.
  retentions: RetentionEffect[]
  // Module-level `let`/`var` reads, and reads through `const` objects/arrays.
  // Keep the bindings so callers can reclassify captured locals correctly.
  mutableOuterReads: Map<BindingKey, OuterBinding>
  // calls console.*, Date.now, performance.now, or Math.random: I/O or a value
  // that differs across runs with the same inputs
  observesEnvironment: boolean
  // calls something the analysis cannot resolve to a known function or method,
  // so it could do anything and the function cannot be proved pure. Keep the
  // reasons so deliberate platform boundaries survive through helper calls.
  unknownCallReasons: Set<string>
  // Function shapes that the purity boundary deliberately does not model.
  // These reasons take precedence over otherwise definite effects: any use of
  // `this`, for example, is unknown rather than a partly analyzed mutation.
  boundaryUnknownReasons: Set<string>
  throws: boolean
  // Only the returned outer object crosses a function boundary. References
  // stored inside a returned object or array are deliberately not summarized.
  result: FunctionResult
}

const unknownCallBodyReason = 'calls a function whose body cannot be analyzed'
const unknownReturnReason = 'cannot determine whether the returned object or array is new or comes from an argument'
const recursiveFunctionReason = 'recursive functions are unsupported'
const implicitStringConversionReason = 'implicit object-to-string conversion can run user code'
const opaqueFreshResult = '__freerange_opaque_fresh_result__'

const noMutationTargets = (): MutationTargets => ({
  outerBindings: new Map(),
  containedOuterBindings: new Map(),
  paramIndexes: new Set(),
  containedParamIndexes: new Set(),
  thisValue: false,
})

const unknownFunctionResult = (reason = unknownReturnReason): FunctionResult => ({
  fresh: false,
  argumentIndexes: [],
  outerBindings: [],
  unknownReason: reason,
})

const emptyFunctionResult = (): FunctionResult => ({
  fresh: false,
  argumentIndexes: [],
  outerBindings: [],
  unknownReason: null,
})

const noEffects = (result: FunctionResult = emptyFunctionResult()): FunctionEffects => ({
  mutations: {
    certain: noMutationTargets(),
    uncertain: noMutationTargets(),
  },
  reassignedOuterBindings: new Map(),
  retentions: [],
  mutableOuterReads: new Map(),
  observesEnvironment: false,
  unknownCallReasons: new Set(),
  boundaryUnknownReasons: new Set(),
  throws: false,
  result,
})

// A function is pure when it changes nothing observable, reads no mutable
// outside state, observes no environment, and calls nothing unanalyzable. Local
// mutation, allocation, and reading module-level `const` primitives are fine.
// Throwing and other definite effects make the function impure. An unanalyzable
// call leaves the claim unknown because the callee could be pure or not. This
// result is derived from the effect summary, so there is one source of truth.
export type Purity =
  | {kind: 'pure'}
  | {kind: 'impure'; reason: string}
  | {kind: 'unknown'; reason: string}

export function functionPurity(implementation: FunctionImplementationRef): Purity {
  const node = implementation.node
  const effects = functionEffects(implementation)
  if (effects.throws) return {kind: 'impure', reason: 'throws'}
  const mutatedParam = effects.mutations.certain.paramIndexes.values().next().value
    ?? effects.mutations.certain.containedParamIndexes.values().next().value
  if (mutatedParam != null) {
    const parameter = node.parameters[mutatedParam]?.name
    const name = parameter != null && ts.isIdentifier(parameter) ? parameter.text : null
    return {kind: 'impure', reason: name == null ? 'mutates a parameter' : `mutates parameter \`${name}\``}
  }
  const writtenOuter = firstOuterRoot(effects.mutations.certain)
  if (writtenOuter != null) {
    return {kind: 'impure', reason: `writes outside state \`${writtenOuter}\``}
  }
  const reassignedOuter = effects.reassignedOuterBindings.values().next().value
  if (reassignedOuter != null) {
    return {kind: 'impure', reason: `writes outside state \`${reassignedOuter.root}\``}
  }
  if (effects.mutableOuterReads.size > 0) return {kind: 'impure', reason: 'reads mutable outside state'}
  if (effects.observesEnvironment) return {kind: 'impure', reason: 'observes the environment (I/O, the clock, or randomness)'}
  const boundaryReason = effects.boundaryUnknownReasons.values().next().value
  if (boundaryReason != null) return {kind: 'unknown', reason: boundaryReason}
  const unknownCallReason = effects.unknownCallReasons.values().next().value
  if (unknownCallReason != null) return {kind: 'unknown', reason: unknownCallReason}
  return {kind: 'pure'}
}

function firstOuterRoot(targets: MutationTargets): string | null {
  return targets.outerBindings.values().next().value?.root
    ?? targets.containedOuterBindings.values().next().value?.root
    ?? null
}

export function mutationRootsForProgram(targets: MutationTargets, program: Program): string[] {
  return outerBindingRootsForProgram([
    ...targets.outerBindings.values(),
    ...targets.containedOuterBindings.values(),
  ], program)
}

export function retainedValues(effects: FunctionEffects): MutationTargets {
  const values = noMutationTargets()
  for (const retention of effects.retentions) addMutationTargets(values, retention.values)
  return values
}

function addMutationTargets(target: MutationTargets, source: MutationTargets) {
  for (const binding of source.outerBindings.values()) {
    target.outerBindings.set(binding.key, binding)
  }
  for (const binding of source.containedOuterBindings.values()) {
    target.containedOuterBindings.set(binding.key, binding)
  }
  for (const index of source.paramIndexes) target.paramIndexes.add(index)
  for (const index of source.containedParamIndexes) target.containedParamIndexes.add(index)
  target.thisValue ||= source.thisValue
}

export function reassignedRootsForProgram(effects: FunctionEffects, program: Program): string[] {
  return outerBindingRootsForProgram(effects.reassignedOuterBindings.values(), program)
}

function outerBindingRootsForProgram(bindings: Iterable<OuterBinding>, program: Program): string[] {
  const roots = new Set<string>()
  for (const binding of bindings) {
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

type CallEdge = {
  callee: FunctionImplementationRef
  arguments: StructuredArgument<ArgumentRoots>[]
  receiverRoots: ClassifiedRoots
  classifyBindingContainer: Classifier
  classifyBindingReach: Classifier
  classifyBindingReachUnknown: (binding: BindingKey) => string | null
}

type ArgumentRoots = {
  container: ClassifiedRoots
  reach: ClassifiedRoots
}

type MemberInfo = {
  implementation: FunctionImplementationRef
  effects: FunctionEffects
  edges: CallEdge[]
}

export function functionEffects(implementation: FunctionImplementationRef): FunctionEffects {
  assertFunctionImplementationReference(implementation)
  return analyzeFunctionEffects(implementation, {
    active: new Map(),
    completed: new Map(),
  })
}

type AnalysisState = {
  active: Map<Program, Set<FunctionImplementationNode>>
  completed: Map<Program, Map<FunctionImplementationNode, FunctionEffects>>
}

function analyzeFunctionEffects(
  implementation: FunctionImplementationRef,
  state: AnalysisState,
): FunctionEffects {
  const completed = state.completed.get(implementation.program)?.get(implementation.node)
  if (completed != null) return completed
  let activeForProgram = state.active.get(implementation.program)
  if (activeForProgram?.has(implementation.node) === true) {
    const recursive = noEffects(unknownFunctionResult(recursiveFunctionReason))
    recursive.boundaryUnknownReasons.add(recursiveFunctionReason)
    implementation.node.parameters.forEach((_, index) => {
      recursive.mutations.uncertain.paramIndexes.add(index)
      recursive.mutations.uncertain.containedParamIndexes.add(index)
    })
    return recursive
  }
  if (activeForProgram == null) {
    activeForProgram = new Set()
    state.active.set(implementation.program, activeForProgram)
  }
  activeForProgram.add(implementation.node)

  const context: ValueFlowContext = {
    resultFor: callee => analyzeFunctionEffects(callee, state).result,
    effectsFor: callee => analyzeFunctionEffects(callee, state),
  }
  const scope = buildScope(implementation.node, implementation.program, context)
  const result = analyzeFunctionResult(implementation, context, scope)
  const member: MemberInfo = {implementation, effects: noEffects(result), edges: []}
  addFunctionBoundaryEffects(member.effects, implementation.node)
  collectWrites(
    implementation,
    member,
    scope,
    valueFlowContextForScope(context, scope),
  )
  for (const edge of member.edges) {
    composeEdge(member.effects, edge, analyzeFunctionEffects(edge.callee, state))
  }

  activeForProgram.delete(implementation.node)
  if (activeForProgram.size === 0) state.active.delete(implementation.program)
  let completedForProgram = state.completed.get(implementation.program)
  if (completedForProgram == null) {
    completedForProgram = new Map()
    state.completed.set(implementation.program, completedForProgram)
  }
  completedForProgram.set(implementation.node, member.effects)
  return member.effects
}

function addFunctionBoundaryEffects(effects: FunctionEffects, node: FunctionImplementationNode) {
  const boundaryReason = functionBoundaryReason(node)
  if (boundaryReason != null) effects.boundaryUnknownReasons.add(boundaryReason)
}

function functionBoundaryReason(node: FunctionImplementationNode): string | null {
  if (functionHasMutableBinding(node)) return 'functions stored in mutable bindings are unsupported'
  if (
    ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
  ) return 'class constructors, methods, getters, and setters are unsupported'
  if (node.asteriskToken != null) return 'generator functions are unsupported'
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) return 'async functions are unsupported'
  if (functionUsesThis(node)) return 'functions that use `this` are unsupported'
  if (functionContains(node, ts.isTryStatement)) return 'try/catch is unsupported'
  if (functionContains(node, ts.isLabeledStatement)) return 'labeled control flow is unsupported'
  return null
}

function functionHasMutableBinding(node: FunctionImplementationNode): boolean {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isVariableDeclaration(current)) {
      return (ts.getCombinedNodeFlags(current.parent) & ts.NodeFlags.Const) === 0
    }
    if (ts.isFunctionLike(current)) return false
  }
  return false
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function functionContains<T extends ts.Node>(
  node: FunctionImplementationNode,
  predicate: (node: ts.Node) => node is T,
): boolean {
  let found = false
  const visit = (current: ts.Node) => {
    if (found || (current !== node && isFunctionImplementation(current))) return
    if (predicate(current)) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

function composeEdge(into: FunctionEffects, edge: CallEdge, callee: FunctionEffects) {
  const add = (targets: MutationTargets, roots: RootKind[]) => {
    addMutationRoots(targets, roots)
  }
  const addMapped = (mapping: ClassifiedRoots, certain: boolean) => {
    if (mapping.unknownReason != null) {
      into.unknownCallReasons.add(mapping.unknownReason)
      add(into.mutations.uncertain, mapping.roots)
      return
    }
    add(certain ? into.mutations.certain : into.mutations.uncertain, mapping.roots)
  }
  const addOuterMutation = (binding: OuterBinding, certain: boolean) => {
    const containers = edge.classifyBindingContainer(binding.key)
    if (containers.length > 0) {
      add(certain ? into.mutations.certain : into.mutations.uncertain, containers)
      return
    }
    const reachable = edge.classifyBindingReach(binding.key)
    if (reachable.length === 0) return
    add(into.mutations.uncertain, reachable)
    into.unknownCallReasons.add(
      'a nested function changes a local container that also contains an argument',
    )
  }
  const addContainedOuterMutation = (binding: OuterBinding, certain: boolean) => {
    addMapped({
      roots: edge.classifyBindingReach(binding.key),
      unknownReason: edge.classifyBindingReachUnknown(binding.key),
    }, certain)
  }
  for (const binding of callee.mutations.certain.outerBindings.values()) {
    addOuterMutation(binding, true)
  }
  for (const binding of callee.mutations.certain.containedOuterBindings.values()) {
    addContainedOuterMutation(binding, true)
  }
  for (const binding of callee.mutations.uncertain.outerBindings.values()) {
    addOuterMutation(binding, false)
  }
  for (const binding of callee.mutations.uncertain.containedOuterBindings.values()) {
    addContainedOuterMutation(binding, false)
  }
  for (const binding of callee.reassignedOuterBindings.values()) {
    for (const root of edge.classifyBindingContainer(binding.key)) {
      if (root.kind === 'outer') {
        into.reassignedOuterBindings.set(root.binding.key, root.binding)
      }
    }
  }
  // These three describe the callee itself, not anything it does through this
  // edge's arguments, so they propagate to every caller unconditionally: calling
  // an impure function is impure.
  for (const binding of callee.mutableOuterReads.values()) {
    for (const root of edge.classifyBindingReach(binding.key)) {
      if (root.kind !== 'outer') continue
      addMutableOuterRead(into, root.binding)
    }
  }
  if (callee.observesEnvironment) into.observesEnvironment = true
  if (callee.throws) into.throws = true
  for (const reason of callee.boundaryUnknownReasons) into.boundaryUnknownReasons.add(reason)
  if (callee.mutations.certain.thisValue) addMapped(edge.receiverRoots, true)
  if (callee.mutations.uncertain.thisValue) addMapped(edge.receiverRoots, false)
  for (const reason of callee.unknownCallReasons) into.unknownCallReasons.add(reason)
  const mapParamIndexes = (
    indexes: Set<number>,
    select: (roots: ArgumentRoots) => ClassifiedRoots,
    apply: (roots: ClassifiedRoots) => void,
  ) => {
    for (const index of indexes) {
      const mapped = parameterValues(
        edge.callee.node.parameters[index]?.dotDotDotToken != null,
        index,
        edge.arguments,
      )
      for (const roots of mapped.values) {
        const selected = select(roots)
        apply(mapped.inexactSpread
          ? mergeClassifiedRoots([
              selected,
              {roots: [], unknownReason: 'cannot determine which spread element the called function changes or stores'},
            ])
          : selected)
      }
      if (mapped.inexactSpread && mapped.values.length === 0) {
        apply({
          roots: [],
          unknownReason: 'cannot determine which spread element the called function changes or stores',
        })
      }
    }
  }
  mapParamIndexes(callee.mutations.certain.paramIndexes, roots => roots.container, roots => addMapped(roots, true))
  mapParamIndexes(callee.mutations.certain.containedParamIndexes, roots => roots.reach, roots => addMapped(roots, true))
  mapParamIndexes(callee.mutations.uncertain.paramIndexes, roots => roots.container, roots => addMapped(roots, false))
  mapParamIndexes(callee.mutations.uncertain.containedParamIndexes, roots => roots.reach, roots => addMapped(roots, false))
  const mapTargets = (targets: MutationTargets, values: boolean): ClassifiedRoots => {
    const mapped: ClassifiedRoots[] = []
    for (const binding of targets.outerBindings.values()) {
      mapped.push({
        roots: values
          ? edge.classifyBindingReach(binding.key)
          : edge.classifyBindingContainer(binding.key),
        unknownReason: null,
      })
    }
    for (const binding of targets.containedOuterBindings.values()) {
      mapped.push({roots: edge.classifyBindingReach(binding.key), unknownReason: null})
    }
    if (targets.thisValue) mapped.push(edge.receiverRoots)
    mapParamIndexes(
      targets.paramIndexes,
      roots => values ? roots.reach : roots.container,
      roots => mapped.push(roots),
    )
    mapParamIndexes(
      targets.containedParamIndexes,
      roots => roots.reach,
      roots => mapped.push(roots),
    )
    return mergeClassifiedRoots(mapped)
  }
  for (const retention of callee.retentions) {
    const destinations = mapTargets(retention.destinations, false)
    const values = mapTargets(retention.values, true)
    if (destinations.unknownReason != null) into.unknownCallReasons.add(destinations.unknownReason)
    if (values.unknownReason != null) into.unknownCallReasons.add(values.unknownReason)
    const mappedRetention: RetentionEffect = {
      destinations: noMutationTargets(),
      values: noMutationTargets(),
    }
    addMutationRoots(mappedRetention.destinations, destinations.roots)
    addMutationRoots(mappedRetention.values, values.roots)
    if (!mutationTargetsEmpty(mappedRetention.destinations) && !mutationTargetsEmpty(mappedRetention.values)) {
      into.retentions.push(mappedRetention)
    }
  }
}

function addMutationRoots(targets: MutationTargets, roots: RootKind[]) {
  for (const root of roots) {
    switch (root.kind) {
      case 'param':
        (root.contained ? targets.containedParamIndexes : targets.paramIndexes).add(root.index)
        break
      case 'outer':
        (root.contained ? targets.containedOuterBindings : targets.outerBindings)
          .set(root.binding.key, root.binding)
        break
      case 'fresh':
        break
      case 'this':
        targets.thisValue = true
        break
    }
  }
}

function mutationTargetsEmpty(targets: MutationTargets): boolean {
  return targets.outerBindings.size === 0
    && targets.containedOuterBindings.size === 0
    && targets.paramIndexes.size === 0
    && targets.containedParamIndexes.size === 0
    && !targets.thisValue
}

function addMutableOuterRead(effects: FunctionEffects, binding: OuterBinding) {
  effects.mutableOuterReads.set(binding.key, binding)
}

function analyzeFunctionResult(
  implementation: FunctionImplementationRef,
  context: ValueFlowContext,
  scope: Scope,
): FunctionResult {
  const scopedContext = valueFlowContextForScope(context, scope)
  const returned = returnedExpressions(implementation.node)
    .map(unwrapExpression)
    .filter(expression => scope.reachableNodes.has(expression))
  if (returned.length === 0) return emptyFunctionResult()
  const flow = mergeValueFlows(returned.map(expression =>
    expressionValueFlow(expression, implementation.program, scopedContext)))
  return valueFlowFunctionResult(
    flow,
    scope,
    implementation.program,
    valueFlowUnknownReason(flow, scope),
  )
}

function valueFlowFunctionResult(
  flow: ValueFlow,
  scope: Scope,
  program: Program,
  initialUnknownReason: string | null,
): FunctionResult {
  let hasFresh = false
  let unknownReason = initialUnknownReason
  const arguments_ = new Set<number>()
  const outers = new Map<BindingKey, OuterBinding>()
  for (const reference of flow.references) {
    if (reference.binding === opaqueFreshResult) {
      if (reference.selections > 0) unknownReason ??= unknownReturnReason
      else hasFresh = true
      continue
    }
    const roots = bindingFunctionReferences(reference, scope, program, new Set())
    for (const root of roots) {
      if (root.containers > 0) {
        hasFresh = true
        continue
      }
      if (root.source.kind === 'fresh') {
        if (root.selections === 0) hasFresh = true
      } else if (root.source.kind === 'param') {
        arguments_.add(root.source.index)
      } else if (root.source.kind === 'outer') {
        outers.set(root.source.binding.key, root.source.binding)
      } else {
        unknownReason ??= 'functions that return `this` are unsupported'
      }
    }
  }
  return {
    fresh: hasFresh,
    argumentIndexes: [...arguments_],
    outerBindings: [...outers.values()],
    unknownReason,
  }
}

type LocalResultReference = {
  source: RootKind
  selections: number
  containers: number
}

function bindingFunctionReferences(
  reference: ValueReference,
  scope: Scope,
  program: Program,
  seen: Set<BindingKey>,
): LocalResultReference[] {
  const aggregateUnknown = scope.aggregateUnknownReasons.get(reference.binding)
  if (
    reference.selections > 0
    && aggregateUnknown != null
    && reference.at >= aggregateUnknown.from
  ) return []
  if (seen.has(reference.binding)) return []
  seen.add(reference.binding)

  const references: LocalResultReference[] = []
  const direct = directRoot(reference.binding, scope, program)
  if (direct != null) {
    references.push({
      source: reference.selections > 0 ? containedRoot(direct) : direct,
      selections: reference.selections,
      containers: reference.containers,
    })
  }
  for (const source of scope.references.get(reference.binding) ?? []) {
    addResultReferences(
      references,
      bindingFunctionReferences(
        composeValueReferences(source, reference),
        scope,
        program,
        seen,
      ),
    )
  }
  seen.delete(reference.binding)
  return references
}

function directRoot(binding: BindingKey, scope: Scope, program: Program): RootKind | null {
  if (binding === opaqueFreshResult || isAllocationKey(binding)) return {kind: 'fresh'}
  if (binding === 'this') return {kind: 'this'}
  const paramIndex = scope.paramIndexByBinding.get(binding)
  if (paramIndex != null) return {kind: 'param', index: paramIndex, contained: false}
  if (scope.localBindings.has(binding)) return null
  return {kind: 'outer', binding: outerBinding(binding, program), contained: false}
}

function containedRoot(root: RootKind): RootKind {
  switch (root.kind) {
    case 'param': return {...root, contained: true}
    case 'outer': return {...root, contained: true}
    case 'fresh':
    case 'this':
      return root
  }
}

function addResultReferences(
  target: LocalResultReference[],
  sources: readonly LocalResultReference[],
) {
  for (const source of sources) {
    if (!target.some(existing =>
      existing.selections === source.selections
      && existing.containers === source.containers
      && sameRoot(existing.source, source.source))) {
      target.push(source)
    }
  }
}

function sameRoot(left: RootKind, right: RootKind): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'param':
      return right.kind === 'param' && left.index === right.index && left.contained === right.contained
    case 'outer':
      return right.kind === 'outer'
        && left.binding.key === right.binding.key
        && left.contained === right.contained
    case 'fresh':
      return right.kind === 'fresh'
    case 'this':
      return right.kind === 'this'
  }
}

type Scope = {
  paramIndexByBinding: Map<BindingKey, number>
  localBindings: Set<BindingKey>
  references: Map<BindingKey, ValueReference[]>
  unknownReasons: Map<BindingKey, string>
  aggregateUnknownReasons: Map<BindingKey, {reason: string; from: number}>
  reachableNodes: Set<ts.Node>
  definitionsAtUse: Map<ts.Identifier, BindingKey>
  definitionsAtCall: Map<ts.CallExpression, DefinitionState>
  allocationKeys: Map<ts.Expression, AllocationKey>
}

type ValueFlowContext = {
  resultFor: (implementation: FunctionImplementationRef) => FunctionResult
  effectsFor: (implementation: FunctionImplementationRef) => FunctionEffects
  definitionFor?: (identifier: ts.Identifier) => BindingKey | null
  allocationFor?: (expression: ts.Expression) => AllocationKey
}

type DefinitionState = Map<BindingKey, BindingKey>

function valueFlowContextForScope(
  context: ValueFlowContext,
  scope: Scope,
): ValueFlowContext {
  return {
    ...context,
    definitionFor: identifier =>
      scope.definitionsAtUse.get(identifier) ?? null,
    allocationFor: expression => {
      let allocation = scope.allocationKeys.get(expression)
      if (allocation == null) {
        allocation = {kind: 'allocation', node: expression}
        scope.allocationKeys.set(expression, allocation)
      }
      return allocation
    },
  }
}

type ValueReference = {
  binding: BindingKey
  selections: number
  containers: number
  at: number
}

type ValueFlow = {
  references: ValueReference[]
  unknownReason: string | null
}

function buildScope(
  node: FunctionImplementationNode,
  program: Program,
  context: ValueFlowContext,
): Scope {
  const paramIndexByBinding = new Map<BindingKey, number>()
  const localBindings = new Set<BindingKey>()
  const referenceEdges: {target: BindingKey; reference: ValueReference; reversible: boolean}[] = []
  const unknownReasons = new Map<BindingKey, string>()
  const aggregateUnknownReasons = new Map<BindingKey, {reason: string; from: number}>()
  const reachableNodes = new Set<ts.Node>()
  const definitionsAtUse = new Map<ts.Identifier, BindingKey>()
  const definitionsAtCall = new Map<ts.CallExpression, DefinitionState>()
  const definitionKeys = new Map<ts.Node, Map<BindingKey, DefinitionKey>>()
  const regionStarts = new Map<Map<BindingKey, DefinitionKey>, number>()
  const allocationKeys = new Map<ts.Expression, AllocationKey>()
  const allocationFor = (expression: ts.Expression): AllocationKey => {
    let allocation = allocationKeys.get(expression)
    if (allocation == null) {
      allocation = {kind: 'allocation', node: expression}
      allocationKeys.set(expression, allocation)
    }
    return allocation
  }
  const scopeContext: ValueFlowContext = {
    ...context,
    definitionFor: identifier => definitionsAtUse.get(identifier) ?? null,
    allocationFor,
  }
  const copyDefinitions = (definitions: DefinitionState): DefinitionState =>
    new Map(definitions)
  const recordNode = (current: ts.Node, definitions: DefinitionState) => {
    reachableNodes.add(current)
    if (ts.isIdentifier(current)) {
      const binding = bindingKey(current, program)
      definitionsAtUse.set(current, definitions.get(binding) ?? binding)
    }
  }
  const addValueFlow = (target: BindingKey, flow: ValueFlow, reversible = true) => {
    for (const reference of flow.references) referenceEdges.push({target, reference, reversible})
    if (flow.unknownReason != null && !unknownReasons.has(target)) {
      unknownReasons.set(target, flow.unknownReason)
    }
  }
  const markAggregateUnknown = (binding: BindingKey, reason: string, from: number) => {
    const previous = aggregateUnknownReasons.get(binding)
    if (previous == null || from < previous.from) {
      aggregateUnknownReasons.set(binding, {reason, from})
    }
  }
  const assignmentEnd = (target: ts.Expression): number => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    for (let current: ts.Node = target; current.parent != null; current = current.parent) {
      const parent = current.parent
      if (ts.isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
        return parent.end
      }
      if (ts.isStatement(parent) || isFunctionImplementation(parent)) break
    }
    return target.end
  }
  const definitionKey = (target: ts.Node, binding: BindingKey): DefinitionKey => {
    let bindings = definitionKeys.get(target)
    if (bindings == null) {
      bindings = new Map()
      definitionKeys.set(target, bindings)
    }
    let definition = bindings.get(binding)
    if (definition == null) {
      definition = {kind: 'definition', node: target}
      bindings.set(binding, definition)
    }
    return definition
  }
  const addTargetValueFlow = (
    target: AssignmentTarget,
    flow: ValueFlow,
    definitions: DefinitionState,
    region: Map<BindingKey, DefinitionKey> | null,
  ) => {
    if (target.kind === 'binding') {
      const binding = bindingKey(target.identifier, program)
      const definition = region?.get(binding) ?? definitionKey(target.identifier, binding)
      localBindings.add(definition)
      addValueFlow(definition, flow)
      definitions.set(binding, definition)
      return
    }
    const base = pathWriteBaseBinding(target.expression, program)
    if (base != null && expressionHasMutableType(target.expression, program)) {
      markAggregateUnknown(
        definitions.get(base) ?? base,
        'cannot determine where a value stored in a replaced field or entry came from',
        region == null ? assignmentEnd(target.expression) : regionStarts.get(region)!,
      )
    }
  }
  const precollectBindings = (current: ts.Node) => {
    if (ts.isFunctionDeclaration(current) && current.name != null) {
      localBindings.add(bindingKey(current.name, program))
      return
    }
    if (current !== node && isFunctionImplementation(current)) return
    if (ts.isVariableDeclaration(current)) {
      for (const binding of bindingKeys(current.name, program)) localBindings.add(binding)
    }
    if (ts.isClassDeclaration(current) && current.name != null) {
      localBindings.add(bindingKey(current.name, program))
    }
    if (ts.isCatchClause(current) && current.variableDeclaration != null) {
      for (const binding of bindingKeys(current.variableDeclaration.name, program)) localBindings.add(binding)
    }
    ts.forEachChild(current, precollectBindings)
  }
  for (const parameter of node.parameters) {
    for (const binding of bindingKeys(parameter.name, program)) localBindings.add(binding)
  }
  ts.forEachChild(node, precollectBindings)

  const assignTargets = (
    targets: readonly TargetValueFlow[],
    definitions: DefinitionState,
    region: Map<BindingKey, DefinitionKey> | null,
  ) => {
    for (const {target, flow} of targets) addTargetValueFlow(target, flow, definitions, region)
  }

  const assignedBindingsIn = (current: ts.Node): Set<BindingKey> => {
    const bindings = new Set<BindingKey>()
    const visit = (child: ts.Node) => {
      if (child !== current && isFunctionImplementation(child)) return
      if (ts.isVariableDeclaration(child)) {
        for (const binding of bindingKeys(child.name, program)) bindings.add(binding)
      }
      if (ts.isBinaryExpression(child) && assignmentMayTakeRightValue(child.operatorToken.kind)) {
        for (const target of assignmentTargets(child.left)) {
          if (target.kind === 'binding') bindings.add(bindingKey(target.identifier, program))
        }
      }
      if (
        (ts.isForOfStatement(child) || ts.isForInStatement(child))
        && !ts.isVariableDeclarationList(child.initializer)
      ) {
        for (const target of assignmentTargets(child.initializer)) {
          if (target.kind === 'binding') bindings.add(bindingKey(target.identifier, program))
        }
      }
      ts.forEachChild(child, visit)
    }
    visit(current)
    return bindings
  }

  const withRegion = (
    current: ts.Node,
    definitions: DefinitionState,
    existing: Map<BindingKey, DefinitionKey> | null,
    visit: (region: Map<BindingKey, DefinitionKey>) => void,
  ) => {
    if (existing != null) {
      visit(existing)
      return
    }
    const region = new Map<BindingKey, DefinitionKey>()
    regionStarts.set(region, current.pos)
    for (const binding of assignedBindingsIn(current)) {
      const definition = definitionKey(current, binding)
      region.set(binding, definition)
      localBindings.add(definition)
      addValueFlow(definition, {
        references: [{
          binding: definitions.get(binding) ?? binding,
          selections: 0,
          containers: 0,
          at: current.pos,
        }],
        unknownReason: null,
      })
      definitions.set(binding, definition)
    }
    visit(region)
  }

  const flowExpression = (
    expression: ts.Expression,
    definitions: DefinitionState,
    region: Map<BindingKey, DefinitionKey> | null,
  ) => {
    const current = unwrapExpression(expression)
    recordNode(current, definitions)
    if (isFunctionImplementation(current)) return
    if (ts.isIdentifier(current)) return
    if (ts.isConditionalExpression(current)) {
      flowExpression(current.condition, definitions, region)
      withRegion(current, definitions, region, conditionalRegion => {
        flowExpression(current.whenTrue, definitions, conditionalRegion)
        flowExpression(current.whenFalse, definitions, conditionalRegion)
      })
      return
    }
    if (ts.isBinaryExpression(current)) {
      flowExpression(current.left, definitions, region)
      if (assignmentMayTakeRightValue(current.operatorToken.kind)) {
        const assign = (assignmentRegion: Map<BindingKey, DefinitionKey> | null) => {
          flowExpression(current.right, definitions, assignmentRegion)
          assignTargets(
            assignmentValueFlows(
              current.left,
              expressionValueFlow(current.right, program, scopeContext),
              program,
              scopeContext,
            ),
            definitions,
            assignmentRegion,
          )
        }
        if (current.operatorToken.kind === ts.SyntaxKind.EqualsToken) assign(region)
        else withRegion(current, definitions, region, assign)
        return
      }
      if (
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        withRegion(current, definitions, region, conditionalRegion => {
          flowExpression(current.right, definitions, conditionalRegion)
        })
        return
      }
      flowExpression(current.right, definitions, region)
      return
    }
    if (ts.isCallExpression(current)) {
      flowExpression(current.expression, definitions, region)
      for (const argument of current.arguments) {
        flowExpression(
          ts.isSpreadElement(argument) ? argument.expression : argument,
          definitions,
          region,
        )
      }
      definitionsAtCall.set(current, copyDefinitions(definitions))
      const implementation = callTargetImplementation(resolveCallTarget(current.expression, program))
      if (implementation != null) {
        const effects = context.effectsFor(implementation)
        for (const binding of effects.reassignedOuterBindings.values()) {
          if (binding.sourceId !== program.sourceId) continue
          const definition = region?.get(binding.key) ?? definitionKey(current, binding.key)
          localBindings.add(definition)
          unknownReasons.set(definition, 'a nested function reassigns a value used later')
          definitions.set(binding.key, definition)
        }
        const argumentExpressions = structuredCallArguments<ts.Expression | null>(
          current.arguments,
          argument => argument,
          () => null,
          () => null,
        )
        const destinationBindings = (targets: MutationTargets): Set<BindingKey> => {
          const bindings = new Set<BindingKey>()
          const addParameters = (indexes: Set<number>) => {
            for (const index of indexes) {
              const mapped = parameterValues(
                implementation.node.parameters[index]?.dotDotDotToken != null,
                index,
                argumentExpressions,
              )
              for (const expression of mapped.values) {
                if (expression == null) continue
                const binding = pathWriteBaseBinding(expression, program)
                if (binding != null) bindings.add(binding)
              }
            }
          }
          addParameters(targets.paramIndexes)
          addParameters(targets.containedParamIndexes)
          for (const binding of targets.outerBindings.values()) {
            if (binding.sourceId === program.sourceId) bindings.add(binding.key)
          }
          for (const binding of targets.containedOuterBindings.values()) {
            if (binding.sourceId === program.sourceId) bindings.add(binding.key)
          }
          return bindings
        }
        const changedContainers = [
          effects.mutations.certain,
          effects.mutations.uncertain,
          ...effects.retentions.map(retention => retention.destinations),
        ]
        for (const targets of changedContainers) {
          for (const destination of destinationBindings(targets)) {
            markAggregateUnknown(
              definitions.get(destination) ?? destination,
              'cannot determine how a function changed a local container',
              region == null ? current.end : regionStarts.get(region)!,
            )
          }
        }
      }
      const target = unwrapExpression(current.expression)
      const classification = ts.isPropertyAccessExpression(target) && isDefaultLibraryMemberAccess(target, program)
        ? classifyPlatformMethodCall(
          defaultLibraryOwner(target, program),
          target.name.text,
          current.arguments,
          program,
        )
        : {kind: 'unrecognized'} as const
      if (
        ts.isPropertyAccessExpression(target)
        && classification.kind === 'supported'
        && classification.effect.mutatesReceiver
      ) {
        const base = pathWriteBaseBinding(target.expression, program)
        if (base != null) {
          for (const position of classification.effect.retainedParameters) {
            const mapped = callExpressionsForPosition(
              current.arguments,
              position.index,
              position.rest,
            )
            const definition = definitions.get(base) ?? base
            if (mapped.inexactSpread) {
              if (mapped.expressions.some(expression => spreadElementCanBeMutable(expression, program))) {
                markAggregateUnknown(
                  definition,
                  'cannot determine which spread element a platform method stored',
                  region == null ? current.end : regionStarts.get(region)!,
                )
              }
            } else {
              addValueFlow(
                definition,
                wrapValueFlow(mergeValueFlows(mapped.expressions.map(retained =>
                  expressionValueFlow(retained, program, scopeContext))), 1),
              )
            }
          }
        }
      }
      if (ts.isPropertyAccessExpression(target) && classification.kind === 'supported') {
        for (const callback of classification.effect.callbacks) {
          const callbackExpression = callExpressionsForPosition(
            current.arguments,
            callback.argumentIndex,
          ).expressions[0]
          if (callbackExpression == null) continue
          const callbackImplementation = callTargetImplementation(
            resolveCallTarget(unwrapExpression(callbackExpression), program),
          )
          if (callbackImplementation == null) continue
          const markDestination = (binding: BindingKey) => {
            markAggregateUnknown(
              definitions.get(binding) ?? binding,
              'cannot determine how a callback changed a local container',
              region == null ? current.end : regionStarts.get(region)!,
            )
          }
          const callbackEffects = context.effectsFor(callbackImplementation)
          const changedContainers = [
            callbackEffects.mutations.certain,
            callbackEffects.mutations.uncertain,
            ...callbackEffects.retentions.map(retention => retention.destinations),
          ]
          for (const destinations of changedContainers) {
            for (const binding of destinations.outerBindings.values()) {
              if (binding.sourceId === program.sourceId) markDestination(binding.key)
            }
            for (const binding of destinations.containedOuterBindings.values()) {
              if (binding.sourceId === program.sourceId) markDestination(binding.key)
            }
            const markParameterDestinations = (indexes: Set<number>) => {
              for (const index of indexes) {
                for (const source of callback.parameterSources[index] ?? []) {
                  if (source.kind === 'receiver' || source.kind === 'receiver-elements') {
                    const binding = pathWriteBaseBinding(target.expression, program)
                    if (binding != null) markDestination(binding)
                  } else {
                    for (const argument of callExpressionsForPosition(
                      current.arguments,
                      source.index,
                    ).expressions) {
                      const binding = pathWriteBaseBinding(argument, program)
                      if (binding != null) markDestination(binding)
                    }
                  }
                }
              }
            }
            markParameterDestinations(destinations.paramIndexes)
            markParameterDestinations(destinations.containedParamIndexes)
          }
        }
      }
      return
    }
    const flowChildren = (parent: ts.Node) => {
      ts.forEachChild(parent, child => {
        if (ts.isExpression(child)) {
          flowExpression(child, definitions, region)
          return
        }
        if (isFunctionImplementation(child)) return
        recordNode(child, definitions)
        flowChildren(child)
      })
    }
    flowChildren(current)
  }

  type StatementFlow = {
    normal: boolean
    breaks: boolean
    continues: boolean
  }
  const normalFlow = (normal: boolean): StatementFlow => ({
    normal,
    breaks: false,
    continues: false,
  })
  const flowVariableDeclaration = (
    declaration: ts.VariableDeclaration,
    definitions: DefinitionState,
    region: Map<BindingKey, DefinitionKey> | null,
  ) => {
    recordNode(declaration, definitions)
    if (declaration.initializer != null) flowExpression(declaration.initializer, definitions, region)
    const sourceFlow = declaration.initializer == null
      ? emptyValueFlow()
      : expressionValueFlow(declaration.initializer, program, scopeContext)
    flowBindingInitializers(declaration.name, definitions, region)
    assignTargets(
      bindingValueFlows(declaration.name, sourceFlow, program, scopeContext),
      definitions,
      region,
    )
  }
  const flowBindingInitializers = (
    name: ts.BindingName,
    definitions: DefinitionState,
    region: Map<BindingKey, DefinitionKey> | null,
  ) => {
    if (ts.isIdentifier(name)) return
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue
      if (element.propertyName != null && ts.isComputedPropertyName(element.propertyName)) {
        flowExpression(element.propertyName.expression, definitions, region)
      }
      if (element.initializer != null) {
        withRegion(element, definitions, region, conditionalRegion => {
          flowExpression(element.initializer!, definitions, conditionalRegion)
        })
      }
      flowBindingInitializers(element.name, definitions, region)
    }
  }
  const flowVariableDeclarationList = (
    declarationList: ts.VariableDeclarationList,
    definitions: DefinitionState,
    region: Map<BindingKey, DefinitionKey> | null,
  ) => {
    for (const declaration of declarationList.declarations) {
      flowVariableDeclaration(declaration, definitions, region)
    }
  }
  const flowStatement = (
    statement: ts.Statement,
    definitions: DefinitionState,
    region: Map<BindingKey, DefinitionKey> | null,
  ): StatementFlow => {
    recordNode(statement, definitions)
    if (ts.isBlock(statement)) {
      let normal = true
      let breaks = false
      let continues = false
      for (const child of statement.statements) {
        if (!normal) break
        const childFlow = flowStatement(child, definitions, region)
        normal = childFlow.normal
        breaks ||= childFlow.breaks
        continues ||= childFlow.continues
      }
      return {normal, breaks, continues}
    }
    if (ts.isVariableStatement(statement)) {
      flowVariableDeclarationList(statement.declarationList, definitions, region)
      return normalFlow(true)
    }
    if (ts.isExpressionStatement(statement)) {
      flowExpression(statement.expression, definitions, region)
      return normalFlow(true)
    }
    if (ts.isIfStatement(statement)) {
      flowExpression(statement.expression, definitions, region)
      let whenTrue = normalFlow(true)
      let whenFalse = normalFlow(true)
      withRegion(statement, definitions, region, conditionalRegion => {
        whenTrue = flowStatement(statement.thenStatement, definitions, conditionalRegion)
        if (statement.elseStatement != null) {
          whenFalse = flowStatement(statement.elseStatement, definitions, conditionalRegion)
        }
      })
      return {
        normal: whenTrue.normal || whenFalse.normal,
        breaks: whenTrue.breaks || whenFalse.breaks,
        continues: whenTrue.continues || whenFalse.continues,
      }
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      withRegion(statement, definitions, region, loopRegion => {
        if (ts.isWhileStatement(statement)) flowExpression(statement.expression, definitions, loopRegion)
        flowStatement(statement.statement, definitions, loopRegion)
        if (ts.isDoStatement(statement)) flowExpression(statement.expression, definitions, loopRegion)
      })
      return normalFlow(true)
    }
    if (ts.isForStatement(statement)) {
      if (statement.initializer != null) {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          flowVariableDeclarationList(statement.initializer, definitions, region)
        } else {
          flowExpression(statement.initializer, definitions, region)
        }
      }
      withRegion(statement, definitions, region, loopRegion => {
        if (statement.condition != null) flowExpression(statement.condition, definitions, loopRegion)
        flowStatement(statement.statement, definitions, loopRegion)
        if (statement.incrementor != null) flowExpression(statement.incrementor, definitions, loopRegion)
      })
      return normalFlow(true)
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      flowExpression(statement.expression, definitions, region)
      const sourceFlow = ts.isForOfStatement(statement)
        ? selectValueFlow(expressionValueFlow(statement.expression, program, scopeContext))
        : emptyValueFlow()
      withRegion(statement, definitions, region, loopRegion => {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          for (const declaration of statement.initializer.declarations) {
            recordNode(declaration, definitions)
            flowBindingInitializers(declaration.name, definitions, loopRegion)
            assignTargets(
              bindingValueFlows(declaration.name, sourceFlow, program, scopeContext),
              definitions,
              loopRegion,
            )
          }
        } else {
          assignTargets(
            assignmentValueFlows(statement.initializer, sourceFlow, program, scopeContext),
            definitions,
            loopRegion,
          )
        }
        flowStatement(statement.statement, definitions, loopRegion)
      })
      return normalFlow(true)
    }
    if (ts.isSwitchStatement(statement)) {
      flowExpression(statement.expression, definitions, region)
      withRegion(statement, definitions, region, switchRegion => {
        for (const clause of statement.caseBlock.clauses) {
          recordNode(clause, definitions)
          if (ts.isCaseClause(clause)) flowExpression(clause.expression, definitions, switchRegion)
          let normal = true
          for (const child of clause.statements) {
            if (!normal) break
            normal = flowStatement(child, definitions, switchRegion).normal
          }
        }
      })
      return normalFlow(true)
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      if (statement.expression != null) flowExpression(statement.expression, definitions, region)
      return normalFlow(false)
    }
    if (ts.isBreakStatement(statement)) {
      return {normal: false, breaks: true, continues: false}
    }
    if (ts.isContinueStatement(statement)) {
      return {normal: false, breaks: false, continues: true}
    }
    if (ts.isFunctionDeclaration(statement)) return normalFlow(true)
    ts.forEachChild(statement, child => {
      if (ts.isExpression(child)) flowExpression(child, definitions, region)
      else if (ts.isStatement(child)) {
        flowStatement(child, definitions, region)
      }
    })
    return normalFlow(true)
  }

  const definitions: DefinitionState = new Map()
  node.parameters.forEach((parameter, index) => {
    recordNode(parameter, definitions)
    const parameterRoot = `parameter:${node.pos}:${index}`
    paramIndexByBinding.set(parameterRoot, index)
    const parameterFlow: ValueFlow = {
      references: [
        {
          binding: parameterRoot,
          selections: 0,
          containers: parameter.dotDotDotToken == null ? 0 : 1,
          at: parameter.pos,
        },
        ...(parameter.dotDotDotToken == null
          ? []
          : [{binding: {kind: 'allocation', node: parameter}, selections: 0, containers: 0, at: parameter.pos} as const]),
      ],
      unknownReason: null,
    }
    if (parameter.initializer != null) {
      withRegion(parameter, definitions, null, defaultRegion => {
        flowExpression(parameter.initializer!, definitions, defaultRegion)
      })
    }
    const sourceFlow = parameter.initializer == null
      ? parameterFlow
      : mergeValueFlows([
        parameterFlow,
        expressionValueFlow(parameter.initializer, program, scopeContext),
      ])
    flowBindingInitializers(parameter.name, definitions, null)
    if (
      ts.isIdentifier(parameter.name)
      && parameter.initializer == null
      && parameter.dotDotDotToken == null
    ) {
      definitions.set(bindingKey(parameter.name, program), parameterRoot)
    } else {
      assignTargets(
        bindingValueFlows(parameter.name, sourceFlow, program, scopeContext),
        definitions,
        null,
      )
    }
  })
  if (ts.isBlock(node.body)) flowStatement(node.body, definitions, null)
  else flowExpression(node.body, definitions, null)

  // Exact aliases are symmetric: if `ys = xs`, writes and retained references
  // discovered through either name belong to the same container.
  const symmetricReferences = [...referenceEdges]
  for (const edge of referenceEdges) {
    if (!edge.reversible) continue
    if (edge.reference.selections !== 0 || edge.reference.containers !== 0) continue
    symmetricReferences.push({
      target: edge.reference.binding,
      reference: {binding: edge.target, selections: 0, containers: 0, at: edge.reference.at},
      reversible: true,
    })
  }
  return {
    paramIndexByBinding,
    localBindings,
    references: referenceMap(symmetricReferences),
    unknownReasons,
    aggregateUnknownReasons,
    reachableNodes,
    definitionsAtUse,
    definitionsAtCall,
    allocationKeys,
  }
}

function assignmentMayTakeRightValue(operator: ts.SyntaxKind) {
  return operator === ts.SyntaxKind.EqualsToken
    || operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    || operator === ts.SyntaxKind.BarBarEqualsToken
    || operator === ts.SyntaxKind.QuestionQuestionEqualsToken
}

type TargetValueFlow = {
  target: AssignmentTarget
  flow: ValueFlow
}

function bindingValueFlows(
  name: ts.BindingName,
  sourceFlow: ValueFlow,
  program: Program,
  context: ValueFlowContext,
): TargetValueFlow[] {
  if (ts.isIdentifier(name)) {
    return [{target: {kind: 'binding', identifier: name}, flow: sourceFlow}]
  }
  const flows: TargetValueFlow[] = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    const selected = element.dotDotDotToken == null
      ? selectValueFlow(sourceFlow)
      : wrapValueFlow(sourceFlow, 1)
    const value = element.initializer == null
      ? selected
      : mergeValueFlows([
        selected,
        expressionValueFlow(element.initializer, program, context),
      ])
    flows.push(...bindingValueFlows(element.name, value, program, context))
  }
  return flows
}

function assignmentValueFlows(
  expression: ts.Expression,
  sourceFlow: ValueFlow,
  program: Program,
  context: ValueFlowContext,
): TargetValueFlow[] {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) {
    return [{target: {kind: 'binding', identifier: current}, flow: sourceFlow}]
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return [{target: {kind: 'path', expression: current}, flow: sourceFlow}]
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap(property => {
      if (ts.isShorthandPropertyAssignment(property)) {
        const selected = selectValueFlow(sourceFlow)
        const value = property.objectAssignmentInitializer == null
          ? selected
          : mergeValueFlows([
            selected,
            expressionValueFlow(property.objectAssignmentInitializer, program, context),
          ])
        return [{
          target: {kind: 'binding', identifier: property.name} as AssignmentTarget,
          flow: value,
        }]
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentValueFlows(
          property.initializer,
          selectValueFlow(sourceFlow),
          program,
          context,
        )
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentValueFlows(
          property.expression,
          wrapValueFlow(sourceFlow, 1),
          program,
          context,
        )
      }
      return []
    })
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap(element => {
      if (ts.isOmittedExpression(element)) return []
      if (ts.isSpreadElement(element)) {
        return assignmentValueFlows(
          element.expression,
          wrapValueFlow(sourceFlow, 1),
          program,
          context,
        )
      }
      return assignmentValueFlows(
        element,
        selectValueFlow(sourceFlow),
        program,
        context,
      )
    })
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentValueFlows(
      current.left,
      mergeValueFlows([
        sourceFlow,
        expressionValueFlow(current.right, program, context),
      ]),
      program,
      context,
    )
  }
  return []
}

function expressionValueFlow(
  expression: ts.Expression,
  program: Program,
  context: ValueFlowContext,
): ValueFlow {
  const current = unwrapExpression(expression)
  if (!expressionHasMutableType(current, program)) return emptyValueFlow()
  if (ts.isIdentifier(current)) {
    const definition = context.definitionFor?.(current)
    return {
      references: [{
        binding: definition ?? bindingKey(current, program),
        selections: 0,
        containers: 0,
        at: current.pos,
      }],
      unknownReason: null,
    }
  }
  if (current.kind === ts.SyntaxKind.ThisKeyword) {
    return {
      references: [{binding: 'this', selections: 0, containers: 0, at: current.pos}],
      unknownReason: null,
    }
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return selectValueFlow(expressionValueFlow(current.expression, program, context))
  }
  if (ts.isConditionalExpression(current)) {
    return mergeValueFlows([
      expressionValueFlow(current.whenTrue, program, context),
      expressionValueFlow(current.whenFalse, program, context),
    ])
  }
  if (ts.isBinaryExpression(current)) {
    switch (current.operatorToken.kind) {
      case ts.SyntaxKind.EqualsToken:
      case ts.SyntaxKind.CommaToken:
        return expressionValueFlow(current.right, program, context)
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
      case ts.SyntaxKind.BarBarEqualsToken:
      case ts.SyntaxKind.QuestionQuestionEqualsToken:
        return mergeValueFlows([
          expressionValueFlow(current.left, program, context),
          expressionValueFlow(current.right, program, context),
        ])
      default:
        break
    }
  }
  if (ts.isArrayLiteralExpression(current)) {
    return localFreshValueFlow(current, context, current.elements.map(element => {
      if (!ts.isSpreadElement(element)) {
        return wrapValueFlow(expressionValueFlow(element, program, context), 1)
      }
      const spread = expressionValueFlow(element.expression, program, context)
      const yielded = wrapValueFlow(selectValueFlow(spread), 1)
      return isKnownBuiltInIterable(element.expression, program)
        ? yielded
        : {...yielded, unknownReason: 'spread is unsupported because its iterator can run user code'}
    }))
  }
  if (ts.isObjectLiteralExpression(current)) {
    const propertyFlows = current.properties.flatMap(property => {
      if (ts.isSpreadAssignment(property)) {
        const spread = wrapValueFlow(
          selectValueFlow(expressionValueFlow(property.expression, program, context)),
          1,
        )
        return [expressionTypeHasAccessor(property.expression, program)
          ? {...spread, unknownReason: 'object spread is unsupported because reading a property can call a getter'}
          : spread]
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return [wrapValueFlow(expressionValueFlow(property.name, program, context), 1)]
      }
      if (ts.isPropertyAssignment(property)) {
        return [wrapValueFlow(expressionValueFlow(property.initializer, program, context), 1)]
      }
      return []
    })
    return localFreshValueFlow(current, context, propertyFlows)
  }
  if (ts.isNewExpression(current)) {
    const constructorName = ts.isIdentifier(current.expression) ? current.expression.text : null
    if (
      constructorName != null
      && zeroArgumentCollectionConstructorNames.has(constructorName)
      && isDefaultLibrarySymbol(current.expression, program)
      && (current.arguments?.length ?? 0) === 0
    ) return localFreshValueFlow(current, context)
    if (
      constructorName === 'Array'
      && isDefaultLibrarySymbol(current.expression, program)
    ) {
      return localFreshValueFlow(current, context, (current.arguments ?? []).map(argument =>
        wrapValueFlow(expressionValueFlow(argument, program, context), 1)))
    }
    if (
      constructorName != null
      && lengthBearingConstructorNames.has(constructorName)
      && isDefaultLibrarySymbol(current.expression, program)
      && (current.arguments ?? []).every(argument => !expressionHasMutableType(argument, program))
    ) return localFreshValueFlow(current, context)
    const argumentFlows = (current.arguments ?? []).map(argument =>
      wrapValueFlow(expressionValueFlow(argument, program, context), 1))
    return {
      ...mergeValueFlows(argumentFlows),
      unknownReason: 'cannot determine where the constructed value came from',
    }
  }
  if (ts.isCallExpression(current)) {
    const platformFlow = platformCallResultFlow(current, program, context)
    if (platformFlow != null) return platformFlow
    return functionCallResultFlow(current, program, context)
  }
  return {
    references: expressionRootBindings(current, program, context)
      .map(binding => ({binding, selections: 0, containers: 0, at: current.pos})),
    unknownReason: 'cannot determine where the returned object or array came from',
  }
}

function platformCallResultFlow(
  call: ts.CallExpression,
  program: Program,
  context: ValueFlowContext,
): ValueFlow | null {
  const target = unwrapExpression(call.expression)
  if (!ts.isPropertyAccessExpression(target) || !isDefaultLibraryMemberAccess(target, program)) return null
  const base = unwrapExpression(target.expression)
  const global = ts.isIdentifier(base) && isDefaultLibrarySymbol(base, program)
  const classification = global
    ? classifyPlatformGlobalCall(base.text, target.name.text, call.arguments.length)
    : classifyPlatformMethodCall(
      defaultLibraryOwner(target, program),
      target.name.text,
      call.arguments,
      program,
    )
  if (classification.kind !== 'supported') return null
  return platformResultFlow(
    call,
    classification.effect,
    classification.effect.result,
    global ? null : target.expression,
    program,
    context,
  )
}

function platformResultFlow(
  call: ts.CallExpression,
  effect: PlatformCallEffect,
  result: PlatformResultEffect,
  receiver: ts.Expression | null,
  program: Program,
  context: ValueFlowContext,
): ValueFlow {
  const callbackIndexes = new Set(effect.callbacks.map(callback => callback.argumentIndex))
  const argumentFlows = call.arguments.map((argument, index) => callbackIndexes.has(index)
    ? emptyValueFlow()
    : expressionValueFlow(
      ts.isSpreadElement(argument) ? argument.expression : argument,
      program,
      context,
    ))
  const receiverFlow = receiver == null ? emptyValueFlow() : expressionValueFlow(receiver, program, context)
  switch (result.kind) {
    case 'none':
      return emptyValueFlow()
    case 'fresh':
      return freshResultFlow()
    case 'receiver':
      return receiverFlow
    case 'argument':
      return argumentFlows[result.index] ?? emptyValueFlow()
    case 'unknown':
      return {references: [], unknownReason: result.reason}
  }
}

function functionCallResultFlow(
  call: ts.CallExpression,
  program: Program,
  context: ValueFlowContext,
): ValueFlow {
  const target = unwrapExpression(call.expression)
  const implementation = callTargetImplementation(resolveCallTarget(target, program))
  if (implementation == null) {
    return unknownCallResultFlow(unknownCallBodyReason)
  }
  const result = context.resultFor(implementation)
  const argumentFlows = structuredCallArguments(
    call.arguments,
    argument => expressionValueFlow(argument, program, context),
    expression => selectValueFlow(expressionValueFlow(expression, program, context)),
    emptyValueFlow,
  )
  const flowForArgument = (index: number) => parameterSourceFlow(
    implementation.node.parameters[index],
    index,
    argumentFlows,
  )
  const flows: ValueFlow[] = []
  if (result.fresh) flows.push(freshResultFlow())
  flows.push(...result.argumentIndexes.map(flowForArgument))
  if (result.outerBindings.length > 0) {
    flows.push({
      references: result.outerBindings.map(binding => ({
        binding: binding.key,
        selections: 0,
        containers: 0,
        at: call.pos,
      })),
      unknownReason: null,
    })
  }
  const flow = mergeValueFlows(flows)
  return result.unknownReason == null
    ? flow
    : {...flow, unknownReason: result.unknownReason}
}

function unknownCallResultFlow(reason: string): ValueFlow {
  return {references: [], unknownReason: reason}
}

function freshResultFlow(): ValueFlow {
  return {
    references: [{binding: opaqueFreshResult, selections: 0, containers: 0, at: Number.MAX_SAFE_INTEGER}],
    unknownReason: null,
  }
}

function localFreshValueFlow(
  expression: ts.Expression,
  context: ValueFlowContext,
  contents: readonly ValueFlow[] = [],
): ValueFlow {
  const allocation = context.allocationFor?.(expression)
  if (allocation == null) throw new Error(`Missing local allocation context for ${expression.getText()}`)
  return mergeValueFlows([
    ...contents,
    {
      references: [{binding: allocation, selections: 0, containers: 0, at: expression.pos}],
      unknownReason: null,
    },
  ])
}

function parameterSourceFlow(
  parameter: ts.ParameterDeclaration | undefined,
  index: number,
  argumentFlows: readonly StructuredArgument<ValueFlow>[],
): ValueFlow {
  const mapped = parameterValues(parameter?.dotDotDotToken != null, index, argumentFlows)
  const flow = mergeValueFlows(mapped.values)
  return mapped.inexactSpread
    ? {
        ...flow,
        unknownReason: flow.unknownReason
          ?? 'cannot determine which spread element the called function returns',
      }
    : flow
}

function emptyValueFlow(): ValueFlow {
  return {references: [], unknownReason: null}
}

function mergeValueFlows(flows: readonly ValueFlow[]): ValueFlow {
  const references: ValueReference[] = []
  for (const flow of flows) {
    for (const reference of flow.references) addValueReference(references, reference)
  }
  return {
    references,
    unknownReason: firstUnknownReason(flows),
  }
}

function selectValueFlow(flow: ValueFlow, count = 1): ValueFlow {
  return {
    references: flow.references.map(reference => selectValueReference(reference, count)),
    unknownReason: flow.unknownReason,
  }
}

function wrapValueFlow(flow: ValueFlow, count: number): ValueFlow {
  return {
    references: flow.references.map(reference => ({
      ...reference,
      containers: reference.containers + count,
    })),
    unknownReason: flow.unknownReason,
  }
}

function selectValueReference(reference: ValueReference, count: number): ValueReference {
  const consumedContainers = Math.min(reference.containers, count)
  return {
    binding: reference.binding,
    containers: reference.containers - consumedContainers,
    selections: reference.selections + count - consumedContainers,
    at: reference.at,
  }
}

function composeValueReferences(base: ValueReference, next: ValueReference): ValueReference {
  const selectedBase = selectValueReference(base, next.selections)
  return {
    binding: base.binding,
    selections: selectedBase.selections,
    containers: selectedBase.containers + next.containers,
    at: next.at,
  }
}

function addValueReference(target: ValueReference[], reference: ValueReference) {
  if (!target.some(existing =>
    existing.binding === reference.binding
    && existing.selections === reference.selections
    && existing.containers === reference.containers
    && existing.at === reference.at)) {
    target.push(reference)
  }
}

function firstUnknownReason(flows: readonly ValueFlow[]): string | null {
  for (const flow of flows) {
    if (flow.unknownReason != null) return flow.unknownReason
  }
  return null
}

function valueFlowUnknownReason(flow: ValueFlow, scope: Scope): string | null {
  if (flow.unknownReason != null) return flow.unknownReason
  for (const reference of flow.references) {
    const reason = referenceUnknownReason(reference, scope, false, new Set())
    if (reason != null) return reason
  }
  return null
}

function referenceUnknownReason(
  reference: ValueReference,
  scope: Scope,
  includeContained: boolean,
  seen: Set<BindingKey>,
): string | null {
  if (reference.binding === opaqueFreshResult) {
    return reference.selections > 0
      ? 'cannot determine where a value inside the returned object or array came from'
      : null
  }
  if (seen.has(reference.binding)) return null
  seen.add(reference.binding)
  const direct = scope.unknownReasons.get(reference.binding)
  if (direct != null) return direct
  if (reference.selections > 0) {
    const aggregate = scope.aggregateUnknownReasons.get(reference.binding)
    if (aggregate != null && reference.at >= aggregate.from) return aggregate.reason
  }
  for (const source of scope.references.get(reference.binding) ?? []) {
    const composed = composeValueReferences(source, reference)
    if (!includeContained && composed.containers > 0) continue
    const reason = referenceUnknownReason(
      composed,
      scope,
      includeContained,
      seen,
    )
    if (reason != null) return reason
  }
  seen.delete(reference.binding)
  return null
}

function returnedExpressions(node: FunctionImplementationNode): ts.Expression[] {
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return [node.body]
  const expressions: ts.Expression[] = []
  const visit = (current: ts.Node) => {
    if (current !== node && isFunctionImplementation(current)) return
    if (ts.isReturnStatement(current)) {
      if (current.expression != null) expressions.push(current.expression)
      return
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(node, visit)
  return expressions
}

function referenceMap(
  edges: readonly {target: BindingKey; reference: ValueReference}[],
): Map<BindingKey, ValueReference[]> {
  const references = new Map<BindingKey, ValueReference[]>()
  for (const {target, reference} of edges) {
    if (
      target === reference.binding
      && reference.selections === 0
      && reference.containers === 0
    ) continue
    let targetReferences = references.get(target)
    if (targetReferences == null) {
      targetReferences = []
      references.set(target, targetReferences)
    }
    addValueReference(targetReferences, reference)
  }
  return references
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

type AssignmentTarget =
  | {kind: 'binding'; identifier: ts.Identifier}
  | {kind: 'path'; expression: ts.PropertyAccessExpression | ts.ElementAccessExpression}

function assignmentTargets(expression: ts.Expression): AssignmentTarget[] {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return [{kind: 'binding', identifier: current}]
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return [{kind: 'path', expression: current}]
  }
  if (ts.isObjectLiteralExpression(current)) {
    const targets: AssignmentTarget[] = []
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        targets.push({kind: 'binding', identifier: property.name})
      } else if (ts.isPropertyAssignment(property)) {
        targets.push(...assignmentTargets(property.initializer))
      } else if (ts.isSpreadAssignment(property)) {
        targets.push(...assignmentTargets(property.expression))
      }
    }
    return targets
  }
  if (ts.isArrayLiteralExpression(current)) {
    const targets: AssignmentTarget[] = []
    for (const element of current.elements) {
      if (ts.isOmittedExpression(element)) continue
      targets.push(...assignmentTargets(
        ts.isSpreadElement(element) ? element.expression : element,
      ))
    }
    return targets
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargets(current.left)
  }
  return []
}

function writesDefaultLibraryMethod(expression: ts.Expression, program: Program): boolean {
  return assignmentTargets(expression).some(target => target.kind === 'path' && (
    (ts.isPropertyAccessExpression(target.expression) && isDefaultLibraryMemberAccess(target.expression, program))
    || (ts.isElementAccessExpression(target.expression) && isDefaultLibraryElementAccess(target.expression, program))
  ))
}

type Classifier = (binding: BindingKey) => RootKind[]

type Classifiers = {
  // Mutations of the current container, excluding references still behind
  // another object or array.
  container: Classifier
  // Any source reachable after further property or element reads.
  reach: Classifier
  reachUnknown: (binding: BindingKey) => string | null
  reference: (reference: ValueReference, includeContained: boolean) => RootKind[]
  referenceUnknownReason: (reference: ValueReference, includeContained: boolean) => string | null
}

function makeClassifiers(
  scope: Scope,
  program: Program,
  definitions: DefinitionState | null = null,
  at = Number.MAX_SAFE_INTEGER,
): Classifiers {
  const definitionsFor = (binding: BindingKey): readonly BindingKey[] =>
    [definitions?.get(binding) ?? binding]
  const classifyDirect = (binding: BindingKey, includeContained: boolean): RootKind[] => {
    return classifyReference({
      binding,
      selections: 0,
      containers: 0,
      at: Number.MAX_SAFE_INTEGER,
    }, includeContained)
  }
  const classifyReference = (reference: ValueReference, includeContained: boolean): RootKind[] => {
    const roots: RootKind[] = []
    for (const definition of definitionsFor(reference.binding)) {
      const references = bindingFunctionReferences(
        {...reference, binding: definition},
        scope,
        program,
        new Set(),
      )
      for (const reference of references) {
        if (!includeContained && reference.containers > 0) continue
        if (!roots.some(root => sameRoot(root, reference.source))) roots.push(reference.source)
      }
    }
    return roots
  }
  const unknownReasonFor = (reference: ValueReference, includeContained: boolean): string | null => {
    for (const definition of definitionsFor(reference.binding)) {
      const reason = referenceUnknownReason(
        {...reference, binding: definition},
        scope,
        includeContained,
        new Set(),
      )
      if (reason != null) return reason
    }
    return null
  }
  return {
    container: binding => classifyDirect(binding, false),
    reach: binding => classifyDirect(binding, true),
    reachUnknown: binding => unknownReasonFor({
      binding,
      selections: 1,
      containers: 0,
      at,
    }, true),
    reference: classifyReference,
    referenceUnknownReason: unknownReasonFor,
  }
}

function bindingKey(identifier: ts.Identifier, program: Program): BindingKey {
  const checker = program.typeChecker
  if (checker == null) return `binding:${identifier.text}`
  let symbol = valueBindingSymbol(identifier, checker)
  if (symbol == null) return `binding:${identifier.text}`
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
  return symbol
}

function valueBindingSymbol(identifier: ts.Identifier, checker: ts.TypeChecker) {
  const parent = identifier.parent
  return ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(parent)
    : checker.getSymbolAtLocation(identifier)
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
  if (isDefinitionKey(key)) {
    throw new Error(`Local definition escaped purity analysis: ${key.node.getText()}`)
  }
  if (isAllocationKey(key)) {
    throw new Error(`Local allocation escaped purity analysis: ${key.node.getText()}`)
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
  if (
    (
      ts.isPropertyAssignment(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent)
      || ts.isEnumMember(parent)
      || ts.isJsxAttribute(parent)
    )
    && parent.name === id
  ) return null
  if (ts.isBindingElement(parent) && parent.propertyName === id) return null
  if (
    (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent))
    && parent.label === id
  ) return null
  if (isWriteOnlyAssignmentBinding(id)) return null
  if (
    ts.isCallExpression(parent)
    && unwrapExpression(parent.expression) === id
    && mutableFunctionBindingReason(id, program) != null
  ) return null
  if (
    (
      ts.isJsxOpeningElement(parent)
      || ts.isJsxClosingElement(parent)
      || ts.isJsxSelfClosingElement(parent)
    )
    && parent.tagName === id
    && isIntrinsicJsxTagName(id.text)
  ) return null
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

function isWriteOnlyAssignmentBinding(identifier: ts.Identifier) {
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  for (let current: ts.Node = identifier; current.parent != null; current = current.parent) {
    const parent = current.parent
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return assignmentTargets(parent.left).some(target =>
        target.kind === 'binding' && target.identifier === identifier)
    }
    if (ts.isStatement(parent) || isFunctionImplementation(parent)) return false
  }
  return false
}

function isIntrinsicJsxTagName(name: string) {
  const first = name.codePointAt(0)
  return first != null && first >= 97 && first <= 122
}

function isInTypeContext(node: ts.Node): boolean {
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  for (let current = node.parent; current != null; current = current.parent) {
    if (ts.isTypeNode(current)) return true
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false
  }
  return false
}

function isSafeOuterRead(id: ts.Identifier, program: Program): boolean {
  if (isPlatformGlobalNamespace(id.text) && isDefaultLibrarySymbol(id, program)) return true
  if (
    (lengthBearingConstructorNames.has(id.text) || zeroArgumentCollectionConstructorNames.has(id.text))
    && isDefaultLibrarySymbol(id, program)
  ) return true
  if (isResolvedFunctionValueRead(id, program)) return true
  if (isSafeNamespacePrimitiveRead(id, program)) return true
  const checker = program.typeChecker
  if (checker == null) return false
  let symbol = valueBindingSymbol(id, checker)
  if (symbol == null) return false
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration == null) return true
  if (ts.isClassDeclaration(declaration)) return isSafeClassOuterRead(id, checker)
  if (ts.isFunctionDeclaration(declaration)) return isFunctionValuePosition(id)
  if (ts.isEnumDeclaration(declaration)
    || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isTypeParameterDeclaration(declaration)) return true
  if (ts.isVariableDeclaration(declaration)) {
    const isConst = ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    if (!isConst) return false
    try {
      const type = checker.getTypeAtLocation(id)
      return (isFunctionValuePosition(id) && type.getCallSignatures().length > 0) || !typeCanBeMutable(type)
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

function isResolvedFunctionValueRead(id: ts.Identifier, program: Program): boolean {
  const parent = id.parent
  const implementation = callTargetImplementation(resolveCallTarget(id, program))
  if (implementation != null) return isFunctionValuePosition(id)
  if (
    !ts.isPropertyAccessExpression(parent)
    || parent.expression !== id
    || !ts.isCallExpression(parent.parent)
    || parent.parent.expression !== parent
  ) return false
  const checker = program.typeChecker
  const symbol = checker?.getSymbolAtLocation(id)
  const namespaceImport = symbol?.declarations?.some(ts.isNamespaceImport) === true
  return namespaceImport
}

function isFunctionValuePosition(id: ts.Identifier): boolean {
  const parent = id.parent
  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
    return parent.name.text === 'call' || parent.name.text === 'apply' || parent.name.text === 'bind'
  }
  return !(ts.isElementAccessExpression(parent) && parent.expression === id)
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

  const memberSymbols = ts.isPropertyAccessExpression(access)
    ? [checker.getSymbolAtLocation(access.name)].filter(symbol => symbol != null)
    : elementAccessPropertySymbols(access, checker)
  return memberSymbols.length > 0 && memberSymbols.every(memberSymbol => {
    const declaration = memberSymbol.valueDeclaration ?? memberSymbol.declarations?.[0]
    return declaration != null && (
      ts.isMethodDeclaration(declaration)
      || ts.isGetAccessorDeclaration(declaration)
      || ts.isSetAccessorDeclaration(declaration)
    )
  })
}

function collectWrites(
  implementation: FunctionImplementationRef,
  member: MemberInfo,
  scope: Scope,
  valueFlowContext: ValueFlowContext,
) {
  const {node, program} = implementation
  const classifiers = makeClassifiers(scope, program)
  const addMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.certain, roots)
  }
  const addUncertainMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.uncertain, roots)
  }
  const addRetention = (destinations: ClassifiedRoots, values: ClassifiedRoots) => {
    if (destinations.unknownReason != null) addUnknownCall(destinations.unknownReason)
    if (values.unknownReason != null) addUnknownCall(values.unknownReason)
    const retention: RetentionEffect = {
      destinations: noMutationTargets(),
      values: noMutationTargets(),
    }
    addMutationRoots(retention.destinations, destinations.roots)
    addMutationRoots(retention.values, values.roots)
    if (!mutationTargetsEmpty(retention.destinations) && !mutationTargetsEmpty(retention.values)) {
      member.effects.retentions.push(retention)
    }
  }
  const addUnknownCall = (reason = unknownCallBodyReason) => {
    member.effects.unknownCallReasons.add(reason)
  }
  const addUnsupportedPlatformCall = (classification: Exclude<PlatformCallClassification, {kind: 'supported'}>) => {
    if (classification.kind === 'unsupported' && classification.throws === true) {
      member.effects.throws = true
    }
    addUnknownCall(classification.kind === 'unsupported' ? classification.reason : undefined)
  }
  const addUnsupportedMutableFunctionBinding = (target: ts.Expression) => {
    if (!ts.isIdentifier(target)) return
    const reason = mutableFunctionBindingReason(target, program)
    if (reason != null) member.effects.boundaryUnknownReasons.add(reason)
  }
  const addClassifiedMutation = (classification: ClassifiedRoots) => {
    addMutation(classification.roots)
    if (classification.unknownReason != null) addUnknownCall(classification.unknownReason)
  }
  const classifyExpressionRoots = (expression: ts.Expression): ClassifiedRoots =>
    classifyValueFlow(expressionValueFlow(expression, program, valueFlowContext), classifiers, true)
  const classifyExpressionContainerRoots = (expression: ts.Expression): ClassifiedRoots =>
    classifyValueFlow(expressionValueFlow(expression, program, valueFlowContext), classifiers, false)
  const classifyPossibleFreshCallContents = (expression: ts.Expression): ClassifiedRoots => {
    const call = unwrapExpression(expression)
    if (!ts.isCallExpression(call)) return emptyClassifiedRoots()
    const inputs = call.arguments.map(argument =>
      classifyRetainedExpressionRoots(ts.isSpreadElement(argument) ? argument.expression : argument))
    const target = unwrapExpression(call.expression)
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      inputs.push(classifyValueFlow(
        selectValueFlow(expressionValueFlow(target.expression, program, valueFlowContext)),
        classifiers,
        true,
      ))
      inputs.push(classifyFreshExpressionContents(target.expression))
    }
    return mergeClassifiedRoots(inputs)
  }
  const classifyFreshExpressionContents = (expression: ts.Expression): ClassifiedRoots => {
    const current = unwrapExpression(expression)
    if (ts.isCallExpression(current)) return classifyPossibleFreshCallContents(current)
    if (ts.isConditionalExpression(current)) {
      return mergeClassifiedRoots([
        classifyRetainedExpressionRoots(current.whenTrue),
        classifyRetainedExpressionRoots(current.whenFalse),
      ])
    }
    if (ts.isBinaryExpression(current)) {
      switch (current.operatorToken.kind) {
        case ts.SyntaxKind.EqualsToken:
        case ts.SyntaxKind.CommaToken:
          return classifyRetainedExpressionRoots(current.right)
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
        case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
        case ts.SyntaxKind.BarBarEqualsToken:
        case ts.SyntaxKind.QuestionQuestionEqualsToken:
          return mergeClassifiedRoots([
            classifyRetainedExpressionRoots(current.left),
            classifyRetainedExpressionRoots(current.right),
          ])
        default:
          return emptyClassifiedRoots()
      }
    }
    if (ts.isArrayLiteralExpression(current)) {
      return mergeClassifiedRoots(current.elements.map(element => {
        if (!ts.isSpreadElement(element)) return classifyRetainedExpressionRoots(element)
        return mergeClassifiedRoots([
          classifyValueFlow(
            selectValueFlow(expressionValueFlow(element.expression, program, valueFlowContext)),
            classifiers,
            true,
          ),
          classifyFreshExpressionContents(element.expression),
        ])
      }))
    }
    if (ts.isObjectLiteralExpression(current)) {
      return mergeClassifiedRoots(current.properties.flatMap(property => {
        if (ts.isSpreadAssignment(property)) {
          return [
            classifyValueFlow(
              selectValueFlow(expressionValueFlow(property.expression, program, valueFlowContext)),
              classifiers,
              true,
            ),
            classifyFreshExpressionContents(property.expression),
          ]
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return [classifyRetainedExpressionRoots(property.name)]
        }
        if (ts.isPropertyAssignment(property)) {
          return [classifyRetainedExpressionRoots(property.initializer)]
        }
        return []
      }))
    }
    if (ts.isNewExpression(current)) {
      return mergeClassifiedRoots(
        (current.arguments ?? []).map(classifyRetainedExpressionRoots),
      )
    }
    return emptyClassifiedRoots()
  }
  const classifyRetainedExpressionRoots = (expression: ts.Expression): ClassifiedRoots => {
    const directRoots = classifyExpressionRoots(expression)
    return directRoots.roots.some(root => root.kind === 'fresh')
      ? mergeClassifiedRoots([directRoots, classifyFreshExpressionContents(expression)])
      : directRoots
  }
  const classifyCallArgumentRoots = (
    call: ts.CallExpression,
    index: number,
    rest = false,
    includePossibleFreshContents = false,
  ): ClassifiedRoots => {
    const classifyArgument = includePossibleFreshContents
      ? classifyRetainedExpressionRoots
      : classifyExpressionRoots
    const arguments_ = structuredCallArguments(
      call.arguments,
      classifyArgument,
      expression => spreadElementCanBeMutable(expression, program)
        ? classifyValueFlow(
            selectValueFlow(expressionValueFlow(expression, program, valueFlowContext)),
            classifiers,
            true,
          )
        : emptyClassifiedRoots(),
      emptyClassifiedRoots,
    )
    const mapped = parameterValues(rest, index, arguments_)
    const roots = mergeClassifiedRoots(mapped.values)
    return mapped.inexactSpread && (roots.roots.length > 0 || roots.unknownReason != null)
      ? mergeClassifiedRoots([
          roots,
          {roots: [], unknownReason: 'cannot determine which spread element the called function changes or stores'},
        ])
      : roots
  }
  const addResolvedEdge = (
    call: ts.CallExpression,
    callee: FunctionImplementationRef,
    arguments_: readonly ts.Expression[],
    receiverRoots: ClassifiedRoots,
  ) => {
    const edgeClassifiers = makeClassifiers(
      scope,
      program,
      scope.definitionsAtCall.get(call) ?? null,
      call.pos,
    )
    member.edges.push({
      callee,
      arguments: structuredCallArguments(
        arguments_,
        argument => expressionHasMutableType(argument, program)
          ? {
              container: classifyExpressionContainerRoots(argument),
              reach: classifyRetainedExpressionRoots(argument),
            }
          : {container: emptyClassifiedRoots(), reach: emptyClassifiedRoots()},
        expression => {
          const flow = selectValueFlow(expressionValueFlow(expression, program, valueFlowContext))
          return {
            container: classifyValueFlow(flow, classifiers, false),
            reach: classifyValueFlow(flow, classifiers, true),
          }
        },
        () => ({container: emptyClassifiedRoots(), reach: emptyClassifiedRoots()}),
      ),
      receiverRoots,
      classifyBindingContainer: edgeClassifiers.container,
      classifyBindingReach: edgeClassifiers.reach,
      classifyBindingReachUnknown: edgeClassifiers.reachUnknown,
    })
  }
  const addCallbackEdge = (
    call: ts.CallExpression,
    callback: PlatformCallbackEffect,
    rootsForSource: (source: PlatformValueSource) => ClassifiedRoots,
  ) => {
    const mappedCallback = callExpressionsForPosition(call.arguments, callback.argumentIndex)
    if (mappedCallback.inexactSpread) {
      addUnknownCall('cannot determine which spread element is the called function callback')
      return
    }
    const argument = mappedCallback.expressions[0]
    if (argument == null) return
    const resolved = resolveCallTarget(unwrapExpression(argument), program)
    const fn = callTargetImplementation(resolved)
    if (fn == null) {
      if (resolved.kind === 'platform-global') {
        const classification = classifyPlatformGlobalCall(resolved.base, resolved.name, 0)
        if (classification.kind !== 'supported') {
          addUnsupportedPlatformCall(classification)
          return
        }
        if (classification.effect.observesEnvironment) member.effects.observesEnvironment = true
        for (const index of classification.effect.mutatesArgumentIndexes) {
          const sources = callback.parameterSources[index] ?? []
          addClassifiedMutation(mergeClassifiedRoots(sources.map(rootsForSource)))
        }
        if (classification.effect.callbacks.length > 0) addUnknownCall()
        return
      }
      addUnknownCall()
      return
    }
    const inlineArrow = ts.isArrowFunction(fn.node) && unwrapExpression(argument) === fn.node
    const edgeClassifiers = makeClassifiers(
      scope,
      program,
      scope.definitionsAtCall.get(call) ?? null,
      call.pos,
    )
    member.edges.push({
      callee: fn,
      arguments: callback.parameterSources.map(sources => {
        const roots = mergeClassifiedRoots(sources.map(rootsForSource))
        return {kind: 'single', value: {container: roots, reach: roots}}
      }),
      receiverRoots: inlineArrow
        ? emptyClassifiedRoots()
        : callback.thisArgumentIndex == null
          ? emptyClassifiedRoots()
          : rootsForSource({kind: 'argument', index: callback.thisArgumentIndex}),
      classifyBindingContainer: edgeClassifiers.container,
      classifyBindingReach: edgeClassifiers.reach,
      classifyBindingReachUnknown: edgeClassifiers.reachUnknown,
    })
  }
  const applyPlatformCallEffect = (
    call: ts.CallExpression,
    effect: PlatformCallEffect,
    receiverContainerRoots: ClassifiedRoots,
    rootsForSource: (source: PlatformValueSource) => ClassifiedRoots,
  ) => {
    if (effect.observesEnvironment) member.effects.observesEnvironment = true
    if (effect.mutatesReceiver) addClassifiedMutation(receiverContainerRoots)
    for (const index of effect.mutatesArgumentIndexes) {
      addClassifiedMutation(classifyCallArgumentRoots(call, index))
    }
    for (const position of effect.retainedParameters) {
      const retainedRoots = classifyCallArgumentRoots(call, position.index, position.rest, true)
      if (retainedRoots.unknownReason != null) addUnknownCall(retainedRoots.unknownReason)
      if (
        effect.mutatesReceiver
        && (receiverContainerRoots.roots.length > 0 || receiverContainerRoots.unknownReason != null)
      ) {
        if (retainedRoots.roots.length > 0 || retainedRoots.unknownReason != null) {
          addRetention(receiverContainerRoots, retainedRoots)
        }
      }
    }
    for (const callback of effect.callbacks) addCallbackEdge(call, callback, rootsForSource)
  }

  for (const parameter of node.parameters) {
    if (
      bindingNameUsesUnknownIteratorAtLocation(parameter.name, program)
    ) {
      addUnknownCall('array destructuring is unsupported because its iterator can run user code')
    }
    if (bindingPatternTypeAtLocationMayReadAccessor(parameter.name, program)) {
      addUnknownCall('object destructuring is unsupported because reading a property can call a getter')
    }
  }

  const visit = (current: ts.Node) => {
    if (isFunctionImplementation(current)) return
    if (!scope.reachableNodes.has(current)) {
      ts.forEachChild(current, visit)
      return
    }
    if (ts.isThrowStatement(current)) member.effects.throws = true
    if (
      ts.isTemplateExpression(current)
      && !ts.isTaggedTemplateExpression(current.parent)
      && current.templateSpans.some(span => expressionHasMutableType(span.expression, program))
    ) {
      addUnknownCall(implicitStringConversionReason)
    }
    if (ts.isTaggedTemplateExpression(current)) {
      addUnknownCall('tagged templates are unsupported')
    }
    if (
      ts.isBinaryExpression(current)
      && (
        current.operatorToken.kind === ts.SyntaxKind.PlusToken
        || current.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      )
      && (
        expressionHasMutableType(current.left, program)
        || expressionHasMutableType(current.right, program)
      )
    ) {
      addUnknownCall(implicitStringConversionReason)
    }
    if (ts.isSpreadElement(current) && !isKnownBuiltInIterable(current.expression, program)) {
      addUnknownCall('spread is unsupported because its iterator can run user code')
    }
    if (
      ts.isVariableDeclaration(current)
      && current.initializer != null
      && bindingNameUsesUnknownIterator(current.name, current.initializer, program)
    ) {
      addUnknownCall('array destructuring is unsupported because its iterator can run user code')
    }
    if (
      ts.isVariableDeclaration(current)
      && current.initializer != null
      && bindingPatternMayReadAccessor(current.name, current.initializer, program)
    ) {
      addUnknownCall('object destructuring is unsupported because reading a property can call a getter')
    }
    if (ts.isCatchClause(current) && current.variableDeclaration != null) {
      if (bindingNameContainsArrayPattern(current.variableDeclaration.name)) {
        addUnknownCall('array destructuring is unsupported because its iterator can run user code')
      }
      if (bindingNameContainsObjectPattern(current.variableDeclaration.name)) {
        addUnknownCall('object destructuring is unsupported because reading a property can call a getter')
      }
    }
    if (
      ts.isSpreadAssignment(current)
      && expressionTypeHasAccessor(current.expression, program)
    ) {
      addUnknownCall('object spread is unsupported because reading a property can call a getter')
    }
    if (
      ts.isForOfStatement(current)
      && (
        current.awaitModifier != null
        || !isKnownBuiltInIterable(current.expression, program)
      )
    ) {
      addUnknownCall('for-of is unsupported because its iterator can run user code')
    }
    if (
      ts.isYieldExpression(current)
      && current.asteriskToken != null
      && current.expression != null
      && !isKnownBuiltInIterable(current.expression, program)
    ) {
      addUnknownCall('yield* is unsupported because its iterator can run user code')
    }
    if (
      ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && assignmentPatternUsesUnknownIterator(current.left, current.right, program)
    ) {
      addUnknownCall('array destructuring is unsupported because its iterator can run user code')
    }
    if (
      ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && assignmentPatternMayReadAccessor(current.left, current.right, program)
    ) {
      addUnknownCall('object destructuring is unsupported because reading a property can call a getter')
    }
    if (ts.isIdentifier(current)) {
      const binding = mutableOuterRead(current, classifiers, program)
      if (binding != null) addMutableOuterRead(member.effects, binding)
    }
    if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
      const target = unwrapExpression(current.left)
      const reassigned = reassignedOuterBindings(current.left, classifiers, program)
      for (const binding of reassigned) {
        member.effects.reassignedOuterBindings.set(binding.key, binding)
      }
      if (writesDefaultLibraryMethod(current.left, program)) {
        member.effects.boundaryUnknownReasons.add('replacing a built-in method is unsupported')
      }
      const setter = (ts.isPropertyAccessExpression(target) && propertyAccessHasSourceAccessor(target, 'set', program))
        || (ts.isElementAccessExpression(target) && elementAccessHasSourceAccessor(target, 'set', program))
      const targetRoots = setter
        ? emptyClassifiedRoots()
        : writeTargetRoots(current.left, classifiers, program, valueFlowContext)
      addClassifiedMutation(targetRoots)
      // Storing a reference in caller-visible state is not itself a mutation of
      // that reference. Keep the possible escape separate from the definite
      // mutation of the destination.
      const retentionTargets = mergeClassifiedRoots([
        targetRoots,
        {
          roots: reassigned.map(binding => ({kind: 'outer', binding, contained: false})),
          unknownReason: null,
        },
      ])
      if (retentionTargets.roots.length > 0 || retentionTargets.unknownReason != null) {
        const retainedRoots = classifyRetainedExpressionRoots(current.right)
        if (retainedRoots.roots.length > 0 || retainedRoots.unknownReason != null) {
          addRetention(retentionTargets, retainedRoots)
        }
      }
    }
    if (
      (ts.isForOfStatement(current) || ts.isForInStatement(current))
      && !ts.isVariableDeclarationList(current.initializer)
      && writesDefaultLibraryMethod(current.initializer, program)
    ) {
      member.effects.boundaryUnknownReasons.add('replacing a built-in method is unsupported')
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
          addUncertainMutation(classifyExpressionRoots(current.expression).roots)
          addUnknownCall()
        }
      }
      if (assignment != null || increment) {
        const value = assignment?.right
        if (propertyAccessHasSourceAccessor(current, 'set', program)) {
          addUncertainMutation(classifyExpressionRoots(current.expression).roots)
          if (value != null && expressionHasMutableType(value, program)) {
            addUncertainMutation(classifyExpressionRoots(value).roots)
          }
          addUnknownCall()
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
        addUncertainMutation(classifyExpressionRoots(current.expression).roots)
        addUnknownCall()
      }
      if ((assignment != null || increment) && elementAccessHasSourceAccessor(current, 'set', program)) {
        addUncertainMutation(classifyExpressionRoots(current.expression).roots)
        const value = assignment?.right
        if (value != null && expressionHasMutableType(value, program)) {
          addUncertainMutation(classifyExpressionRoots(value).roots)
        }
        addUnknownCall()
      }
    }
    if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
      && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)) {
      const target = unwrapExpression(current.operand)
      const setter = (ts.isPropertyAccessExpression(target) && propertyAccessHasSourceAccessor(target, 'set', program))
        || (ts.isElementAccessExpression(target) && elementAccessHasSourceAccessor(target, 'set', program))
      if (!setter) {
        for (const binding of reassignedOuterBindings(current.operand, classifiers, program)) {
          member.effects.reassignedOuterBindings.set(binding.key, binding)
        }
        addClassifiedMutation(writeTargetRoots(current.operand, classifiers, program, valueFlowContext))
      }
    }
    if (ts.isDeleteExpression(current)) {
      addClassifiedMutation(writeTargetRoots(current.expression, classifiers, program, valueFlowContext))
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
        const classification = classifyPlatformGlobalCall(base.text, target.name.text, call.arguments.length)
        if (classification.kind !== 'supported') {
          addUncertainMutation(mutableArgumentRoots(
            call,
            program,
            expression => classifyExpressionRoots(expression).roots,
          ))
          addUnsupportedPlatformCall(classification)
        } else {
          applyPlatformCallEffect(call, classification.effect, emptyClassifiedRoots(), source => {
            if (source.kind !== 'argument') return emptyClassifiedRoots()
            return classifyCallArgumentRoots(call, source.index)
          })
        }
        return
      }
      const resolved = resolveCallTarget(target, program)
      const implementation = callTargetImplementation(resolved)
      if (implementation != null) {
        addResolvedEdge(call, implementation, call.arguments, emptyClassifiedRoots())
        return
      }
      if (resolved.kind === 'platform-global') {
        const classification = classifyPlatformGlobalCall(resolved.base, resolved.name, call.arguments.length)
        if (classification.kind !== 'supported') {
          addUnsupportedPlatformCall(classification)
        } else {
          applyPlatformCallEffect(call, classification.effect, emptyClassifiedRoots(), source => {
            if (source.kind !== 'argument') return emptyClassifiedRoots()
            return classifyCallArgumentRoots(call, source.index)
          })
        }
        return
      }
      const receiverContainerRoots = classifyExpressionContainerRoots(target.expression)
      const receiverElementRoots = classifyValueFlow(
        selectValueFlow(expressionValueFlow(target.expression, program, valueFlowContext)),
        classifiers,
        true,
      )
      const classification = defaultLibraryMember
        ? classifyPlatformMethodCall(
          defaultLibraryOwner(target, program),
          target.name.text,
          call.arguments,
          program,
        )
        : {kind: 'unrecognized'} as const
      if (classification.kind !== 'supported') {
        addUnsupportedMutableFunctionBinding(target)
        addUncertainMutation(receiverElementRoots.roots)
        addUncertainMutation(mutableArgumentRoots(
          call,
          program,
          expression => classifyExpressionRoots(expression).roots,
        ))
        addUnsupportedPlatformCall(classification)
      } else {
        applyPlatformCallEffect(call, classification.effect, receiverContainerRoots, source => {
          switch (source.kind) {
            case 'receiver':
              return receiverContainerRoots
            case 'receiver-elements':
              return receiverElementRoots
            case 'argument': {
              return classifyCallArgumentRoots(call, source.index)
            }
          }
        })
      }
      return
    }
    const resolved = resolveCallTarget(target, program)
    const implementation = callTargetImplementation(resolved)
    if (implementation != null) {
      addResolvedEdge(call, implementation, call.arguments, emptyClassifiedRoots())
      return
    }
    if (resolved.kind === 'platform-global') {
      const classification = classifyPlatformGlobalCall(resolved.base, resolved.name, call.arguments.length)
      if (classification.kind !== 'supported') {
        addUnsupportedPlatformCall(classification)
      } else {
        applyPlatformCallEffect(call, classification.effect, emptyClassifiedRoots(), source => {
          if (source.kind !== 'argument') return emptyClassifiedRoots()
          return classifyCallArgumentRoots(call, source.index)
        })
      }
      return
    }
    // A call we cannot see: every mutable argument may be written or retained,
    // and the callee could do anything (write globals, I/O, nondeterminism).
    addUnsupportedMutableFunctionBinding(target)
    addUncertainMutation(mutableArgumentRoots(
      call,
      program,
      expression => classifyExpressionRoots(expression).roots,
    ))
    addUnknownCall()
  }

  const collectNew = (expression: ts.NewExpression) => {
    const name = ts.isIdentifier(expression.expression) ? expression.expression.text : null
    if (name === 'Date' && isDefaultLibrarySymbol(expression.expression, program)) {
      if ((expression.arguments?.length ?? 0) === 0) member.effects.observesEnvironment = true
      else addUnknownCall()
      return
    }
    if (
      name != null
      && zeroArgumentCollectionConstructorNames.has(name)
      && isDefaultLibrarySymbol(expression.expression, program)
      && (expression.arguments?.length ?? 0) === 0
    ) return
    if (
      name != null
      && lengthBearingConstructorNames.has(name)
      && isDefaultLibrarySymbol(expression.expression, program)
    ) {
      if ((expression.arguments?.length ?? 0) === 0) return
      for (const argument of expression.arguments ?? []) {
        if (expressionHasMutableType(argument, program)) {
          addUncertainMutation(classifyExpressionRoots(argument).roots)
        }
      }
      addUnknownCall('array construction with arguments is unsupported because construction can throw or inspect mutable input')
      return
    }
    for (const argument of expression.arguments ?? []) {
      if (expressionHasMutableType(argument, program)) {
        addUncertainMutation(classifyExpressionRoots(argument).roots)
      }
    }
    // A user-defined construction includes base constructors, instance field
    // initializers, and dynamic class behavior. Until those execute through one
    // complete model, classes with source and declaration-only classes share the same
    // conservative boundary.
    addUnknownCall()
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

function functionUsesThis(node: FunctionImplementationNode): boolean {
  let found = false
  const visit = (current: ts.Node) => {
    if (found || (current !== node && isFunctionImplementation(current))) return
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

function isKnownBuiltInIterable(expression: ts.Expression, program: Program): boolean {
  const current = unwrapExpression(expression)
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(unwrapExpression(current.expression))
  ) {
    const target = unwrapExpression(current.expression)
    if (
      ts.isPropertyAccessExpression(target)
      && isDefaultLibraryMemberAccess(target, program)
      && (
        target.name.text === 'keys'
        || target.name.text === 'values'
        || target.name.text === 'entries'
      )
    ) {
      const classification = classifyPlatformMethodCall(
        defaultLibraryOwner(target, program),
        target.name.text,
        current.arguments,
        program,
      )
      if (classification.kind === 'supported') return true
    }
  }
  return isKnownBuiltInIterableTypeAtLocation(current, program)
}

function isKnownBuiltInIterableTypeAtLocation(node: ts.Node, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return false
  try {
    return isKnownBuiltInIterableType(checker.getTypeAtLocation(node), checker, program)
  } catch {
    return false
  }
}

function isKnownBuiltInIterableType(
  type: ts.Type,
  checker: ts.TypeChecker,
  program: Program,
): boolean {
  if (type.isUnion()) {
    return type.types.every(member => isKnownBuiltInIterableType(member, checker, program))
  }
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return true
  if (checker.isArrayType(type) || checker.isTupleType(type)) return true
  const referenceTarget = (type.flags & ts.TypeFlags.Object) !== 0
    && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
    ? (type as ts.TypeReference).target
    : null
  const symbols = [type.aliasSymbol, type.getSymbol(), referenceTarget?.getSymbol()]
  return symbols.some(symbol =>
    symbol != null
    && builtInIterableTypeNames.has(symbol.getName())
    && symbol.declarations?.some(declaration =>
      program.project.typeProgram?.isSourceFileDefaultLibrary(declaration.getSourceFile()) === true,
    ) === true)
}

type DestructuringPattern =
  | {kind: 'leaf'}
  | {kind: 'array'; elements: DestructuringPattern[]}
  | {kind: 'object'; properties: DestructuringProperty[]}

type DestructuringProperty = {
  pattern: DestructuringPattern
  location: ts.Node
  name: string | null
  rest: boolean
}

function bindingDestructuringPattern(name: ts.BindingName): DestructuringPattern {
  if (ts.isIdentifier(name)) return {kind: 'leaf'}
  if (ts.isArrayBindingPattern(name)) {
    return {
      kind: 'array',
      elements: name.elements.flatMap(element =>
        ts.isOmittedExpression(element)
          ? []
          : [bindingDestructuringPattern(element.name)]),
    }
  }
  return {
    kind: 'object',
    properties: name.elements.flatMap(element =>
      ts.isOmittedExpression(element)
        ? []
        : [{
            pattern: bindingDestructuringPattern(element.name),
            location: element,
            name: staticPropertyName(element.propertyName ?? element.name),
            rest: element.dotDotDotToken != null,
          }]),
  }
}

function assignmentDestructuringPattern(expression: ts.Expression): DestructuringPattern {
  const current = unwrapExpression(expression)
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentDestructuringPattern(current.left)
  }
  if (ts.isArrayLiteralExpression(current)) {
    return {
      kind: 'array',
      elements: current.elements.flatMap(element => {
        if (ts.isOmittedExpression(element)) return []
        const target = ts.isSpreadElement(element) ? element.expression : element
        return [assignmentDestructuringPattern(target)]
      }),
    }
  }
  if (ts.isObjectLiteralExpression(current)) {
    return {
      kind: 'object',
      properties: current.properties.flatMap((property): DestructuringProperty[] => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return [{
            pattern: {kind: 'leaf'},
            location: property,
            name: property.name.text,
            rest: false,
          }]
        }
        if (ts.isPropertyAssignment(property)) {
          return [{
            pattern: assignmentDestructuringPattern(property.initializer),
            location: property,
            name: staticPropertyName(property.name),
            rest: false,
          }]
        }
        if (ts.isSpreadAssignment(property)) {
          return [{
            pattern: assignmentDestructuringPattern(property.expression),
            location: property,
            name: null,
            rest: true,
          }]
        }
        return []
      }),
    }
  }
  return {kind: 'leaf'}
}

function destructuringPatternContains(
  pattern: DestructuringPattern,
  kind: 'array' | 'object',
): boolean {
  if (pattern.kind === kind) return true
  if (pattern.kind === 'leaf') return false
  return pattern.kind === 'array'
    ? pattern.elements.some(element => destructuringPatternContains(element, kind))
    : pattern.properties.some(property => destructuringPatternContains(property.pattern, kind))
}

function destructuringPropertyType(
  property: DestructuringProperty,
  sourceType: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | null {
  if (property.name == null) return null
  const symbol = checker.getPropertyOfType(sourceType, property.name)
  return symbol == null ? null : checker.getTypeOfSymbolAtLocation(symbol, property.location)
}

function destructuringPatternUsesUnknownIterator(
  pattern: DestructuringPattern,
  sourceType: ts.Type,
  checker: ts.TypeChecker,
  program: Program,
): boolean {
  if (!destructuringPatternContains(pattern, 'array')) return false
  if (sourceType.isUnion()) {
    return sourceType.types.some(member =>
      destructuringPatternUsesUnknownIterator(pattern, member, checker, program))
  }
  if (pattern.kind === 'array') {
    if (!isKnownBuiltInIterableType(sourceType, checker, program)) return true
    const elementType = checker.getIndexTypeOfType(sourceType, ts.IndexKind.Number)
    if (elementType == null) {
      return pattern.elements.some(element =>
        destructuringPatternContains(element, 'array'))
    }
    return pattern.elements.some(element =>
      destructuringPatternUsesUnknownIterator(element, elementType, checker, program))
  }
  if (pattern.kind === 'leaf') return false
  for (const property of pattern.properties) {
    if (!destructuringPatternContains(property.pattern, 'array')) continue
    const propertyType = destructuringPropertyType(property, sourceType, checker)
    if (
      propertyType == null
      || destructuringPatternUsesUnknownIterator(property.pattern, propertyType, checker, program)
    ) return true
  }
  return false
}

function bindingNameUsesUnknownIteratorAtLocation(
  name: ts.BindingName,
  program: Program,
): boolean {
  const pattern = bindingDestructuringPattern(name)
  const checker = program.typeChecker
  if (checker == null) return destructuringPatternContains(pattern, 'array')
  try {
    return destructuringPatternUsesUnknownIterator(
      pattern,
      checker.getTypeAtLocation(name),
      checker,
      program,
    )
  } catch {
    return destructuringPatternContains(pattern, 'array')
  }
}

function bindingNameUsesUnknownIterator(
  name: ts.BindingName,
  source: ts.Expression,
  program: Program,
): boolean {
  const pattern = bindingDestructuringPattern(name)
  const checker = program.typeChecker
  if (checker == null) return destructuringPatternContains(pattern, 'array')
  try {
    return destructuringPatternUsesUnknownIterator(
      pattern,
      checker.getTypeAtLocation(source),
      checker,
      program,
    )
  } catch {
    return destructuringPatternContains(pattern, 'array')
  }
}

function bindingNameContainsArrayPattern(name: ts.BindingName): boolean {
  return destructuringPatternContains(bindingDestructuringPattern(name), 'array')
}

function bindingNameContainsObjectPattern(name: ts.BindingName): boolean {
  return destructuringPatternContains(bindingDestructuringPattern(name), 'object')
}

function assignmentPatternUsesUnknownIterator(
  pattern: ts.Expression,
  source: ts.Expression,
  program: Program,
): boolean {
  const normalized = assignmentDestructuringPattern(pattern)
  const checker = program.typeChecker
  if (checker == null) return destructuringPatternContains(normalized, 'array')
  try {
    return destructuringPatternUsesUnknownIterator(
      normalized,
      checker.getTypeAtLocation(source),
      checker,
      program,
    )
  } catch {
    return destructuringPatternContains(normalized, 'array')
  }
}

const builtInIterableTypeNames = new Set([
  'Array',
  'ReadonlyArray',
  'Map',
  'ReadonlyMap',
  'Set',
  'ReadonlySet',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
])

function bindingPatternMayReadAccessor(
  pattern: ts.BindingName,
  source: ts.Expression,
  program: Program,
): boolean {
  const normalized = bindingDestructuringPattern(pattern)
  const checker = program.typeChecker
  if (checker == null) return destructuringPatternContains(normalized, 'object')
  try {
    return destructuringPatternMayReadAccessor(
      normalized,
      checker.getTypeAtLocation(source),
      checker,
    )
  } catch {
    return destructuringPatternContains(normalized, 'object')
  }
}

function bindingPatternTypeAtLocationMayReadAccessor(
  pattern: ts.BindingName,
  program: Program,
): boolean {
  const normalized = bindingDestructuringPattern(pattern)
  const checker = program.typeChecker
  if (checker == null) return destructuringPatternContains(normalized, 'object')
  try {
    return destructuringPatternMayReadAccessor(
      normalized,
      checker.getTypeAtLocation(pattern),
      checker,
    )
  } catch {
    return destructuringPatternContains(normalized, 'object')
  }
}

function destructuringPatternMayReadAccessor(
  pattern: DestructuringPattern,
  sourceType: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if (!destructuringPatternContains(pattern, 'object')) return false
  if (sourceType.isUnion()) {
    return sourceType.types.some(member =>
      destructuringPatternMayReadAccessor(pattern, member, checker))
  }
  if (pattern.kind === 'array') {
    const elementType = checker.getIndexTypeOfType(sourceType, ts.IndexKind.Number)
    if (elementType == null) {
      return pattern.elements.some(element =>
        destructuringPatternContains(element, 'object'))
    }
    return pattern.elements.some(element =>
      destructuringPatternMayReadAccessor(element, elementType, checker))
  }
  if (pattern.kind === 'leaf') return false
  for (const property of pattern.properties) {
    if (property.rest) {
      if (typeHasAccessor(sourceType, checker)) return true
      continue
    }
    const symbol = property.name == null
      ? undefined
      : checker.getPropertyOfType(sourceType, property.name)
    const propertyType = destructuringPropertyType(property, sourceType, checker)
    if (
      propertyType == null
      || symbolHasAccessor(symbol)
      || destructuringPatternMayReadAccessor(property.pattern, propertyType, checker)
    ) return true
  }
  return false
}

function assignmentPatternMayReadAccessor(
  pattern: ts.Expression,
  source: ts.Expression,
  program: Program,
): boolean {
  const normalized = assignmentDestructuringPattern(pattern)
  const checker = program.typeChecker
  if (checker == null) return destructuringPatternContains(normalized, 'object')
  try {
    return destructuringPatternMayReadAccessor(
      normalized,
      checker.getTypeAtLocation(source),
      checker,
    )
  } catch {
    return destructuringPatternContains(normalized, 'object')
  }
}

function expressionTypeHasAccessor(expression: ts.Expression, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  try {
    return typeHasAccessor(checker.getTypeAtLocation(expression), checker)
  } catch {
    return true
  }
}

function typeHasAccessor(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnion()) return type.types.some(member => typeHasAccessor(member, checker))
  return checker.getPropertiesOfType(type).some(symbolHasAccessor)
}

function symbolHasAccessor(symbol: ts.Symbol | undefined): boolean {
  return symbol?.declarations?.some(declaration =>
    ts.isGetAccessorDeclaration(declaration),
  ) === true
}

function staticPropertyName(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
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

function spreadElementCanBeMutable(expression: ts.Expression, program: Program): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  try {
    const type = checker.getTypeAtLocation(expression)
    if (type.isUnion()) return type.types.some(member => {
      const element = checker.getIndexTypeOfType(member, ts.IndexKind.Number)
      return element == null || typeCanBeMutable(element)
    })
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    return element == null || typeCanBeMutable(element)
  } catch {
    return true
  }
}

const immutableTypeFlags = ts.TypeFlags.NumberLike
  | ts.TypeFlags.StringLike
  | ts.TypeFlags.BooleanLike
  | ts.TypeFlags.EnumLike
  | ts.TypeFlags.BigIntLike
  | ts.TypeFlags.ESSymbolLike
  | ts.TypeFlags.Null
  | ts.TypeFlags.Undefined
  | ts.TypeFlags.Void
  | ts.TypeFlags.Never

function typeCanBeMutable(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(typeCanBeMutable)
  return (type.flags & immutableTypeFlags) === 0
}

function writeTargetRoots(
  target: ts.Expression,
  classifiers: Classifiers,
  program: Program,
  valueFlowContext: ValueFlowContext,
): ClassifiedRoots {
  const classifications: ClassifiedRoots[] = []
  for (const assignmentTarget of assignmentTargets(target)) {
    if (assignmentTarget.kind === 'binding') {
      // Bare reassignments are recorded separately from mutations of the
      // previous value stored in the binding.
      classifications.push(emptyClassifiedRoots())
    } else {
      classifications.push(writeBaseRoots(
        assignmentTarget.expression.expression,
        classifiers,
        program,
        valueFlowContext,
      ))
    }
  }
  return mergeClassifiedRoots(classifications)
}

function reassignedOuterBindings(
  target: ts.Expression,
  classifiers: Classifiers,
  program: Program,
): OuterBinding[] {
  const bindings = new Map<BindingKey, OuterBinding>()
  for (const assignmentTarget of assignmentTargets(target)) {
    if (assignmentTarget.kind !== 'binding') continue
    for (const root of classifiers.container(bindingKey(assignmentTarget.identifier, program))) {
      if (root.kind === 'outer') bindings.set(root.binding.key, root.binding)
    }
  }
  return [...bindings.values()]
}

// A direct property write mutates the expression's aliased container. Each
// property or element step in that expression turns a retained value into a
// possible alias, so `holder.box.n = 1` can reach `box` while `holder.n = 1`
// does not.
function writeBaseRoots(
  expression: ts.Expression,
  classifiers: Classifiers,
  program: Program,
  valueFlowContext: ValueFlowContext,
): ClassifiedRoots {
  return classifyValueFlow(
    expressionValueFlow(expression, program, valueFlowContext),
    classifiers,
    false,
  )
}

type ClassifiedRoots = {
  roots: RootKind[]
  unknownReason: string | null
}

function emptyClassifiedRoots(): ClassifiedRoots {
  return {roots: [], unknownReason: null}
}

function mergeClassifiedRoots(classifications: readonly ClassifiedRoots[]): ClassifiedRoots {
  const roots: RootKind[] = []
  let unknownReason: string | null = null
  for (const classification of classifications) {
    unknownReason ??= classification.unknownReason
    for (const candidate of classification.roots) {
      if (!roots.some(root => sameRoot(root, candidate))) roots.push(candidate)
    }
  }
  return {roots, unknownReason}
}

function classifyValueFlow(
  flow: ValueFlow,
  classifiers: Classifiers,
  includeContained: boolean,
): ClassifiedRoots {
  const roots: RootKind[] = []
  let unknownReason = flow.unknownReason
  for (const reference of flow.references) {
    unknownReason ??= classifiers.referenceUnknownReason(reference, includeContained)
    if (!includeContained && reference.containers > 0) continue
    const candidates = classifiers.reference(reference, includeContained)
    for (const candidate of candidates) {
      if (!roots.some(root => sameRoot(root, candidate))) roots.push(candidate)
    }
  }
  return {roots, unknownReason}
}

// Roots whose values could flow into this expression's value. A subtree of
// immutable type (number, string, boolean, ...) carries no references, so
// nothing flows out of it. Callee names are not values that flow (only their
// arguments and receiver are), and object literal property names are labels,
// not reads.
function expressionRootBindings(
  expression: ts.Expression,
  program: Program,
  context: ValueFlowContext,
): BindingKey[] {
  const roots: BindingKey[] = []
  const visit = (current: ts.Node) => {
    // Type positions name types, not values; nothing flows through them.
    if (ts.isTypeNode(current)) return
    if (isFunctionImplementation(current)) return
    if (ts.isExpression(current) && !expressionHasMutableType(current, program)) return
    if (ts.isIdentifier(current)) {
      roots.push(context.definitionFor?.(current) ?? bindingKey(current, program))
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
