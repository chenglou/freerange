import {
  type FitCheck,
  type FitInferRedundantSpec,
  type FitInferSpec,
} from './check-types.ts'
import {type FitInferFact} from './facts.ts'
import {
  fitSpecIsAssumption,
  fitRangeCases,
  fitExpressionText,
  parseFitSpecLine,
  type FitComparisonCheckSpec,
  type FitExpressionLike,
  type FitCheckSpec,
  type FitRangeCheckSpec,
  type FitRange,
  type FitRangeCase,
  type FitSpec,
} from './parser.ts'
import {type Value} from './domain.ts'
import {sameExpressionText} from './linear.ts'

export type {FitInferRedundantSpec, FitInferSpec, FitInferSpecStatus} from './check-types.ts'

export function inferFunctionSpecReports(
  specs: FitSpec[],
  backgroundChecks: FitCheck[],
  verify: (spec: FitCheckSpec) => FitCheck,
): FitInferSpec[] {
  const checkByText = new Map<string, FitCheck>()
  for (const check of backgroundChecks) {
    if (!checkByText.has(check.text)) checkByText.set(check.text, check)
  }

  return specs.map(spec => {
    if (fitSpecIsAssumption(spec)) {
      const check = checkByText.get(spec.text)
      if (check == null || check.status === 'pass') return {text: spec.text, status: 'assumed'}
      return {text: spec.text, status: 'not-inferred', reason: check.reason ?? check.status}
    }

    const check = verify(spec)
    if (check.status === 'pass') return {text: spec.text, status: 'checked'}
    return {text: spec.text, status: 'not-inferred', reason: check.reason ?? check.status}
  })
}

export function redundantSpecs(specs: FitInferSpec[], facts: FitInferFact[]) {
  const redundant: FitInferRedundantSpec[] = []
  for (const spec of specs) {
    if (spec.status !== 'checked') continue
    const reason = inferredFactReasonForSpecText(spec.text, facts)
    if (reason == null) continue
    redundant.push({text: spec.text, reason})
  }
  return redundant
}

export function topUnknownReason(value: Value): string[] {
  if (value.kind === 'unknown') return [value.reason]
  return []
}

export function uniqueUnsupported(lines: string[]) {
  const roots = unsupportedRootSummary(lines)
  const reportedRoots = {
    unknowns: new Set<string>(),
    assignments: new Set<string>(),
    recursiveHelpers: new Set<string>(),
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    const reason = contextualUnsupportedReason(line)
    if (reason != null && shouldSuppressUnsupportedReason(reason, roots, reportedRoots)) {
      continue
    } else if (roots.contextualReasons.has(line) && !line.startsWith('unsupported ')) {
      continue
    }
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
  }
  return result
}

type UnsupportedRootSummary = {
  contextualReasons: Set<string>
  unknownRoots: Set<string>
  unknownAssignmentRoots: Set<string>
  recursiveHelpers: Set<string>
}

function unsupportedRootSummary(lines: string[]): UnsupportedRootSummary {
  const summary: UnsupportedRootSummary = {
    contextualReasons: new Set(),
    unknownRoots: new Set(),
    unknownAssignmentRoots: new Set(),
    recursiveHelpers: new Set(),
  }
  for (const line of lines) {
    const reason = contextualUnsupportedReason(line)
    if (reason == null) continue
    summary.contextualReasons.add(reason)
    const unknownRoot = unknownIdentifierRoot(reason)
    if (unknownRoot != null) summary.unknownRoots.add(unknownRoot)
    const assignmentRoot = unknownAssignmentRoot(reason)
    if (assignmentRoot != null) summary.unknownAssignmentRoots.add(assignmentRoot)
    const recursiveHelper = recursiveHelperName(reason)
    if (recursiveHelper != null) summary.recursiveHelpers.add(recursiveHelper)
  }
  return summary
}

