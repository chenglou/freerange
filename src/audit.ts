import type {AssertionVerdict, ProgramAnalysis, Stop, StopReason} from './engine/outcome.ts'
import type {SiteID} from './ir/ids.ts'
import {
  formatSite,
  reportPath,
  type ProgramIR,
  type UnsupportedReason,
} from './ir/program.ts'
import type {
  BoundsAssumption,
  InferredPrecondition,
  NumericExpression,
} from './requirements/model.ts'
import {createReport, formatReport, type AnalysisReport} from './report/index.ts'

type RefactorGuideShape = {
  id: string
  title: string
  summary: string
  applicability: string
  behavior: string
  before: string
  after: string
  result: string
}

export const refactorGuides = [
  {
    id: 'guard-derived-value',
    title: 'Check the exact divisor',
    summary: 'Check the value used as the divisor. If the divisor is an expression, give that expression a name first.',
    applicability: 'The function already defines what should happen when the divisor is zero. If zero is invalid input, keep the caller requirement instead.',
    behavior: 'The extra check does not change this example\'s behavior; it restates the existing equality guard in the exact form Freerange follows. If the code has no zero case yet, choosing a fallback or throwing an error does change behavior.',
    before: `export function remap(value: number, oldMin: number, oldMax: number, newMin: number, newMax: number): number {
  if (oldMin === oldMax) return (newMin + newMax) / 2
  return (value - oldMin) / (oldMax - oldMin) * (newMax - newMin) + newMin
}`,
    after: `export function remap(value: number, oldMin: number, oldMax: number, newMin: number, newMax: number): number {
  const oldSpan = oldMax - oldMin
  if (oldMin === oldMax) return (newMin + newMax) / 2
  if (oldSpan === 0) return (newMin + newMax) / 2
  return (value - oldMin) / oldSpan * (newMax - newMin) + newMin
}`,
    result: 'The divisor is proven nonzero at the operation, so the corresponding requirement or assumption disappears.',
  },
  {
    id: 'encode-input-rule',
    title: 'Encode a real input rule where the calculation begins',
    summary: 'Turn a domain rule such as "column count is a positive integer" into code once, before downstream calculations use it.',
    applicability: 'The function or API defines the rule. A count may reasonably be floored; a general measurement may not. Otherwise return an error or keep a caller requirement.',
    behavior: 'The rewrite changes fractional and nonpositive column counts. It is correct only when those inputs are outside the intended domain. Math.floor and Math.max do not recover NaN, so validate NaN when it can arrive at runtime.',
    before: `export function perColumn(total: number, columnCount: number): number {
  if (columnCount === 0) return 0
  return total / columnCount
}`,
    after: `export function perColumn(total: number, columnCount: number): number {
  const columns = Math.max(1, Math.floor(columnCount))
  return total / columns
}`,
    result: 'The return changes from possibly infinite to finite because columns is an integer of at least 1.',
  },
  {
    id: 'use-direct-operands',
    title: 'Use guarded dimensions directly instead of dividing by a ratio',
    summary: 'A positive ratio can still round down to zero. Guard the original dimensions and divide by one of those values directly.',
    applicability: 'The values are dimensions or another quantity where the fallback and minimum are real product rules. If precision-sensitive code chose a particular evaluation order, keep that order.',
    behavior: 'The rewrite changes nonpositive dimensions and can change the last few floating-point bits for valid inputs. Math.max does not recover NaN. Multiplication can still overflow, so this removes the ratio division hazard rather than promising a finite result for every magnitude.',
    before: `export function fittedHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  const aspectRatio = imageWidth / imageHeight
  return frameWidth / aspectRatio
}`,
    after: `export function fittedHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  const width = Math.max(1, imageWidth)
  const height = Math.max(1, imageHeight)
  return (frameWidth * height) / width
}`,
    result: 'The two nonzero requirements and the possible NaN disappear. The report still allows overflow from the multiplication.',
  },
  {
    id: 'write-explicit-condition',
    title: 'Write the numeric case explicitly',
    summary: 'Replace number truthiness with the exact comparison that expresses the intended case.',
    applicability: 'The code means a specific numeric condition, such as zero. Choose a different comparison for positivity, finiteness, or another rule.',
    behavior: 'The example matches the original for finite numbers. It differs for NaN, which TypeScript does not exclude at runtime even though Freerange lists finite, non-NaN inputs as an assumption.',
    before: `export function safeWidth(width: number): number {
  return width || 1
}`,
    after: `export function safeWidth(width: number): number {
  return width === 0 ? 1 : width
}`,
    result: 'The unsupported truthiness condition becomes an exact finite-number contract.',
  },
  {
    id: 'use-loop-for-aggregation',
    title: 'Use an explicit loop for dense-array aggregation',
    summary: 'For a simple aggregation, a for loop exposes the accumulator and each numeric step.',
    applicability: 'The code is a simple aggregation with an explicit initial value, the array is dense and is not mutated during traversal, and callback receiver, index, and side effects do not matter. This is not a general rewrite for map, filter, sparse arrays, or callbacks with observable behavior.',
    behavior: 'Array.reduce skips holes; an indexed for loop reads them as undefined. The two examples agree for dense number arrays but differ for sparse arrays. A reduction without an initial value also has different empty-array behavior.',
    before: `export function total(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0)
}`,
    after: `export function total(values: number[]): number {
  let sum = 0
  for (let index = 0; index < values.length; index++) {
    sum += values[index]!
  }
  return sum
}`,
    result: 'The explicit loop analyzes. Its result may still overflow, which the contract states honestly.',
  },
  {
    id: 'handle-missing-element',
    title: 'Handle a possibly missing array element',
    summary: 'A bare array read may be undefined even when the project\'s TypeScript settings show a plain element type. Handle the missing case before using the value.',
    applicability: 'Use a fallback only when it is real application behavior. If an invalid index is a bug, validate the index or throw instead. Use a non-null assertion only when another invariant guarantees a dense, in-bounds element.',
    behavior: 'The example changes an out-of-bounds or sparse read from NaN to 1. Choose a fallback that matches the application; a bounds check alone does not detect a hole in a sparse array.',
    before: `export function incrementAt(values: number[], index: number): number {
  return values[index] + 1
}`,
    after: `export function incrementAt(values: number[], index: number): number {
  const value = values[index] ?? 0
  return value + 1
}`,
    result: 'The addition receives a number, so analysis can continue through the function.',
  },
  {
    id: 'guard-array-index',
    title: 'Check an asserted array index',
    summary: 'Before using values[index]!, prove that the index is an integer inside the array bounds.',
    applicability: 'The function defines the invalid-index behavior. If callers guarantee the index instead, keep the generated requirement or assumption and test that invariant.',
    behavior: 'The example changes an invalid read from undefined at runtime to 0. A throw or another fallback may be the correct policy instead.',
    before: `export function valueAt(values: number[], index: number): number {
  return values[index]!
}`,
    after: `export function valueAt(values: number[], index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return 0
  return values[index]!
}`,
    result: 'The read is proven in bounds, so the corresponding requirement or assumption disappears.',
  },
] as const satisfies readonly RefactorGuideShape[]

