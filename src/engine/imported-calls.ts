import {isFiniteNumber} from '../domain/number.ts'
import {holdsStructure, recordProperty, type AbstractValue, type NullishSentinels} from '../domain/value.ts'
import type {ValueIdentity} from '../domain/value-identity.ts'
import type {BlockID, FunctionRef, ModuleBindingID, ModuleID, SiteID, ValueID} from '../ir/ids.ts'
import type {InstructionIR} from '../ir/instructions.ts'
import {declaredKindOf, type DeclaredKind, type FunctionIR, type ProgramIR} from '../ir/program.ts'
import {
  canonicalValueIdentity,
  createExpressionContext,
  resolveStoredValue,
  type ExpressionContext,
} from '../requirements/infer.ts'
import type {BoundsAssumption, InferredPrecondition, NumericExpression} from '../requirements/model.ts'
import type {AssertionVerdict, FunctionAnalysis} from './outcome.ts'
import {addValueFact, type ExecutionState, type SharedState} from './state.ts'

// Limits on the work imported calls can start. Each fails closed: reaching one stops the call,
// or publishes no relation, and never strengthens a result.
//
// Files lowered because an imported call needed them, in one run. Files a report asks for don't
// count. Lowering a file also runs its TypeScript diagnostics and its module initialization, and
// initializing a file can reach further imported calls, so the limit bounds that whole chain.
// It also bounds how deeply callee analyses nest: a call can only start the analysis of a file
// that isn't on the stack yet (see ImportedCalls.reachesModule).
export const maximumImportedModules = 64
// Functions one walk over what a call can reach may visit, e.g. when checking that a callee
// never calls back into the caller's file.
export const maximumCallClosureFunctions = 1024
// Values one search for a path into a returned record literal may visit.
export const maximumReturnPathSteps = 256

// One project module as an imported call sees it: its lowered program and what its own
// function analyses start from.
export type ImportedModule = {
  program: ProgramIR
  // Function-entry module slots: published values, declared kinds, or uninitialized.
  entryState: SharedState
  moduleValues: Array<AbstractValue | null>
  // Element reads and divisors the initializer could not prove. They condition every
  // function of the module that reads module state.
  initializerBounds: BoundsAssumption[]
  // Per FunctionID, the module bindings the function reads, through same-file calls.
  moduleReads: Set<ModuleBindingID>[]
}

// Why an imported call cannot use a file: the file has TypeScript errors, so the declared types
// the analysis trusts may be wrong, or lowering it would pass maximumImportedModules.
export type UnavailableModule = 'typeScriptErrors' | 'moduleLimit'

// What a walk over the functions a call can reach found. `incomplete` means the walk couldn't see
// every reached function: it passed maximumCallClosureFunctions or reached an unavailable file.
export type CallClosureAnswer = 'found' | 'notFound' | 'incomplete'

export type ImportedCalls = {
  module: (module: ModuleID) => ImportedModule | 'initializing' | UnavailableModule
  // The callee's own analysis, computed once. Only valid after `module` returned a module.
  standalone: (callee: FunctionRef) => FunctionAnalysis | 'analyzing'
  // Whether the callee's calls, followed through same-file and imported callees, can reach a
  // function of `module`.
  reachesModule: (callee: FunctionRef, module: ModuleID) => CallClosureAnswer
}

// The module binding an imported callee's result rests on that the callee's own report prints as
// an assumption, if any: a binding seeded from its declared kind, e.g. `assumes: scale is finite and
// not NaN`, or a published structure, e.g. `assumes: other modules do not modify gaps or any object
// or array inside it`. Assumptions are printed per file, so the caller could not print them, and
// the caller's own file may be the one that modifies the structure.
export function assumedModuleBinding(imported: ImportedModule, callee: FunctionRef): ModuleBindingID | null {
  const reads = imported.moduleReads[callee.function]
  if (reads == null) throw new Error(`Unknown function ${callee.function} in module ${callee.module}`)
  for (const binding of reads) {
    const published = imported.moduleValues[binding]
    const category = imported.program.moduleBindings[binding]?.category
    if (category == null) throw new Error(`Unknown module binding ${binding} in module ${callee.module}`)
    if (published == null ? declaredKindOf(category) != null : holdsStructure(published)) return binding
  }
  return null
}

