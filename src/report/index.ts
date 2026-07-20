import {nextDown, nextUp, isFiniteNumber, type AbstractNumber} from '../domain/number.ts'
import {recordProperty, tryJoinValues, type AbstractValue} from '../domain/value.ts'
import type {AssertionVerdict, FunctionAnalysis, ProgramAnalysis, RequirementFailure, Stop} from '../engine/outcome.ts'
import {finiteInputs, type FiniteInput} from '../ir/finite-inputs.ts'
import type {FunctionID, ModuleBindingID, SiteID, ValueID} from '../ir/ids.ts'
import {functionUsage, transitiveModuleBindings} from '../ir/function-usage.ts'
import {forEachOperand} from '../ir/instructions.ts'
import {declaredKindOf, formatSite, type DeclaredKind, type FunctionIR, type ProgramIR, type UnsupportedReason} from '../ir/program.ts'
import {numericParameterPath} from '../requirements/infer.ts'
import type {BoundsAssumption, InferredPrecondition} from '../requirements/model.ts'
import {describePrecondition, formatObservedNeed, formatPrecondition} from './format-requirement.ts'

export type FunctionReport =
  | {kind: 'analyzed'; name: string; assumptions: string[]; requires: string[]; ensures: string[]; assertions?: AssertionReport[]}
  // e.g. 'unknown identifier scheduledRender at /abs/demo/index.ts:6:7'
  | {kind: 'unsupported'; name: string; unsupported: string}
  // Some paths could not be analyzed completely; `observed` lines are evidence from the
  // paths that completed, never a contract. e.g. partialReasons:
  // ['recursive call to countdown (call at /abs/file.ts:3:10)'],
  // observed: 'return is a finite integer number from 0 through 0'.
  | {kind: 'partial'; name: string; assumptions: string[]; partialReasons: string[]; skipped?: string[]; observed: string[]; assertions?: AssertionReport[]}

export type AssertionReport = {
  verdict: AssertionVerdict['verdict']
  text: string
  location: string
}

export type AnalysisReport = {
  functions: FunctionReport[]
}

export function createReport(program: ProgramIR, analysis: ProgramAnalysis): AnalysisReport {
  const functions: FunctionReport[] = []
  const assumedBindings = functionModuleAssumptions(program, analysis)
  // An unproven asserted element read at the top level (`breakpoints[idx]!` with a
  // platform-derived idx) conditions everything the initializer published, and the
  // initializer usually prints no entry — so the assumption lines travel to every
  // function that reads any module binding, the same way declared-kind assumptions do.
  // Without this, a reader's ensures would publish unconditionally while the runtime
  // read can miss.
  const initializerBounds = analysis.initializer.kind === 'analyzed'
    ? analysis.initializer.boundsAssumptions
    : analysis.initializer.observedBoundsAssumptions
  const initializerBoundsLines = initializerBounds.map(assumption => formatBoundsAssumption(assumption, program))
  // Top-level code runs before any function, so its entry comes first — but only when it is
  // partially supported or contains skipped statements. A fully analyzed initializer with
  // nothing skipped is invisible: its results show up as the exact module values other entries
  // report, with its bounds assumptions carried by the readers above.
  // Like an unsupported function, show the first module blocker and let the coverage
  // header carry the total. FileAudit.references retains every skip for structured use.
  const firstSkip = program.initializerSkips[0]
  const skippedLines = firstSkip == null
    ? []
    : [`${formatUnsupportedReason(firstSkip.reason)} at ${formatSite(program, firstSkip.site)}`]
  if (analysis.initializer.kind === 'partial' || skippedLines.length > 0) {
    const observed: string[] = []
    if (analysis.initializer.kind === 'partial') {
      for (const need of analysis.initializer.observedNeeds) observed.push(formatObservedNeed(need, [], program))
    }
    functions.push({
      kind: 'partial',
      name: program.initializer.name,
      assumptions: initializerBoundsLines,
      partialReasons: analysis.initializer.kind === 'partial'
        ? analysis.initializer.stops.map(stop => formatStop(stop, program, analysis))
        : [],
      skipped: skippedLines,
      observed,
    })
  }
  for (let functionID = 0; functionID < analysis.functions.length; functionID++) {
    const fn = analysis.functions[functionID]!
    switch (fn.kind) {
      case 'notLowered': {
        const lowering = fn.lowering
        functions.push({
          kind: 'unsupported',
          name: lowering.name,
          unsupported: `${formatUnsupportedReason(lowering.reason)} at ${formatSite(program, lowering.site)}`,
        })
        break
      }
      case 'partial': {
        const lowering = fn.lowering
        const observed: string[] = []
        if (fn.observedReturn != null) {
          observed.push(...returnSummaries('return', declaredReturn(fn.observedReturn.value, lowering), program))
        }
        for (const need of fn.observedNeeds) observed.push(formatObservedNeed(need, lowering.parameters, program))
        functions.push({
          kind: 'partial',
          name: lowering.name,
          assumptions: assumptionLines(lowering, program, assumedBindings[functionID]!, fn.observedBoundsAssumptions, []),
          partialReasons: fn.stops.map(stop => formatStop(stop, program, analysis)),
          observed,
          ...(fn.assertions.length === 0 ? {} : {assertions: assertionReports(fn.assertions, program)}),
        })
        break
      }
      case 'analyzed': {
        const lowering = fn.lowering
        const finite = finiteInputs(lowering)
        const requires = requirementLines(lowering, finite, fn.preconditions, program)
        const assumptions = assumptionLines(
          lowering,
          program,
          assumedBindings[functionID]!,
          fn.boundsAssumptions,
          finiteAssumptionInputs(lowering, finite, fn.preconditions),
        )
        functions.push({
          kind: 'analyzed',
          name: lowering.name,
          assumptions,
          requires,
          ensures: returnSummaries('return', declaredReturn(fn.returnValue, lowering), program),
          ...(fn.assertions.length === 0 ? {} : {assertions: assertionReports(fn.assertions, program)}),
        })
        break
      }
    }
  }
  return {functions}
}

function finiteAssumptionInputs(
  fn: FunctionIR,
  automatic: FiniteInput[],
  preconditions: InferredPrecondition[],
): FiniteInput[] {
  const inputs = [...automatic]
  const paths = finitePathIndexes(fn, inputs)
  for (const precondition of preconditions) {
    if (precondition.kind !== 'declaredNumberCheck'
      || (precondition.predicate !== 'finite' && precondition.predicate !== 'integer')) continue
    const path = numericParameterPath(precondition.expression)
    if (path == null || pathIndexHas(paths[path.parameter]!, path.properties)) continue
    inputs.push({parameter: path.parameter, properties: path.properties, site: precondition.site})
    pathIndexAdd(paths[path.parameter]!, path.properties)
  }
  return inputs
}

