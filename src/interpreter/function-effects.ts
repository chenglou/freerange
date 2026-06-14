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
}

const unknownCallBodyReason = 'calls a function whose body cannot be analyzed'
const recursiveCallbackReturnReason = 'cannot analyze a recursive callback return value'

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
  unknownCallReasons: new Set(),
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
  for (const reason of callee.unknownCallReasons) {
    if (!into.unknownCallReasons.has(reason)) {
      into.unknownCallReasons.add(reason)
      changed = true
    }
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
  const valueFlowContext: ValueFlowContext = {
    activeCallbackReturns: new Set(),
    encounteredRecursiveCallbackReturn: false,
  }
  const scope = buildScope(node, program, valueFlowContext)
  const classifiers = makeClassifiers(scope, program)
  collectWrites(implementation, member, classifiers, members, valueFlowContext)
  if (valueFlowContext.encounteredRecursiveCallbackReturn) {
    member.effects.unknownCallReasons.add(recursiveCallbackReturnReason)
  }
}

type Scope = {
  paramIndexByBinding: Map<BindingKey, number>
  localBindings: Set<BindingKey>
  // ys = xs: ys IS the same container; mutating ys mutates xs.
  containerSources: Map<BindingKey, Set<BindingKey>>
  // item = xs[0]: item aliases something reachable from xs, but xs does not
  // alias item.
  reachableAliasSources: Map<BindingKey, Set<BindingKey>>
  // ys.push(box), obj.field = box: box is reachable FROM the container; only a
  // later write through the container can hit it, mutating the container's own
  // shape (push, sort) cannot.
  reachableSources: Map<BindingKey, Set<BindingKey>>
}

type ValueFlowContext = {
  activeCallbackReturns: Set<FunctionImplementationNode>
  encounteredRecursiveCallbackReturn: boolean
}

type ValueAlias = {
  binding: BindingKey
  relation: 'same' | 'reachable'
}

type ValueFlow = {
  aliases: ValueAlias[]
  retainedRoots: BindingKey[]
}