export type RefactorGuide = (typeof refactorGuides)[number]
export type RefactorGuideID = RefactorGuide['id']

export type AuditCoverage = {
  functions: number
  analyzed: number
  partial: number
  unsupported: number
  initializer: 'analyzed' | 'partial'
  initializerSkips: number
}

export type AuditReason =
  | {kind: 'requires'; precondition: InferredPrecondition}
  | {kind: 'assumes'; assumption: BoundsAssumption}
  | {kind: 'assertion'; assertion: AssertionVerdict}
  | {kind: 'staticAnnotationIssue'; issue: ProgramIR['staticAnnotationIssues'][number]}
  | {kind: 'unsupported'; reason: UnsupportedReason}
  | {kind: 'stopped'; reason: StopReason}
  | {kind: 'skipped'; reason: UnsupportedReason}

export type AuditReference = {
  functionName: string
  location: string
  span: {start: number; end: number}
  reason: AuditReason
  guideIDs: RefactorGuideID[]
}

export type FileAudit = {
  file: string
  coverage: AuditCoverage
  contracts: AnalysisReport
  references: AuditReference[]
  guideIDs: RefactorGuideID[]
}

export function createFileAudit({program, analysis}: {program: ProgramIR; analysis: ProgramAnalysis}): FileAudit {
  const contracts = createReport(program, analysis)
  let analyzed = 0
  let partial = 0
  let unsupported = 0
  const references: AuditReference[] = []

  const addReference = (
    functionName: string,
    site: SiteID,
    reason: AuditReason,
  ): void => {
    const span = program.sites[site]
    if (span == null) throw new Error(`Unknown site ${site}`)
    references.push({
      functionName,
      location: formatSite(program, site),
      span: {...span},
      reason,
      guideIDs: guidesForReason(reason),
    })
  }

  const addStop = (functionName: string, stop: Stop): void => {
    addReference(functionName, stop.site, {kind: 'stopped', reason: stop.reason})
  }

  const addPrecondition = (functionName: string, precondition: InferredPrecondition): void => {
    addReference(functionName, precondition.site, {kind: 'requires', precondition})
  }

  const addAssumption = (functionName: string, assumption: BoundsAssumption): void => {
    addReference(functionName, assumption.site, {kind: 'assumes', assumption})
  }

  const addAssertion = (functionName: string, assertion: AssertionVerdict): void => {
    addReference(functionName, assertion.site, {kind: 'assertion', assertion})
  }

  for (const fn of analysis.functions) {
    switch (fn.kind) {
      case 'analyzed': {
        analyzed++
        for (const precondition of fn.preconditions) addPrecondition(fn.lowering.name, precondition)
        for (const assumption of fn.boundsAssumptions) addAssumption(fn.lowering.name, assumption)
        for (const assertion of fn.assertions) addAssertion(fn.lowering.name, assertion)
        break
      }
      case 'partial': {
        partial++
        for (const precondition of fn.observedNeeds) addPrecondition(fn.lowering.name, precondition)
        for (const assumption of fn.observedBoundsAssumptions) addAssumption(fn.lowering.name, assumption)
        for (const assertion of fn.assertions) addAssertion(fn.lowering.name, assertion)
        for (const stop of fn.stops) addStop(fn.lowering.name, stop)
        break
      }
      case 'notLowered': {
        unsupported++
        addReference(
          fn.lowering.name,
          fn.lowering.site,
          {kind: 'unsupported', reason: fn.lowering.reason},
        )
        break
      }
    }
  }

  if (analysis.initializer.kind === 'partial') {
    for (const precondition of analysis.initializer.observedNeeds) {
      addPrecondition(program.initializer.name, precondition)
    }
    for (const assumption of analysis.initializer.observedBoundsAssumptions) {
      addAssumption(program.initializer.name, assumption)
    }
    for (const stop of analysis.initializer.stops) addStop(program.initializer.name, stop)
  }
  for (const assertion of analysis.initializer.assertions) {
    addAssertion(program.initializer.name, assertion)
  }
  for (const issue of program.staticAnnotationIssues) {
    addReference(
      program.initializer.name,
      issue.site,
      {kind: 'staticAnnotationIssue', issue},
    )
  }
  for (const skip of program.initializerSkips) {
    addReference(
      program.initializer.name,
      skip.site,
      {kind: 'skipped', reason: skip.reason},
    )
  }

  const initializer = analysis.initializer.kind
  const functions = analysis.functions.length
  const initializerSkips = program.initializerSkips.length
  references.sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end)
  const guideIDs: RefactorGuideID[] = []
  for (const reference of references) {
    for (const guideID of reference.guideIDs) {
      if (!guideIDs.includes(guideID)) guideIDs.push(guideID)
    }
  }
  return {
    file: reportPath(program),
    coverage: {
      functions,
      analyzed,
      partial,
      unsupported,
      initializer,
      initializerSkips,
    },
    contracts,
    references,
    guideIDs,
  }
}