function requirementLines(
  fn: FunctionIR,
  inputs: FiniteInput[],
  preconditions: InferredPrecondition[],
  program: ProgramIR,
): string[] {
  const inputsByParameter = fn.parameters.map((): FiniteInput[] => [])
  for (const input of inputs) inputsByParameter[input.parameter]!.push(input)
  const folded: boolean[] = []
  for (let parameter = 0; parameter < fn.parameters.length; parameter++) {
    const current = fn.parameters[parameter]!
    folded[parameter] = current.bindings != null || inputsByParameter[parameter]!.length >= 3
  }
  const lines: string[] = []
  const emitted: boolean[] = []
  for (const precondition of preconditions) {
    const isFiniteInput = precondition.kind === 'declaredNumberCheck'
      && precondition.predicate === 'finite'
      && precondition.purpose === 'finiteInput'
    const path = isFiniteInput
      ? numericParameterPath(precondition.expression)
      : null
    if (path != null && folded[path.parameter]) {
      if (!emitted[path.parameter]) {
        const parameter = fn.parameters[path.parameter]!
        const parameterInputs = inputsByParameter[path.parameter]!
        const condition = parameter.bindings == null
          ? `every number field in ${parameter.name} is finite`
          : finiteBindingList(parameter, parameterInputs)
        lines.push(`${condition} (input at ${formatSite(program, parameter.site)})`)
        emitted[path.parameter] = true
      }
      continue
    }
    if (isFiniteInput) {
      lines.push(`${describePrecondition(precondition, fn.parameters).condition} (input at ${formatSite(program, precondition.site)})`)
      continue
    }
    lines.push(formatPrecondition(precondition, fn.parameters, program))
  }
  return lines
}