function shouldSuppressUnsupportedReason(
  reason: string,
  roots: UnsupportedRootSummary,
  reported: {unknowns: Set<string>; assignments: Set<string>; recursiveHelpers: Set<string>},
) {
  const recursiveHelper = recursiveHelperName(reason)
  if (recursiveHelper != null) {
    if (reported.recursiveHelpers.has(recursiveHelper)) return true
    reported.recursiveHelpers.add(recursiveHelper)
    return false
  }

  const unknownRoot = unknownIdentifierRoot(reason)
  if (unknownRoot != null) {
    if (reported.unknowns.has(unknownRoot)) return true
    reported.unknowns.add(unknownRoot)
    return false
  }

  const assignmentRoot = unknownAssignmentRoot(reason)
  if (assignmentRoot != null) {
    if (roots.unknownRoots.has(assignmentRoot)) return true
    if (reported.assignments.has(assignmentRoot)) return true
    reported.assignments.add(assignmentRoot)
    return false
  }

  return unsupportedLineIsDerivativeOfUnknownRoot(reason, roots.unknownRoots)
    || unsupportedLineIsDerivativeOfUnknownAssignmentRoot(reason, roots.unknownAssignmentRoots)
}

function contextualUnsupportedReason(line: string): string | null {
  if (!line.startsWith('unsupported ')) return null
  const separator = line.indexOf(': ')
  return separator === -1 ? null : line.slice(separator + 2)
}