// Prose every audit run prints once, above the per-file units: what the analysis covers,
// what each contract line kind means, and how to treat the refactoring suggestions. Both
// `fr --audit` and `fr --audit <file>` print it, so a file's unit below stays identical
// between the two outputs.
export const auditPreamble = [
  'Freerange tracks number ranges, integer values, NaN, Infinity, and supported branch checks through synchronous named top-level function declarations. It does not guess through unknown calls, callback order, mutation through aliases, or arbitrary algebraic relationships between separately computed values. Reports assume that repeated reads of a property stay stable during one analyzed calculation.',
  '',
  'Each file below gets one unit: its result for each function, then the refactoring suggestions that apply to it. In a contract entry, `requires` are caller conditions; `ensures` hold when the function returns and its `requires` and `assumes` are true; `assumes` are input conditions accepted without proof; `proves` shows a successful console.assert. Unproven, failing, blocked, and unreachable assertions are shown explicitly. An `unsupported` entry names the first construct outside the analyzed subset. Change that blocker and rerun when the function should become analyzable; framework wrappers may remain unsupported. `stopped` means analysis halted partway on some path, and `on analyzed paths` is evidence from the paths that completed, not a contract for the whole function. `skipped` marks a top-level statement the module analysis stepped over; values it could write are not trusted.',
  '',
  'Refactoring suggestions are conditional examples, not automatic fixes. Apply one only when its "Use when" condition matches the program, then run behavioral tests and the audit again. Only recognized patterns get suggestions; a file with no suggestions and incomplete coverage is not necessarily safe.',
].join('\n')