function buildScope(
  node: FunctionImplementationNode,
  program: Program,
  context: ValueFlowContext,
): Scope {
  const paramIndexByBinding = new Map<BindingKey, number>()
  node.parameters.forEach((parameter, index) => {
    for (const binding of bindingKeys(parameter.name, program)) paramIndexByBinding.set(binding, index)
  })
  const localBindings = new Set<BindingKey>()
  const containerEdges: {target: BindingKey; sourceRoots: BindingKey[]}[] = []
  const reachableAliasEdges: {target: BindingKey; sourceRoots: BindingKey[]}[] = []
  const reachableEdges: {target: BindingKey; sourceRoots: BindingKey[]}[] = []
  const addValueFlow = (target: BindingKey, flow: ValueFlow) => {
    containerEdges.push({
      target,
      sourceRoots: flow.aliases
        .filter(alias => alias.relation === 'same')
        .map(alias => alias.binding),
    })
    reachableAliasEdges.push({
      target,
      sourceRoots: flow.aliases
        .filter(alias => alias.relation === 'reachable')
        .map(alias => alias.binding),
    })
    reachableEdges.push({target, sourceRoots: flow.retainedRoots})
  }
  const addTargetValueFlow = (target: AssignmentTarget, flow: ValueFlow) => {
    if (target.kind === 'binding') {
      addValueFlow(bindingKey(target.identifier, program), flow)
      return
    }
    const base = pathWriteBaseBinding(target.expression, program)
    if (base != null) {
      reachableEdges.push({target: base, sourceRoots: allReachableRoots(flow)})
    }
  }
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
            reachableEdges.push({
              target: base,
              sourceRoots: allReachableRoots(expressionValueFlow(expression, program, context)),
            })
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
    containerSources: sourceMap(symmetricContainerEdges),
    reachableAliasSources: sourceMap(reachableAliasEdges),
    reachableSources: sourceMap(reachableEdges),
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
      ? reachableAliasFlow(sourceFlow)
      : freshContainerFlow(sourceFlow)
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
        const selected = reachableAliasFlow(sourceFlow)
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
          reachableAliasFlow(sourceFlow),
          program,
          context,
        )
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentValueFlows(
          property.expression,
          freshContainerFlow(sourceFlow),
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
          freshContainerFlow(sourceFlow),
          program,
          context,
        )
      }
      return assignmentValueFlows(
        element,
        reachableAliasFlow(sourceFlow),
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
    return {aliases: [{binding: bindingKey(current, program), relation: 'same'}], retainedRoots: []}
  }
  if (current.kind === ts.SyntaxKind.ThisKeyword) {
    return {aliases: [{binding: 'this', relation: 'same'}], retainedRoots: []}
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return reachableAliasFlow(expressionValueFlow(current.expression, program, context))
  }
  if (ts.isArrayLiteralExpression(current)) {
    return {
      aliases: [],
      retainedRoots: current.elements.flatMap(element =>
        allReachableRoots(expressionValueFlow(
          ts.isSpreadElement(element) ? element.expression : element,
          program,
          context,
        ))),
    }
  }
  if (ts.isObjectLiteralExpression(current)) {
    return {
      aliases: [],
      retainedRoots: current.properties.flatMap(property => {
        if (ts.isSpreadAssignment(property)) {
          return allReachableRoots(expressionValueFlow(property.expression, program, context))
        }
        if (ts.isShorthandPropertyAssignment(property)) return [bindingKey(property.name, program)]
        if (ts.isPropertyAssignment(property)) {
          return allReachableRoots(expressionValueFlow(property.initializer, program, context))
        }
        return []
      }),
    }
  }
  if (ts.isNewExpression(current)) {
    return {
      aliases: [],
      retainedRoots: (current.arguments ?? []).flatMap(argument =>
        allReachableRoots(expressionValueFlow(argument, program, context))),
    }
  }
  if (ts.isCallExpression(current)) {
    const platformFlow = platformCallResultFlow(current, program, context)
    if (platformFlow != null) return platformFlow
  }
  return {
    aliases: expressionRootBindings(current, program)
      .map(binding => ({binding, relation: 'reachable'})),
    retainedRoots: [],
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
          : reachableAliasFlow(expressionValueFlow(receiver, program, context))
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
          : callbackReturnFlow(call, callback, flowForValueSource, program, context)
      }
    }
  }
  const aliasFlow = mergeValueFlows(result.aliases.map(flowForResultSource))
  const retainedFlow = mergeValueFlows(result.retains.map(flowForResultSource))
  return {
    aliases: aliasFlow.aliases,
    retainedRoots: [
      ...aliasFlow.retainedRoots,
      ...allReachableRoots(retainedFlow),
    ],
  }
}