function finiteBindingList(parameter: FunctionIR['parameters'][number], inputs: FiniteInput[]): string {
  const bindings = parameter.bindings == null
    ? null
    : new Map(parameter.bindings.map(binding => [binding.property, binding.local]))
  const names = inputs.map(input => {
    const [first, ...rest] = input.properties
    const binding = first == null ? null : bindings?.get(first)
    return binding == null ? input.properties.join('.') : [binding, ...rest].join('.')
  })
  if (names.length === 1) return `${names[0]} is finite`
  if (names.length === 2) return `${names[0]} and ${names[1]} are finite`
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)} are finite`
}

// Within an entry, line kinds print rarest-and-most-actionable first: requires (what the
// caller must arrange), ensures (what it gets), assumes (what is being trusted — the
// bulkiest kind, and the one every reader scans past to reach the other two).
export function formatReport(report: AnalysisReport): string {
  const lines: string[] = []
  for (const fn of report.functions) {
    if (lines.length > 0) lines.push('')
    lines.push(fn.name)
    switch (fn.kind) {
      case 'analyzed': {
        for (const precondition of fn.requires) lines.push(`  requires: ${precondition}`)
        for (const assertion of fn.assertions ?? []) lines.push(formatAssertionReport(assertion))
        for (const guarantee of fn.ensures) lines.push(`  ensures: ${guarantee}`)
        for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
        break
      }
      case 'unsupported': {
        lines.push(`  unsupported: ${fn.unsupported}`)
        break
      }
      case 'partial': {
        for (const assertion of fn.assertions ?? []) lines.push(formatAssertionReport(assertion))
        for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
        for (const reason of fn.partialReasons) lines.push(`  partially supported: ${reason}`)
        for (const skip of fn.skipped ?? []) lines.push(`  skipped: ${skip}`)
        for (const evidence of fn.observed) lines.push(`  on analyzed paths: ${evidence}`)
        break
      }
    }
  }
  return lines.join('\n')
}

function assertionReports(assertions: AssertionVerdict[], program: ProgramIR): AssertionReport[] {
  return assertions.map(assertion => ({
    verdict: assertion.verdict,
    text: assertion.text,
    location: formatSite(program, assertion.site),
  }))
}

function formatAssertionReport(assertion: AssertionReport): string {
  switch (assertion.verdict) {
    case 'proven': return `  proves: ${assertion.text} (assertion at ${assertion.location})`
    case 'refuted': return `  assertion can fail: ${assertion.text} (at ${assertion.location})`
    case 'unproven': return `  assertion unproven: could not prove ${assertion.text} (at ${assertion.location})`
    case 'dead': return `  unreachable assertion: ${assertion.text} (at ${assertion.location})`
    case 'blocked': return `  assertion blocked: the function did not finish analysis without site-specific assumptions: ${assertion.text} (at ${assertion.location})`
  }
}


// A string tag prints quoted ('lightbox'); a boolean tag prints bare (true), matching how
// each is written in the type.
function formatTagValue(tagValue: string | boolean): string {
  return typeof tagValue === 'string' ? `'${tagValue}'` : String(tagValue)
}

// A parameter path the body read, as property-name segments from the parameter root ([]
// is the root itself). Reads never descend below an array or tuple: an element read marks
// the container's path, so every line inside the container prints or drops with it.
type ParameterRead = {parameter: number; segments: string[]}

// Which declared paths of each parameter the body touched, from a walk over the lowered
// IR. A declared-type assumes line prints only when its path was touched: a path no
// instruction ever read derived no value, so no printed requires/ensures can rest on its
// trust, and dropping its line removes no load-bearing condition. The soundness direction
// is asymmetric — printing an extra line is harmless, dropping a line a claim rests on is
// the hole the honesty work closed — so every approximation errs toward marking MORE
// paths as read:
// - Escapes keep everything at and below the escaping path: a value passed as a call
//   argument (the callee may read anything under it), returned (the ensures describe
//   it), written into module state, or consumed by any instruction the walk does not
//   treat specially, marks its whole path as read.
// - Property reads are projections: `box.xs` extends the tracked path without marking
//   `box` itself read, which is what lets an unread sibling property drop.
// - Values the walk loses sight of are marked at the point of loss: a tracked value
//   passed as a block argument (a ternary or loop join) marks its path, because the
//   block parameter it feeds is not tracked and anything read through it later sits at
//   or below that path.
// - A tag check consumes the union directly and marks nothing: the tag property prints
//   no line (a string tag is opaque, a boolean tag would restate the qualifier), so
//   there is no line for the check to keep — this is what makes a function that only
//   switches on a union tag print an empty assumes block.
// Any future instruction kind lands in the default arm, which marks every tracked
// operand read — over-printing, never under.
function parameterReadPaths(fn: FunctionIR): PathIndex[] {
  const tracked = new Map<ValueID, ParameterRead>()
  const projections = new Map<ValueID, Array<{result: ValueID; property: string}>>()
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.kind !== 'property') continue
      const dependents = projections.get(instruction.object) ?? []
      dependents.push({result: instruction.result, property: instruction.property})
      projections.set(instruction.object, dependents)
    }
  }
  const queue: ValueID[] = []
  for (let index = 0; index < fn.parameters.length; index++) {
    const value = fn.parameters[index]!.value
    tracked.set(value, {parameter: index, segments: []})
    queue.push(value)
  }
  for (let current = 0; current < queue.length; current++) {
    const value = queue[current]!
    const base = tracked.get(value)!
    for (const projection of projections.get(value) ?? []) {
      if (tracked.has(projection.result)) continue
      tracked.set(projection.result, {
        parameter: base.parameter,
        segments: [...base.segments, projection.property],
      })
      queue.push(projection.result)
    }
  }
  const reads = fn.parameters.map((): PathIndex => ({terminal: false, children: new Map()}))
  const markOperand = (operand: ValueID): void => {
    const path = tracked.get(operand)
    if (path != null) pathIndexAdd(reads[path.parameter]!, path.segments)
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      switch (instruction.kind) {
        // A projection, not a consumption: the derived value is tracked above, and
        // whichever instruction consumes it marks the extended path then.
        case 'property': break
        // The tag read keeps nothing — see the rationale above.
        case 'tagCheck': break
        // Generated boundary checks are contracts, not evidence that the body used a value.
        case 'numberCheck': {
          if (instruction.purpose !== 'finiteInput') forEachOperand(instruction, markOperand)
          break
        }
        default: forEachOperand(instruction, markOperand)
      }
    }
    const terminator = block.terminator
    switch (terminator.kind) {
      case 'return': {
        if (terminator.value != null) markOperand(terminator.value)
        break
      }
      case 'jump': {
        for (const argument of terminator.target.arguments) markOperand(argument)
        break
      }
      case 'branch': {
        markOperand(terminator.condition)
        for (const argument of terminator.whenTrue.arguments) markOperand(argument)
        for (const argument of terminator.whenFalse.arguments) markOperand(argument)
        break
      }
      case 'stop':
      case 'thrown':
        break
    }
  }
  return reads
}

// Whether a line about the declared path `segments` prints, given the paths the body
// read: yes when some read sits at, below, or above the line's path (one is a prefix of
// the other). A read below keeps the lines above it that its trust chains through
// (reading values[i] keeps the plain-array line on values), and a read at or above keeps
// everything under it (an escaped record keeps its whole subtree).
type KeepPath = (segments: string[]) => boolean

const keepEverything: KeepPath = () => true

function assumptionLines(
  fn: FunctionIR,
  program: ProgramIR,
  assumedBindings: ReadonlySet<ModuleBindingID>,
  boundsAssumptions: BoundsAssumption[],
  finiteRequirements: FiniteInput[],
): string[] {
  const assumptions: string[] = []
  const reads = parameterReadPaths(fn)
  const finitePaths = finitePathIndexes(fn, finiteRequirements)
  for (let index = 0; index < fn.parameters.length; index++) {
    const parameter = fn.parameters[index]!
    const keep = (path: string[]): boolean =>
      !pathIndexHas(finitePaths[index]!, path) && pathIndexOverlaps(reads[index]!, path)
    if (parameter.bindings == null) {
      pushRootAssumptions(parameter.name, parameter.type, assumptions, keep)
      continue
    }
    if (parameter.type.kind !== 'record') {
      const start = assumptions.length
      pushRootAssumptions(parameter.name, parameter.type, assumptions, keep)
      for (let line = start; line < assumptions.length; line++) {
        for (const binding of parameter.bindings) {
          assumptions[line] = assumptions[line]!.replaceAll(
            `${parameter.name}.${binding.property}`,
            binding.local,
          )
        }
      }
      continue
    }
    const properties = new Map(parameter.type.properties.map(property => [property.name, property.declared]))
    for (const binding of parameter.bindings) {
      const property = properties.get(binding.property)
      if (property == null) continue
      pushRootAssumptions(
        binding.local,
        property,
        assumptions,
        path => keep([binding.property, ...path]),
      )
    }
  }
  // Module bindings filter at whole-binding granularity: assumedBindings already contains
  // only the bindings this function (or a callee) reads, and a callee's reads arrive as a
  // binding ID with no path detail, so a read binding keeps all its lines.
  for (const bindingID of assumedBindings) {
    const binding = program.moduleBindings[bindingID]!
    const declaredKind = declaredKindOf(binding.category)
    if (declaredKind == null) throw new Error(`Module binding ${binding.name} has no declared kind to assume`)
    pushRootAssumptions(binding.name, declaredKind, assumptions, keepEverything)
  }
  for (const assumption of boundsAssumptions) {
    // The engine could not prove the asserted element read in bounds; the entry's
    // guarantees rest on it. E.g. `the element read at demo.ts:4:10 is in bounds`, or,
    // for a divisor no requirement could name, `the divisor at demo.ts:4:10 is nonzero`.
    assumptions.push(formatBoundsAssumption(assumption, program))
  }
  return assumptions
}

type PathIndex = {
  terminal: boolean
  children: Map<string, PathIndex>
}

function finitePathIndexes(fn: FunctionIR, inputs: FiniteInput[]): PathIndex[] {
  const indexes = fn.parameters.map((): PathIndex => ({terminal: false, children: new Map()}))
  for (const input of inputs) pathIndexAdd(indexes[input.parameter]!, input.properties)
  return indexes
}

function pathIndexAdd(index: PathIndex, path: string[]): void {
  let current = index
  for (const segment of path) {
    let child = current.children.get(segment)
    if (child == null) {
      child = {terminal: false, children: new Map()}
      current.children.set(segment, child)
    }
    current = child
  }
  current.terminal = true
}

function pathIndexHas(index: PathIndex, path: string[]): boolean {
  let current = index
  for (const segment of path) {
    const child = current.children.get(segment)
    if (child == null) return false
    current = child
  }
  return current.terminal
}

function pathIndexOverlaps(index: PathIndex, path: string[]): boolean {
  let current = index
  if (current.terminal) return true
  for (const segment of path) {
    const child = current.children.get(segment)
    if (child == null) return false
    current = child
    if (current.terminal) return true
  }
  return current.children.size > 0
}

function formatBoundsAssumption(assumption: BoundsAssumption, program: ProgramIR): string {
  switch (assumption.kind) {
    case 'elementInBounds': return `the element read at ${formatSite(program, assumption.site)} is in bounds`
    case 'nonzeroDivisor': return `the divisor at ${formatSite(program, assumption.site)} is nonzero`
  }
}

// A record with many number leaves would print the same default once per leaf — a
// PreparedLayout parameter with a dozen numeric properties repeats "is finite and not NaN"
// a dozen times, on every function that takes one, and the repetition drowns the requires
// and ensures lines that carry actual information. The number default folds into one line
// per value, e.g. `every property declared as a number in prepared holds a finite non-NaN
// number` (array elements and tuple slots are index properties, so one word covers every
// leaf). The quantifier ranges over the DECLARED properties and demands a held value; a
// quantifier over runtime values would be vacuous for exactly the two smuggles that must
// violate the line — a non-number in a number slot (not a "number value") and an absent
// property (no value at all), both reachable through `any`: the per-leaf line `box.width is finite and not
// NaN` asserts that box.width actually holds a finite number, so a non-number smuggled
// through `any` violates the assumption and keeps the ensures vacuous rather than false —
// the folded line must keep exactly that force (a review round ran the counterexample).
// Nullish-wrapped leaves stay out of the fold and keep their exact lines: a `number |
// null` leaf legally holds null, which the folded assertion would wrongly forbid.
// Tagged-union leaves stay out too (see numberLeafCount's taggedUnion arm). Small
// values (one or two number leaves) keep their per-leaf lines, and non-number leaves
// (booleans, tagged-union qualifiers) always print exactly.
//
// Plain-array lines fold the same way, but membership is exactly the set the folded
// sentence names on its surface reading: the DIRECT NON-NULLABLE properties of a
// non-nullable record root whose declared type is an array. Three or more such
// properties fold into one quantified line, and only those properties' own plain-array
// lines are suppressed — nothing the folded sentence does not restate may be. Every
// other array position keeps its per-level line even when the fold triggers: a root
// that is itself an array or a nullable root (the sentence quantifies over properties
// IN the root, saying nothing about the root itself), nested element levels (`every
// prepared.grid element is a plain array — ...` — a genuine outer array can hold a
// lying inner row, and the nested line is the one such a row violates), arrays behind a nullable
// record (`options.config is null or options.config.grid is a plain array — ...` — the
// folded line's unconditional 'holds' would forbid the legal null at config), tuples
// (see the tuple arm below), and nullable array members themselves. Nullable members
// were the last to leave the fold: their folded coverage was a parenthetical blessing
// null AND undefined for every such member, while the engine seeds each member with
// only its DECLARED sentinel and prunes a branch testing the other — so a caller
// smuggling undefined into `overrides: number[] | null` (or null into `overrides?:
// number[]`, which any JSON-derived value does, since serializers write null for
// absent) satisfied every printed line while a printed ensures was false at runtime.
// The member's own disjunct line is sentinel-precise — `prepared.overrides is null or
// prepared.overrides is a plain array — ...` — and a wrong-sentinel smuggle violates it,
// so it always prints, and with no nullable member folded the parenthetical is gone.
// Review rounds falsified each looser membership the same way: a nullable root folded
// into a sentence that said nothing about the root, a suppressed nested line let a
// lying inner row through with every printed line holding, and the unconditional
// 'holds' was violated by a legal null behind a nullable record, so the whole report
// stopped applying to legitimate callers.
// Either fold prints only when the read filter keeps EVERY position its sentence covers:
// the sentence quantifies over the DECLARED properties ("every property declared as a
// number in prepared"), so printing it while a covered position is unread would claim
// trust nothing rests on — and re-restrict legal callers at the unread position, the
// exact over-restriction the read filter removes. When any covered position is unread,
// the kept positions print per-property and the unread ones stay silent.
function pushRootAssumptions(path: string, declared: DeclaredKind, assumptions: string[], keep: KeepPath): void {
  const numberLeaves = numberLeafCount(declared, [], keep)
  const folds = !hasLiteralNumberInterval(declared)
    && numberLeaves.total >= 3
    && numberLeaves.kept === numberLeaves.total
    && declared.kind !== 'number'
  if (folds) assumptions.push(`every property declared as a number in ${path} holds a finite non-NaN number`)
  if (declared.kind === 'record') {
    const arrayProperties = declared.properties.filter(property => property.declared.kind === 'array')
    const keptArrayProperties = arrayProperties.filter(property => keep([property.name]))
    if (arrayProperties.length >= 3 && keptArrayProperties.length === arrayProperties.length) {
      assumptions.push(`every property declared as an array in ${path} holds a plain array — its length counts its elements, and every index below the length holds an element`)
      for (const property of declared.properties) {
        pushDeclaredAssumptions(`${path}.${property.name}`, [property.name], property.declared, assumptions, keep, {
          skipNumberLeaves: folds,
          skipOwnArrayLine: property.declared.kind === 'array',
        })
      }
      return
    }
  }
  pushDeclaredAssumptions(path, [], declared, assumptions, keep, {skipNumberLeaves: folds, skipOwnArrayLine: false})
}

