import {
  type FitCheck,
  type FitInferRedundantSpec,
  type FitInferSpec,
} from './check-types.ts'
import {type FitInferFact} from './facts.ts'
import {
  parseFitSpecLine,
  type FitSpec,
} from './parser.ts'
import {type Value} from './domain.ts'
import {sameExpressionText} from './linear.ts'

export type {FitInferRedundantSpec, FitInferSpec, FitInferSpecStatus} from './check-types.ts'

export function inferFunctionSpecReports(
  specs: FitSpec[],
  backgroundChecks: FitCheck[],
  verify: (spec: Extract<FitSpec, {kind: 'check-range'} | {kind: 'check-comparison'} | {kind: 'check-atom'}>) => FitCheck,
): FitInferSpec[] {
  const checkByText = new Map<string, FitCheck>()
  for (const check of backgroundChecks) {
    if (!checkByText.has(check.text)) checkByText.set(check.text, check)
  }

  return specs.map(spec => {
    if (spec.kind === 'given-range' || spec.kind === 'given-comparison') {
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
  const unknownRoots = new Set<string>()
  const contextualReasons = new Set<string>()
  for (const line of lines) {
    const reason = contextualUnsupportedReason(line)
    if (reason != null) contextualReasons.add(reason)
    const unknownRoot = unknownIdentifierRoot(reason ?? line)
    if (unknownRoot != null) unknownRoots.add(unknownRoot)
  }
  const seen = new Set<string>()
  const seenUnknownRoots = new Set<string>()
  const seenRecursiveHelpers = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    const reason = contextualUnsupportedReason(line)
    const comparableReason = reason ?? line
    const recursiveHelper = recursiveHelperName(comparableReason)
    if (recursiveHelper != null) {
      if (seenRecursiveHelpers.has(recursiveHelper)) continue
      seenRecursiveHelpers.add(recursiveHelper)
    }
    const unknownRoot = unknownIdentifierRoot(comparableReason)
    if (unknownRoot != null) {
      if (seenUnknownRoots.has(unknownRoot)) continue
      seenUnknownRoots.add(unknownRoot)
    }
    if (contextualReasons.has(line) && reason == null) continue
    if (unsupportedLineIsDerivativeOfUnknownRoot(comparableReason, unknownRoots)) continue
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
  }
  return result
}

function contextualUnsupportedReason(line: string): string | null {
  if (!line.startsWith('unsupported ')) return null
  const separator = line.indexOf(': ')
  return separator === -1 ? null : line.slice(separator + 2)
}

function unknownIdentifierRoot(reason: string): string | null {
  return /^Unknown identifier ([A-Za-z_$][\w$]*)$/.exec(reason)?.[1] ?? null
}

function recursiveHelperName(reason: string): string | null {
  return /^Recursive helper inlining is unsupported at ([A-Za-z_$][\w$]*)$/.exec(reason)?.[1] ?? null
}

function unsupportedLineIsDerivativeOfUnknownRoot(reason: string, unknownRoots: Set<string>) {
  const root = derivativeUnknownRoot(reason)
  return root != null && unknownRoots.has(root)
}

function derivativeUnknownRoot(reason: string): string | null {
  const assignment = /^Unknown assignment root ([A-Za-z_$][\w$]*)$/.exec(reason)
  if (assignment != null) return assignment[1]!

  const propertyAccess = /^Property access expected an object path(?: or array length)?: (.+)$/.exec(reason)
  if (propertyAccess != null) return expressionRoot(propertyAccess[1]!)

  const elementAccess = /^Element access expected an array path: (.+)$/.exec(reason)
  if (elementAccess != null) return expressionRoot(elementAccess[1]!)

  return null
}

function expressionRoot(text: string) {
  return /^[A-Za-z_$][\w$]*/.exec(text)?.[0] ?? null
}

function inferredFactReasonForSpecText(specText: string, facts: FitInferFact[]) {
  const exactFact = facts.find(fact => fact.text === specText)
  if (exactFact != null) return exactFact.text

  const spec = parseFitSpecLineForInference(specText)
  if (spec == null || spec.kind === 'given-range' || spec.kind === 'given-comparison') return null
  if (spec.kind === 'check-atom') return null
  if (spec.kind === 'check-range') return rangeFactReasonForSpec(spec, facts)
  return comparisonFactReasonForSpec(spec, facts)
}

function parseFitSpecLineForInference(text: string): FitSpec | null {
  try {
    return parseFitSpecLine(text)
  } catch {
    return null
  }
}

function rangeFactReasonForSpec(spec: Extract<FitSpec, {kind: 'check-range'}>, facts: FitInferFact[]) {
  const range = inferredRangeFactForExpression(facts, spec.expression)
  if (range == null) return null
  if (spec.range.finiteValues != null) {
    return range.values != null && range.values.every(value => spec.range.finiteValues!.includes(value)) ? range.text : null
  }
  const lowerOk = spec.range.lowerValue != null
    && (spec.range.lowerInclusive ? range.min >= spec.range.lowerValue : range.min > spec.range.lowerValue)
  const upperOk = spec.range.upperValue != null
    && (spec.range.upperInclusive ? range.max <= spec.range.upperValue : range.max < spec.range.upperValue)
  return lowerOk
    && upperOk
    && (spec.range.valueKind !== 'int' || range.isInteger)
    ? range.text
    : null
}

function comparisonFactReasonForSpec(spec: Extract<FitSpec, {kind: 'check-comparison'}>, facts: FitInferFact[]) {
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

function equalityFactReasonForSpec(spec: Extract<FitSpec, {kind: 'check-comparison'}>, facts: FitInferFact[]) {
  for (const fact of facts) {
    const inferred = parseFitSpecLineForInference(fact.text)
    if (inferred?.kind !== 'check-comparison' || inferred.op !== '==') continue
    const sameOrder = sameExpressionText(spec.left, inferred.left) && sameExpressionText(spec.right, inferred.right)
    const flipped = sameExpressionText(spec.left, inferred.right) && sameExpressionText(spec.right, inferred.left)
    if (sameOrder || flipped) return fact.text
  }
  return null
}

function inferredRangeFactForExpression(facts: FitInferFact[], expression: string) {
  for (const fact of facts) {
    if (fact.kind === 'range' && sameExpressionText(fact.path, expression)) return fact
  }
  return null
}

function numberText(text: string): number | null {
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}