// Whether an argument lies inside the declared kind the callee's own analysis seeded the
// parameter with. A number leaf that the published finite requirement covers is left to the
// contract stub, so a caller can still inherit `requires: Number.isFinite(width)`. Every other
// seeded trust — array elements, tuple positions, literal intervals, nullable inners, external
// record fields — must already hold for the argument's abstract value. For example, a caller
// passing `[Number.parseFloat(text)]` to a `values: number[]` parameter fails the check,
// because the callee's summary assumed every element finite.
export function withinDeclaredKind(value: AbstractValue, declared: DeclaredKind, finiteRequired: boolean): boolean {
  switch (declared.kind) {
    case 'number': {
      if (value.kind !== 'number') return false
      if (declared.interval == null) return finiteRequired || (!value.mayBeNaN && isFiniteNumber(value))
      return !value.mayBeNaN
        && value.lower >= declared.interval.lower
        && value.upper <= declared.interval.upper
        && (!declared.interval.integer || value.integer)
    }
    case 'boolean': return value.kind === 'boolean'
    case 'opaque': return true
    case 'record': {
      if (value.kind !== 'record') return false
      for (const property of declared.properties) {
        const field = recordProperty(value, property.name)
        if (field == null
          || !withinDeclaredKind(field, property.declared, finiteRequired && property.external !== true)) return false
      }
      return true
    }
    case 'nullish': {
      if (value.kind === 'nullish') return sentinelsWithin(value.sentinels, declared.sentinels)
      if (value.kind === 'maybeNullish') {
        return sentinelsWithin(value.sentinels, declared.sentinels)
          && withinDeclaredKind(value.inner, declared.inner, false)
      }
      return withinDeclaredKind(value, declared.inner, false)
    }
    case 'array': {
      if (value.kind === 'tuple') {
        return value.elements.every(element => withinDeclaredKind(element, declared.element, false))
      }
      return value.kind === 'array'
        && (value.element == null || withinDeclaredKind(value.element, declared.element, false))
    }
    case 'tuple': {
      return value.kind === 'tuple'
        && value.elements.length === declared.elements.length
        && value.elements.every((element, index) => withinDeclaredKind(element, declared.elements[index]!, false))
    }
    // Summaries over tagged-union parameters are not applied; the call stops instead.
    case 'taggedUnion': return false
  }
}

function sentinelsWithin(actual: NullishSentinels, declared: NullishSentinels): boolean {
  return declared === 'both' || actual === declared
}

type WithoutResult<Instruction> = Instruction extends unknown ? Omit<Instruction, 'result'> : never