// Counts the number leaves the fold may cover, and how many of them the read filter
// keeps. Nullish subtrees count zero: their leaves keep exact per-leaf lines whether or
// not the root folds.
function numberLeafCount(declared: DeclaredKind, segments: string[], keep: KeepPath): {total: number; kept: number} {
  switch (declared.kind) {
    case 'number': return {total: 1, kept: keep(segments) ? 1 : 0}
    case 'boolean': return {total: 0, kept: 0}
    case 'opaque': return {total: 0, kept: 0}
    case 'nullish': return {total: 0, kept: 0}
    case 'array': return numberLeafCount(declared.element, [...segments, '[each]'], keep)
    case 'tuple': {
      const count = {total: 0, kept: 0}
      for (let index = 0; index < declared.elements.length; index++) {
        const element = numberLeafCount(declared.elements[index]!, [...segments, String(index)], keep)
        count.total += element.total
        count.kept += element.kept
      }
      return count
    }
    case 'record': {
      const count = {total: 0, kept: 0}
      for (const property of declared.properties) {
        const inner = numberLeafCount(property.declared, [...segments, property.name], keep)
        count.total += inner.total
        count.kept += inner.kept
      }
      return count
    }
    // Tagged unions never fold: their per-leaf lines carry the `(when route.type is ...)`
    // qualifier scoping each assumption to its variant, which one folded line cannot
    // express — a legal value of one variant has no values in the other variants' slots,
    // so an unqualified declaration-wide assertion is violated by every legal value,
    // while a presence-scoped one is vacuous for a wrong-shape smuggle (a review round
    // ran both failures).
    case 'taggedUnion': return {total: 0, kept: 0}
  }
}

type AssumptionOptions = {
  // True when the root already printed the folded number line; number leaves then add
  // nothing, while boolean and qualified lines still print per leaf.
  skipNumberLeaves: boolean
  // True when the folded plain-array line already restates this value's own plain-array
  // claim — set only on the direct non-nullable array properties of a folding record
  // root. The suppression covers exactly one line: nested levels below the value still
  // print theirs, because the folded sentence quantifies over the root's direct
  // properties only.
  skipOwnArrayLine: boolean
}

const exactLeaves: AssumptionOptions = {skipNumberLeaves: false, skipOwnArrayLine: false}

