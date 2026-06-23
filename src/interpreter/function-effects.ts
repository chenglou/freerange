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
  classifyPlatformGlobalCall,
  classifyPlatformMethodCall,
  isPlatformGlobalNamespace,
  retainedArgumentIndexes,
  type PlatformCallbackEffect,
  type PlatformCallEffect,
  type PlatformResultEffect,
  type PlatformValueSource,
} from './platform-effects.ts'

// What a call can change in its caller's world, beyond returning a value.
// `paramIndexes` holds parameters whose argument may be written through.
// `retained` separately records references stored somewhere that outlives the
// call. The interpreter forgets caller facts in either case because it cannot
// represent the new alias. Outside bindings retain TypeScript identity until
// the caller asks for the root names from one source.
// The mutation fields are what the interpreter uses to forget caller facts.
// The remaining fields extend the summary to the stricter notion a `pure`
// annotation needs: a pure function also reads no mutable outside state, never
// observes or affects the environment (I/O, the clock, randomness), and calls
// nothing it cannot analyze. Purity is derived from this summary, never stored
// separately.
type DefinitionKey = {kind: 'definition'; node: ts.Node}
type AllocationKey = {kind: 'allocation'; expression: ts.Expression}
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

type FunctionResult =
  | {kind: 'none'}
  | {kind: 'fresh'}
  | {kind: 'arguments'; indexes: readonly number[]}
  | {kind: 'outer'; bindings: readonly OuterBinding[]}
  | {kind: 'unknown'; reason: string}