// The callee's published requirements as instructions over the callee's own parameters,
// evaluated with the caller's arguments. Each requirement reuses the instruction that created
// it, so proving it, naming the caller's condition, falling back to an assumes line, and
// failing on a definitely false condition all follow the ordinary rules: a nonzero requirement
// divides by its divisor, an in-bounds requirement is an asserted element read, and declared
// conditions are static requirements. Instruction sites are the callee's original sites.
export function contractStub(callee: FunctionIR, preconditions: InferredPrecondition[], callSite: SiteID): FunctionIR {
  let nextValue = 0
  for (const parameter of callee.parameters) nextValue = Math.max(nextValue, parameter.value + 1)
  const instructions: InstructionIR[] = []
  const add = (instruction: WithoutResult<InstructionIR>): ValueID => {
    const result = nextValue++
    instructions.push({...instruction, result} as InstructionIR)
    return result
  }
  const lower = (expression: NumericExpression, site: SiteID): ValueID => {
    switch (expression.kind) {
      case 'parameter': return callee.parameters[expression.index]!.value
      case 'constant': return add({kind: 'constant', value: expression.value, site})
      case 'binary': {
        const left = lower(expression.left, site)
        const right = lower(expression.right, site)
        return add({kind: 'binary', operator: expression.operator, left, right, site})
      }
      case 'floor': return add({kind: 'floor', value: lower(expression.operand, site), site})
      case 'property': return add({kind: 'property', object: lower(expression.base, site), property: expression.name, site})
    }
  }
  for (const precondition of preconditions) {
    const site = precondition.site
    switch (precondition.kind) {
      case 'nonzero':
      case 'notEqualConstant': {
        const operand = lower(precondition.expression, site)
        // `X is not c` is exactly `X - c is nonzero` for a finite c, the form it was peeled from.
        const divisor = precondition.kind === 'nonzero'
          ? operand
          : add({
              kind: 'binary',
              operator: 'subtract',
              left: operand,
              right: add({kind: 'constant', value: precondition.value, site}),
              site,
            })
        const one = add({kind: 'constant', value: 1, site})
        add({
          kind: 'binary',
          operator: precondition.operation === 'division' ? 'divide' : 'remainder',
          left: one,
          right: divisor,
          site,
        })
        break
      }
      case 'inBounds': {
        const array = lower(precondition.sequence, site)
        const index = lower(precondition.index, site)
        add({kind: 'arrayIndex', array, index, mode: 'asserted', site})
        break
      }
      case 'declaredComparison': {
        const left = lower(precondition.left, site)
        const right = lower(precondition.right, site)
        const check = add({kind: 'compare', operator: precondition.operator, left, right, site})
        add({kind: 'staticRequire', value: check, site})
        break
      }
      case 'declaredNumberCheck': {
        const value = lower(precondition.expression, site)
        const purpose = precondition.purpose == null ? {} : {purpose: precondition.purpose}
        const check = add({kind: 'numberCheck', predicate: precondition.predicate, value, site, ...purpose})
        add({kind: 'staticRequire', value: check, site, ...purpose})
        break
      }
    }
  }
  return {
    kind: 'lowered',
    name: callee.name,
    assertions: [],
    parameters: callee.parameters,
    returnPropertyNames: null,
    entry: 0,
    blocks: [{loopHeader: null, parameters: [], instructions, terminator: {kind: 'return', value: null, site: callSite}}],
  }
}

type RelationPath = {root: {kind: 'parameter'; index: number} | {kind: 'return'}; properties: string[]}

// An interior assertion that relates a function's inputs and its returned value, e.g.
// `console.assert(inputBottom <= layout.subnavTop)` before `return layout`. When the
// assertion's block dominates the only return and each operand is a parameter path or a path
// into the returned record literal, a proof of the assertion is an order fact about the call.
type ReturnRelation = {assertion: number; smaller: RelationPath; larger: RelationPath; strict: boolean}

function returnRelations(fn: FunctionIR): ReturnRelation[] {
  let onlyReturn: {block: BlockID; value: ValueID} | null = null
  for (let block = 0; block < fn.blocks.length; block++) {
    const terminator = fn.blocks[block]!.terminator
    if (terminator.kind !== 'return') continue
    if (terminator.value == null || onlyReturn != null) return []
    onlyReturn = {block, value: terminator.value}
  }
  if (onlyReturn == null) return []
  const returned = onlyReturn
  const context = createExpressionContext(fn, fn.parameters.map(() => null))
  const relations: ReturnRelation[] = []
  for (let block = 0; block < fn.blocks.length; block++) {
    for (const instruction of fn.blocks[block]!.instructions) {
      if (instruction.kind !== 'staticAssert' || !dominates(fn, block, returned.block)) continue
      const check = context.instructionByValue[instruction.value]
      if (check?.kind !== 'compare') continue
      const left = relationPath(check.left, returned.value, context)
      const right = relationPath(check.right, returned.value, context)
      if (left == null || right == null) continue
      const assertion = instruction.assertion
      switch (check.operator) {
        case 'lessThan': relations.push({assertion, smaller: left, larger: right, strict: true}); break
        case 'lessThanOrEqual': relations.push({assertion, smaller: left, larger: right, strict: false}); break
        case 'greaterThan': relations.push({assertion, smaller: right, larger: left, strict: true}); break
        case 'greaterThanOrEqual': relations.push({assertion, smaller: right, larger: left, strict: false}); break
        case 'equal':
          relations.push({assertion, smaller: left, larger: right, strict: false})
          relations.push({assertion, smaller: right, larger: left, strict: false})
          break
        case 'notEqual': break
      }
    }
  }
  return relations
}