function callbackReturnFlow(
  call: ts.CallExpression,
  callback: PlatformCallbackEffect,
  flowForValueSource: (source: PlatformValueSource) => ValueFlow,
  callerProgram: Program,
  context: ValueFlowContext,
): ValueFlow {
  const argument = call.arguments[callback.argumentIndex]
  if (argument == null) return emptyValueFlow()
  const implementation = functionValuedArgument(argument, callerProgram)
  if (implementation == null) return emptyValueFlow()
  const lexicalThisFlow = ts.isArrowFunction(implementation.node)
    && unwrapExpression(argument) === implementation.node
    ? {aliases: [{binding: 'this', relation: 'same'}] satisfies ValueAlias[], retainedRoots: []}
    : null
  if (context.activeCallbackReturns.has(implementation.node)) {
    context.encounteredRecursiveCallbackReturn = true
    return mergeValueFlows(callback.parameterSources
      .flatMap(sources => sources.map(flowForValueSource))
      .map(reachableAliasFlow))
  }
  context.activeCallbackReturns.add(implementation.node)
  try {
    const scope = buildScope(implementation.node, implementation.program, context)
    const classifiers = makeClassifiers(scope, implementation.program)
    const returnedFlows: ValueFlow[] = []
    for (const expression of returnedExpressions(implementation.node)) {
      const flow = expressionValueFlow(expression, implementation.program, context)
      const aliasFlow = mergeValueFlows(flow.aliases.map(alias =>
        callbackRootFlows(
          alias.relation === 'same'
            ? classifiers.container(alias.binding)
            : classifiers.reach(alias.binding),
          callback,
          flowForValueSource,
          lexicalThisFlow,
        )))
      const aliasContents = mergeValueFlows(flow.aliases.map(alias =>
        callbackRootFlows(
          classifiers.reach(alias.binding),
          callback,
          flowForValueSource,
          lexicalThisFlow,
        )))
      returnedFlows.push({
        aliases: aliasFlow.aliases,
        retainedRoots: [
          ...aliasFlow.retainedRoots,
          ...allReachableRoots(aliasContents),
          ...flow.retainedRoots.flatMap(root =>
            allReachableRoots(callbackRootFlows(
              classifiers.reach(root),
              callback,
              flowForValueSource,
              lexicalThisFlow,
            ))),
        ],
      })
    }
    return mergeValueFlows(returnedFlows)
  } finally {
    context.activeCallbackReturns.delete(implementation.node)
  }
}

function callbackRootFlows(
  roots: RootKind[],
  callback: PlatformCallbackEffect,
  flowForValueSource: (source: PlatformValueSource) => ValueFlow,
  lexicalThisFlow: ValueFlow | null,
): ValueFlow {
  return mergeValueFlows(roots.flatMap(root => {
    switch (root.kind) {
      case 'param':
        return (callback.parameterSources[root.index] ?? []).map(flowForValueSource)
      case 'outer':
        return [{
          aliases: [{binding: root.binding.key, relation: 'same'}] satisfies ValueAlias[],
          retainedRoots: [],
        }]
      case 'this':
        if (lexicalThisFlow != null) return [lexicalThisFlow]
        return callback.thisSource == null ? [] : [flowForValueSource(callback.thisSource)]
    }
  }))
}

function emptyValueFlow(): ValueFlow {
  return {aliases: [], retainedRoots: []}
}

function mergeValueFlows(flows: readonly ValueFlow[]): ValueFlow {
  const aliases = new Map<BindingKey, Set<ValueAlias['relation']>>()
  const retainedRoots = new Set<BindingKey>()
  for (const flow of flows) {
    for (const alias of flow.aliases) {
      let relations = aliases.get(alias.binding)
      if (relations == null) {
        relations = new Set()
        aliases.set(alias.binding, relations)
      }
      relations.add(alias.relation)
    }
    for (const root of flow.retainedRoots) retainedRoots.add(root)
  }
  return {
    aliases: [...aliases].flatMap(([binding, relations]) =>
      [...relations].map(relation => ({binding, relation}))),
    retainedRoots: [...retainedRoots],
  }
}

function reachableAliasFlow(flow: ValueFlow): ValueFlow {
  return {
    aliases: allReachableRoots(flow).map(binding => ({binding, relation: 'reachable'})),
    retainedRoots: [],
  }
}

function freshContainerFlow(flow: ValueFlow): ValueFlow {
  return {aliases: [], retainedRoots: allReachableRoots(flow)}
}