function unknownIdentifierRoot(reason: string): string | null {
  return /^Unknown identifier ([\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)$/u.exec(reason)?.[1] ?? null
}

function recursiveHelperName(reason: string): string | null {
  return /^Recursive helper inlining is unsupported at ([\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)$/u.exec(reason)?.[1] ?? null
}

function unknownAssignmentRoot(reason: string): string | null {
  return /^Unknown assignment root ([\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)$/u.exec(reason)?.[1] ?? null
}

function unsupportedLineIsDerivativeOfUnknownRoot(reason: string, unknownRoots: Set<string>) {
  const root = derivativeUnknownRoot(reason)
  return root != null && unknownRoots.has(root)
}

function unsupportedLineIsDerivativeOfUnknownAssignmentRoot(reason: string, unknownAssignmentRoots: Set<string>) {
  const root = compoundAssignmentRoot(reason)
  return root != null && unknownAssignmentRoots.has(root)
}

function derivativeUnknownRoot(reason: string): string | null {
  const assignmentRoot = unknownAssignmentRoot(reason)
  if (assignmentRoot != null) return assignmentRoot

  const propertyAccess = /^Property access expected an object path(?: or array length)?: (.+)$/.exec(reason)?.[1]
  if (propertyAccess != null) return expressionRoot(propertyAccess)

  const elementAccess = /^Element access expected an array path: (.+)$/.exec(reason)?.[1]
  if (elementAccess != null) return expressionRoot(elementAccess)

  return null
}

function compoundAssignmentRoot(reason: string): string | null {
  const assignment = /^Compound assignment (.+?) expected numbers$/.exec(reason)?.[1]
  return assignment == null ? null : expressionRoot(assignment)
}

function expressionRoot(text: string): string | null {
  return /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*/u.exec(text.trim())?.[0] ?? null
}

function inferredFactReasonForSpecText(specText: string, facts: FitInferFact[]) {
  const exactFact = facts.find(fact => fact.text === specText)
  if (exactFact != null) return exactFact.text

  const spec = parseFitSpecLineForInference(specText)
  if (spec == null || fitSpecIsAssumption(spec)) return null
  if (spec.kind === 'expression') return null
  if (spec.kind === 'value') return null
  if (spec.kind === 'pure') return null
  if (spec.kind === 'range') return rangeFactReasonForSpec(spec, facts)
  return comparisonFactReasonForSpec(spec, facts)
}

function parseFitSpecLineForInference(text: string): FitSpec | null {
  try {
    return parseFitSpecLine(text)
  } catch {
    return null
  }
}

function rangeFactReasonForSpec(spec: FitRangeCheckSpec, facts: FitInferFact[]) {
  const range = inferredRangeFactForExpression(facts, spec.expression)
  if (range == null) return null
  return inferredRangeInsideSpec(range, spec.range)
    ? range.text
    : null
}

function inferredRangeInsideSpec(
  range: Extract<FitInferFact, {kind: 'range'}>,
  specRange: FitRange,
) {
  if (specRange.valueKind === 'int' && !range.isInteger) return false
  if (range.values != null) return range.values.every(value => valueInsideRangeCases(value, specRange))
  return fitRangeCases(specRange).some(rangeCaseContainsInferredRange(range, specRange))
}

function valueInsideRangeCases(value: number, range: FitRange) {
  return fitRangeCases(range).some(rangeCase => valueInsideRangeCase(value, range, rangeCase))
}

function valueInsideRangeCase(value: number, range: FitRange, rangeCase: FitRangeCase) {
  if (range.valueKind === 'int' && !Number.isInteger(value)) return false
  if (rangeCase.lowerValue == null || rangeCase.upperValue == null) return false
  const lowerOk = rangeCase.lowerInclusive ? value >= rangeCase.lowerValue : value > rangeCase.lowerValue
  const upperOk = rangeCase.upperInclusive ? value <= rangeCase.upperValue : value < rangeCase.upperValue
  return lowerOk && upperOk
}

function rangeCaseContainsInferredRange(
  range: Extract<FitInferFact, {kind: 'range'}>,
  specRange: FitRange,
) {
  return (rangeCase: FitRangeCase) => {
    if (rangeCase.lowerValue == null || rangeCase.upperValue == null) return false
    const lowerOk = rangeCase.lowerInclusive ? range.min >= rangeCase.lowerValue : range.min > rangeCase.lowerValue
    const upperOk = rangeCase.upperInclusive ? range.max <= rangeCase.upperValue : range.max < rangeCase.upperValue
    return lowerOk && upperOk && (specRange.valueKind !== 'int' || range.isInteger)
  }
}

function comparisonFactReasonForSpec(spec: FitComparisonCheckSpec, facts: FitInferFact[]) {
  const leftRange = inferredRangeFactForExpression(facts, spec.left)
  const rightRange = inferredRangeFactForExpression(facts, spec.right)
  const leftNumber = numberText(spec.left)
  const rightNumber = numberText(spec.right)

  switch (spec.op) {
    case '>=':
      if (leftRange != null && rightNumber != null && leftRange.min >= rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber >= rightRange.max) return rightRange.text
      return null
    case '>':
      if (leftRange != null && rightNumber != null && leftRange.min > rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber > rightRange.max) return rightRange.text
      return null
    case '<=':
      if (leftRange != null && rightNumber != null && leftRange.max <= rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber <= rightRange.min) return rightRange.text
      return null
    case '<':
      if (leftRange != null && rightNumber != null && leftRange.max < rightNumber) return leftRange.text
      if (leftNumber != null && rightRange != null && leftNumber < rightRange.min) return rightRange.text
      return null
    case '==':
      return equalityFactReasonForSpec(spec, facts)
  }
}

function equalityFactReasonForSpec(spec: FitComparisonCheckSpec, facts: FitInferFact[]) {
  for (const fact of facts) {
    const inferred = parseFitSpecLineForInference(fact.text)
    if (inferred?.role !== 'prove' || inferred.kind !== 'comparison' || inferred.op !== '==') continue
    const sameOrder = sameExpressionText(spec.left, inferred.left) && sameExpressionText(spec.right, inferred.right)
    const flipped = sameExpressionText(spec.left, inferred.right) && sameExpressionText(spec.right, inferred.left)
    if (sameOrder || flipped) return fact.text
  }
  return null
}

function inferredRangeFactForExpression(facts: FitInferFact[], expression: FitExpressionLike) {
  for (const fact of facts) {
    if (fact.kind === 'range' && sameExpressionText(fact.path, expression)) return fact
  }
  return null
}

function numberText(text: FitExpressionLike): number | null {
  const value = Number(fitExpressionText(text))
  return Number.isFinite(value) ? value : null
}