// Whether every path from the entry to `target` passes through `dominator`. The walk enqueues each
// block at most once, so it is bounded by the function's block count.
function dominates(fn: FunctionIR, dominator: BlockID, target: BlockID): boolean {
  if (dominator === target || dominator === fn.entry) return true
  const reached: boolean[] = []
  reached[fn.entry] = true
  const queue: BlockID[] = [fn.entry]
  for (let index = 0; index < queue.length; index++) {
    const terminator = fn.blocks[queue[index]!]!.terminator
    const successors: BlockID[] = []
    switch (terminator.kind) {
      case 'jump': successors.push(terminator.target.block); break
      case 'branch': successors.push(terminator.whenTrue.block, terminator.whenFalse.block); break
      case 'return':
      case 'stop':
      case 'thrown': break
    }
    for (const successor of successors) {
      if (successor === dominator || reached[successor] === true) continue
      reached[successor] = true
      queue.push(successor)
    }
  }
  return reached[target] !== true
}

function relationPath(value: ValueID, returned: ValueID, context: ExpressionContext): RelationPath | null {
  const stored = resolveStoredValue(value, context)
  return parameterPath(stored, context) ?? returnedPath(stored, resolveStoredValue(returned, context), context)
}

function parameterPath(value: ValueID, context: ExpressionContext): RelationPath | null {
  const index = context.parameterIndexByValue[value]
  if (index != null) return {root: {kind: 'parameter', index}, properties: []}
  const producer = context.instructionByValue[value]
  if (producer?.kind !== 'property') return null
  const base = parameterPath(resolveStoredValue(producer.object, context), context)
  return base == null ? null : {root: base.root, properties: [...base.properties, producer.property]}
}

// The fields leading from the returned value to `target` through record literals, e.g.
// `['content', 'top']`. The search visits each value once, in field order, and gives up after
// maximumReturnPathSteps values, so an assertion about a large returned record publishes nothing.
function returnedPath(target: ValueID, returned: ValueID, context: ExpressionContext): RelationPath | null {
  const visited = new Set<ValueID>()
  const pending: Array<{value: ValueID; properties: string[]}> = [{value: returned, properties: []}]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.value === target) return {root: {kind: 'return'}, properties: current.properties}
    if (visited.has(current.value)) continue
    if (visited.size === maximumReturnPathSteps) return null
    visited.add(current.value)
    const producer = context.instructionByValue[current.value]
    if (producer?.kind !== 'object') continue
    for (let index = producer.properties.length - 1; index >= 0; index--) {
      const property = producer.properties[index]!
      pending.push({
        value: resolveStoredValue(property.value, context),
        properties: [...current.properties, property.name],
      })
    }
  }
  return null
}

// Publishes each relation whose assertion was proven for this call as an order fact over the
// caller's values: argument paths, and paths into the call's result. A proven comparison also
// proves both operands were not NaN when it ran, and values are immutable, so the fact holds
// for the returned value.
export function publishReturnRelations(
  state: ExecutionState,
  call: {result: ValueID; arguments: ValueID[]},
  callee: FunctionIR,
  verdicts: AssertionVerdict[],
  context: ExpressionContext,
): void {
  for (const relation of returnRelations(callee)) {
    if (verdicts[relation.assertion]?.verdict !== 'proven') continue
    addValueFact(state.valueFacts, {
      kind: 'order',
      left: callerIdentity(relation.smaller, call, context),
      right: callerIdentity(relation.larger, call, context),
      strict: relation.strict,
    })
  }
}

// The caller-side identity of a relation operand. A path into a record literal the caller
// built resolves to the stored field value, the same way the caller's own reads resolve.
function callerIdentity(
  path: RelationPath,
  call: {result: ValueID; arguments: ValueID[]},
  context: ExpressionContext,
): ValueIdentity {
  let current: ValueID = path.root.kind === 'return' ? call.result : call.arguments[path.root.index]!
  let identity: ValueIdentity | null = null
  for (const property of path.properties) {
    if (identity == null) {
      const producer = context.instructionByValue[resolveStoredValue(current, context)]
      const field = producer?.kind === 'object'
        ? producer.properties.find(candidate => candidate.name === property)
        : undefined
      if (field != null) {
        current = field.value
        continue
      }
      identity = canonicalValueIdentity(current, context)
    }
    identity = {kind: 'property', object: identity, property}
  }
  return identity ?? canonicalValueIdentity(current, context)
}
