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
  classifyPlatformGlobalCall,
  classifyPlatformMethodCall,
  isPlatformGlobalNamespace,
  retainedArgumentIndexes,
  type PlatformCallbackEffect,
  type PlatformCallEffect,
  type PlatformResultEffect,
  type PlatformResultSource,
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
type BindingKey = ts.Symbol | string

type OuterBinding = {
  key: BindingKey
  sourceId: string
  root: string
}

type RootKind =
  | {kind: 'param'; index: number}
  | {kind: 'outer'; binding: OuterBinding}
  | {kind: 'this'}

// A returned reference is described without property names or array slots.
// `selections` counts property/element reads into the source. `containers`
// counts object/array layers still wrapped around it. A later selection first
// consumes a container layer; only then can it reach the source.
type FunctionResultReference = {
  source: RootKind
  selections: number
  containers: number
}

type FunctionResult =
  | {
      kind: 'known'
      references: FunctionResultReference[]
    }
  | {kind: 'unknown'; reason: string}

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
  // so it could do anything and the function cannot be proved pure. Keep the
  // reasons so deliberate platform boundaries survive through helper calls.
  unknownCallReasons: Set<string>
  // Where mutable references in the returned value come from. This is part of
  // the function summary so ordinary helpers and callbacks cross the same call
  // boundary instead of callbacks receiving a separate body inspection.
  result: FunctionResult
}

const unknownCallBodyReason = 'calls a function whose body cannot be analyzed'
const unknownReturnReason = 'cannot analyze returned references'
const recursiveReturnReason = 'recursive returned references keep adding container layers'

const noMutationTargets = (): MutationTargets => ({
  outerBindings: new Map(),
  paramIndexes: new Set(),
  thisValue: false,
})

const unknownFunctionResult = (reason = unknownReturnReason): FunctionResult => ({
  kind: 'unknown',
  reason,
})

const emptyFunctionResult = (): FunctionResult => ({kind: 'known', references: []})

