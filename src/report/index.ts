import {nextDown, nextUp, isFiniteNumber, type AbstractNumber} from '../domain/number.ts'
import {recordProperty, tryJoinValues, type AbstractValue} from '../domain/value.ts'
import type {FunctionAnalysis, ProgramAnalysis, Stop} from '../engine/outcome.ts'
import type {FunctionID} from '../ir/ids.ts'
import type {BoundsAssumption} from '../requirements/model.ts'
import {declaredKindOf, formatSite, reportPath, type DeclaredKind, type FunctionIR, type ProgramIR, type UnsupportedReason} from '../ir/program.ts'
import {formatObservedNeed, formatPrecondition} from './format-requirement.ts'

export type FunctionReport =
  | {kind: 'analyzed'; name: string; assumptions: string[]; requires: string[]; ensures: string[]}
  // e.g. 'unknown identifier scheduledRender at /abs/demo/index.ts:6:7'
  | {kind: 'unsupported'; name: string; unsupported: string}
  // Some path stopped; `observed` lines are evidence from the paths that completed, never a
  // contract. e.g. stopped: 'recursive call to countdown (call at /abs/file.ts:3:10)',
  // observed: 'return is a finite integer number from 0 through 0'.
  | {kind: 'partial'; name: string; assumptions: string[]; stopped: string[]; skipped?: string[]; observed: string[]}

export type AnalysisReport = {
  file: string
  functions: FunctionReport[]
}

export function createReport(program: ProgramIR, analysis: ProgramAnalysis): AnalysisReport {
  const functions: FunctionReport[] = []
  const {assumedBindings, readsModules} = functionModuleUsage(program, analysis)
  // An unproven asserted element read at the top level (`breakpoints[idx]!` with a
  // platform-derived idx) conditions everything the initializer published, and the
  // initializer usually prints no entry — so the assumption lines travel to every
  // function that reads any module binding, the same way declared-kind assumptions do.
  // Without this, a reader's ensures would publish unconditionally while the runtime
  // read can miss.
  const initializerBounds = analysis.initializer.kind === 'analyzed'
    ? analysis.initializer.boundsAssumptions
    : analysis.initializer.kind === 'partial' ? analysis.initializer.observedBoundsAssumptions : []
  const initializerBoundsLines = initializerBounds.map(assumption => formatBoundsAssumption(assumption, program))
  // Top-level code runs before any function, so its entry comes first — but only when it
  // stopped or skipped statements. A fully analyzed initializer with nothing skipped is
  // invisible: its results show up as the exact module values other entries report, with
  // its bounds assumptions carried by the readers above.
  const skippedLines = program.initializerSkips.map(skip =>
    `${formatUnsupportedReason(skip.reason)} at ${formatSite(program, skip.site)}`)
  if (analysis.initializer.kind === 'partial' || skippedLines.length > 0) {
    const observed: string[] = []
    if (analysis.initializer.kind === 'partial') {
      for (const need of analysis.initializer.observedNeeds) observed.push(formatObservedNeed(need, [], program))
    }
    functions.push({
      kind: 'partial',
      name: program.initializer.name,
      assumptions: initializerBoundsLines,
      stopped: analysis.initializer.kind === 'partial'
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
        const parameterNames = lowering.parameters.map(parameter => parameter.name)
        const observed: string[] = []
        if (fn.observedReturn != null) {
          observed.push(...returnSummaries('return', declaredReturn(fn.observedReturn.value, lowering), program))
        }
        for (const need of fn.observedNeeds) observed.push(formatObservedNeed(need, parameterNames, program))
        functions.push({
          kind: 'partial',
          name: lowering.name,
          assumptions: [
            ...assumptionLines(lowering, program, assumedBindings[functionID]!, fn.observedBoundsAssumptions),
            ...(readsModules[functionID] === true ? initializerBoundsLines : []),
          ],
          stopped: fn.stops.map(stop => formatStop(stop, program, analysis)),
          observed,
        })
        break
      }
      case 'analyzed': {
        const lowering = fn.lowering
        const parameterNames = lowering.parameters.map(parameter => parameter.name)
        functions.push({
          kind: 'analyzed',
          name: lowering.name,
          assumptions: [
            ...assumptionLines(lowering, program, assumedBindings[functionID]!, fn.boundsAssumptions),
            ...(readsModules[functionID] === true ? initializerBoundsLines : []),
          ],
          requires: fn.preconditions.map(precondition => formatPrecondition(precondition, parameterNames, program)),
          ensures: returnSummaries('return', declaredReturn(fn.returnValue, lowering), program),
        })
        break
      }
    }
  }
  return {file: reportPath(program), functions}
}