// One assumption line per leaf of the declared kind: a record binding's condition is a
// condition on each of its properties, e.g. `pointer.x is finite and not NaN`. `segments`
// is the same path as `path` in property-name segments, checked against the read filter
// at every line-emitting arm; a line whose path the body never touched stays silent.
function pushDeclaredAssumptions(path: string, segments: string[], declared: DeclaredKind, assumptions: string[], keep: KeepPath, options: AssumptionOptions = exactLeaves): void {
  switch (declared.kind) {
    case 'number': {
      if (!options.skipNumberLeaves && keep(segments)) {
        assumptions.push(`${path} is ${declaredNumberAssumption(declared)}`)
      }
      break
    }
    case 'boolean': {
      if (keep(segments)) assumptions.push(`${path} is a boolean`)
      break
    }
    case 'tuple': {
      // The engine reads a declared tuple's length as its position count and every slot
      // as present (a [number, number] parameter's .length is seeded as exactly 2) —
      // boundary trust in a value the caller controls, stronger than the plain-array
      // line, and previously unprinted. Type-checked callers can break it: strict tsc
      // allows push on tuples, so `const grown: [number, number] = [1, 2]; grown.push(3)`
      // legally builds a three-element value, and a Proxy over a genuine pair can answer
      // 7 to a length read. The exact-count clause is what those callers violate; the
      // trailing clauses carry the same length-vs-elements and presence trust as the
      // array line. Only all-required tuples classify (optional and rest positions leave
      // the subset at classification), so the count is always the position count. Tuples
      // never join the plain-array fold: the folded sentence cannot state a different
      // element count per property, and the count is the clause a grown tuple violates.
      const count = declared.elements.length
      if (keep(segments)) {
        assumptions.push(`${path} is a plain array of exactly ${count} element${count === 1 ? '' : 's'} — its length counts its elements, and every index below the length holds an element`)
      }
      for (let index = 0; index < declared.elements.length; index++) {
        pushDeclaredAssumptions(`${path}[${index}]`, [...segments, String(index)], declared.elements[index]!, assumptions, keep, options)
      }
      break
    }
    case 'array': {
      // The plain-array line is the trust the element reads and length reads rest on: the
      // engine treats an in-range read as finding a present value of the declared element
      // type, and each length read as a genuine element count (an integer from 0 through
      // 2^32 - 1). Both are boundary trust in a value the caller controls — a Proxy with a
      // lying length trap, an array with holes, or an undefined smuggled into a nested row
      // each violate this line, which is exactly what keeps the ensures lines honest (a
      // review round ran all three falsifications against the previously silent trust).
      // Element lines alone cannot carry it: `every grid[each] element is finite and not
      // NaN` quantifies over the elements an array actually holds, so a lied-about length
      // adds no elements and violates nothing on that line.
      if (!options.skipOwnArrayLine && keep(segments)) {
        assumptions.push(`${path} is a plain array — its length counts its elements, and every index below the length holds an element`)
      }
      // E.g. `every values element is finite and not NaN`. The recursion path uses
      // `[each]` so nesting stays readable: a number[][] parameter prints
      // `every grid[each] element is finite and not NaN`, and a record element prints
      // its property path, e.g. `points[each].x is finite and not NaN`. The nested
      // plain-array line rides the same sugar: `every grid element is a plain array — ...`.
      const leaf: string[] = []
      pushDeclaredAssumptions(`${path}[each]`, [...segments, '[each]'], declared.element, leaf, keep, {skipNumberLeaves: options.skipNumberLeaves, skipOwnArrayLine: false})
      for (const line of leaf) {
        const prefix = `${path}[each] is `
        // The `every X element is` sugar only reads right when the element path appears
        // once. A nullish element's disjunction mentions it again (`slots[each] is null
        // or slots[each].x is finite and not NaN`), and rewriting only the first mention
        // would mix the two quantifier styles in one line.
        const mentionsOnce = line.split(`${path}[each]`).length === 2
        assumptions.push(line.startsWith(prefix) && mentionsOnce
          ? `every ${path} element is ${line.slice(prefix.length)}`
          : line)
      }
      break
    }
    // No claims are made about an opaque leaf, so there is nothing to assume.
    case 'opaque': break
    case 'nullish': {
      if (!keep(segments)) break
      const sentinelWords = declared.sentinels === 'both' ? 'null or undefined' : declared.sentinels
      if (declared.inner.kind === 'number') {
        // E.g. `animatedUntilTime is null or a finite non-NaN number`. Never folded: the
        // folded line's kind assertion would wrongly forbid the legal null.
        const numberWords = declared.inner.interval == null
          ? 'a finite non-NaN number'
          : declaredNumberAssumption(declared.inner)
        assumptions.push(`${path} is ${sentinelWords} or ${numberWords}`)
      } else if (declared.inner.kind === 'boolean') {
        assumptions.push(`${path} is ${sentinelWords} or a boolean`)
      } else {
        // One line per inner leaf, each carrying the missing-value caveat — e.g. a
        // `Config | null` parameter prints `config is null or config.width is finite and
        // not NaN`. The seeded finiteness of every leaf must reach the report: the
        // ensures lines rest on it. An opaque inner (`string | null`) contributes no
        // line, because nothing is claimed about the string either way. A nullish
        // subtree never joins either fold, so every inner line prints exactly — in
        // particular a nullable array member's own disjunct, `overrides is null or
        // overrides is a plain array — ...`, whose named sentinel is the one the engine
        // seeds and narrows by; a wrong-sentinel smuggle violates the disjunct.
        const leaf: string[] = []
        pushDeclaredAssumptions(path, segments, declared.inner, leaf, keep, exactLeaves)
        for (const line of leaf) assumptions.push(`${path} is ${sentinelWords} or ${line}`)
      }
      break
    }
    case 'record': {
      for (const property of declared.properties) {
        pushDeclaredAssumptions(`${path}.${property.name}`, [...segments, property.name], property.declared, assumptions, keep, options)
      }
      break
    }
    case 'taggedUnion': {
      // Per-variant leaf lines, each qualified by the tag — e.g. `route.index is finite
      // and not NaN (when route.type is 'lightbox')`. The tag property itself is skipped:
      // a string tag is an opaque leaf with no line anyway, and a boolean tag's "ok is a
      // boolean" would restate what the qualifier already pins. When several variants
      // share one tag value, or when a plain-boolean tag expands into several shapes, the
      // tag alone does not pin the shape. Each line then adds a presence qualifier, so
      // the assumption speaks only about values that actually carry the property.
      // Reads mark a variant property's path with no variant attached (the narrow that
      // preceded the read is not tracked), so a read of one variant's property keeps the
      // same-named property's lines in every variant that declares it.
      for (const variant of declared.variants) {
        const sharedTag = declared.variants.filter(candidate => candidate.tagValue === variant.tagValue).length > 1
        const leaf: string[] = []
        for (const property of variant.properties) {
          if (property.name === declared.tagProperty) continue
          const qualifier = sharedTag
            ? `when ${path}.${declared.tagProperty} is ${formatTagValue(variant.tagValue)} and ${path}.${property.name} is present`
            : `when ${path}.${declared.tagProperty} is ${formatTagValue(variant.tagValue)}`
          const perProperty: string[] = []
          pushDeclaredAssumptions(`${path}.${property.name}`, [...segments, property.name], property.declared, perProperty, keep, exactLeaves)
          for (const line of perProperty) leaf.push(`${line} (${qualifier})`)
        }
        for (const line of leaf) {
          if (!assumptions.includes(line)) assumptions.push(line)
        }
      }
      break
    }
  }
}