function formatAuditCoverage(coverage: AuditCoverage): string {
  const parts = coverage.functions === 0
    ? ['no named function declarations']
    : [`${coverage.analyzed}/${coverage.functions} functions fully analyzed`]
  if (coverage.partial > 0) parts.push(`${coverage.partial} partial`)
  if (coverage.unsupported > 0) parts.push(`${coverage.unsupported} unsupported`)
  if (coverage.initializer !== 'analyzed') parts.push(`module setup ${coverage.initializer}`)
  if (coverage.initializerSkips > 0) {
    parts.push(`${coverage.initializerSkips} module statement${coverage.initializerSkips === 1 ? '' : 's'} skipped`)
  }
  return parts.join('; ')
}

// One file's audit unit: a header carrying the file's coverage counts, its contract
// entries, then its refactoring suggestions — always in that order, under these exact
// section labels. `fr --audit <file>` prints one unit; bare `fr --audit` prints one unit
// per project file; both print auditPreamble once above, which keeps a file's unit
// identical in the two outputs.
export function formatFileAuditUnit(audit: FileAudit): string {
  const {coverage} = audit
  const lines = [`# ${audit.file} (${formatAuditCoverage(coverage)})`]
  if (audit.contracts.functions.length > 0) {
    lines.push(
      '',
      '## Contracts',
      '',
      formatReport(audit.contracts),
    )
  }

  if (audit.guideIDs.length > 0) {
    const primaryGuideIDs: RefactorGuideID[] = []
    for (const reference of audit.references) {
      const primary = reference.guideIDs[0]
      if (primary != null && !primaryGuideIDs.includes(primary)) primaryGuideIDs.push(primary)
    }
    const secondaryGuideIDs = audit.guideIDs.filter(guideID => !primaryGuideIDs.includes(guideID))
    lines.push(
      '',
      '## Refactoring suggestions',
    )
    for (const guideID of primaryGuideIDs) {
      const guide = refactorGuide(guideID)
      const relevant = audit.references.filter(reference => reference.guideIDs.includes(guideID))
      lines.push(
        '',
        `### ${guide.title}`,
        '',
        `Shown for: ${formatReferences(relevant)}`,
        '',
        guide.summary,
        '',
        `Use when: ${guide.applicability}`,
        '',
        `Behavior: ${guide.behavior}`,
        '',
        'Example rewrite:',
        '',
        '```ts',
        guide.after,
        '```',
        '',
        `Freerange result: ${guide.result}`,
      )
    }
    if (secondaryGuideIDs.length > 0) {
      lines.push('', '### Other options')
      for (const guideID of secondaryGuideIDs) {
        const guide = refactorGuide(guideID)
        const relevant = audit.references.filter(reference => reference.guideIDs.includes(guideID))
        lines.push(
          '',
          `**${guide.title}.** ${guide.summary}`,
          '',
          `Shown for: ${formatReferences(relevant)}`,
          '',
          `Use when: ${guide.applicability}`,
          '',
          `Behavior: ${guide.behavior}`,
        )
      }
    }
  }
  return lines.join('\n')
}

export function refactorGuide(id: RefactorGuideID): RefactorGuide {
  const guide = refactorGuides.find(candidate => candidate.id === id)
  if (guide == null) throw new Error(`Missing refactor guide ${id}`)
  return guide
}