const noEffects = (result: FunctionResult = emptyFunctionResult()): FunctionEffects => ({
  mutations: {
    certain: noMutationTargets(),
    uncertain: noMutationTargets(),
  },
  mutableOuterReads: new Map(),
  observesEnvironment: false,
  unknownCallReasons: new Set(),
  result,
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
  const unknownCallReason = effects.unknownCallReasons.values().next().value
  if (unknownCallReason != null) return {kind: 'unknown', reason: unknownCallReason}
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

type CallEdge = {
  callee: FunctionImplementationRef
  // classified roots per caller argument position; `null` marks a spread
  // argument whose positions cannot be mapped
  argumentRoots: (ClassifiedRoots | null)[]
  receiverRoots: ClassifiedRoots
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
  collectMemberGraph(implementation, members)
  solveFunctionResults(members)
  for (const programMembers of members.values()) {
    for (const member of programMembers.values()) analyzeMemberEffects(member, members)
  }
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
  const addMapped = (mapping: ClassifiedRoots, certain: boolean) => {
    if (mapping.unknownReason != null) {
      if (!into.unknownCallReasons.has(mapping.unknownReason)) {
        into.unknownCallReasons.add(mapping.unknownReason)
        changed = true
      }
      add(into.mutations.uncertain, mapping.roots)
      return
    }
    add(certain ? into.mutations.certain : into.mutations.uncertain, mapping.roots)
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
  for (const reason of callee.unknownCallReasons) {
    if (!into.unknownCallReasons.has(reason)) {
      into.unknownCallReasons.add(reason)
      changed = true
    }
  }
  if (callee.mutations.certain.thisValue) addMapped(edge.receiverRoots, true)
  if (callee.mutations.certain.paramIndexes.size > 0) {
    const hasSpread = edge.argumentRoots.some(roots => roots == null)
    for (const index of callee.mutations.certain.paramIndexes) {
      const rest = edge.callee.node.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) {
          if (roots != null) addMapped(roots, true)
        }
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) {
          if (roots != null) addMapped(roots, true)
        }
      } else {
        const roots = edge.argumentRoots[index]
        if (roots != null) addMapped(roots, true)
      }
    }
  }
  if (callee.mutations.uncertain.thisValue) addMapped(edge.receiverRoots, false)
  if (callee.mutations.uncertain.paramIndexes.size > 0) {
    const hasSpread = edge.argumentRoots.some(roots => roots == null)
    for (const index of callee.mutations.uncertain.paramIndexes) {
      const rest = edge.callee.node.parameters[index]?.dotDotDotToken != null
      if (hasSpread) {
        for (const roots of edge.argumentRoots) {
          if (roots != null) addMapped(roots, false)
        }
      } else if (rest) {
        for (const roots of edge.argumentRoots.slice(index)) {
          if (roots != null) addMapped(roots, false)
        }
      } else {
        const roots = edge.argumentRoots[index]
        if (roots != null) addMapped(roots, false)
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

function collectMemberGraph(implementation: FunctionImplementationRef, members: MemberIndex) {
  if (indexedMember(members, implementation) != null || cachedFunctionEffects(implementation) != null) return
  const member: MemberInfo = {
    implementation,
    effects: noEffects(),
    edges: [],
  }
  indexMember(members, member)
  const {node, program} = implementation
  const visit = (current: ts.Node) => {
    if (current !== node && isFunctionImplementation(current)) return
    if (ts.isCallExpression(current)) {
      const target = unwrapExpression(current.expression)
      if (ts.isPropertyAccessExpression(target) && isDefaultLibraryMemberAccess(target, program)) {
        const base = unwrapExpression(target.expression)
        const global = ts.isIdentifier(base) && isDefaultLibrarySymbol(base, program)
        const classification = global
          ? classifyPlatformGlobalCall(base.text, target.name.text, current.arguments.length)
          : classifyPlatformMethodCall(
            defaultLibraryOwner(target, program),
            target.name.text,
            current.arguments.length,
          )
        if (classification.kind === 'supported') {
          for (const callback of classification.effect.callbacks) {
            const argument = current.arguments[callback.argumentIndex]
            if (argument == null) continue
            const callbackFunction = functionValuedArgument(argument, program)
            if (callbackFunction != null) collectMemberGraph(callbackFunction, members)
          }
        }
      } else {
        const resolved = resolveCallTarget(target, program)
        if (resolved.kind === 'function') {
          collectMemberGraph(
            functionImplementationReference(resolved.program, resolved.fn.node),
            members,
          )
        }
      }
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(node, visit)
}

function solveFunctionResults(members: MemberIndex) {
  const memberList = [...members.values()].flatMap(programMembers => [...programMembers.values()])
  // Empty known results are the starting point. Each pass can only add
  // relationships or change a result to unknown. An acyclic dependency path
  // crosses at most every member once, so a later change means recursion keeps
  // increasing a selection or container count.
  for (let round = 0; round < memberList.length; round += 1) {
    let changed = false
    for (const member of memberList) {
      const result = analyzeFunctionResult(member.implementation, members)
      if (sameFunctionResult(result, member.effects.result)) continue
      member.effects.result = result
      changed = true
    }
    if (!changed) return
  }

  const recursiveGrowth: MemberInfo[] = []
  for (const member of memberList) {
    const result = analyzeFunctionResult(member.implementation, members)
    if (!sameFunctionResult(result, member.effects.result)) recursiveGrowth.push(member)
  }
  if (recursiveGrowth.length === 0) return
  for (const member of recursiveGrowth) {
    member.effects.result = unknownFunctionResult(recursiveReturnReason)
  }

  for (let round = 0; round <= memberList.length; round += 1) {
    let changed = false
    for (const member of memberList) {
      const result = analyzeFunctionResult(member.implementation, members)
      if (sameFunctionResult(result, member.effects.result)) continue
      member.effects.result = result
      changed = true
    }
    if (!changed) return
  }
  throw new Error('Function result summaries did not settle after recursive growth became unknown')
}

function functionResultFor(
  implementation: FunctionImplementationRef,
  members: MemberIndex,
): FunctionResult {
  return cachedFunctionEffects(implementation)?.result
    ?? indexedMember(members, implementation)?.effects.result
    ?? unknownFunctionResult()
}

function analyzeFunctionResult(
  implementation: FunctionImplementationRef,
  members: MemberIndex,
): FunctionResult {
  const context: ValueFlowContext = {
    resultFor: callee => functionResultFor(callee, members),
  }
  const scope = buildScope(implementation.node, implementation.program, context)
  const returned = returnedExpressions(implementation.node)
  const flow = mergeValueFlows(returned.map(expression =>
    expressionValueFlow(expression, implementation.program, context)))
  const unknownReason = valueFlowUnknownReason(flow, scope)
  if (unknownReason != null) return unknownFunctionResult(unknownReason)
  return valueFlowFunctionResult(flow, scope, implementation.program)
}

function valueFlowFunctionResult(
  flow: ValueFlow,
  scope: Scope,
  program: Program,
): FunctionResult {
  const references: FunctionResultReference[] = []
  for (const reference of flow.references) {
    addResultReferences(
      references,
      bindingFunctionReferences(reference, scope, program, new Set()),
    )
  }
  return {kind: 'known', references}
}

function bindingFunctionReferences(
  reference: ValueReference,
  scope: Scope,
  program: Program,
  seen: Set<BindingKey>,
): FunctionResultReference[] {
  if (seen.has(reference.binding)) return []
  seen.add(reference.binding)

  const references: FunctionResultReference[] = []
  const direct = directRoot(reference.binding, scope, program)
  if (direct != null) {
    references.push({
      source: direct,
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
  if (binding === 'this') return {kind: 'this'}
  const paramIndex = scope.paramIndexByBinding.get(binding)
  if (paramIndex != null) return {kind: 'param', index: paramIndex}
  if (scope.localBindings.has(binding)) return null
  return {kind: 'outer', binding: outerBinding(binding, program)}
}

function addResultReferences(
  target: FunctionResultReference[],
  sources: readonly FunctionResultReference[],
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

function sameFunctionResult(left: FunctionResult, right: FunctionResult): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'unknown' || right.kind === 'unknown') {
    return left.kind === 'unknown' && right.kind === 'unknown' && left.reason === right.reason
  }
  return left.references.length === right.references.length
    && left.references.every(reference => right.references.some(candidate =>
      candidate.selections === reference.selections
      && candidate.containers === reference.containers
      && sameRoot(candidate.source, reference.source)))
}

function sameRoot(left: RootKind, right: RootKind): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'param':
      return right.kind === 'param' && left.index === right.index
    case 'outer':
      return right.kind === 'outer' && left.binding.key === right.binding.key
    case 'this':
      return right.kind === 'this'
  }
}

function analyzeMemberEffects(member: MemberInfo, members: MemberIndex) {
  const {implementation} = member
  const {node, program} = implementation
  const result = member.effects.result
  member.effects = noEffects(result)
  member.edges = []
  const valueFlowContext: ValueFlowContext = {
    resultFor: callee => functionResultFor(callee, members),
  }
  const scope = buildScope(node, program, valueFlowContext)
  const classifiers = makeClassifiers(scope, program)
  collectWrites(implementation, member, classifiers, valueFlowContext)
}

type Scope = {
  paramIndexByBinding: Map<BindingKey, number>
  localBindings: Set<BindingKey>
  references: Map<BindingKey, ValueReference[]>
  unknownReasons: Map<BindingKey, string>
}

type ValueFlowContext = {
  resultFor: (implementation: FunctionImplementationRef) => FunctionResult
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
  const referenceEdges: {target: BindingKey; reference: ValueReference}[] = []
  const unknownReasons = new Map<BindingKey, string>()
  const addValueFlow = (target: BindingKey, flow: ValueFlow) => {
    for (const reference of flow.references) referenceEdges.push({target, reference})
    if (flow.unknownReason != null && !unknownReasons.has(target)) {
      unknownReasons.set(target, flow.unknownReason)
    }
  }
  const addTargetValueFlow = (target: AssignmentTarget, flow: ValueFlow) => {
    if (target.kind === 'binding') {
      addValueFlow(bindingKey(target.identifier, program), flow)
      return
    }
    const base = pathWriteBaseBinding(target.expression, program)
    if (base != null) {
      addValueFlow(base, wrapValueFlow(flow, pathDepth(target.expression)))
    }
  }
  node.parameters.forEach((parameter, index) => {
    const parameterRoot = `parameter:${node.pos}:${index}`
    paramIndexByBinding.set(parameterRoot, index)
    for (const binding of bindingKeys(parameter.name, program)) localBindings.add(binding)
    const parameterFlow: ValueFlow = {
      references: [{
        binding: parameterRoot,
        selections: 0,
        containers: parameter.dotDotDotToken == null ? 0 : 1,
      }],
      unknownReason: null,
    }
    const sourceFlow = parameter.initializer == null
      ? parameterFlow
      : mergeValueFlows([
        parameterFlow,
        expressionValueFlow(parameter.initializer, program, context),
      ])
    for (const {target, flow} of bindingValueFlows(
      parameter.name,
      sourceFlow,
      program,
      context,
    )) {
      addTargetValueFlow(target, flow)
    }
  })
  const visit = (current: ts.Node) => {
    if (ts.isVariableDeclaration(current)) {
      const bindings = bindingKeys(current.name, program)
      for (const binding of bindings) localBindings.add(binding)
      if (current.initializer != null) {
        const sourceFlow = expressionValueFlow(current.initializer, program, context)
        for (const {target, flow} of bindingValueFlows(current.name, sourceFlow, program, context)) {
          addTargetValueFlow(target, flow)
        }
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
    if (
      ts.isBinaryExpression(current)
      && assignmentMayTakeRightValue(current.operatorToken.kind)
    ) {
      const sourceFlow = expressionValueFlow(current.right, program, context)
      for (const {target, flow} of assignmentValueFlows(
        current.left,
        sourceFlow,
        program,
        context,
      )) {
        addTargetValueFlow(target, flow)
      }
    }
    if (ts.isCallExpression(current)) {
      const target = unwrapExpression(current.expression)
      const classification = ts.isPropertyAccessExpression(target) && isDefaultLibraryMemberAccess(target, program)
        ? classifyPlatformMethodCall(
          defaultLibraryOwner(target, program),
          target.name.text,
          current.arguments.length,
        )
        : {kind: 'unrecognized'} as const
      if (ts.isPropertyAccessExpression(target) && classification.kind === 'supported') {
        const base = pathWriteBaseBinding(target.expression, program)
        if (base != null) {
          for (const index of retainedArgumentIndexes(classification.effect, current.arguments.length)) {
            const argument = current.arguments[index]
            if (argument == null) continue
            const expression = ts.isSpreadElement(argument) ? argument.expression : argument
            addValueFlow(
              base,
              wrapValueFlow(expressionValueFlow(expression, program, context), 1),
            )
          }
        }
      }
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(node, visit)

  // Exact aliases are symmetric: if `ys = xs`, writes and retained references
  // discovered through either name belong to the same container.
  const symmetricReferences = [...referenceEdges]
  for (const edge of referenceEdges) {
    if (edge.reference.selections !== 0 || edge.reference.containers !== 0) continue
    symmetricReferences.push({
      target: edge.reference.binding,
      reference: {binding: edge.target, selections: 0, containers: 0},
    })
  }
  return {
    paramIndexByBinding,
    localBindings,
    references: referenceMap(symmetricReferences),
    unknownReasons,
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
    return {
      references: [{binding: bindingKey(current, program), selections: 0, containers: 0}],
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
    return mergeValueFlows(current.elements.map(element => {
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
    return mergeValueFlows(propertyFlows)
  }
  if (ts.isNewExpression(current)) {
    const constructorName = ts.isIdentifier(current.expression) ? current.expression.text : null
    if (
      constructorName != null
      && zeroArgumentCollectionConstructorNames.has(constructorName)
      && isDefaultLibrarySymbol(current.expression, program)
      && (current.arguments?.length ?? 0) === 0
    ) return emptyValueFlow()
    if (
      constructorName === 'Array'
      && isDefaultLibrarySymbol(current.expression, program)
    ) {
      return mergeValueFlows((current.arguments ?? []).map(argument =>
        wrapValueFlow(expressionValueFlow(argument, program, context), 1)))
    }
    if (
      constructorName != null
      && lengthBearingConstructorNames.has(constructorName)
      && isDefaultLibrarySymbol(current.expression, program)
      && (current.arguments ?? []).every(argument => !expressionHasMutableType(argument, program))
    ) return emptyValueFlow()
    const argumentFlows = (current.arguments ?? []).map(argument =>
      wrapValueFlow(expressionValueFlow(argument, program, context), 1))
    return {
      ...mergeValueFlows(argumentFlows),
      unknownReason: 'constructor return references are unsupported',
    }
  }
  if (ts.isCallExpression(current)) {
    const platformFlow = platformCallResultFlow(current, program, context)
    if (platformFlow != null) return platformFlow
    return functionCallResultFlow(current, program, context)
  }
  return {
    references: expressionRootBindings(current, program)
      .map(binding => ({binding, selections: 0, containers: 0})),
    unknownReason: 'returned references from this expression are unsupported',
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
      call.arguments.length,
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
  const flowForValueSource = (source: PlatformValueSource): ValueFlow => {
    switch (source.kind) {
      case 'receiver':
        return receiver == null ? emptyValueFlow() : expressionValueFlow(receiver, program, context)
      case 'receiver-elements':
        return receiver == null
          ? emptyValueFlow()
          : selectValueFlow(expressionValueFlow(receiver, program, context))
      case 'argument': {
        const argument = call.arguments[source.index]
        if (argument == null) return emptyValueFlow()
        return expressionValueFlow(
          ts.isSpreadElement(argument) ? argument.expression : argument,
          program,
          context,
        )
      }
    }
  }
  const flowForResultSource = (source: PlatformResultSource): ValueFlow => {
    switch (source.kind) {
      case 'receiver':
      case 'receiver-elements':
      case 'argument':
        return flowForValueSource(source)
      case 'arguments-from':
        return mergeValueFlows(call.arguments.slice(source.index).map(argument =>
          expressionValueFlow(
            ts.isSpreadElement(argument) ? argument.expression : argument,
            program,
            context,
          )))
      case 'callback-return': {
        const callback = effect.callbacks.find(callback =>
          callback.argumentIndex === source.argumentIndex)
        return callback == null
          ? emptyValueFlow()
          : callbackResultFlow(call, callback, flowForValueSource, program, context)
      }
    }
  }
  return mergeValueFlows(result.references.map(reference =>
    transformValueFlow(
      flowForResultSource(reference.source),
      reference.selections,
      reference.containers,
    )))
}

function functionCallResultFlow(
  call: ts.CallExpression,
  program: Program,
  context: ValueFlowContext,
): ValueFlow {
  const target = unwrapExpression(call.expression)
  const resolved = resolveCallTarget(target, program)
  if (resolved.kind !== 'function') {
    return unknownCallResultFlow(call, target, program, context, unknownCallBodyReason)
  }
  const implementation = functionImplementationReference(resolved.program, resolved.fn.node)
  const result = context.resultFor(implementation)
  if (result.kind === 'unknown') {
    return unknownCallResultFlow(call, target, program, context, result.reason)
  }
  const receiver = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
    ? target.expression
    : null
  const argumentFlows = call.arguments.map(argument =>
    ts.isSpreadElement(argument)
      ? selectValueFlow(expressionValueFlow(argument.expression, program, context))
      : expressionValueFlow(argument, program, context))
  const firstSpreadIndex = call.arguments.findIndex(ts.isSpreadElement)
  return functionResultValueFlow(result, source => {
    switch (source.kind) {
      case 'param':
        return parameterSourceFlow(
          implementation.node.parameters[source.index],
          source.index,
          argumentFlows,
          firstSpreadIndex < 0 ? null : firstSpreadIndex,
        )
      case 'outer':
        return {
          references: [{binding: source.binding.key, selections: 0, containers: 0}],
          unknownReason: null,
        }
      case 'this':
        return receiver == null
          ? unknownValueFlow('cannot map a returned `this` reference')
          : expressionValueFlow(receiver, program, context)
    }
  })
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

function functionResultValueFlow(
  result: Extract<FunctionResult, {kind: 'known'}>,
  flowForSource: (source: RootKind) => ValueFlow,
): ValueFlow {
  return mergeValueFlows(result.references.map(reference =>
    transformValueFlow(
      flowForSource(reference.source),
      reference.selections,
      reference.containers,
    )))
}

function callbackResultFlow(
  call: ts.CallExpression,
  callback: PlatformCallbackEffect,
  flowForValueSource: (source: PlatformValueSource) => ValueFlow,
  callerProgram: Program,
  context: ValueFlowContext,
): ValueFlow {
  const argument = call.arguments[callback.argumentIndex]
  if (argument == null) return unknownValueFlow('callback argument is missing')
  const implementation = functionValuedArgument(argument, callerProgram)
  if (implementation == null) {
    const possibleSources = mergeValueFlows(callback.parameterSources
      .flatMap(sources => sources.map(flowForValueSource)))
    return {
      ...possibleSources,
      unknownReason: unknownCallBodyReason,
    }
  }
  const result = context.resultFor(implementation)
  if (result.kind === 'unknown') {
    const possibleSources = mergeValueFlows(callback.parameterSources
      .flatMap(sources => sources.map(flowForValueSource)))
    return {
      ...possibleSources,
      unknownReason: result.reason,
    }
  }
  const inlineArrow = ts.isArrowFunction(implementation.node)
    && unwrapExpression(argument) === implementation.node
  const parameterFlows = callback.parameterSources.map(sources =>
    mergeValueFlows(sources.map(flowForValueSource)))
  return functionResultValueFlow(result, source => {
    switch (source.kind) {
      case 'param':
        return parameterSourceFlow(
          implementation.node.parameters[source.index],
          source.index,
          parameterFlows,
        )
      case 'outer':
        return {
          references: [{binding: source.binding.key, selections: 0, containers: 0}],
          unknownReason: null,
        }
      case 'this':
        if (ts.isArrowFunction(implementation.node)) {
          return inlineArrow
            ? {
                references: [{binding: 'this', selections: 0, containers: 0}],
                unknownReason: null,
              }
            : unknownValueFlow('cannot map lexical `this` from a referenced arrow callback')
        }
        return callback.thisSource == null
          ? emptyValueFlow()
          : flowForValueSource(callback.thisSource)
    }
  })
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

function unknownValueFlow(reason: string): ValueFlow {
  return {references: [], unknownReason: reason}
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

function transformValueFlow(flow: ValueFlow, selections: number, containers: number): ValueFlow {
  return wrapValueFlow(selectValueFlow(flow, selections), containers)
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
    const reason = bindingUnknownReason(reference.binding, scope, new Set())
    if (reason != null) return reason
  }
  return null
}

function bindingUnknownReason(
  binding: BindingKey,
  scope: Scope,
  seen: Set<BindingKey>,
): string | null {
  if (seen.has(binding)) return null
  seen.add(binding)
  const direct = scope.unknownReasons.get(binding)
  if (direct != null) return direct
  for (const reference of scope.references.get(binding) ?? []) {
    const reason = bindingUnknownReason(reference.binding, scope, seen)
    if (reason != null) return reason
  }
  seen.delete(binding)
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

type Classifier = (binding: BindingKey) => RootKind[]

type Classifiers = {
  // Mutations of the current container, excluding references still behind
  // another object or array.
  container: Classifier
  // Any source reachable after further property or element reads.
  reach: Classifier
  unknownReason: (binding: BindingKey) => string | null
}

function makeClassifiers(scope: Scope, program: Program): Classifiers {
  const classifyDirect = (binding: BindingKey, includeContained: boolean): RootKind[] => {
    const references = bindingFunctionReferences(
      {binding, selections: 0, containers: 0},
      scope,
      program,
      new Set(),
    )
    const roots: RootKind[] = []
    for (const reference of references) {
      if (!includeContained && reference.containers > 0) continue
      if (!roots.some(root => sameRoot(root, reference.source))) roots.push(reference.source)
    }
    return roots
  }
  return {
    container: binding => classifyDirect(binding, false),
    reach: binding => classifyDirect(binding, true),
    unknownReason: binding => bindingUnknownReason(binding, scope, new Set()),
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
  if (isResolvedFunctionCallRead(id, program)) return true
  if (isSafeNamespacePrimitiveRead(id, program)) return true
  const checker = program.typeChecker
  if (checker == null) return false
  let symbol = valueBindingSymbol(id, checker)
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
  if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
    return checker.getPropertyOfType(checker.getTypeAtLocation(access.expression), argument.text)
  }
  return checker.getSymbolAtLocation(argument)
}

function collectWrites(
  implementation: FunctionImplementationRef,
  member: MemberInfo,
  classifiers: Classifiers,
  valueFlowContext: ValueFlowContext,
) {
  const {node, program} = implementation
  const addMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.certain, roots)
  }
  const addUncertainMutation = (roots: RootKind[]) => {
    addMutationRoots(member.effects.mutations.uncertain, roots)
  }
  const addUnknownCall = (reason = unknownCallBodyReason) => {
    member.effects.unknownCallReasons.add(reason)
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
    target: Extract<ReturnType<typeof resolveCallTarget>, {kind: 'function'}>,
    arguments_: readonly ts.Expression[],
    receiverRoots: ClassifiedRoots,
  ) => {
    const callee = functionImplementationReference(target.program, target.fn.node)
    member.edges.push({
      callee,
      argumentRoots: arguments_.map(argument =>
        ts.isSpreadElement(argument)
          ? null
          : expressionHasMutableType(argument, program)
            ? classifyExpressionRoots(argument)
            : emptyClassifiedRoots()),
      receiverRoots,
      classifyBinding: classifiers.reach,
    })
  }
  const addCallbackEdge = (
    call: ts.CallExpression,
    callback: PlatformCallbackEffect,
    rootsForSource: (source: PlatformValueSource) => ClassifiedRoots,
  ) => {
    const argument = call.arguments[callback.argumentIndex]
    if (argument == null) return
    const fn = functionValuedArgument(argument, program)
    if (fn == null) {
      if (expressionMayBeCallable(argument, program)) addUnknownCall()
      return
    }
    const inlineArrow = ts.isArrowFunction(fn.node) && unwrapExpression(argument) === fn.node
    if (ts.isArrowFunction(fn.node) && !inlineArrow && functionUsesThis(fn.node)) {
      addUnknownCall('calls an arrow callback whose lexical `this` cannot be represented')
    }
    member.edges.push({
      callee: fn,
      argumentRoots: callback.parameterSources.map(sources =>
        mergeClassifiedRoots(sources.map(rootsForSource))),
      receiverRoots: inlineArrow
        ? {roots: [{kind: 'this'}], unknownReason: null}
        : callback.thisSource == null ? emptyClassifiedRoots() : rootsForSource(callback.thisSource),
      classifyBinding: classifiers.reach,
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
          addClassifiedMutation(classifyExpressionRoots(argument))
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
      const setter = (ts.isPropertyAccessExpression(target) && propertyAccessHasSourceAccessor(target, 'set', program))
        || (ts.isElementAccessExpression(target) && elementAccessHasSourceAccessor(target, 'set', program))
      const targetRoots = setter
        ? emptyClassifiedRoots()
        : writeTargetRoots(current.left, classifiers, program, valueFlowContext)
      addClassifiedMutation(targetRoots)
      // Writing a value into caller-visible state lets the caller's world reach
      // it later; the value's own roots must be forgotten too (escape).
      if (targetRoots.roots.length > 0 || targetRoots.unknownReason != null) {
        addClassifiedMutation(classifyExpressionRoots(current.right))
      }
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
      if (resolved.kind === 'function') {
        addResolvedEdge(resolved, call.arguments, emptyClassifiedRoots())
        return
      }
      if (resolved.kind === 'math') {
        if (resolved.name === 'random') member.effects.observesEnvironment = true
        return
      }
      const receiverBase = pathWriteBaseBinding(target.expression, program)
      const receiverContainerRoots = receiverBase != null
        ? {
            roots: classifiers.container(receiverBase),
            unknownReason: classifiers.unknownReason(receiverBase),
          }
        : classifyExpressionContainerRoots(target.expression)
      const receiverElementRoots = receiverBase != null
        ? {
            roots: classifiers.reach(receiverBase),
            unknownReason: classifiers.unknownReason(receiverBase),
          }
        : classifyExpressionRoots(target.expression)
      const classification = defaultLibraryMember
        ? classifyPlatformMethodCall(
          defaultLibraryOwner(target, program),
          target.name.text,
          call.arguments.length,
        )
        : {kind: 'unrecognized'} as const
      if (classification.kind !== 'supported') {
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
    if (resolved.kind === 'math') {
      if (resolved.name === 'random') member.effects.observesEnvironment = true
      return
    }
    if (resolved.kind === 'function') {
      addResolvedEdge(resolved, call.arguments, emptyClassifiedRoots())
      return
    }
    // A call we cannot see: every mutable argument may be written or retained,
    // and the callee could do anything (write globals, I/O, nondeterminism).
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
      if (
        name === 'Array'
        || (expression.arguments ?? []).every(argument => !expressionHasMutableType(argument, program))
      ) return
      for (const argument of expression.arguments ?? []) {
        if (expressionHasMutableType(argument, program)) {
          addUncertainMutation(classifyExpressionRoots(argument).roots)
        }
      }
      addUnknownCall('typed array construction from mutable input is unsupported')
      return
    }
    for (const argument of expression.arguments ?? []) {
      if (expressionHasMutableType(argument, program)) {
        addUncertainMutation(classifyExpressionRoots(argument).roots)
      }
    }
    // A user-defined construction includes base constructors, instance field
    // initializers, and dynamic class behavior. Until those execute through one
    // complete model, source-backed and declaration-only classes share the same
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
        current.arguments.length,
      )
      if (classification.kind === 'supported' || target.name.text === 'entries') return true
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

function writeTargetRoots(
  target: ts.Expression,
  classifiers: Classifiers,
  program: Program,
  valueFlowContext: ValueFlowContext,
): ClassifiedRoots {
  const classifications: ClassifiedRoots[] = []
  for (const assignmentTarget of assignmentTargets(target)) {
    if (assignmentTarget.kind === 'binding') {
      // A bare rebind replaces the caller-invisible binding, except for outer
      // roots, whose binding the caller shares.
      const binding = bindingKey(assignmentTarget.identifier, program)
      classifications.push({
        roots: classifiers.container(binding).filter(root => root.kind === 'outer'),
        unknownReason: null,
      })
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
    unknownReason ??= classifiers.unknownReason(reference.binding)
    if (!includeContained && reference.containers > 0) continue
    const candidates = reference.containers === 0 && reference.selections === 0
      ? classifiers.container(reference.binding)
      : classifiers.reach(reference.binding)
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