function hasLiteralNumberInterval(declared: DeclaredKind): boolean {
  switch (declared.kind) {
    case 'number': return declared.interval != null
    case 'boolean':
    case 'opaque': return false
    case 'nullish': return hasLiteralNumberInterval(declared.inner)
    case 'tuple': return declared.elements.some(hasLiteralNumberInterval)
    case 'array': return hasLiteralNumberInterval(declared.element)
    case 'record': return declared.properties.some(property => hasLiteralNumberInterval(property.declared))
    case 'taggedUnion': return declared.variants.some(variant =>
      variant.properties.some(property => hasLiteralNumberInterval(property.declared)))
  }
}

function declaredNumberAssumption(declared: Extract<DeclaredKind, {kind: 'number'}>): string {
  if (declared.interval == null) return 'finite and not NaN'
  const integer = declared.interval.integer ? ' integer' : ''
  return `a finite${integer} number from ${String(declared.interval.lower)} through ${String(declared.interval.upper)}`
}

// Per function, the module bindings whose declared-kind seeding the result rests on.
// The dependency travels through calls so callers print their callees' assumptions too.
function functionModuleAssumptions(
  program: ProgramIR,
  analysis: ProgramAnalysis,
): Set<ModuleBindingID>[] {
  const usage = functionUsage(program)
  const direct = usage.map(fn => {
    const reads = new Set<ModuleBindingID>()
    for (const bindingID of fn.moduleBindings) {
      if (analysis.moduleValues[bindingID] != null) continue
      const binding = program.moduleBindings[bindingID]
      if (binding == null) throw new Error(`Unknown module binding ${bindingID}`)
      if (declaredKindOf(binding.category) != null) reads.add(bindingID)
    }
    return reads
  })
  return transitiveModuleBindings(usage, direct)
}

// The only place stop prose exists; everything else branches on reason.kind.
function formatStop(stop: Stop, program: ProgramIR, analysis: ProgramAnalysis): string {
  const reason = stop.reason
  switch (reason.kind) {
    case 'recursion': {
      return `recursive call to ${functionName(program, reason.callee)} (call at ${formatSite(program, stop.site)})`
    }
    case 'calleeStopped': {
      // A partially supported callee did not necessarily hit syntax rejected during lowering;
      // saying so would send an agent hunting through a body whose constructs all lower.
      const calleeState = calleeStateText(analysis.functions[reason.callee])
      return `calls ${functionName(program, reason.callee)}, ${calleeState} (call at ${formatSite(program, stop.site)})`
    }
    case 'kindMismatch': {
      return `uses a value whose runtime kind the analysis cannot establish (at ${formatSite(program, stop.site)})`
    }
    case 'possiblyMissingElement': {
      return `uses a possibly missing array element without handling undefined (at ${formatSite(program, stop.site)})`
    }
    case 'requirementFailure': {
      return formatRequirementFailure(reason.failure, reason.callee, stop.site, program)
    }
    case 'loopLimit': {
      return `the loop at ${formatSite(program, stop.site)} did not converge after ${reason.updates} updates`
    }
    case 'nonExitingLoop': {
      return `the loop at ${formatSite(program, stop.site)} never exits on any analyzed path`
    }
    case 'unsupportedCode': {
      return `${formatUnsupportedReason(reason.reason)} at ${formatSite(program, stop.site)}`
    }
    case 'moduleRead': {
      const binding = program.moduleBindings[reason.binding]
      if (binding == null) throw new Error(`Unknown module binding ${reason.binding}`)
      switch (binding.category.kind) {
        case 'import':
        // An imported constant's slot is always seeded with its literal, so its reads never
        // stop; the case exists for exhaustiveness (demotion rewrites the category to plain
        // import before any stop could carry it here).
        case 'importedConstant':
          return `reads ${binding.name}, which is imported from another module (read at ${formatSite(program, stop.site)})`
        case 'opaque':
          return `reads ${binding.name}, whose value the analysis does not track (read at ${formatSite(program, stop.site)})`
        // A value or kind binding is always seeded inside functions, so an uninitialized
        // read of one can only happen in the initializer's own top-level code.
        case 'value':
        case 'kind':
          return `reads ${binding.name} before it is initialized (read at ${formatSite(program, stop.site)})`
      }
    }
  }
}

function formatRequirementFailure(
  failure: RequirementFailure,
  calleeID: FunctionID | null,
  stopSite: SiteID,
  program: ProgramIR,
): string {
  const origin = formatSite(program, failure.site)
  if (calleeID == null) {
    switch (failure.kind) {
      case 'elementInBounds': return `reads an element provably outside the array (at ${origin})`
      case 'nonzeroDivisor': return `${failure.operation} has a divisor that is definitely zero (at ${origin})`
      case 'finiteInput': return failure.status === 'refuted'
        ? `number input is definitely not finite (at ${origin})`
        : `could not verify the number input (at ${origin})`
      case 'declared': return failure.status === 'refuted'
        ? `declared requirement is false (at ${origin})`
        : `could not express or prove the declared requirement (at ${origin})`
    }
  }

  const callee = functionName(program, calleeID)
  const callSite = formatSite(program, stopSite)
  switch (failure.kind) {
    case 'elementInBounds':
      return `call to ${callee} makes an asserted element read definitely out of bounds (call at ${callSite}; element read at ${origin})`
    case 'nonzeroDivisor':
      return `call to ${callee} violates its nonzero divisor requirement (call at ${callSite}; ${failure.operation} at ${origin})`
    case 'finiteInput': return failure.status === 'refuted'
      ? `call to ${callee} passes a number that is definitely not finite (call at ${callSite}; input declared at ${origin})`
      : `could not verify ${callee}'s number input (call at ${callSite}; input declared at ${origin})`
    case 'declared': return failure.status === 'refuted'
      ? `call to ${callee} makes its declared requirement definitely false (call at ${callSite}; declared at ${origin})`
      : `could not express or prove ${callee}'s declared requirement (call at ${callSite}; declared at ${origin})`
  }
}

function calleeStateText(callee: FunctionAnalysis | undefined): string {
  if (callee == null) return 'which is only partially supported'
  switch (callee.kind) {
    case 'notLowered': return 'which hit unsupported code'
    case 'partial': return 'which is only partially supported'
    // The callee analyzes completely in general but could not be fully analyzed from this call —
    // because of this caller's arguments (e.g. an argument whose expression the requirement
    // language cannot name) or the module state at this point (e.g. a module binding not yet
    // initialized when top-level code makes the call).
    case 'analyzed': return 'which could not be fully analyzed for this specific call'
  }
}

function functionName(program: ProgramIR, callee: number): string {
  const fn = program.functions[callee]
  if (fn == null) throw new Error(`Unknown function ${callee}`)
  return fn.name
}