function guidesForReason(reason: AuditReason): RefactorGuideID[] {
  switch (reason.kind) {
    case 'requires': return guidesForPrecondition(reason.precondition)
    case 'assumes': return reason.assumption.kind === 'nonzeroDivisor'
      ? ['guard-derived-value']
      : ['guard-array-index']
    case 'assertion':
    case 'staticAnnotationIssue': return []
    case 'unsupported': return guidesForUnsupportedReason(reason.reason)
    case 'stopped': return guidesForStop(reason.reason)
    case 'skipped': return guidesForUnsupportedReason(reason.reason)
  }
}

function guidesForPrecondition(precondition: InferredPrecondition): RefactorGuideID[] {
  switch (precondition.kind) {
    case 'inBounds': return ['guard-array-index']
    case 'declaredComparison':
    case 'declaredNumberCheck': return []
    case 'nonzero':
    case 'notEqualConstant': break
  }
  const directRatio = precondition.kind === 'nonzero'
    && precondition.operation === 'division'
    && precondition.expression.kind === 'binary'
    && precondition.expression.operator === 'divide'
  const guides: RefactorGuideID[] = directRatio
    ? ['use-direct-operands', 'guard-derived-value']
    : ['guard-derived-value']
  if (precondition.kind === 'nonzero') {
    if (isCallerInput(precondition.expression)) guides.push('encode-input-rule')
  }
  return guides
}

function guidesForUnsupportedReason(reason: UnsupportedReason): RefactorGuideID[] {
  // A rejection selects a guide only when its structured fields identify the relevant
  // rewrite shape. Generic calls, mutation, and display text are not enough evidence.
  switch (reason.kind) {
    case 'call': return reason.arrayMethod === 'reduce'
      ? ['use-loop-for-aggregation']
      : []
    case 'nonBooleanCondition': return reason.conditionKind === 'number'
      ? ['write-explicit-condition']
      : []
    case 'unknownIdentifier':
    case 'missingSymbol':
    case 'functionWithoutSignature':
    case 'functionWithoutBody':
    case 'destructuredParameter':
    case 'parameterType':
    case 'parameterDefaultValue':
    case 'missingReturn':
    case 'objectPropertyForm':
    case 'computedPropertyName':
    case 'objectSpread':
    case 'asyncOrGeneratorFunction':
    case 'typePredicate':
    case 'protoProperty':
    case 'enumMemberRead':
    case 'prototypeMemberRead':
    case 'binaryOperator':
    case 'callWithFewerArguments':
    case 'callWithMoreArguments':
    case 'nonNumberOperand':
    case 'valueType':
    case 'kindChangingAssertion':
    case 'propertyReadOnNonObject':
    case 'statementAfterReturn':
    case 'assignmentInValuePosition':
    case 'propertyWrite':
    case 'staticAssertionForm':
    case 'varDeclaration':
    case 'evalInFile':
    case 'typeCheckSuppressed':
    case 'forLoopWithoutCondition':
    case 'variableDeclarationShape':
    case 'expressionForm':
    case 'statementForm':
    case 'switchFallthrough':
    case 'switchDefaultNotLast':
    case 'switchSubject':
    case 'switchLabel': return []
  }
}

function guidesForStop(reason: StopReason): RefactorGuideID[] {
  switch (reason.kind) {
    case 'unsupportedCode': return guidesForUnsupportedReason(reason.reason)
    case 'possiblyMissingElement': return ['handle-missing-element']
    case 'outOfBoundsRead': return []
    case 'refutedRequirement':
    case 'unrefinableRequirement':
    case 'callRequirement':
    case 'moduleRead':
    case 'recursion':
    case 'calleeStopped':
    case 'loopLimit':
    case 'nonExitingLoop':
    case 'kindMismatch': return []
  }
}

function isCallerInput(expression: NumericExpression): boolean {
  switch (expression.kind) {
    case 'parameter': return true
    case 'property': return isCallerInput(expression.base)
    case 'floor': return isCallerInput(expression.operand)
    case 'constant':
    case 'binary': return false
  }
}

function formatReferences(references: AuditReference[]): string {
  const namesByLocation = new Map<string, string[]>()
  for (const reference of references) {
    const names = namesByLocation.get(reference.location)
    if (names == null) namesByLocation.set(reference.location, [reference.functionName])
    else if (!names.includes(reference.functionName)) names.push(reference.functionName)
  }
  return [...namesByLocation].map(([location, names]) => `${location} in ${names.join(', ')}`).join('; ')
}