// The legend targets a reader — usually another model — that has never seen a freerange
// report: each line kind in one sentence, so the report is self-describing. Exported so
// project runs (the survey) can write it ONCE per run instead of per file — it was 28% of
// the report corpus, and every reader learned to skip it.
export const reportLegend = [
  '# freerange: static analysis of the numeric behavior of each top-level function.',
  '# requires: conditions the caller must make true; given them, the ensures lines hold.',
  '# ensures:  guarantees about the returned value whenever the function returns.',
  '# assumes:  input conditions accepted without proof; no other line holds unless these do.',
  '# unsupported: the function uses code outside the analyzed subset; the message names the construct and may include a short conditional hint.',
  '# stopped:  analysis halted partway on some path; the entry describes only what ran before the stop.',
  '# skipped:  a top-level statement the module analysis stepped over; anything it could write is distrusted.',
  '# on analyzed paths: evidence from the paths that completed - not a guarantee for the whole function.',
].join('\n')

// Within an entry, line kinds print rarest-and-most-actionable first: requires (what the
// caller must arrange), ensures (what it gets), assumes (what is being trusted — the
// bulkiest kind, and the one every reader scans past to reach the other two).
export function formatReport(report: AnalysisReport, options?: {legend?: boolean; file?: boolean}): string {
  const lines: string[] = []
  if (options?.legend !== false) lines.push(reportLegend)
  if (options?.file !== false) lines.push(report.file)
  for (const fn of report.functions) {
    if (lines.length > 0) lines.push('')
    lines.push(fn.name)
    switch (fn.kind) {
      case 'analyzed': {
        for (const precondition of fn.requires) lines.push(`  requires: ${precondition}`)
        for (const guarantee of fn.ensures) lines.push(`  ensures: ${guarantee}`)
        for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
        break
      }
      case 'unsupported': {
        lines.push(`  unsupported: ${fn.unsupported}`)
        break
      }
      case 'partial': {
        for (const assumption of fn.assumptions) lines.push(`  assumes: ${assumption}`)
        for (const stop of fn.stopped) lines.push(`  stopped: ${stop}`)
        for (const skip of fn.skipped ?? []) lines.push(`  skipped: ${skip}`)
        for (const evidence of fn.observed) lines.push(`  on analyzed paths: ${evidence}`)
        break
      }
    }
  }
  return lines.join('\n')
}


// A string tag prints quoted ('lightbox'); a boolean tag prints bare (true), matching how
// each is written in the type.
function formatTagValue(tagValue: string | boolean): string {
  return typeof tagValue === 'string' ? `'${tagValue}'` : String(tagValue)
}