// The only place reason prose exists; everything else branches on reason.kind. The
// exhaustiveness check forces a formatting arm for every future variant.
export function formatUnsupportedReason(reason: UnsupportedReason): string {
  switch (reason.kind) {
    case 'unknownIdentifier': return `unknown identifier ${reason.name}`
    case 'missingSymbol': return 'node without a TypeScript symbol'
    case 'functionWithoutSignature': return 'function without a TypeScript signature'
    case 'functionWithoutBody': return 'function declarations need bodies'
    case 'destructuredParameter': return 'destructured parameters (take a named parameter and destructure it in the body)'
    case 'parameterType': return reason.optionalOrRestTuple
      ? `function parameter with type ${reason.typeText} (a tuple position marked optional or rest makes the runtime length a range, which is outside the analyzed subset; model the value as number[], or as a fixed tuple like [number, number])`
      : `function parameter with type ${reason.typeText}`
    case 'parameterDefaultValue': return `default value for parameter ${reason.name}; supported defaults are literals provably inside the assumed kind (= 5 for a number, = null for a nullable) — otherwise drop the default and pass the argument explicitly`
    case 'missingReturn': return 'function path without a return (add a return on every path)'
    case 'objectPropertyForm': return 'object property form (use plain data properties: name: value or shorthand)'
    case 'computedPropertyName': return 'computed object property name'
    case 'objectSpread': return 'object spread (list every field explicitly, e.g. {gain: config.gain})'
    case 'asyncOrGeneratorFunction': return 'an async or generator function (the runtime result is a Promise or iterator, not the body\'s return value)'
    case 'typePredicate': return 'a type predicate (the checker takes the predicate on faith; return a plain boolean and check properties where they are read)'
    case 'protoProperty': return 'a property named __proto__ (prototype-setting syntax at runtime, not a data property)'
    case 'enumMemberRead': return 'an enum member read (replace the enum with plain module consts, e.g. const directionUp = 1)'
    case 'prototypeMemberRead': return `read of the inherited prototype member ${reason.property} (records carry only their own data properties)`
    case 'binaryOperator': return reason.operator === 'in'
      ? 'the `in` operator (use a distinct string or boolean tag when property presence distinguishes union variants)'
      : `binary operator ${reason.operator} (supported: + - * / %, comparisons, and boolean && || !)`
    case 'call': return reason.callee === 'Object.assign'
      ? 'function call Object.assign (object mutation is outside the subset; rebuilding a plain-data record may be suitable when identity and mutation are not observed)'
      : reason.arrayMethod != null
        ? `function call ${reason.callee} (array methods are outside the subset; a for loop may suit simple dense-array aggregation)`
        : `function call ${reason.callee}`
    case 'callWithFewerArguments': return `call to ${reason.callee} with fewer arguments than parameters (pass every argument explicitly)`
    case 'callWithMoreArguments': return `call to ${reason.callee} with more arguments than its implementation declares`
    case 'nonNumberOperand': return `non-number operand of type ${reason.typeText}`
    case 'nonBooleanCondition': return `condition of type ${reason.typeText} (compare explicitly, e.g. width > 0 or mode !== undefined)`
    case 'valueType': return `value of type ${reason.typeText}`
    case 'kindChangingAssertion': return `a non-null assertion turning ${reason.fromText} into ${reason.toText}`
    case 'propertyReadOnNonObject': return `property read from ${reason.typeText}`
    case 'statementAfterReturn': return 'statements after return'
    case 'assignmentInValuePosition': return 'an assignment used as a value (write it as its own statement)'
    case 'propertyWrite': return 'a write into an object (mutation is outside the subset; rebuilding a plain-data record may be suitable when identity and mutation are not observed)'
    case 'staticAssertionForm': {
      switch (reason.problem) {
        case 'argumentCount': return 'console.assert must have exactly one condition argument'
        case 'position': return 'console.assert must be a standalone statement'
        case 'optionalCall': return 'optional console.assert calls are not supported'
        case 'directCheck': return 'console.assert must contain one direct numeric comparison using ===, !==, <, <=, >, or >=, or a supported Number check'
        case 'bindValueFirst': return 'calculate or read the value before console.assert, then check the variable'
        case 'functionCall': return 'console.assert cannot call a function inside its condition except Number.isInteger, Number.isFinite, or Number.isNaN'
        case 'callerRequirement': return 'a leading console.assert describes what callers must provide. It can compare one parameter with a fixed finite number, require one parameter to be an integer, or require a parameter or fixed-record property to be finite'
      }
    }
    case 'varDeclaration': return 'var declarations (use let or const)'
    case 'evalInFile': return 'eval appears in this file; an eval string can rewrite any binding, so no function in the file is analyzed'
    case 'typeCheckSuppressed': return 'a @ts-ignore, @ts-expect-error, or @ts-nocheck comment turns off type checking in this file, so declared types cannot be trusted and no function is analyzed'
    case 'forLoopWithoutCondition': return 'for loop without a condition'
    case 'variableDeclarationShape': return 'variables without identifier names and initializers'
    case 'expressionForm': return `expression (${reason.syntax})`
    case 'statementForm': return `statement (${reason.syntax})`
    case 'switchFallthrough': return 'switch case that falls through to the next case (end every case body with break or return)'
    case 'switchDefaultNotLast': return 'switch with a default clause before other cases (write default as the last clause)'
    case 'switchSubject': return `switch on a value of type ${reason.typeText} (only numbers and strings dispatch)`
    case 'switchLabel': return `switch case label of type ${reason.typeText} (labels must be literals matching the subject's kind)`
  }
}

function declaredReturn(value: AbstractValue, lowering: FunctionIR): AbstractValue {
  if (lowering.returnPropertyNames == null) return value
  const declared = new Set(lowering.returnPropertyNames)
  if (value.kind === 'record') {
    return {kind: 'record', properties: value.properties.filter(property => declared.has(property.name))}
  }
  if (value.kind === 'maybeNullish' && value.inner.kind === 'record') {
    return {
      ...value,
      inner: {kind: 'record', properties: value.inner.properties.filter(property => declared.has(property.name))},
    }
  }
  return value
}