type MutationTargets = {
  outerBindings: Map<BindingKey, OuterBinding>
  containedOuterBindings: Map<BindingKey, OuterBinding>
  paramIndexes: Set<number>
  containedParamIndexes: Set<number>
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
  // Reassigning a captured binding changes the local name, not the object the
  // name previously referred to. It remains observable only while that binding
  // is still outside the function being summarized.
  reassignedOuterBindings: Map<BindingKey, OuterBinding>
  // Existing references stored into a parameter or outside container. This is
  // not a mutation of the retained value, but callers that cannot represent
  // the new alias must forget facts reachable through it.
  retained: MutationTargets
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
const opaqueFreshResult = '__freerange_opaque_fresh_result__'

const noMutationTargets = (): MutationTargets => ({
  outerBindings: new Map(),
  containedOuterBindings: new Map(),
  paramIndexes: new Set(),
  containedParamIndexes: new Set(),
  thisValue: false,
})

const unknownFunctionResult = (reason = unknownReturnReason): FunctionResult => ({
  kind: 'unknown',
  reason,
})

const emptyFunctionResult = (): FunctionResult => ({kind: 'none'})

const noEffects = (result: FunctionResult = emptyFunctionResult()): FunctionEffects => ({
  mutations: {
    certain: noMutationTargets(),
    uncertain: noMutationTargets(),
  },
  reassignedOuterBindings: new Map(),
  retained: noMutationTargets(),
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
  const boundaryReason = effects.boundaryUnknownReasons.values().next().value
  if (boundaryReason != null) return {kind: 'unknown', reason: boundaryReason}
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
  // classified roots per caller argument position; `null` marks a spread
  // argument whose positions cannot be mapped
  argumentRoots: ({container: ClassifiedRoots; reach: ClassifiedRoots} | null)[]
  receiverRoots: ClassifiedRoots
  classifyBindingContainer: Classifier
  classifyBindingReach: Classifier
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
    valueFlowContextForScope(context, scope, implementation.program),
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
  const addRetainedMapped = (mapping: ClassifiedRoots) => {
    if (mapping.unknownReason != null) into.unknownCallReasons.add(mapping.unknownReason)
    add(into.retained, mapping.roots)
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
  for (const binding of callee.mutations.certain.outerBindings.values()) {
    addOuterMutation(binding, true)
  }
  for (const binding of callee.mutations.certain.containedOuterBindings.values()) {
    add(into.mutations.certain, edge.classifyBindingReach(binding.key))
  }
  for (const binding of callee.mutations.uncertain.outerBindings.values()) {
    addOuterMutation(binding, false)
  }
  for (const binding of callee.mutations.uncertain.containedOuterBindings.values()) {
    add(into.mutations.uncertain, edge.classifyBindingReach(binding.key))
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
  for (const binding of callee.retained.outerBindings.values()) {
    add(into.retained, edge.classifyBindingReach(binding.key))
  }
  for (const binding of callee.retained.containedOuterBindings.values()) {
    add(into.retained, edge.classifyBindingReach(binding.key))
  }
  if (callee.retained.thisValue) addRetainedMapped(edge.receiverRoots)
  for (const reason of callee.unknownCallReasons) into.unknownCallReasons.add(reason)
  const mapParamIndexes = (
    indexes: Set<number>,
    select: (roots: {container: ClassifiedRoots; reach: ClassifiedRoots}) => ClassifiedRoots,
    apply: (roots: ClassifiedRoots) => void,
  ) => {
    const hasSpread = edge.argumentRoots.some(roots => roots == null)
    for (const index of indexes) {
      const rest = edge.callee.node.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) {
          if (roots != null) apply(select(roots))
        }
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) {
          if (roots != null) apply(select(roots))
        }
      } else {
        const roots = edge.argumentRoots[index]
        if (roots != null) apply(select(roots))
      }
    }
  }
  mapParamIndexes(callee.mutations.certain.paramIndexes, roots => roots.container, roots => addMapped(roots, true))
  mapParamIndexes(callee.mutations.certain.containedParamIndexes, roots => roots.reach, roots => addMapped(roots, true))
  mapParamIndexes(callee.mutations.uncertain.paramIndexes, roots => roots.container, roots => addMapped(roots, false))
  mapParamIndexes(callee.mutations.uncertain.containedParamIndexes, roots => roots.reach, roots => addMapped(roots, false))
  const retainedIndexes = new Set([
    ...callee.retained.paramIndexes,
    ...callee.retained.containedParamIndexes,
  ])
  mapParamIndexes(retainedIndexes, roots => roots.reach, addRetainedMapped)
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

function addMutableOuterRead(effects: FunctionEffects, binding: OuterBinding) {
  effects.mutableOuterReads.set(binding.key, binding)
}

function analyzeFunctionResult(
  implementation: FunctionImplementationRef,
  context: ValueFlowContext,
  scope: Scope,
): FunctionResult {
  const scopedContext = valueFlowContextForScope(context, scope, implementation.program)
  const returned = returnedExpressions(implementation.node)
    .map(unwrapExpression)
    .filter(expression => scope.environments.has(expression))
  if (returned.length === 0) return emptyFunctionResult()
  const flow = mergeValueFlows(returned.map(expression =>
    expressionValueFlow(expression, implementation.program, scopedContext)))
  const unknownReason = valueFlowUnknownReason(flow, scope)
  if (unknownReason != null) return unknownFunctionResult(unknownReason)
  return valueFlowFunctionResult(flow, scope, implementation.program)
}

function valueFlowFunctionResult(
  flow: ValueFlow,
  scope: Scope,
  program: Program,
): FunctionResult {
  let hasFresh = false
  const arguments_ = new Set<number>()
  const outers = new Map<BindingKey, OuterBinding>()
  for (const reference of flow.references) {
    if (reference.binding === opaqueFreshResult) {
      if (reference.selections > 0) return unknownFunctionResult()
      hasFresh = true
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
        return unknownFunctionResult('functions that return `this` are unsupported')
      }
    }
  }
  const sourceKinds = Number(hasFresh) + Number(arguments_.size > 0) + Number(outers.size > 0)
  if (sourceKinds > 1) return unknownFunctionResult()
  if (hasFresh) return {kind: 'fresh'}
  if (arguments_.size > 0) return {kind: 'arguments', indexes: [...arguments_]}
  if (outers.size > 0) return {kind: 'outer', bindings: [...outers.values()]}
  return {kind: 'fresh'}
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
  environments: Map<ts.Node, BindingEnvironment>
  allocationKeys: Map<ts.Expression, AllocationKey>
}

type ValueFlowContext = {
  resultFor: (implementation: FunctionImplementationRef) => FunctionResult
  effectsFor: (implementation: FunctionImplementationRef) => FunctionEffects
  definitionsFor?: (identifier: ts.Identifier) => readonly BindingKey[] | null
  allocationFor?: (expression: ts.Expression) => AllocationKey
}

// A binding has one reaching definition on a sequential path and may have
// several only after control-flow joins. Assignment definitions are stable
// graph nodes, so aliases keep the value they observed before a later rebind.
type BindingEnvironment = Map<BindingKey, BindingKey[]>

function valueFlowContextForScope(
  context: ValueFlowContext,
  scope: Scope,
  program: Program,
): ValueFlowContext {
  return {
    ...context,
    definitionsFor: identifier =>
      scope.environments.get(identifier)?.get(bindingKey(identifier, program)) ?? null,
    allocationFor: expression => {
      let allocation = scope.allocationKeys.get(expression)
      if (allocation == null) {
        allocation = {kind: 'allocation', expression}
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
  const environments = new Map<ts.Node, BindingEnvironment>()
  const definitionKeys = new Map<ts.Node, DefinitionKey>()
  const callReassignmentKeys = new Map<ts.CallExpression, Map<BindingKey, DefinitionKey>>()
  const allocationKeys = new Map<ts.Expression, AllocationKey>()
  const allocationFor = (expression: ts.Expression): AllocationKey => {
    let allocation = allocationKeys.get(expression)
    if (allocation == null) {
      allocation = {kind: 'allocation', expression}
      allocationKeys.set(expression, allocation)
    }
    return allocation
  }
  const scopeContext: ValueFlowContext = {
    ...context,
    definitionsFor: identifier => {
      const environment = environments.get(identifier)
      return environment?.get(bindingKey(identifier, program)) ?? null
    },
    allocationFor,
  }
  const copyEnvironment = (environment: BindingEnvironment): BindingEnvironment =>
    new Map([...environment].map(([binding, definitions]) => [binding, [...definitions]]))
  const mergeEnvironments = (
    environmentsToMerge: readonly (BindingEnvironment | null)[],
  ): BindingEnvironment | null => {
    const reachable = environmentsToMerge.filter(environment => environment != null)
    if (reachable.length === 0) return null
    const merged = copyEnvironment(reachable[0]!)
    for (const environment of reachable.slice(1)) {
      for (const [binding, definitions] of environment) {
        let mergedDefinitions = merged.get(binding)
        if (mergedDefinitions == null) {
          mergedDefinitions = []
          merged.set(binding, mergedDefinitions)
        }
        for (const definition of definitions) {
          if (!mergedDefinitions.includes(definition)) mergedDefinitions.push(definition)
        }
      }
    }
    return merged
  }
  const sameEnvironment = (left: BindingEnvironment, right: BindingEnvironment) => {
    if (left.size !== right.size) return false
    for (const [binding, definitions] of left) {
      const other = right.get(binding)
      if (other == null || definitions.length !== other.length) return false
      if (definitions.some(definition => !other.includes(definition))) return false
    }
    return true
  }
  const recordEnvironment = (current: ts.Node, environment: BindingEnvironment) => {
    const existing = environments.get(current)
    const merged = existing == null
      ? copyEnvironment(environment)
      : mergeEnvironments([existing, environment])!
    environments.set(current, merged)
  }
  const addValueFlow = (target: BindingKey, flow: ValueFlow, reversible = true) => {
    for (const reference of flow.references) referenceEdges.push({target, reference, reversible})
    if (flow.unknownReason != null && !unknownReasons.has(target)) {
      unknownReasons.set(target, flow.unknownReason)
    }
  }
  const definitionKey = (target: ts.Node): DefinitionKey => {
    let definition = definitionKeys.get(target)
    if (definition == null) {
      definition = {kind: 'definition', node: target}
      definitionKeys.set(target, definition)
    }
    return definition
  }
  const callReassignmentKey = (call: ts.CallExpression, binding: BindingKey): DefinitionKey => {
    let bindings = callReassignmentKeys.get(call)
    if (bindings == null) {
      bindings = new Map()
      callReassignmentKeys.set(call, bindings)
    }
    let definition = bindings.get(binding)
    if (definition == null) {
      definition = {kind: 'definition', node: call}
      bindings.set(binding, definition)
    }
    return definition
  }
  const addTargetValueFlow = (
    target: AssignmentTarget,
    flow: ValueFlow,
    environment: BindingEnvironment,
  ) => {
    if (target.kind === 'binding') {
      const binding = bindingKey(target.identifier, program)
      const definition = definitionKey(target.identifier)
      localBindings.add(definition)
      addValueFlow(definition, flow)
      environment.set(binding, [definition])
      return
    }
    const base = pathWriteBaseBinding(target.expression, program)
    if (base != null) {
      const previousDefinitions = environment.get(base) ?? [base]
      const definition = definitionKey(target.expression)
      localBindings.add(definition)
      addValueFlow(definition, {
        references: previousDefinitions.map(binding => ({binding, selections: 0, containers: 0})),
        unknownReason: null,
      }, false)
      addValueFlow(definition, wrapValueFlow(flow, pathDepth(target.expression)), false)
      environment.set(base, [definition])
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
    input: BindingEnvironment,
  ): BindingEnvironment => {
    const assigned = copyEnvironment(input)
    for (const {target, flow} of targets) addTargetValueFlow(target, flow, assigned)
    return assigned
  }

  const flowExpression = (
    expression: ts.Expression,
    input: BindingEnvironment,
  ): BindingEnvironment => {
    const current = unwrapExpression(expression)
    recordEnvironment(current, input)
    if (isFunctionImplementation(current)) return input
    if (ts.isConditionalExpression(current)) {
      const afterCondition = flowExpression(current.condition, input)
      return mergeEnvironments([
        flowExpression(current.whenTrue, copyEnvironment(afterCondition)),
        flowExpression(current.whenFalse, copyEnvironment(afterCondition)),
      ])!
    }
    if (ts.isBinaryExpression(current)) {
      const afterLeft = flowExpression(current.left, input)
      if (assignmentMayTakeRightValue(current.operatorToken.kind)) {
        const afterRight = flowExpression(current.right, afterLeft)
        const sourceFlow = expressionValueFlow(current.right, program, scopeContext)
        const assigned = assignTargets(
          assignmentValueFlows(current.left, sourceFlow, program, scopeContext),
          afterRight,
        )
        return current.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? assigned
          : mergeEnvironments([afterLeft, assigned])!
      }
      if (
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return mergeEnvironments([
          afterLeft,
          flowExpression(current.right, copyEnvironment(afterLeft)),
        ])!
      }
      return flowExpression(current.right, afterLeft)
    }
    if (ts.isCallExpression(current)) {
      let output = flowExpression(current.expression, input)
      for (const argument of current.arguments) {
        output = flowExpression(
          ts.isSpreadElement(argument) ? argument.expression : argument,
          output,
        )
      }
      const implementation = callTargetImplementation(resolveCallTarget(current.expression, program))
      if (implementation != null) {
        for (const binding of context.effectsFor(implementation).reassignedOuterBindings.values()) {
          if (binding.sourceId !== program.sourceId) continue
          const definition = callReassignmentKey(current, binding.key)
          localBindings.add(definition)
          unknownReasons.set(definition, 'a nested function reassigns a value used later')
          output = copyEnvironment(output)
          output.set(binding.key, [definition])
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
      if (ts.isPropertyAccessExpression(target) && classification.kind === 'supported') {
        const base = pathWriteBaseBinding(target.expression, program)
        if (base != null) {
          for (const index of retainedArgumentIndexes(classification.effect, current.arguments.length)) {
            const argument = current.arguments[index]
            if (argument == null) continue
            const retained = ts.isSpreadElement(argument) ? argument.expression : argument
            for (const definition of output.get(base) ?? [base]) {
              addValueFlow(
                definition,
                wrapValueFlow(expressionValueFlow(retained, program, scopeContext), 1),
              )
            }
          }
        }
      }
      return output
    }
    let output = input
    const flowChildren = (parent: ts.Node) => {
      ts.forEachChild(parent, child => {
        if (ts.isExpression(child)) {
          output = flowExpression(child, output)
          return
        }
        if (isFunctionImplementation(child)) return
        recordEnvironment(child, output)
        flowChildren(child)
      })
    }
    flowChildren(current)
    return output
  }

  type StatementFlow = {
    normal: BindingEnvironment | null
    breaks: BindingEnvironment[]
    continues: BindingEnvironment[]
  }
  const normalFlow = (normal: BindingEnvironment | null): StatementFlow => ({
    normal,
    breaks: [],
    continues: [],
  })
  const mergeStatementFlows = (flows: readonly StatementFlow[]): StatementFlow => {
    const normalEnvironments: (BindingEnvironment | null)[] = []
    const breaks: BindingEnvironment[] = []
    const continues: BindingEnvironment[] = []
    for (const flow of flows) {
      normalEnvironments.push(flow.normal)
      breaks.push(...flow.breaks)
      continues.push(...flow.continues)
    }
    return {
      normal: mergeEnvironments(normalEnvironments),
      breaks,
      continues,
    }
  }
  const flowVariableDeclaration = (
    declaration: ts.VariableDeclaration,
    input: BindingEnvironment,
  ): BindingEnvironment => {
    recordEnvironment(declaration, input)
    const afterInitializer = declaration.initializer == null
      ? input
      : flowExpression(declaration.initializer, input)
    const sourceFlow = declaration.initializer == null
      ? emptyValueFlow()
      : expressionValueFlow(declaration.initializer, program, scopeContext)
    const afterBindingInitializers = flowBindingInitializers(declaration.name, afterInitializer)
    return assignTargets(
      bindingValueFlows(declaration.name, sourceFlow, program, scopeContext),
      afterBindingInitializers,
    )
  }
  const flowBindingInitializers = (
    name: ts.BindingName,
    input: BindingEnvironment,
  ): BindingEnvironment => {
    if (ts.isIdentifier(name)) return input
    let output = input
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue
      if (element.propertyName != null && ts.isComputedPropertyName(element.propertyName)) {
        output = flowExpression(element.propertyName.expression, output)
      }
      if (element.initializer != null) {
        output = mergeEnvironments([
          output,
          flowExpression(element.initializer, copyEnvironment(output)),
        ])!
      }
      output = flowBindingInitializers(element.name, output)
    }
    return output
  }
  const flowVariableDeclarationList = (
    declarationList: ts.VariableDeclarationList,
    input: BindingEnvironment,
  ) => {
    let output = input
    for (const declaration of declarationList.declarations) {
      output = flowVariableDeclaration(declaration, output)
    }
    return output
  }
  const flowLoop = (
    entry: BindingEnvironment,
    condition: ts.Expression | null,
    body: ts.Statement,
    increment: ts.Expression | null,
    bodyRunsAtLeastOnce: boolean,
  ): StatementFlow => {
    const firstBody = bodyRunsAtLeastOnce
      ? flowStatement(body, copyEnvironment(entry))
      : null
    const firstIterationBreaks = firstBody?.breaks ?? []
    const initialHead = firstBody == null
      ? entry
      : mergeEnvironments([firstBody.normal, ...firstBody.continues])
    if (initialHead == null) {
      return normalFlow(mergeEnvironments(firstBody?.breaks ?? []))
    }
    let head = initialHead
    let latestBody = firstBody
    let conditionOutput = head
    for (;;) {
      conditionOutput = condition == null
        ? head
        : flowExpression(condition, copyEnvironment(head))
      latestBody = flowStatement(body, copyEnvironment(conditionOutput))
      let backEdge = mergeEnvironments([latestBody.normal, ...latestBody.continues])
      if (backEdge != null && increment != null) {
        backEdge = flowExpression(increment, backEdge)
      }
      const nextHead = mergeEnvironments([initialHead, backEdge])!
      if (sameEnvironment(head, nextHead)) break
      head = nextHead
    }
    const conditionExit = condition == null ? null : conditionOutput
    return {
      normal: mergeEnvironments([
        conditionExit,
        ...firstIterationBreaks,
        ...latestBody.breaks,
      ]),
      breaks: [],
      continues: [],
    }
  }
  const flowStatement = (
    statement: ts.Statement,
    input: BindingEnvironment,
  ): StatementFlow => {
    recordEnvironment(statement, input)
    if (ts.isBlock(statement)) {
      let normal: BindingEnvironment | null = input
      const breaks: BindingEnvironment[] = []
      const continues: BindingEnvironment[] = []
      for (const child of statement.statements) {
        if (normal == null) break
        const childFlow = flowStatement(child, normal)
        normal = childFlow.normal
        breaks.push(...childFlow.breaks)
        continues.push(...childFlow.continues)
      }
      return {normal, breaks, continues}
    }
    if (ts.isVariableStatement(statement)) {
      return normalFlow(flowVariableDeclarationList(statement.declarationList, input))
    }
    if (ts.isExpressionStatement(statement)) {
      return normalFlow(flowExpression(statement.expression, input))
    }
    if (ts.isIfStatement(statement)) {
      const afterCondition = flowExpression(statement.expression, input)
      const whenTrue = flowStatement(statement.thenStatement, copyEnvironment(afterCondition))
      const whenFalse = statement.elseStatement == null
        ? normalFlow(copyEnvironment(afterCondition))
        : flowStatement(statement.elseStatement, copyEnvironment(afterCondition))
      return mergeStatementFlows([whenTrue, whenFalse])
    }
    if (ts.isWhileStatement(statement)) {
      return flowLoop(input, statement.expression, statement.statement, null, false)
    }
    if (ts.isDoStatement(statement)) {
      return flowLoop(input, statement.expression, statement.statement, null, true)
    }
    if (ts.isForStatement(statement)) {
      let afterInitializer = input
      if (statement.initializer != null) {
        afterInitializer = ts.isVariableDeclarationList(statement.initializer)
          ? flowVariableDeclarationList(statement.initializer, input)
          : flowExpression(statement.initializer, input)
      }
      return flowLoop(
        afterInitializer,
        statement.condition ?? null,
        statement.statement,
        statement.incrementor ?? null,
        false,
      )
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      const afterExpression = flowExpression(statement.expression, input)
      const sourceFlow = ts.isForOfStatement(statement)
        ? selectValueFlow(expressionValueFlow(statement.expression, program, scopeContext))
        : emptyValueFlow()
      const assignIterationValue = (environment: BindingEnvironment) => {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          let assigned = environment
          for (const declaration of statement.initializer.declarations) {
            recordEnvironment(declaration, assigned)
            const afterBindingInitializers = flowBindingInitializers(declaration.name, assigned)
            assigned = assignTargets(
              bindingValueFlows(declaration.name, sourceFlow, program, scopeContext),
              afterBindingInitializers,
            )
          }
          return assigned
        }
        return assignTargets(
          assignmentValueFlows(statement.initializer, sourceFlow, program, scopeContext),
          environment,
        )
      }
      let head = afterExpression
      let bodyFlow = normalFlow(head)
      for (;;) {
        const iterationEnvironment = assignIterationValue(copyEnvironment(head))
        bodyFlow = flowStatement(statement.statement, iterationEnvironment)
        const backEdge = mergeEnvironments([bodyFlow.normal, ...bodyFlow.continues])
        const nextHead = mergeEnvironments([afterExpression, backEdge])!
        if (sameEnvironment(head, nextHead)) break
        head = nextHead
      }
      return normalFlow(mergeEnvironments([head, ...bodyFlow.breaks]))
    }
    if (ts.isSwitchStatement(statement)) {
      const afterExpression = flowExpression(statement.expression, input)
      let selectionEnvironment = afterExpression
      const selectedEnvironments: (BindingEnvironment | null)[] = []
      let defaultIndex = -1
      for (let index = 0; index < statement.caseBlock.clauses.length; index++) {
        const clause = statement.caseBlock.clauses[index]!
        recordEnvironment(clause, selectionEnvironment)
        if (ts.isCaseClause(clause)) {
          selectionEnvironment = flowExpression(clause.expression, selectionEnvironment)
          selectedEnvironments.push(selectionEnvironment)
        } else {
          defaultIndex = index
          selectedEnvironments.push(null)
        }
      }
      if (defaultIndex >= 0) selectedEnvironments[defaultIndex] = selectionEnvironment

      let fallthrough: BindingEnvironment | null = null
      const exits: BindingEnvironment[] = []
      const continues: BindingEnvironment[] = []
      for (let index = 0; index < statement.caseBlock.clauses.length; index++) {
        const clause = statement.caseBlock.clauses[index]!
        let normal: BindingEnvironment | null = mergeEnvironments([
          selectedEnvironments[index] ?? null,
          fallthrough,
        ])
        for (const child of clause.statements) {
          if (normal == null) break
          const childFlow = flowStatement(child, normal)
          exits.push(...childFlow.breaks)
          continues.push(...childFlow.continues)
          normal = childFlow.normal
        }
        fallthrough = normal
      }
      if (defaultIndex < 0) exits.push(selectionEnvironment)
      if (fallthrough != null) exits.push(fallthrough)
      return {normal: mergeEnvironments(exits), breaks: [], continues}
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      const output = statement.expression == null
        ? input
        : flowExpression(statement.expression, input)
      recordEnvironment(statement, output)
      return normalFlow(null)
    }
    if (ts.isBreakStatement(statement)) {
      return {normal: null, breaks: [input], continues: []}
    }
    if (ts.isContinueStatement(statement)) {
      return {normal: null, breaks: [], continues: [input]}
    }
    if (ts.isFunctionDeclaration(statement)) return normalFlow(input)
    let output = input
    ts.forEachChild(statement, child => {
      if (ts.isExpression(child)) output = flowExpression(child, output)
      else if (ts.isStatement(child)) {
        const childFlow = flowStatement(child, output)
        output = childFlow.normal ?? output
      }
    })
    return normalFlow(output)
  }

  let parameterEnvironment: BindingEnvironment = new Map()
  node.parameters.forEach((parameter, index) => {
    recordEnvironment(parameter, parameterEnvironment)
    const parameterRoot = `parameter:${node.pos}:${index}`
    paramIndexByBinding.set(parameterRoot, index)
    const parameterFlow: ValueFlow = {
      references: [{
        binding: parameterRoot,
        selections: 0,
        containers: parameter.dotDotDotToken == null ? 0 : 1,
      }],
      unknownReason: null,
    }
    const afterInitializer = parameter.initializer == null
      ? parameterEnvironment
      : flowExpression(parameter.initializer, parameterEnvironment)
    const sourceFlow = parameter.initializer == null
      ? parameterFlow
      : mergeValueFlows([
        parameterFlow,
        expressionValueFlow(parameter.initializer, program, scopeContext),
      ])
    const afterBindingInitializers = flowBindingInitializers(parameter.name, afterInitializer)
    if (ts.isIdentifier(parameter.name) && parameter.initializer == null) {
      parameterEnvironment = copyEnvironment(afterInitializer)
      parameterEnvironment.set(bindingKey(parameter.name, program), [parameterRoot])
    } else {
      parameterEnvironment = assignTargets(
        bindingValueFlows(parameter.name, sourceFlow, program, scopeContext),
        afterBindingInitializers,
      )
    }
  })
  if (ts.isBlock(node.body)) flowStatement(node.body, parameterEnvironment)
  else flowExpression(node.body, parameterEnvironment)

  // Exact aliases are symmetric: if `ys = xs`, writes and retained references
  // discovered through either name belong to the same container.
  const symmetricReferences = [...referenceEdges]
  for (const edge of referenceEdges) {
    if (!edge.reversible) continue
    if (edge.reference.selections !== 0 || edge.reference.containers !== 0) continue
    symmetricReferences.push({
      target: edge.reference.binding,
      reference: {binding: edge.target, selections: 0, containers: 0},
      reversible: true,
    })
  }
  return {
    paramIndexByBinding,
    localBindings,
    references: referenceMap(symmetricReferences),
    unknownReasons,
    environments,
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
    const definitions = context.definitionsFor?.(current)
    return {
      references: (definitions ?? [bindingKey(current, program)]).map(binding => ({
        binding,
        selections: 0,
        containers: 0,
      })),
      unknownReason: null,
    }
  }
  if (current.kind === ts.SyntaxKind.ThisKeyword) {
    return {
      references: [{binding: 'this', selections: 0, containers: 0}],
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
      .map(binding => ({binding, selections: 0, containers: 0})),
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
      return freshResultFlow([receiverFlow, ...argumentFlows])
    case 'receiver':
      return receiverFlow
    case 'argument':
      return argumentFlows[result.index] ?? emptyValueFlow()
    case 'unknown':
      return {...mergeValueFlows([receiverFlow, ...argumentFlows]), unknownReason: result.reason}
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
    return unknownCallResultFlow(call, target, program, context, unknownCallBodyReason)
  }
  const result = context.resultFor(implementation)
  if (result.kind === 'unknown') {
    return unknownCallResultFlow(call, target, program, context, result.reason)
  }
  const argumentFlows = call.arguments.map(argument =>
    ts.isSpreadElement(argument)
      ? selectValueFlow(expressionValueFlow(argument.expression, program, context))
      : expressionValueFlow(argument, program, context))
  const firstSpreadIndex = call.arguments.findIndex(ts.isSpreadElement)
  const flowForArgument = (index: number) => parameterSourceFlow(
    implementation.node.parameters[index],
    index,
    argumentFlows,
    firstSpreadIndex < 0 ? null : firstSpreadIndex,
  )
  switch (result.kind) {
    case 'none':
      return emptyValueFlow()
    case 'fresh':
      return freshResultFlow(argumentFlows)
    case 'arguments':
      return mergeValueFlows(result.indexes.map(flowForArgument))
    case 'outer':
      return {
        references: result.bindings.map(binding => ({
          binding: binding.key,
          selections: 0,
          containers: 0,
        })),
        unknownReason: null,
      }
  }
}

function unknownCallResultFlow(
  call: ts.CallExpression,
  target: ts.Expression,
  program: Program,
  context: ValueFlowContext,
  reason: string,
): ValueFlow {
  const inputs: ValueFlow[] = []
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    inputs.push(expressionValueFlow(target.expression, program, context))
  }
  for (const argument of call.arguments) {
    inputs.push(expressionValueFlow(
      ts.isSpreadElement(argument) ? argument.expression : argument,
      program,
      context,
    ))
  }
  return {...mergeValueFlows(inputs), unknownReason: reason}
}

function freshResultFlow(inputs: readonly ValueFlow[]): ValueFlow {
  const retainedInputs = wrapValueFlow(mergeValueFlows(inputs), 1)
  return mergeValueFlows([
    retainedInputs,
    {
      references: [{binding: opaqueFreshResult, selections: 0, containers: 0}],
      unknownReason: null,
    },
  ])
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
      references: [{binding: allocation, selections: 0, containers: 0}],
      unknownReason: null,
    },
  ])
}

function parameterSourceFlow(
  parameter: ts.ParameterDeclaration | undefined,
  index: number,
  argumentFlows: readonly ValueFlow[],
  firstSpreadIndex: number | null = null,
): ValueFlow {
  if (parameter?.dotDotDotToken == null) {
    if (firstSpreadIndex != null && index >= firstSpreadIndex) {
      return mergeValueFlows(argumentFlows.slice(firstSpreadIndex))
    }
    return argumentFlows[index] ?? emptyValueFlow()
  }
  return mergeValueFlows(argumentFlows.slice(
    firstSpreadIndex == null ? index : Math.min(index, firstSpreadIndex),
  ))
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
  }
}

function composeValueReferences(base: ValueReference, next: ValueReference): ValueReference {
  const selectedBase = selectValueReference(base, next.selections)
  return {
    binding: base.binding,
    selections: selectedBase.selections,
    containers: selectedBase.containers + next.containers,
  }
}

function addValueReference(target: ValueReference[], reference: ValueReference) {
  if (!target.some(existing =>
    existing.binding === reference.binding
    && existing.selections === reference.selections
    && existing.containers === reference.containers)) {
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
    const reason = referenceUnknownReason(reference, scope, new Set())
    if (reason != null) return reason
  }
  return null
}

function referenceUnknownReason(
  reference: ValueReference,
  scope: Scope,
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
  for (const source of scope.references.get(reference.binding) ?? []) {
    const reason = referenceUnknownReason(
      composeValueReferences(source, reference),
      scope,
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

function pathDepth(expression: ts.Expression): number {
  const current = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return 1 + pathDepth(current.expression)
  }
  return 0
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
  unknownReason: (binding: BindingKey) => string | null
  referenceUnknownReason: (reference: ValueReference) => string | null
}

function makeClassifiers(scope: Scope, program: Program, at: ts.Node): Classifiers {
  const environment = scope.environments.get(at)
  const definitionsFor = (binding: BindingKey): readonly BindingKey[] =>
    environment?.get(binding) ?? [binding]
  const classifyDirect = (binding: BindingKey, includeContained: boolean): RootKind[] => {
    const roots: RootKind[] = []
    for (const definition of definitionsFor(binding)) {
      const references = bindingFunctionReferences(
        {binding: definition, selections: 0, containers: 0},
        scope,
        program,
        new Set(),
      )
      for (const reference of references) {
        if (!includeContained && reference.containers > 0) continue
        if (reference.source.kind === 'fresh') continue
        if (!roots.some(root => sameRoot(root, reference.source))) roots.push(reference.source)
      }
    }
    return roots
  }
  const unknownReasonFor = (reference: ValueReference): string | null => {
    for (const definition of definitionsFor(reference.binding)) {
      const reason = referenceUnknownReason(
        {...reference, binding: definition},
        scope,
        new Set(),
      )
      if (reason != null) return reason
    }
    return null
  }
  return {
    container: binding => classifyDirect(binding, false),
    reach: binding => classifyDirect(binding, true),
    unknownReason: binding => unknownReasonFor(
      {binding, selections: 0, containers: 0},
    ),
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
    throw new Error(`Local allocation escaped purity analysis: ${key.expression.getText()}`)
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
  if (isWriteOnlyAssignmentBinding(id)) return null
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
  let classifiers = makeClassifiers(scope, program, node)
  const addMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.certain, roots)
  }
  const addUncertainMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.uncertain, roots)
  }
  const addRetained = (roots: RootKind[]) => {
    addMutationRoots(member.effects.retained, roots)
  }
  const addUnknownCall = (reason = unknownCallBodyReason) => {
    member.effects.unknownCallReasons.add(reason)
  }
  const addUnsupportedMutableFunctionBinding = (target: ts.Expression) => {
    if (!ts.isIdentifier(target)) return
    const reason = mutableFunctionBindingReason(target, program)
    if (reason != null) member.effects.boundaryUnknownReasons.add(reason)
  }
  const addClassifiedMutation = (classification: ClassifiedRoots) => {
    if (classification.unknownReason == null) {
      addMutation(classification.roots)
      return
    }
    addUncertainMutation(classification.roots)
    addUnknownCall(classification.unknownReason)
  }
  const classifyExpressionRoots = (expression: ts.Expression): ClassifiedRoots =>
    classifyValueFlow(expressionValueFlow(expression, program, valueFlowContext), classifiers, true)
  const classifyExpressionContainerRoots = (expression: ts.Expression): ClassifiedRoots =>
    classifyValueFlow(expressionValueFlow(expression, program, valueFlowContext), classifiers, false)
  const addResolvedEdge = (
    callee: FunctionImplementationRef,
    arguments_: readonly ts.Expression[],
    receiverRoots: ClassifiedRoots,
  ) => {
    const edgeClassifiers = classifiers
    member.edges.push({
      callee,
      argumentRoots: arguments_.map(argument =>
        ts.isSpreadElement(argument)
          ? null
          : expressionHasMutableType(argument, program)
            ? {
                container: classifyExpressionContainerRoots(argument),
                reach: classifyExpressionRoots(argument),
              }
            : {container: emptyClassifiedRoots(), reach: emptyClassifiedRoots()}),
      receiverRoots,
      classifyBindingContainer: edgeClassifiers.container,
      classifyBindingReach: edgeClassifiers.reach,
    })
  }
  const addCallbackEdge = (
    call: ts.CallExpression,
    callback: PlatformCallbackEffect,
    rootsForSource: (source: PlatformValueSource) => ClassifiedRoots,
  ) => {
    const argument = call.arguments[callback.argumentIndex]
    if (argument == null) return
    const resolved = resolveCallTarget(unwrapExpression(argument), program)
    const fn = callTargetImplementation(resolved)
    if (fn == null) {
      if (resolved.kind === 'platform-global') {
        const classification = classifyPlatformGlobalCall(resolved.base, resolved.name, 0)
        if (classification.kind !== 'supported') {
          addUnknownCall(classification.kind === 'unsupported' ? classification.reason : undefined)
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
    const edgeClassifiers = classifiers
    member.edges.push({
      callee: fn,
      argumentRoots: callback.parameterSources.map(sources => {
        const roots = mergeClassifiedRoots(sources.map(rootsForSource))
        return {container: roots, reach: roots}
      }),
      receiverRoots: inlineArrow
        ? emptyClassifiedRoots()
        : callback.thisArgumentIndex == null
          ? emptyClassifiedRoots()
          : rootsForSource({kind: 'argument', index: callback.thisArgumentIndex}),
      classifyBindingContainer: edgeClassifiers.container,
      classifyBindingReach: edgeClassifiers.reach,
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
      const argument = call.arguments[index]
      if (argument != null && !ts.isSpreadElement(argument)) {
        addClassifiedMutation(classifyExpressionRoots(argument))
      }
    }
    const retained = retainedArgumentIndexes(effect, call.arguments.length)
    if (receiverContainerRoots.roots.length > 0 || receiverContainerRoots.unknownReason != null) {
      for (const index of retained) {
        const argument = call.arguments[index]
        if (argument != null && !ts.isSpreadElement(argument)) {
          const retainedRoots = classifyExpressionRoots(argument)
          if (retainedRoots.roots.length > 0 || retainedRoots.unknownReason != null) {
            addRetained(retainedRoots.roots)
            addUnknownCall(
              'storing an existing object or array through a helper parameter is unsupported',
            )
          }
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
    if (!scope.environments.has(current)) {
      ts.forEachChild(current, visit)
      return
    }
    classifiers = makeClassifiers(scope, program, current)
    if (ts.isThrowStatement(current)) member.effects.throws = true
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
      for (const binding of reassignedOuterBindings(current.left, classifiers, program)) {
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
      if (
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
        && expressionHasMutableType(current.right, program)
        && !targetRoots.roots.some(root => root.kind === 'param' || root.kind === 'outer')
      ) {
        const base = pathWriteBaseBinding(target.expression, program)
        const reachableRoots = base == null
          ? classifyExpressionRoots(target.expression).roots
          : classifiers.reach(base)
        if (
          reachableRoots.some(root => root.kind === 'param')
          && !reachableRoots.some(root => root.kind === 'outer')
        ) {
          member.effects.boundaryUnknownReasons.add(
            'replacing an object or array inside a local container that also contains an argument is unsupported',
          )
        }
      }
      addClassifiedMutation(targetRoots)
      // Storing a reference in caller-visible state is not itself a mutation of
      // that reference. Keep the possible escape separate from the definite
      // mutation of the destination.
      if (targetRoots.roots.length > 0 || targetRoots.unknownReason != null) {
        const retainedRoots = classifyExpressionRoots(current.right)
        if (retainedRoots.roots.length > 0 || retainedRoots.unknownReason != null) {
          addRetained(retainedRoots.roots)
          addUnknownCall(
            'storing an existing object or array in a parameter or outside container is unsupported',
          )
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
          addUnknownCall(classification.kind === 'unsupported' ? classification.reason : undefined)
        } else {
          applyPlatformCallEffect(call, classification.effect, emptyClassifiedRoots(), source => {
            if (source.kind !== 'argument') return emptyClassifiedRoots()
            const argument = call.arguments[source.index]
            return argument == null || ts.isSpreadElement(argument)
              ? emptyClassifiedRoots()
              : classifyExpressionRoots(argument)
          })
        }
        return
      }
      const resolved = resolveCallTarget(target, program)
      const implementation = callTargetImplementation(resolved)
      if (implementation != null) {
        addResolvedEdge(implementation, call.arguments, emptyClassifiedRoots())
        return
      }
      if (resolved.kind === 'platform-global') {
        const classification = classifyPlatformGlobalCall(resolved.base, resolved.name, call.arguments.length)
        if (classification.kind !== 'supported') {
          addUnknownCall(classification.kind === 'unsupported' ? classification.reason : undefined)
        } else {
          applyPlatformCallEffect(call, classification.effect, emptyClassifiedRoots(), source => {
            if (source.kind !== 'argument') return emptyClassifiedRoots()
            const argument = call.arguments[source.index]
            return argument == null || ts.isSpreadElement(argument)
              ? emptyClassifiedRoots()
              : classifyExpressionRoots(argument)
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
        addUnknownCall(classification.kind === 'unsupported' ? classification.reason : undefined)
      } else {
        applyPlatformCallEffect(call, classification.effect, receiverContainerRoots, source => {
          switch (source.kind) {
            case 'receiver':
              return receiverContainerRoots
            case 'receiver-elements':
              return receiverElementRoots
            case 'argument': {
              const argument = call.arguments[source.index]
              return argument == null || ts.isSpreadElement(argument)
                ? emptyClassifiedRoots()
                : classifyExpressionRoots(argument)
            }
          }
        })
      }
      return
    }
    const resolved = resolveCallTarget(target, program)
    const implementation = callTargetImplementation(resolved)
    if (implementation != null) {
      addResolvedEdge(implementation, call.arguments, emptyClassifiedRoots())
      return
    }
    if (resolved.kind === 'platform-global') {
      const classification = classifyPlatformGlobalCall(resolved.base, resolved.name, call.arguments.length)
      if (classification.kind !== 'supported') {
        addUnknownCall(classification.kind === 'unsupported' ? classification.reason : undefined)
      } else {
        applyPlatformCallEffect(call, classification.effect, emptyClassifiedRoots(), source => {
          if (source.kind !== 'argument') return emptyClassifiedRoots()
          const argument = call.arguments[source.index]
          return argument == null || ts.isSpreadElement(argument)
            ? emptyClassifiedRoots()
            : classifyExpressionRoots(argument)
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
    unknownReason ??= classifiers.referenceUnknownReason(reference)
    if (!includeContained && reference.containers > 0) continue
    const candidates = !includeContained && reference.containers === 0 && reference.selections === 0
      ? classifiers.container(reference.binding)
      : classifiers.reach(reference.binding)
    for (const original of candidates) {
      const candidate = reference.selections > 0 ? containedRoot(original) : original
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
      roots.push(...(context.definitionsFor?.(current) ?? [bindingKey(current, program)]))
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