function assumptionLines(
  fn: FunctionIR,
  program: ProgramIR,
  assumedBindings: boolean[],
  boundsAssumptions: BoundsAssumption[],
): string[] {
  const assumptions: string[] = []
  for (const parameter of fn.parameters) {
    pushRootAssumptions(parameter.name, parameter.type, assumptions)
  }
  for (let bindingID = 0; bindingID < program.moduleBindings.length; bindingID++) {
    if (assumedBindings[bindingID] !== true) continue
    const binding = program.moduleBindings[bindingID]!
    const declaredKind = declaredKindOf(binding.category)
    if (declaredKind == null) throw new Error(`Module binding ${binding.name} has no declared kind to assume`)
    pushRootAssumptions(binding.name, declaredKind, assumptions)
  }
  for (const assumption of boundsAssumptions) {
    // The engine could not prove the asserted element read in bounds; the entry's
    // guarantees rest on it. E.g. `the element read at demo.ts:4:10 is in bounds`, or,
    // for a divisor no requirement could name, `the divisor at demo.ts:4:10 is nonzero`.
    assumptions.push(formatBoundsAssumption(assumption, program))
  }
  return assumptions
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
function pushRootAssumptions(path: string, declared: DeclaredKind, assumptions: string[]): void {
  const folds = numberLeafCount(declared) >= 3 && declared.kind !== 'number'
  if (folds) assumptions.push(`every property declared as a number in ${path} holds a finite non-NaN number`)
  if (declared.kind === 'record'
    && declared.properties.filter(property => property.declared.kind === 'array').length >= 3) {
    assumptions.push(`every property declared as an array in ${path} holds a plain array — its length counts its elements, and every index below the length holds an element`)
    for (const property of declared.properties) {
      pushDeclaredAssumptions(`${path}.${property.name}`, property.declared, assumptions, {
        skipNumberLeaves: folds,
        skipOwnArrayLine: property.declared.kind === 'array',
      })
    }
    return
  }
  pushDeclaredAssumptions(path, declared, assumptions, {skipNumberLeaves: folds, skipOwnArrayLine: false})
}

// Counts the number leaves the fold may cover. Nullish subtrees count zero: their leaves
// keep exact per-leaf lines whether or not the root folds.
function numberLeafCount(declared: DeclaredKind): number {
  switch (declared.kind) {
    case 'number': return 1
    case 'boolean': return 0
    case 'opaque': return 0
    case 'nullish': return 0
    case 'array': return numberLeafCount(declared.element)
    case 'tuple': {
      let count = 0
      for (const element of declared.elements) count += numberLeafCount(element)
      return count
    }
    case 'record': {
      let count = 0
      for (const property of declared.properties) count += numberLeafCount(property.declared)
      return count
    }
    // Tagged unions never fold: their per-leaf lines carry the `(when route.type is ...)`
    // qualifier scoping each assumption to its variant, which one folded line cannot
    // express — a legal value of one variant has no values in the other variants' slots,
    // so an unqualified declaration-wide assertion is violated by every legal value,
    // while a presence-scoped one is vacuous for a wrong-shape smuggle (a review round
    // ran both failures).
    case 'taggedUnion': return 0
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
// condition on each of its properties, e.g. `pointer.x is finite and not NaN`.
function pushDeclaredAssumptions(path: string, declared: DeclaredKind, assumptions: string[], options: AssumptionOptions = exactLeaves): void {
  switch (declared.kind) {
    case 'number': {
      if (!options.skipNumberLeaves) assumptions.push(`${path} is finite and not NaN`)
      break
    }
    case 'boolean': assumptions.push(`${path} is a boolean`); break
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
      assumptions.push(`${path} is a plain array of exactly ${count} element${count === 1 ? '' : 's'} — its length counts its elements, and every index below the length holds an element`)
      for (let index = 0; index < declared.elements.length; index++) {
        pushDeclaredAssumptions(`${path}[${index}]`, declared.elements[index]!, assumptions, options)
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
      if (!options.skipOwnArrayLine) {
        assumptions.push(`${path} is a plain array — its length counts its elements, and every index below the length holds an element`)
      }
      // E.g. `every values element is finite and not NaN`. The recursion path uses
      // `[each]` so nesting stays readable: a number[][] parameter prints
      // `every grid[each] element is finite and not NaN`, and a record element prints
      // its property path, e.g. `points[each].x is finite and not NaN`. The nested
      // plain-array line rides the same sugar: `every grid element is a plain array — ...`.
      const leaf: string[] = []
      pushDeclaredAssumptions(`${path}[each]`, declared.element, leaf, {skipNumberLeaves: options.skipNumberLeaves, skipOwnArrayLine: false})
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
      const sentinelWords = declared.sentinels === 'both' ? 'null or undefined' : declared.sentinels
      if (declared.inner.kind === 'number') {
        // E.g. `animatedUntilTime is null or a finite non-NaN number`. Never folded: the
        // folded line's kind assertion would wrongly forbid the legal null.
        assumptions.push(`${path} is ${sentinelWords} or a finite non-NaN number`)
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
        pushDeclaredAssumptions(path, declared.inner, leaf, exactLeaves)
        for (const line of leaf) assumptions.push(`${path} is ${sentinelWords} or ${line}`)
      }
      break
    }
    case 'record': {
      for (const property of declared.properties) {
        pushDeclaredAssumptions(`${path}.${property.name}`, property.declared, assumptions, options)
      }
      break
    }
    case 'taggedUnion': {
      // Per-variant leaf lines, each qualified by the tag — e.g. `route.index is finite
      // and not NaN (when route.type is 'lightbox')`. The tag property itself is skipped:
      // a string tag is an opaque leaf with no line anyway, and a boolean tag's "ok is a
      // boolean" would restate what the qualifier already pins. When several variants
      // share one tag value (two shapes told apart by an in-check, or the expansion of a
      // plain-boolean tag), the tag alone does not pin the shape, so each line adds a
      // presence qualifier — the assumption then speaks only about values that actually
      // carry the property.
      for (const variant of declared.variants) {
        const sharedTag = declared.variants.filter(candidate => candidate.tagValue === variant.tagValue).length > 1
        const leaf: string[] = []
        for (const property of variant.properties) {
          if (property.name === declared.tagProperty) continue
          const qualifier = sharedTag
            ? `when ${path}.${declared.tagProperty} is ${formatTagValue(variant.tagValue)} and ${path}.${property.name} is present`
            : `when ${path}.${declared.tagProperty} is ${formatTagValue(variant.tagValue)}`
          const perProperty: string[] = []
          pushDeclaredAssumptions(`${path}.${property.name}`, property.declared, perProperty, exactLeaves)
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

// Per function: the module bindings whose declared-kind seeding the result rests on, and
// whether the function reads any module binding at all. Both facts travel through calls.
// The first prints the conditions under which guarantees hold; the second carries a
// top-level bounds assumption to every consumer of the initializer's values. Closing over
// a static call edge that never executes can only add a harmless assumption line.
function functionModuleUsage(
  program: ProgramIR,
  analysis: ProgramAnalysis,
): {assumedBindings: boolean[][]; readsModules: boolean[]} {
  const assumedBindings: boolean[][] = []
  const readsModules: boolean[] = []
  const callees: FunctionID[][] = []
  for (const lowering of program.functions) {
    const reads: boolean[] = []
    let readsAny = false
    const calls: FunctionID[] = []
    if (lowering.kind === 'lowered') {
      for (const block of lowering.blocks) {
        for (const instruction of block.instructions) {
          if (instruction.kind === 'call' && !calls.includes(instruction.function)) calls.push(instruction.function)
          if (instruction.kind !== 'moduleRead') continue
          readsAny = true
          if (analysis.moduleValues[instruction.binding] != null) continue
          const binding = program.moduleBindings[instruction.binding]
          if (binding == null) throw new Error(`Unknown module binding ${instruction.binding}`)
          if (declaredKindOf(binding.category) != null) {
            reads[instruction.binding] = true
          }
        }
      }
    }
    assumedBindings.push(reads)
    readsModules.push(readsAny)
    callees.push(calls)
  }
  // Call graphs can have cycles. Propagate both facts over the same graph until stable:
  // callers inherit the module assumptions and initializer dependencies of their callees.
  let changed = true
  while (changed) {
    changed = false
    for (let caller = 0; caller < assumedBindings.length; caller++) {
      for (const callee of callees[caller]!) {
        if (readsModules[callee] === true && readsModules[caller] !== true) {
          readsModules[caller] = true
          changed = true
        }
        const calleeAssumed = assumedBindings[callee]!
        for (let bindingID = 0; bindingID < calleeAssumed.length; bindingID++) {
          if (calleeAssumed[bindingID] === true && assumedBindings[caller]![bindingID] !== true) {
            assumedBindings[caller]![bindingID] = true
            changed = true
          }
        }
      }
    }
  }
  return {assumedBindings, readsModules}
}

// The only place stop prose exists; everything else branches on reason.kind.
function formatStop(stop: Stop, program: ProgramIR, analysis: ProgramAnalysis): string {
  const reason = stop.reason
  switch (reason.kind) {
    case 'recursion': {
      return `recursive call to ${functionName(program, reason.callee)} (call at ${formatSite(program, stop.site)})`
    }
    case 'calleeStopped': {
      // A merely stopped callee did not itself hit unsupported code; saying so would send an
      // agent hunting through a body whose constructs all lower.
      const calleeState = calleeStateText(analysis.functions[reason.callee])
      return `calls ${functionName(program, reason.callee)}, ${calleeState} (call at ${formatSite(program, stop.site)})`
    }
    case 'outOfBoundsRead': {
      return `reads an element provably outside the array (at ${formatSite(program, stop.site)})`
    }
    case 'unmodeledNarrowing': {
      return `narrows a value in a way the analysis does not model (at ${formatSite(program, stop.site)})`
    }
    case 'possiblyMissingElement': {
      return `uses a possibly missing array element without handling undefined (at ${formatSite(program, stop.site)})`
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

function calleeStateText(callee: FunctionAnalysis | undefined): string {
  if (callee == null) return 'whose analysis stopped'
  switch (callee.kind) {
    case 'notLowered': return 'which hit unsupported code'
    case 'partial': return 'whose analysis stopped'
    // The callee analyzes completely in general but stopped when evaluated from this call —
    // because of this caller's arguments (e.g. an argument whose expression the requirement
    // language cannot name) or the module state at this point (e.g. a module binding not yet
    // initialized when top-level code makes the call).
    case 'analyzed': return 'whose analysis stopped for this specific call'
  }
}

function functionName(program: ProgramIR, callee: number): string {
  const fn = program.functions[callee]
  if (fn == null) throw new Error(`Unknown function ${callee}`)
  return fn.name
}

// The only place reason prose exists; everything else branches on reason.kind. The
// exhaustiveness check forces a formatting arm for every future variant.
function formatUnsupportedReason(reason: UnsupportedReason): string {
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
    case 'objectPropertyForm': return 'object property form (use plain data properties: name: value, shorthand, or spread)'
    case 'computedPropertyName': return 'computed object property name'
    case 'spreadAfterProperties': return 'a spread after other entries (the spread value can carry extra properties that override earlier entries at runtime; write the spread first, then override with explicit properties)'
    case 'spreadOfExternalRecord': return 'a spread of a record the analysis cannot trace to a record literal built in this function (an external record — a parameter, a module binding, a call result — can hold its properties on a getter or the prototype, and object spread copies only own enumerable properties, leaving such a copy empty; a local record reassigned across branches or loop iterations also cannot be traced; to build exactly the declared record shape, list the fields explicitly, e.g. {gain: config.gain} instead of {...config})'
    case 'asyncOrGeneratorFunction': return 'an async or generator function (the runtime result is a Promise or iterator, not the body\'s return value)'
    case 'typePredicate': return 'a type predicate (the checker takes the predicate on faith; return a plain boolean and check properties where they are read)'
    case 'protoProperty': return 'a property named __proto__ (prototype-setting syntax at runtime, not a data property)'
    case 'enumMemberRead': return 'an enum member read (replace the enum with plain module consts, e.g. const directionUp = 1)'
    case 'prototypeMemberRead': return `read of the inherited prototype member ${reason.property} (records carry only their own data properties)`
    case 'binaryOperator': return `binary operator ${reason.operator} (supported: + - * / %, comparisons, and boolean && || !)`
    case 'call': return reason.callee === 'Object.assign'
      ? 'function call Object.assign (object mutation is outside the subset; rebuilding a plain-data record may be suitable when identity and mutation are not observed)'
      : reason.arrayMethod != null
        ? `function call ${reason.callee} (array methods are outside the subset; a for loop may suit simple dense-array aggregation)`
        : `function call ${reason.callee}`
    case 'callWithFewerArguments': return `call to ${reason.callee} with fewer arguments than parameters (pass every argument explicitly)`
    case 'nonNumberOperand': return `non-number operand of type ${reason.typeText}`
    case 'nonBooleanCondition': return `condition of type ${reason.typeText} (compare explicitly, e.g. width > 0 or mode !== undefined)`
    case 'valueType': return `value of type ${reason.typeText}`
    case 'kindChangingAssertion': return `a non-null assertion turning ${reason.fromText} into ${reason.toText}`
    case 'propertyReadOnNonObject': return `property read from ${reason.typeText}`
    case 'statementAfterReturn': return 'statements after return'
    case 'assignmentInValuePosition': return 'an assignment used as a value (write it as its own statement)'
    case 'propertyWrite': return 'a write into an object (mutation is outside the subset; rebuilding a plain-data record may be suitable when identity and mutation are not observed)'
    case 'varDeclaration': return 'var declarations (use let or const)'
    case 'evalInFile': return 'eval appears in this file; an eval string can rewrite any binding, so no function in the file is analyzed'
    case 'typeCheckSuppressed': return 'a @ts-ignore, @ts-expect-error, or @ts-nocheck comment turns off type checking in this file, so declared types cannot be trusted and no function is analyzed'
    case 'forLoopWithoutCondition': return 'for loop without a condition'
    case 'forLoopWithoutIncrementor': return 'for loop without an incrementor'
    case 'variableDeclarationShape': return 'variables without identifier names and initializers'
    case 'expressionForm': return `expression (${reason.syntax})`
    case 'statementForm': return `statement (${reason.syntax})`
    case 'switchFallthrough': return 'switch case that falls through to the next case (end every case body with break or return)'
    case 'switchDefaultNotLast': return 'switch with a default clause before other cases (write default as the last clause)'
    case 'switchSubject': return `switch on a value of type ${reason.typeText} (only numbers and strings dispatch)`
    case 'switchLabel': return `switch case label of type ${reason.typeText} (labels must be literals matching the subject's kind)`
  }
}

// The contract covers only what the declared return type exposes: a wider returned
// record's extra properties are true facts, but not ones any type-checked caller can read.
function declaredReturn(value: AbstractValue, lowering: FunctionIR): AbstractValue {
  if (lowering.returnPropertyNames == null) return value
  const declared = new Set(lowering.returnPropertyNames)
  if (value.kind === 'record') {
    return {kind: 'record', properties: value.properties.filter(property => declared.has(property.name))}
  }
  // A {w: number} | null return carries the record inside the wrapper.
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
      // several variants share one tag value (shapes told apart by an in-check, or the
      // expansion of a plain-boolean tag), a property's claim must hold across the whole
      // group — values join, and a property only some shapes carry gets a presence
      // qualifier. A review round caught the per-variant version publishing two same-tag
      // shapes' exclusive properties as unconditional: mutually exclusive claims, at
      // least one false on every call. The tag property itself is skipped — the tags
      // line and the qualifier already say its value.
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