function returnSummaries(path: string, value: AbstractValue, program: ProgramIR): string[] {
  switch (value.kind) {
    case 'number': return [numberSummary(path, value, program)]
    case 'boolean': return [`${path} is ${value.canBeFalse ? (value.canBeTrue ? 'boolean' : 'false') : 'true'}`]
    case 'record': {
      const summaries: string[] = []
      for (const property of value.properties) {
        summaries.push(...returnSummaries(`${path}.${property.name}`, property.value, program))
      }
      return summaries
    }
    case 'void': return []
    // No numeric claims exist about an opaque value; saying nothing is the honest line.
    case 'opaque': return []
    case 'nullish': return [`${path} is ${sentinelsText(value.sentinels)}`]
    case 'tuple': {
      const lines: string[] = [`${path}.length is exactly ${value.elements.length}`]
      for (let index = 0; index < value.elements.length; index++) {
        lines.push(...returnSummaries(`${path}[${index}]`, value.elements[index]!, program))
      }
      return lines
    }
    case 'array': {
      const lines = [numberSummary(`${path}.length`, value.length, program)]
      if (value.element != null) {
        lines.push(...returnSummaries(`${path}[each]`, value.element, program).map(line =>
          line.startsWith(`${path}[each] is `)
            ? `every ${path} element is ${line.slice(`${path}[each] is `.length)}`
            : line))
      }
      return lines
    }
    case 'taggedUnion': {
      // One line naming the possible tags, then each variant's facts qualified by its
      // tag — e.g. `return.width is a finite number (when return.type is 'sidebar')`.
      const uniqueTags: Array<string | boolean> = []
      for (const variant of value.variants) {
        if (!uniqueTags.includes(variant.tagValue)) uniqueTags.push(variant.tagValue)
      }
      const lines = [`${path}.${value.tagProperty} is ${uniqueTags.map(formatTagValue).join(' or ')}`]
      // Claims group by tag value, because the tag is all a caller can dispatch on: when
      // several variants share one tag value, or a plain-boolean tag expands into several
      // shapes, a property's claim must hold across the whole group — values join, and a
      // property only some shapes carry gets a presence qualifier. A review round caught
      // the per-variant version publishing two same-tag shapes' exclusive properties as
      // unconditional: mutually exclusive claims, at least one false on every call. The
      // tag property itself is skipped — the tags line and the qualifier already say its
      // value.
      for (const tagValue of uniqueTags) {
        const group = value.variants.filter(variant => variant.tagValue === tagValue)
        const names: string[] = []
        for (const variant of group) {
          for (const property of variant.record.properties) {
            if (property.name === value.tagProperty) continue
            if (!names.includes(property.name)) names.push(property.name)
          }
        }
        for (const name of names) {
          const carried = group
            .map(variant => recordProperty(variant.record, name))
            .filter(propertyValue => propertyValue != null)
          let joined: AbstractValue | null = null
          for (const propertyValue of carried) {
            joined = joined == null ? propertyValue : tryJoinValues(joined, propertyValue)
            if (joined == null) break
          }
          // Mixed kinds across same-tag shapes: nothing sound to say about the property.
          if (joined == null) continue
          const qualifier = value.variants.length === 1
            ? null
            : carried.length === group.length
              ? `when ${path}.${value.tagProperty} is ${formatTagValue(tagValue)}`
              : `when ${path}.${value.tagProperty} is ${formatTagValue(tagValue)} and ${path}.${name} is present`
          const summaries = returnSummaries(`${path}.${name}`, joined, program)
          lines.push(...(qualifier == null ? summaries : summaries.map(line => `${line} (${qualifier})`)))
        }
      }
      return lines
    }
    case 'maybeNullish': {
      // The inner summary describes the present case; one line states the missing case.
      // E.g. `return is null or a finite number from 0 through 100`.
      const inner = returnSummaries(path, value.inner, program)
      if (inner.length === 0) return [`${path} may be ${sentinelsText(value.sentinels)}`]
      if (inner.length === 1 && inner[0]!.startsWith(`${path} is `)) {
        return [`${path} is ${sentinelsText(value.sentinels)} or ${inner[0]!.slice(`${path} is `.length)}`]
      }
      return [`${path} may be ${sentinelsText(value.sentinels)}; when present:`, ...inner]
    }
  }
}

function sentinelsText(sentinels: 'null' | 'undefined' | 'both'): string {
  return sentinels === 'both' ? 'null or undefined' : sentinels
}

function numberSummary(path: string, value: AbstractNumber, program: ProgramIR): string {
  const kind = value.integer ? 'integer ' : ''
  // Three-way: NaN is the scarier possibility and names itself; a value that can only
  // overflow says non-finite; everything else is finite.
  const domain = value.mayBeNaN ? 'possibly NaN ' : isFiniteNumber(value) ? 'finite ' : 'possibly non-finite '
  // The blame suffix names where the degradation was born, so the line points at the
  // missing input fact instead of just shrugging. A recovered value (clamped back to a
  // clean range) prints no suffix even when the annotation lingers.
  const blameSite = value.mayBeNaN ? value.nanSite : value.nonFiniteSite
  const blame = blameSite == null || (isFiniteNumber(value) && !value.mayBeNaN)
    ? ''
    : value.mayBeNaN
      ? ` (NaN possible from the operation at ${formatSite(program, blameSite)})`
      : ` (can overflow at ${formatSite(program, blameSite)})`
  const subject = `${path} is a ${domain}${kind}number`
  // A point interval is an exact value (`return 0.1 + 0.2` is exactly
  // 0.30000000000000004); rewriting either bound into strict phrasing would print an
  // absurd range around a constant, so the rewrite only applies to genuine ranges.
  const pointInterval = value.lower === value.upper
  const strictLower = pointInterval ? null : strictBoundWords(value.lower, 'lower')
  const strictUpper = pointInterval ? null : strictBoundWords(value.upper, 'upper')
  if (value.lower === -Number.MAX_VALUE && value.upper === Number.MAX_VALUE) return `${subject}${blame}`
  if (value.upper === Number.MAX_VALUE) {
    return `${subject} ${strictLower ?? `at least ${formatNumber(value.lower)}`}${blame}`
  }
  if (value.lower === -Number.MAX_VALUE) {
    return `${subject} ${strictUpper ?? `at most ${formatNumber(value.upper)}`}${blame}`
  }
  if (strictLower != null || strictUpper != null) {
    const low = strictLower ?? `at least ${formatNumber(value.lower)}`
    const high = strictUpper ?? `at most ${formatNumber(value.upper)}`
    return `${subject} ${low} and ${high}${blame}`
  }
  return `${subject} from ${formatNumber(value.lower)} through ${formatNumber(value.upper)}${blame}`
}

// A strict comparison refines a float bound to the adjacent representable double, which
// prints hideously (`if (x > 0)` gives lower bound 5e-324, `if (x < 100)` gives upper
// bound 99.99999999999999). When stepping the bound back lands on a visibly simpler
// number, the strict phrasing says the same thing readably: 'more than 0', 'less than
// 100'. Bounds that already print plainly return null and keep the ordinary phrasing.
function strictBoundWords(bound: number, side: 'lower' | 'upper'): string | null {
  const stepped = side === 'lower' ? nextDown(bound) : nextUp(bound)
  // The margin is deliberately wide: only rewrite when the stepped form is drastically
  // shorter (5e-324 -> 0, 99.99999999999999 -> 100), never for a computed bound whose
  // neighbor happens to print a digit or two shorter.
  if (formatNumber(stepped).length + 4 <= formatNumber(bound).length) {
    return `${side === 'lower' ? 'more than' : 'less than'} ${formatNumber(stepped)}`
  }
  return null
}

// Infinite bounds are expected here; String renders them as 'Infinity'/'-Infinity'.
function formatNumber(value: number): string {
  return String(value)
}
