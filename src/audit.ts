import type {AssertionVerdict, ProgramAnalysis, Stop, StopReason} from './engine/outcome.ts'
import type {SiteID} from './ir/ids.ts'
import {
  reportPath,
  siteLocation,
  type ProgramIR,
  type UnsupportedReason,
} from './ir/program.ts'
import type {
  BoundsAssumption,
  InferredPrecondition,
  NumericExpression,
} from './requirements/model.ts'
import {createReport, formatReport, type AnalysisReport} from './report/index.ts'
import {color, formatDiagnosticPrefix} from './typescript/diagnostics.ts'

type RefactorGuideShape = {
  id: string
  title: string
  summary: string
  caveat: string
  before: string
  after: string
}

export const refactorGuides = [
  {
    id: 'guard-derived-value',
    title: 'Check the exact divisor',
    summary: 'Give the divisor expression a name, then handle zero before dividing.',
    caveat: 'The function owns the zero case. If zero is invalid input, keep the caller requirement instead.',
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
  },
  {
    id: 'encode-input-rule',
    title: 'Encode a real input rule where the calculation begins',
    summary: 'Turn a domain rule such as "column count is a positive integer" into code once, before downstream calculations use it.',
    caveat: 'A positive integer is the real API rule. This changes fractional and nonpositive values, and external NaN still needs validation.',
    before: `export function perColumn(total: number, columnCount: number): number {
  if (columnCount === 0) return 0
  return total / columnCount
}`,
    after: `export function perColumn(total: number, columnCount: number): number {
  const columns = Math.max(1, Math.floor(columnCount))
  return total / columns
}`,
  },
  {
    id: 'use-direct-operands',
    title: 'Use guarded dimensions directly instead of dividing by a ratio',
    summary: 'A positive ratio can still round down to zero. Guard the original dimensions and divide by one of those values directly.',
    caveat: 'The positive minimum is a real product rule and small rounding differences are acceptable. Nonpositive values change, NaN still needs validation, and multiplication can still overflow.',
    before: `export function fittedHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  const aspectRatio = imageWidth / imageHeight
  return frameWidth / aspectRatio
}`,
    after: `export function fittedHeight(frameWidth: number, imageWidth: number, imageHeight: number): number {
  const width = Math.max(1, imageWidth)
  const height = Math.max(1, imageHeight)
  return (frameWidth * height) / width
}`,
  },
  {
    id: 'write-explicit-condition',
    title: 'Write the numeric case explicitly',
    summary: 'Replace number truthiness with the exact comparison that expresses the intended case.',
    caveat: 'The code means a specific condition such as zero. Choose the comparison that states that condition; NaN can behave differently from truthiness.',
    before: `export function safeWidth(width: number): number {
  return width || 1
}`,
    after: `export function safeWidth(width: number): number {
  return width === 0 ? 1 : width
}`,
  },
  {
    id: 'use-loop-for-aggregation',
    title: 'Use an explicit loop for dense-array aggregation',
    summary: 'For a simple aggregation, a for loop exposes the accumulator and each numeric step.',
    caveat: 'The array is dense, the reduction has an initial value, and callback arguments or effects do not matter. Indexed loops differ for sparse arrays.',
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
  },
  {
    id: 'handle-missing-element',
    title: 'Handle a possibly missing array element',
    summary: 'A bare array read may be undefined even when the project\'s TypeScript settings show a plain element type. Handle the missing case before using the value.',
    caveat: 'A fallback is real application behavior. Otherwise validate or throw; a bounds check alone does not detect a sparse-array hole.',
    before: `export function incrementAt(values: number[], index: number): number {
  return values[index] + 1
}`,
    after: `export function incrementAt(values: number[], index: number): number {
  const value = values[index] ?? 0
  return value + 1
}`,
  },
  {
    id: 'guard-array-index',
    title: 'Check an asserted array index',
    summary: 'Before using values[index]!, prove that the index is an integer inside the array bounds.',
    caveat: 'The function owns invalid-index behavior. Otherwise keep the caller requirement; any fallback changes an invalid read.',
    before: `export function valueAt(values: number[], index: number): number {
  return values[index]!
}`,
    after: `export function valueAt(values: number[], index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return 0
  return values[index]!
}`,
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
  | {kind: 'partialSupport'; reason: StopReason}
  | {kind: 'skipped'; reason: UnsupportedReason}

export type AuditReference = {
  functionName: string
  line: number
  column: number
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
      ...siteLocation(program, site),
      span: {...span},
      reason,
      guideIDs: guidesForReason(reason),
    })
  }

  const addPartialReason = (functionName: string, stop: Stop): void => {
    addReference(functionName, stop.site, {kind: 'partialSupport', reason: stop.reason})
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
        for (const stop of fn.stops) addPartialReason(fn.lowering.name, stop)
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
    for (const stop of analysis.initializer.stops) addPartialReason(program.initializer.name, stop)
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

function formatAuditCoverage(coverage: AuditCoverage): string {
  const parts = coverage.functions === 0
    ? ['no named function declarations']
    : [`${coverage.analyzed}/${coverage.functions} functions fully analyzed`]
  if (coverage.partial > 0) parts.push(`${coverage.partial} partially supported`)
  if (coverage.unsupported > 0) parts.push(`${coverage.unsupported} unsupported`)
  if (coverage.initializer !== 'analyzed') parts.push('module setup partially supported')
  if (coverage.initializerSkips > 0) {
    parts.push(`${coverage.initializerSkips} module statement${coverage.initializerSkips === 1 ? '' : 's'} skipped`)
  }
  return parts.join('; ')
}

// One file's audit unit: a header carrying the file's coverage counts, its contract
// entries, then its refactoring suggestions — always in that order, under these exact
// section labels. `fr --audit <file>` prints one unit; bare `fr --audit` prints one unit
// per project file, so a file's unit stays identical between the two outputs.
export function formatFileAuditUnit(audit: FileAudit, pretty = false): string {
  const {coverage} = audit
  const file = pretty ? color(96, audit.file) : audit.file
  const lines = [`# ${file} (${formatAuditCoverage(coverage)})`]
  if (audit.contracts.functions.length > 0) {
    lines.push(
      '',
      '## Contracts',
      '',
      colorAuditLocations(formatReport(audit.contracts), audit.file, pretty),
    )
  }

  if (audit.guideIDs.length > 0) {
    const printedSuggestions = new Set<string>()
    lines.push(
      '',
      '## Refactoring suggestions',
    )
    for (const reference of audit.references) {
      const guideIDs = reference.guideIDs.filter(guideID =>
        !printedSuggestions.has(`${reference.span.start}:${guideID}`))
      if (guideIDs.length === 0) continue
      lines.push('')
      for (const guideID of guideIDs) {
        printedSuggestions.add(`${reference.span.start}:${guideID}`)
        const guide = refactorGuide(guideID)
        const prefix = formatDiagnosticPrefix(
          {file: audit.file, line: reference.line, column: reference.column},
          'suggestion',
          guide.id,
          pretty,
        )
        lines.push(`${prefix}${guide.title}. ${guide.summary}`)
      }
    }
  }
  return lines.join('\n')
}

function colorAuditLocations(output: string, file: string, pretty: boolean): string {
  if (!pretty) return output
  const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return output.replace(
    new RegExp(`${escapedFile}:(\\d+):(\\d+)`, 'g'),
    (_location, line: string, column: string) =>
      `${color(96, file)}:${color(93, line)}:${color(93, column)}`,
  )
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
    case 'partialSupport': return guidesForStop(reason.reason)
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
    case 'requirementFailure':
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