function allReachableRoots(flow: ValueFlow): BindingKey[] {
  return [...new Set([
    ...flow.aliases.map(alias => alias.binding),
    ...flow.retainedRoots,
  ])]
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

function sourceMap(edges: {target: BindingKey; sourceRoots: BindingKey[]}[]): Map<BindingKey, Set<BindingKey>> {
  const sources = new Map<BindingKey, Set<BindingKey>>()
  for (const {target, sourceRoots} of edges) {
    if (sourceRoots.length === 0) continue
    let targetSources = sources.get(target)
    if (targetSources == null) {
      targetSources = new Set()
      sources.set(target, targetSources)
    }
    for (const root of sourceRoots) {
      if (root !== target) {
        targetSources.add(root)
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
  // mutations of the container itself: the root plus everything it container-aliases
  container: Classifier
  // writes through the container: additionally everything retained inside it
  reach: Classifier
}

function makeClassifiers(scope: Scope, program: Program): Classifiers {
  const classifyDirect = (
    binding: BindingKey,
    seen: Map<BindingKey, boolean>,
    includeReachable: boolean,
  ): RootKind[] => {
    if (seen.has(binding)) {
      const previouslyIncludedReachable = seen.get(binding)!
      if (previouslyIncludedReachable || !includeReachable) return []
    }
    seen.set(binding, includeReachable)
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
    ]
    for (const source of sources) {
      result.push(...classifyDirect(source, seen, includeReachable))
    }
    for (const source of scope.reachableAliasSources.get(binding) ?? []) {
      result.push(...classifyDirect(source, seen, true))
    }
    if (includeReachable) {
      for (const source of scope.reachableSources.get(binding) ?? []) {
        result.push(...classifyDirect(source, seen, true))
      }
    }
    return result
  }
  return {
    container: binding => classifyDirect(binding, new Map(), false),
    reach: binding => classifyDirect(binding, new Map(), true),
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
  const classifyExpressionRoots = (expression: ts.Expression): RootKind[] =>
    classifyValueFlow(expressionValueFlow(expression, program, valueFlowContext), classifiers, true)
  const classifyExpressionContainerRoots = (expression: ts.Expression): RootKind[] =>
    classifyValueFlow(expressionValueFlow(expression, program, valueFlowContext), classifiers, false)
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
      if (expressionMayBeCallable(argument, program)) addUnknownCall()
      return
    }
    const inlineArrow = ts.isArrowFunction(fn.node) && unwrapExpression(argument) === fn.node
    if (ts.isArrowFunction(fn.node) && !inlineArrow && functionUsesThis(fn.node)) {
      addUnknownCall('calls an arrow callback whose lexical `this` cannot be represented')
    }
    member.edges.push({
      callee: fn,
      argumentRoots: callback.parameterSources.map(sources => sources.flatMap(rootsForSource)),
      receiverRoots: inlineArrow
        ? [{kind: 'this'}]
        : callback.thisSource == null ? [] : rootsForSource(callback.thisSource),
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

  for (const parameter of node.parameters) {
    if (bindingNameHasNestedPattern(parameter.name)) {
      addUnknownCall('nested destructuring is unsupported because selected values need separate reference tracking')
    }
    if (
      ts.isArrayBindingPattern(parameter.name)
      && !isKnownBuiltInIterableTypeAtLocation(parameter.name, program)
    ) {
      addUnknownCall('array destructuring is unsupported because its iterator can run user code')
    }
    if (
      ts.isObjectBindingPattern(parameter.name)
      && bindingPatternTypeAtLocationMayReadAccessor(parameter.name, program)
    ) {
      addUnknownCall('object destructuring is unsupported because reading a property can call a getter')
    }
  }

  const visit = (current: ts.Node) => {
    if (isFunctionImplementation(current)) return
    if (
      ts.isVariableDeclaration(current)
      && bindingNameHasNestedPattern(current.name)
    ) {
      addUnknownCall('nested destructuring is unsupported because selected values need separate reference tracking')
    }
    if (ts.isSpreadElement(current) && !isKnownBuiltInIterable(current.expression, program)) {
      addUnknownCall('spread is unsupported because its iterator can run user code')
    }
    if (
      ts.isVariableDeclaration(current)
      && ts.isArrayBindingPattern(current.name)
      && current.initializer != null
      && !isKnownBuiltInIterable(current.initializer, program)
    ) {
      addUnknownCall('array destructuring is unsupported because its iterator can run user code')
    }
    if (
      ts.isVariableDeclaration(current)
      && ts.isObjectBindingPattern(current.name)
      && current.initializer != null
      && bindingPatternMayReadAccessor(current.name, current.initializer, program)
    ) {
      addUnknownCall('object destructuring is unsupported because reading a property can call a getter')
    }
    if (ts.isCatchClause(current) && current.variableDeclaration != null) {
      if (ts.isArrayBindingPattern(current.variableDeclaration.name)) {
        addUnknownCall('array destructuring is unsupported because its iterator can run user code')
      }
      if (ts.isObjectBindingPattern(current.variableDeclaration.name)) {
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
      && assignmentHasNestedPattern(current.left)
    ) {
      addUnknownCall('nested destructuring is unsupported because selected values need separate reference tracking')
    }
    if (
      ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isArrayLiteralExpression(unwrapExpression(current.left))
      && !isKnownBuiltInIterable(current.right, program)
    ) {
      addUnknownCall('array destructuring is unsupported because its iterator can run user code')
    }
    if (
      ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isObjectLiteralExpression(unwrapExpression(current.left))
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
        ? []
        : writeTargetRoots(current.left, classifiers, program, valueFlowContext)
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
          addUnknownCall()
        }
      }
      if (assignment != null || increment) {
        const value = assignment?.right
        if (propertyAccessHasSourceAccessor(current, 'set', program)) {
          addUncertainMutation(classifyExpressionRoots(current.expression))
          if (value != null && expressionHasMutableType(value, program)) addUncertainMutation(classifyExpressionRoots(value))
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
        addUncertainMutation(classifyExpressionRoots(current.expression))
        addUnknownCall()
      }
      if ((assignment != null || increment) && elementAccessHasSourceAccessor(current, 'set', program)) {
        addUncertainMutation(classifyExpressionRoots(current.expression))
        const value = assignment?.right
        if (value != null && expressionHasMutableType(value, program)) addUncertainMutation(classifyExpressionRoots(value))
        addUnknownCall()
      }
    }
    if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
      && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)) {
      const target = unwrapExpression(current.operand)
      const setter = (ts.isPropertyAccessExpression(target) && propertyAccessHasSourceAccessor(target, 'set', program))
        || (ts.isElementAccessExpression(target) && elementAccessHasSourceAccessor(target, 'set', program))
      if (!setter) {
        addMutation(writeTargetRoots(current.operand, classifiers, program, valueFlowContext))
      }
    }
    if (ts.isDeleteExpression(current)) {
      addMutation(writeTargetRoots(current.expression, classifiers, program, valueFlowContext))
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
          addUncertainMutation(mutableArgumentRoots(call, program, classifyExpressionRoots))
          addUnknownCall(classification.kind === 'unsupported' ? classification.reason : undefined)
        } else {
          applyPlatformCallEffect(call, classification.effect, [], source => {
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
        : classifyExpressionContainerRoots(target.expression)
      const receiverElementRoots = receiverBase != null
        ? classifiers.reach(receiverBase)
        : classifyExpressionRoots(target.expression)
      const classification = defaultLibraryMember
        ? classifyPlatformMethodCall(
          defaultLibraryOwner(target, program),
          target.name.text,
          call.arguments.length,
        )
        : {kind: 'unrecognized'} as const
      if (classification.kind !== 'supported') {
        addUncertainMutation(receiverElementRoots)
        addUncertainMutation(mutableArgumentRoots(call, program, classifyExpressionRoots))
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
    if (name != null && lengthBearingConstructorNames.has(name) && isDefaultLibrarySymbol(expression.expression, program)) return
    for (const argument of expression.arguments ?? []) {
      if (expressionHasMutableType(argument, program)) addUncertainMutation(classifyExpressionRoots(argument))
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

function bindingNameHasNestedPattern(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return false
  return name.elements.some(element =>
    !ts.isOmittedExpression(element)
    && !ts.isIdentifier(element.name))
}

function assignmentHasNestedPattern(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentHasNestedPattern(current.left)
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.some(property =>
      ts.isPropertyAssignment(property)
      && assignmentPatternExpression(property.initializer))
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.some(element =>
      !ts.isOmittedExpression(element)
      && assignmentPatternExpression(
        ts.isSpreadElement(element) ? element.expression : element,
      ))
  }
  return false
}

function assignmentPatternExpression(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentPatternExpression(current.left)
  }
  return ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)
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
  pattern: ts.ObjectBindingPattern,
  source: ts.Expression,
  program: Program,
): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  try {
    return bindingPatternTypeMayReadAccessor(pattern, checker.getTypeAtLocation(source), checker)
  } catch {
    return true
  }
}

function bindingPatternTypeAtLocationMayReadAccessor(
  pattern: ts.ObjectBindingPattern,
  program: Program,
): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  try {
    return bindingPatternTypeMayReadAccessor(
      pattern,
      checker.getTypeAtLocation(pattern),
      checker,
    )
  } catch {
    return true
  }
}

function bindingPatternTypeMayReadAccessor(
  pattern: ts.ObjectBindingPattern,
  sourceType: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  for (const element of pattern.elements) {
    if (element.dotDotDotToken != null) {
      if (typeHasAccessor(sourceType, checker)) return true
      continue
    }
    const name = staticPropertyName(element.propertyName ?? element.name)
    if (name == null) return true
    const property = checker.getPropertyOfType(sourceType, name)
    if (symbolHasAccessor(property)) return true
  }
  return false
}

function assignmentPatternMayReadAccessor(
  pattern: ts.Expression,
  source: ts.Expression,
  program: Program,
): boolean {
  const checker = program.typeChecker
  if (checker == null) return true
  try {
    return assignmentPatternTypeMayReadAccessor(
      unwrapExpression(pattern),
      checker.getTypeAtLocation(source),
      checker,
    )
  } catch {
    return true
  }
}

function assignmentPatternTypeMayReadAccessor(
  pattern: ts.Expression,
  sourceType: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const current = unwrapExpression(pattern)
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentPatternTypeMayReadAccessor(current.left, sourceType, checker)
  }
  if (!ts.isObjectLiteralExpression(current)) return false
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (typeHasAccessor(sourceType, checker)) return true
      continue
    }
    const name = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : null
    if (name == null) return true
    const sourceProperty = checker.getPropertyOfType(sourceType, name)
    if (symbolHasAccessor(sourceProperty)) return true
  }
  return false
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
): RootKind[] {
  const roots: RootKind[] = []
  for (const assignmentTarget of assignmentTargets(target)) {
    if (assignmentTarget.kind === 'binding') {
      // A bare rebind replaces the caller-invisible binding, except for outer
      // roots, whose binding the caller shares.
      roots.push(...classifiers
        .container(bindingKey(assignmentTarget.identifier, program))
        .filter(root => root.kind === 'outer'))
    } else {
      roots.push(...writeBaseRoots(
        assignmentTarget.expression.expression,
        classifiers,
        program,
        valueFlowContext,
      ))
    }
  }
  return roots
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
): RootKind[] {
  return classifyValueFlow(
    expressionValueFlow(expression, program, valueFlowContext),
    classifiers,
    false,
  )
}

function classifyValueFlow(
  flow: ValueFlow,
  classifiers: Classifiers,
  includeRetained: boolean,
): RootKind[] {
  const roots = flow.aliases.flatMap(alias =>
    alias.relation === 'same'
      ? classifiers.container(alias.binding)
      : classifiers.reach(alias.binding))
  if (includeRetained) {
    roots.push(...flow.retainedRoots.flatMap(root => classifiers.reach(root)))
  }
  return roots
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
