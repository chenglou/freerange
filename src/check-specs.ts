import * as ts from 'typescript'
import {
  proveBoundIndexComparisonSpec,
  proveBoundIndexRangeSpec,
  unsupportedNamedIndexSpecReason,
  type BoundIndexContext,
} from './bound-index.ts'
import {nondecreasingFailureReason} from './builtins.ts'
import {
  arrayElement,
  arrayLength,
  arraySummary,
  finiteNumberSet,
  finiteMembersAreIntegers,
  isDefinitelyEmptyArray,
  literalKey,
  numberValue,
  withNumberCases,
  withNumberCaseLoss,
  numberBranches,
  type ArrayValue,
  type LiteralPrimitive,
  type NumberCase,
  type NumberValue,
  type Value,
  gridMeet,
  gridOfNumber,
  integerValued,
  maxNumberCases,
  numberCaseLossMessage,
  type Assumption,
  type BranchArm,
} from './domain.ts'
import {linearConstraints, mergeAssumptions, sharedAssumptions} from './assumptions.ts'
import {
  branchRelationship,
  mergeBranchArms,
} from './branch-context.ts'
import {linearConstant} from './linear.ts'
import {
  checkedDomainPathProblem,
} from './domain-paths.ts'
import {
  fitExpressionDomainPath,
  fitExpressionScopeSourceId,
  fitExpressionParsed,
  fitExpressionText,
  fitRangeCases,
  fitValueSpecNumberLiteralValue,
  fitValueSpecLiteralValues,
  fitValueSpecPropertyName,
  fitValueSpecRangeForTypeNode,
  fitReturnInternalRoot,
  parseFitRangeText,
  publicFitText,
  publicLinearName,
  type FitCheckSpec,
  type FitDomainPath,
  type FitExpressionCheckSpec,
  type FitExpressionLike,
  type ComparisonOperator,
  type FitRange,
  type FitRangeCase,
  type FitValueSpec,
} from './parser.ts'
import {
  createFitValueSpecTypeEnv,
  fitValueSpecTupleElementType,
  withResolvedFitValueSpecTypeReference,
  type FitValueSpecTypeEnv,
} from './value-specs.ts'
import {
  assumptionsAreReachable,
  comparisonCounterexample,
  proveComparison,
  proveComparisonWithStep,
  reachableNumberCases,
} from './proof.ts'
import {rationalToNumber, type Rational} from './rational.ts'
import {
  booleanExpressionIsAssumed,
  proveBooleanTrue,
} from './boolean-claims.ts'
import {
  finiteRangeSpecFailureReason,
  formatArraySummary,
  formatRange,
  formatRangeSpec,
  knownProofContextMany,
  rangeSpecFailureReason,
} from './reporting.ts'
import {
  adjacentComparisonText,
  proveAdjacentComparison,
  sequenceRelationText,
} from './sequence-facts.ts'
import {
  type EvalContext,
  type FitCheck,
  type FitCheckStatus,
  type FunctionContractProof,
  type Program,
} from './check-types.ts'
import type {FitProofStep} from './obligations.ts'
import {proofFactsFromValues} from './proof-facts.ts'

export type CheckSpecHooks = {
  evaluateExpression: (expression: ts.Expression, context: EvalContext) => Value
  evaluateDomainPath: (domainPath: FitDomainPath, context: EvalContext) => Value
  contextForExpression?: (expression: FitExpressionLike, context: EvalContext) => EvalContext
  parsePrintedNumber: (text: string) => number | null
}

type WildcardUse =
  | {kind: 'none'}
  | {kind: 'one'; collection: string}
  | {kind: 'unsupported'; reason: string}

type CheckSpecProof = {
  check: FitCheck
  step: FitProofStep
  usedFacts: string[]
}

export function verifyCheckSpecWithProof(
  file: string,
  program: Program,
  functionName: string,
  baseEnv: Map<string, Value>,
  result: Value,
  spec: FitCheckSpec,
  checks: FitCheck[],
  assumptions: EvalContext['assumptions'],
  booleanAssumptions: EvalContext['booleanAssumptions'],
  contractCache: Map<string, FunctionContractProof>,
  branchIds: {next: number},
  hooks: CheckSpecHooks,
): CheckSpecProof {
  const env = new Map(baseEnv)
  env.set(fitReturnInternalRoot, result)
  const inputRoots = [...baseEnv.keys(), fitReturnInternalRoot]
  const context: EvalContext = {
    program,
    file,
    env,
    inputRoots,
    stack: [functionName],
    checks,
    assumptions,
    branchIds,
    ...(booleanAssumptions == null ? {} : {booleanAssumptions}),
    contractCache,
  }
  const boundIndexContext = specBoundIndexContext(context, hooks)
  const unsupportedNamedIndex = spec.kind === 'expression' || spec.kind === 'value'
    ? unsupportedNamedIndexSpecReason(spec)
    : null
  if (unsupportedNamedIndex != null) {
    return checkProof({
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: 'unknown',
      reason: unsupportedNamedIndex,
    }, 'collection', 'unsupported-named-index', 'rejected unsupported named index relationship', [], context.assumptions)
  }

  if (spec.kind === 'range') {
    const domainPath = fitExpressionDomainPath(spec.expression)
    const pathProblem = domainPath == null ? null : checkedDomainPathProblem(domainPath, context.env.get(domainPath.root))
    if (pathProblem != null) {
      return checkProof({
        file,
        ...(spec.line == null ? {} : {line: spec.line}),
        functionName,
        text: spec.text,
        status: 'unknown',
        reason: pathProblem,
      }, 'shape', 'static-path', 'checked static contract path placement', [], context.assumptions)
    }
    const boundIndexCheck = proveBoundIndexRangeSpec(spec, boundIndexContext)
    if (boundIndexCheck != null && boundIndexCheck.status !== 'pass') {
      return checkProof({
        file,
        ...(spec.line == null ? {} : {line: spec.line}),
        functionName,
        text: spec.text,
        status: boundIndexCheck.status,
        ...(boundIndexCheck.reason == null ? {} : {reason: boundIndexCheck.reason}),
      }, 'collection', 'bound-index-range', 'checked indexed range claim', [], context.assumptions)
    }
    const value = evaluateSpecExpression(spec.expression, context, hooks)
    const status = proveRangeSpec(value, spec.range, context, hooks)
    return checkProof({
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    }, 'numeric', 'range', 'checked numeric range claim', [value], context.assumptions)
  }

  if (spec.kind === 'value') {
    const value = evaluateSpecExpression(spec.expression, context, hooks)
    const status = proveValueSpec(value, spec.value, context, hooks, publicFitText(fitExpressionText(spec.expression)))
    return checkProof({
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: status.status,
      ...(status.reason == null ? {} : {reason: status.reason}),
    }, 'value', 'shape', 'checked value shape claim', status.values, context.assumptions)
  }

  if (spec.kind === 'expression') return verifyBooleanExpressionSpec(file, functionName, spec, context, hooks)
  const boundIndexCheck = proveBoundIndexComparisonSpec(spec, boundIndexContext)
  if (boundIndexCheck != null) {
    return checkProof({
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: boundIndexCheck.status,
      ...(boundIndexCheck.reason == null ? {} : {reason: boundIndexCheck.reason}),
    }, 'collection', 'bound-index-comparison', 'checked indexed comparison claim', [], context.assumptions)
  }

  const wildcardCheck = checkWildcardComparisonShape(spec.left, spec.right)
  if (wildcardCheck.kind === 'unsupported') {
    return checkProof(
      {file, functionName, ...(spec.line == null ? {} : {line: spec.line}), text: spec.text, status: 'unknown', reason: wildcardCheck.reason},
      'shape',
      'wildcard-shape',
      'checked wildcard claim shape',
      [],
      context.assumptions,
    )
  }

  const left = evaluateSpecExpression(spec.left, context, hooks)
  const right = evaluateSpecExpression(spec.right, context, hooks)
  const proof = proveComparisonWithStep(left, spec.op, right, context.assumptions)
  const reason = wildcardCheck.kind === 'one' && proof.status !== 'pass' && proof.reason != null
    ? `applies to: every item in ${wildcardCollectionLabel(wildcardCheck.collection)}\n${proof.reason}`
    : proof.reason
  return checkProofWithStep({
    file,
    ...(spec.line == null ? {} : {line: spec.line}),
    functionName,
    text: spec.text,
    status: proof.status,
    ...(reason == null ? {} : {reason}),
  }, proof.step, [left, right], context.assumptions)
}

function checkProof(
  check: FitCheck,
  domain: string,
  rule: string,
  message: string,
  values: Value[],
  assumptions: EvalContext['assumptions'],
): CheckSpecProof {
  return checkProofWithStep(check, {domain, rule, message}, values, assumptions)
}

function checkProofWithStep(
  check: FitCheck,
  step: FitProofStep,
  values: Value[],
  assumptions: EvalContext['assumptions'],
): CheckSpecProof {
  return {
    check,
    step,
    usedFacts: proofFactsFromValues(values, assumptions),
  }
}

function wildcardCollectionLabel(collection: string) {
  const text = publicFitText(collection)
  return text.endsWith('[]') ? text.slice(0, -2) : text
}

export function proveRangeSpec(value: Value, range: FitRange, context: EvalContext, hooks: CheckSpecHooks): {status: FitCheckStatus; reason?: string} {
  if (value.kind !== 'number') return {status: 'unknown', reason: expectedNumberReason(value)}
  const expected = evaluateRangeCases(range, context, hooks)
  if (expected.kind === 'invalid') return {status: 'unknown', reason: rangeBoundNumberReason(expected.bound, expected.value, expected.text)}
  return proveNumberInsideRangeCases(value, range, expandedEvaluatedRangeCases(expected.cases), context.assumptions)
}

type ValueSpecProof = {
  status: FitCheckStatus
  reason?: string
  values: Value[]
  matched: number
}

function proveValueSpec(value: Value, spec: FitValueSpec, context: EvalContext, hooks: CheckSpecHooks, path: string): ValueSpecProof {
  return proveValueTypeSpec(value, spec.typeNode, createFitValueSpecTypeEnv(context.program, spec), context, hooks, path)
}

function proveValueTypeSpec(value: Value, node: ts.TypeNode, env: FitValueSpecTypeEnv, context: EvalContext, hooks: CheckSpecHooks, path: string): ValueSpecProof {
  if (ts.isParenthesizedTypeNode(node)) return proveValueTypeSpec(value, node.type, env, context, hooks, path)
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return proveValueTypeSpec(value, node.type, env, context, hooks, path)
  if (ts.isUnionTypeNode(node)) return proveValueUnionSpec(value, node.types, env, context, hooks, path)
  if (ts.isIntersectionTypeNode(node)) return combineValueSpecProofs(node.types.map(member => proveValueTypeSpec(value, member, env, context, hooks, path)))
  const range = fitValueSpecRangeForTypeNode(node, env.spec.ranges)
  if (range != null) {
    const status = proveRangeSpec(value, range, context, hooks)
    return {...status, values: [value], matched: status.status === 'pass' ? 1 : 0}
  }
  if (ts.isLiteralTypeNode(node)) {
    const number = fitValueSpecNumberLiteralValue(node)
    if (number != null) {
      const status = proveRangeSpec(value, exactNumberRange(number), context, hooks)
      return {...status, values: [value], matched: status.status === 'pass' ? 1 : 0}
    }
    const values = fitValueSpecLiteralValues(node)
    return values == null
      ? {status: 'unknown', reason: `${path} expected a supported literal value`, values: [value], matched: 0}
      : proveLiteralSpec(value, values, path)
  }
  if (ts.isTypeLiteralNode(node)) return proveObjectSpec(value, node.members, env, context, hooks, path)
  if (ts.isArrayTypeNode(node)) return proveArraySpec(value, node.elementType, env, context, hooks, path)
  if (ts.isTupleTypeNode(node)) return proveTupleSpec(value, node, env, context, hooks, path)
  if (ts.isTypeReferenceNode(node)) {
    const resolved = withResolvedFitValueSpecTypeReference(node, env, current => {
      switch (current.kind) {
        case 'node':
          return proveValueTypeSpec(value, current.node, current.env, context, hooks, path)
        case 'members':
          return proveObjectSpec(value, current.members, current.env, context, hooks, path)
        case 'array':
          return proveArraySpec(value, current.element, current.env, context, hooks, path)
      }
    })
    if (resolved != null) return resolved
  }
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return proveLiteralSpec(value, [false, true], path)
  if (node.kind === ts.SyntaxKind.NumberKeyword) {
    const range = parseBroadNumberRange()
    const status = proveRangeSpec(value, range, context, hooks)
    return {...status, values: [value], matched: status.status === 'pass' ? 1 : 0}
  }
  return {status: 'unknown', reason: `${path} used unsupported value spec syntax`, values: [value], matched: 0}
}

function proveValueUnionSpec(value: Value, cases: ts.NodeArray<ts.TypeNode>, env: FitValueSpecTypeEnv, context: EvalContext, hooks: CheckSpecHooks, path: string): ValueSpecProof {
  const proofs = cases.map(current => proveValueTypeSpec(value, current, env, context, hooks, path))
  const pass = proofs.find(proof => proof.status === 'pass')
  if (pass != null) return pass
  const unknown = highestMatchedProof(proofs.filter(proof => proof.status === 'unknown'))
  if (unknown != null) return unknown
  return highestMatchedProof(proofs) ?? {status: 'unknown', reason: `Empty value alternatives for ${path}`, values: [value], matched: 0}
}

function proveLiteralSpec(value: Value, expected: LiteralPrimitive[], path: string): ValueSpecProof {
  if (value.kind === 'unknown') return {status: 'unknown', reason: value.reason, values: [value], matched: 0}
  if (value.kind !== 'literal') return {status: 'unknown', reason: `${path} expected a literal value`, values: [value], matched: 0}
  const expectedKeys = new Set(expected.map(literalKey))
  const actualKeys = value.values.map(literalKey)
  if (actualKeys.every(key => expectedKeys.has(key))) return {status: 'pass', values: [value], matched: 1}
  return {
    status: 'fail',
    reason: `${path} was ${value.values.map(String).join(' | ')}, expected ${expected.map(String).join(' | ')}`,
    values: [value],
    matched: 0,
  }
}

function proveObjectSpec(value: Value, members: ts.NodeArray<ts.TypeElement>, env: FitValueSpecTypeEnv, context: EvalContext, hooks: CheckSpecHooks, path: string): ValueSpecProof {
  if (value.kind === 'unknown') return {status: 'unknown', reason: value.reason, values: [value], matched: 0}
  if (value.kind !== 'object') return {status: 'unknown', reason: `${path} expected an object`, values: [value], matched: 0}
  return combineValueSpecProofs(members.map(member => {
    if (!ts.isPropertySignature(member) || member.questionToken != null || member.type == null) {
      return {status: 'unknown', reason: `${path} used unsupported object value spec syntax`, values: [value], matched: 0} satisfies ValueSpecProof
    }
    const name = fitValueSpecPropertyName(member.name)
    if (name == null) return {status: 'unknown', reason: `${path} used unsupported object property syntax`, values: [value], matched: 0} satisfies ValueSpecProof
    const propPath = `${path}.${name}`
    const propValue = value.props.get(name)
    return propValue == null
      ? {status: 'fail', reason: `${propPath} was missing`, values: [value], matched: 0} satisfies ValueSpecProof
      : proveValueTypeSpec(propValue, member.type, env, context, hooks, propPath)
  }))
}

function proveArraySpec(value: Value, element: ts.TypeNode, env: FitValueSpecTypeEnv, context: EvalContext, hooks: CheckSpecHooks, path: string): ValueSpecProof {
  if (value.kind === 'unknown') return {status: 'unknown', reason: value.reason, values: [value], matched: 0}
  if (value.kind !== 'array') return {status: 'unknown', reason: `${path} expected an array`, values: [value], matched: 0}
  const item = arrayElement(value)
  if (item == null) {
    return isDefinitelyEmptyArray(value)
      ? {status: 'pass', values: [value], matched: 1}
      : {status: 'unknown', reason: `${path}[] was not inferred`, values: [value], matched: 0}
  }
  return proveValueTypeSpec(item, element, env, context, hooks, `${path}[]`)
}

function proveTupleSpec(value: Value, node: ts.TupleTypeNode, env: FitValueSpecTypeEnv, context: EvalContext, hooks: CheckSpecHooks, path: string): ValueSpecProof {
  if (value.kind === 'unknown') return {status: 'unknown', reason: value.reason, values: [value], matched: 0}
  if (value.kind !== 'array') return {status: 'unknown', reason: `${path} expected an array`, values: [value], matched: 0}
  const elements = node.elements.map(fitValueSpecTupleElementType).filter(element => element != null)
  if (elements.length !== node.elements.length) return {status: 'unknown', reason: `${path} used unsupported tuple value spec syntax`, values: [value], matched: 0}
  const length = proveTupleLength(value, elements.length, path)
  if (length.status !== 'pass') return length
  if (value.layout !== 'tuple') return {status: 'unknown', reason: `${path} was not inferred as a fixed tuple`, values: [value], matched: length.matched}
  return combineValueSpecProofs(elements.map((element, index) => proveValueTypeSpec(value.elements[index]!, element, env, context, hooks, `${path}[${index}]`)))
}

function parseBroadNumberRange() {
  const range = parseFitRangeText('-Infinity..Infinity')
  if (range == null) throw new Error('Internal error: broad number range failed to parse')
  return range
}

function exactNumberRange(value: number) {
  const range = parseFitRangeText(String(value))
  if (range == null) throw new Error('Internal error: exact number range failed to parse')
  return range
}

function proveTupleLength(value: ArrayValue, expected: number, path: string): ValueSpecProof {
  const length = arrayLength(value)
  if (length.min === expected && length.max === expected) return {status: 'pass', values: [length], matched: 1}
  if (length.max < expected || length.min > expected) {
    return {status: 'fail', reason: `${path}.length was ${length.min}..${length.max}, expected ${expected}`, values: [length], matched: 0}
  }
  return {status: 'unknown', reason: `${path}.length was not proven to be ${expected}`, values: [length], matched: 0}
}

function combineValueSpecProofs(proofs: ValueSpecProof[]): ValueSpecProof {
  const aggregate = aggregateValueSpecProofs(proofs)
  const fail = proofs.find(proof => proof.status === 'fail')
  if (fail != null) return {...fail, ...aggregate}
  const unknown = proofs.find(proof => proof.status === 'unknown')
  if (unknown != null) return {...unknown, ...aggregate}
  return {status: 'pass', ...aggregate}
}

function aggregateValueSpecProofs(proofs: ValueSpecProof[]) {
  return {
    values: proofs.flatMap(proof => proof.values),
    matched: proofs.reduce((sum, proof) => sum + proof.matched, 0),
  }
}

function highestMatchedProof(proofs: ValueSpecProof[]): ValueSpecProof | null {
  let best: ValueSpecProof | null = null
  for (const proof of proofs) {
    if (best == null || proof.matched > best.matched) best = proof
  }
  return best
}

type EvaluatedRangeCase = {
  source: FitRangeCase
  lower: NumberValue
  upper: NumberValue
  assumptions: Assumption[]
  branches: BranchArm[]
  separateBranches: boolean
}

type EvaluatedRangeCases =
  | {kind: 'cases'; cases: EvaluatedRangeCase[]}
  | {kind: 'invalid'; bound: 'lower' | 'upper'; value: Exclude<Value, NumberValue>; text: string}

export function evaluateRangeValue(
  range: FitRange,
  context: EvalContext,
  hooks: CheckSpecHooks,
  expr: string | null,
  origin: string[] = [],
): Value {
  const evaluated = evaluateRangeCases(range, context, hooks)
  if (evaluated.kind === 'invalid') return {kind: 'unknown', reason: rangeBoundNumberReason(evaluated.bound, evaluated.value, evaluated.text)}
  const cases = evaluated.cases.flatMap(rangeCase => evaluatedRangeCaseValues(range, rangeCase, expr, origin))
  if (cases.length === 0) return {kind: 'unknown', reason: `Range ${formatRangeSpec(range)} had no possible values`}
  const min = Math.min(...cases.map(item => item.value.min))
  const max = Math.max(...cases.map(item => item.value.max))
  const value = numberValue(min, max, range.valueKind === 'int' || cases.every(item => integerValued(item.value)) ? 0 : null, expr, null, null, origin)
  const withCases = withNumberCases(value, cases)
  return evaluated.cases.some(rangeCase => rangeBoundsComeFromSeparateBranches(rangeCase))
    ? withNumberCaseLoss(withCases, {kind: 'separate-branches'})
    : withCases
}

function evaluateRangeCases(range: FitRange, context: EvalContext, hooks: CheckSpecHooks): EvaluatedRangeCases {
  const cases: EvaluatedRangeCase[] = []
  for (const rangeCase of fitRangeCases(range)) {
    const lower = evaluateRangeBound(rangeCase.lower, context, hooks)
    if (lower.kind !== 'number') return {kind: 'invalid', bound: 'lower', value: lower, text: rangeCase.lower.text}
    const upper = evaluateRangeBound(rangeCase.upper, context, hooks)
    if (upper.kind !== 'number') return {kind: 'invalid', bound: 'upper', value: upper, text: rangeCase.upper.text}
    cases.push({
      source: rangeCase,
      lower,
      upper,
      assumptions: [],
      branches: [],
      separateBranches: false,
    })
  }
  return {kind: 'cases', cases}
}

type ExpandedRangeAlternative = {
  cases: EvaluatedRangeCase[]
}

function expandedEvaluatedRangeCases(cases: EvaluatedRangeCase[]): ExpandedRangeAlternative[] {
  return cases.map(rangeCase => ({cases: expandedEvaluatedRangeCase(rangeCase)}))
}

function expandedEvaluatedRangeCase(rangeCase: EvaluatedRangeCase): EvaluatedRangeCase[] {
  const exactSameExpression = rangeCase.source.lowerInclusive
    && rangeCase.source.upperInclusive
    && rangeCase.source.lower.text === rangeCase.source.upper.text
  if (exactSameExpression) {
    return numberBranches(rangeCase.lower).map(branch => ({
      source: rangeCase.source,
      lower: branch.value,
      upper: branch.value,
      assumptions: mergeAssumptions(rangeCase.assumptions, branch.assumptions),
      branches: mergeBranchArms(rangeCase.branches, branch.branches),
      separateBranches: rangeCase.separateBranches,
    }))
  }

  const cases: EvaluatedRangeCase[] = []
  for (const lower of numberBranches(rangeCase.lower)) {
    for (const upper of numberBranches(rangeCase.upper)) {
      const relationship = branchRelationship(
        rangeCase.branches,
        lower.branches,
        upper.branches,
      )
      if (relationship === 'conflict') continue
      const separateBranches = rangeCase.separateBranches
        || relationship === 'separate'
      const assumptions = separateBranches
        ? mergeAssumptions(
            rangeCase.assumptions,
            sharedAssumptions([lower.assumptions, upper.assumptions]),
          )
        : mergeAssumptions(rangeCase.assumptions, lower.assumptions, upper.assumptions)
      if (!separateBranches && lower.value.min > upper.value.max) continue
      if (!separateBranches && !assumptionsAreReachable(assumptions)) continue
      cases.push({
        source: rangeCase.source,
        lower: lower.value,
        upper: upper.value,
        assumptions,
        branches: mergeBranchArms(rangeCase.branches, lower.branches, upper.branches),
        separateBranches,
      })
    }
  }
  return cases
}

function evaluatedRangeCaseValues(range: FitRange, rangeCase: EvaluatedRangeCase, expr: string | null, origin: string[]): NumberCase[] {
  const exactSameExpression = rangeCase.source.lowerInclusive
    && rangeCase.source.upperInclusive
    && rangeCase.source.lower.text === rangeCase.source.upper.text
  if (exactSameExpression) {
    const value = rangeCase.lower
    return numberBranches(value).map(branch => ({
      value: numberValue(
        branch.value.min,
        branch.value.max,
        gridMeet(range.valueKind === 'int' ? 0 : null, branch.value.grid),
        expr ?? branch.value.expr,
        branch.value.linear,
        null,
        mergeRangeOrigin(branch.value, origin),
      ),
      assumptions: mergeAssumptions(rangeCase.assumptions, branch.assumptions),
      branches: mergeBranchArms(rangeCase.branches, branch.branches),
    }))
  }
  const cases: NumberCase[] = []
  for (const lower of numberBranches(rangeCase.lower)) {
    for (const upper of numberBranches(rangeCase.upper)) {
      const relationship = branchRelationship(
        rangeCase.branches,
        lower.branches,
        upper.branches,
      )
      if (relationship === 'conflict') continue
      const separateBranches = rangeCase.separateBranches
        || relationship === 'separate'
      const assumptions = separateBranches
        ? mergeAssumptions(
            rangeCase.assumptions,
            sharedAssumptions([lower.assumptions, upper.assumptions]),
          )
        : mergeAssumptions(rangeCase.assumptions, lower.assumptions, upper.assumptions)
      if (!separateBranches && lower.value.min > upper.value.max) continue
      if (!separateBranches && !assumptionsAreReachable(assumptions)) continue
      cases.push({
        value: numberValue(
          lower.value.min,
          upper.value.max,
          range.valueKind === 'int' ? 0 : null,
          expr,
          null,
          null,
          mergeRangeOrigin(lower.value, upper.value, origin),
        ),
        assumptions,
        branches: mergeBranchArms(rangeCase.branches, lower.branches, upper.branches),
      })
    }
  }
  return cases
}

function rangeBoundsComeFromSeparateBranches(rangeCase: EvaluatedRangeCase) {
  const exactSameExpression = rangeCase.source.lowerInclusive
    && rangeCase.source.upperInclusive
    && rangeCase.source.lower.text === rangeCase.source.upper.text
  if (exactSameExpression) return false
  for (const lower of numberBranches(rangeCase.lower)) {
    for (const upper of numberBranches(rangeCase.upper)) {
      if (branchRelationship(
        rangeCase.branches,
        lower.branches,
        upper.branches,
      ) === 'separate') return true
    }
  }
  return false
}

function mergeRangeOrigin(...items: (NumberValue | string[])[]) {
  const lines: string[] = []
  for (const item of items) lines.push(...(Array.isArray(item) ? item : item.origin))
  return [...new Set(lines)]
}

type RangeProblem = {
  value: NumberValue
  cases: EvaluatedRangeCase[]
  proof: Exclude<RangeCasesProof, {kind: 'pass'}>
  assumptions: Assumption[]
  uncorrelated: boolean
}

function proveNumberInsideRangeCases(
  value: NumberValue,
  range: FitRange,
  alternatives: ExpandedRangeAlternative[],
  assumptions: Assumption[],
): {status: FitCheckStatus; reason?: string} {
  if (range.finiteValues != null) {
    const finite = proveFiniteRangeSpec(value, range, assumptions)
    if (finite.status === 'pass' || alternatives.length === range.finiteValues.length) return finite
  }
  const worlds = evaluatedRangeWorlds(alternatives, assumptions)
  if (worlds.kind === 'overflow') {
    return proveNumberInsideRangeCasesAfterWorldLimit(value, range, alternatives, assumptions)
  }
  if (worlds.worlds.length === 0) return {status: 'fail', reason: emptyRangeSpecFailureReason(value, range)}
  if (value.caseLoss != null) {
    return proveNumberInsideRangeCasesAfterLoss(
      value,
      value.caseLoss,
      range,
      worlds.worlds,
      assumptions,
    )
  }

  let unknownProblem: RangeProblem | null = null
  const valueHasAlternatives = numberBranches(value).length > 1
  for (const branch of reachableNumberCases(value, assumptions)) {
    let passCount = 0
    let failCount = 0
    let unknownCount = 0
    let branchProblem: RangeProblem | null = null
    for (const world of worlds.worlds) {
      const relationship = branchRelationship(
        [],
        branch.caseBranches,
        world.branches,
      )
      if (relationship === 'conflict') continue
      const separateBranches = world.separateBranches
        || relationship === 'separate'
      const branchAssumptions = separateBranches
        ? mergeAssumptions(
            assumptions,
            sharedAssumptions([branch.caseAssumptions, world.assumptions]),
          )
        : mergeAssumptions(branch.assumptions, world.assumptions)
      const projected = reachableNumberCases(
        branch.value,
        separateBranches
          ? mergeAssumptions(assumptions, branch.caseAssumptions)
          : branchAssumptions,
        branch.branches,
      )
      if (projected.length === 0) continue
      const branchProof = proveNumberInsideAnyRangeCase(
        projected[0]!.value,
        range,
        world.cases,
        branchAssumptions,
      )
      if (branchProof.kind === 'pass') {
        passCount++
        continue
      }
      if (branchProof.kind === 'fail') failCount++
      else unknownCount++
      branchProblem ??= {
        value: projected[0]!.value,
        cases: world.cases,
        proof: branchProof,
        assumptions: branchAssumptions,
        uncorrelated: separateBranches,
      }
    }
    if (passCount === 0 && failCount === 0 && unknownCount === 0) {
      return {status: 'unknown', reason: 'No reachable value and dynamic range combination was available'}
    }
    if (
      failCount > 0
      && unknownCount === 0
      && branchProblem != null
      && !(branchProblem.uncorrelated && passCount > 0)
      && (!valueHasAlternatives || passCount === 0)
    ) {
      const reason = rangeProblemReason(branchProblem.value, range, branchProblem.cases, branchProblem.proof, branchProblem.assumptions)
      return {status: 'fail', reason}
    }
    if (failCount > 0 || unknownCount > 0) {
      if (branchProblem != null && passCount > 0) branchProblem.uncorrelated = true
      unknownProblem ??= branchProblem
    }
  }
  if (unknownProblem == null) return {status: 'pass'}
  const reason = rangeProblemReason(
    unknownProblem.value,
    range,
    unknownProblem.cases,
    unknownProblem.proof,
    unknownProblem.assumptions,
  )
  return {
    status: 'unknown',
    reason: unknownProblem.uncorrelated
      ? `Dynamic range choices and the returned value came from separate branch constructs, so Freerange does not assume they match\n${reason}`
      : reason,
  }
}

function proveNumberInsideRangeCasesAfterLoss(
  value: NumberValue,
  loss: NonNullable<NumberValue['caseLoss']>,
  range: FitRange,
  worlds: EvaluatedRangeWorld[],
  assumptions: Assumption[],
): {status: FitCheckStatus; reason?: string} {
  let passCount = 0
  let failCount = 0
  let unknownCount = 0
  let firstProblem: RangeProblem | null = null
  for (const branch of reachableNumberCases(value, assumptions)) {
    for (const world of worlds) {
      const relationship = branchRelationship(
        [],
        branch.caseBranches,
        world.branches,
      )
      if (relationship === 'conflict') continue
      const separateBranches = world.separateBranches
        || relationship === 'separate'
      const branchAssumptions = separateBranches
        ? mergeAssumptions(
            assumptions,
            sharedAssumptions([branch.caseAssumptions, world.assumptions]),
          )
        : mergeAssumptions(branch.assumptions, world.assumptions)
      const projected = reachableNumberCases(
        branch.value,
        separateBranches
          ? mergeAssumptions(assumptions, branch.caseAssumptions)
          : branchAssumptions,
        branch.branches,
      )
      if (projected.length === 0) continue
      const proof = proveNumberInsideAnyRangeCase(
        projected[0]!.value,
        range,
        world.cases,
        branchAssumptions,
      )
      if (proof.kind === 'pass') {
        passCount++
        continue
      }
      if (proof.kind === 'fail') failCount++
      else unknownCount++
      firstProblem ??= {
        value: projected[0]!.value,
        cases: world.cases,
        proof,
        assumptions: branchAssumptions,
        uncorrelated: true,
      }
    }
  }
  if (passCount === 0 && failCount === 0 && unknownCount === 0) {
    return {status: 'unknown', reason: 'No reachable value and dynamic range combination was available'}
  }
  if (failCount > 0 && passCount === 0 && unknownCount === 0 && firstProblem != null) {
    return {
      status: 'fail',
      reason: rangeProblemReason(
        firstProblem.value,
        range,
        firstProblem.cases,
        firstProblem.proof,
        firstProblem.assumptions,
      ),
    }
  }
  if (passCount > 0 && failCount === 0 && unknownCount === 0) return {status: 'pass'}
  return {status: 'unknown', reason: numberCaseLossMessage(loss)}
}

function proveNumberInsideRangeCasesAfterWorldLimit(
  value: NumberValue,
  range: FitRange,
  alternatives: ExpandedRangeAlternative[],
  assumptions: Assumption[],
): {status: FitCheckStatus; reason?: string} {
  const guaranteedCases = alternatives
    .map(alternative => guaranteedRangeCase(alternative.cases))
    .filter(rangeCase => rangeCase != null)
  if (
    guaranteedCases.length > 0
    && proveNumberInsideAnyRangeCase(value, range, guaranteedCases, assumptions).kind === 'pass'
  ) {
    return {status: 'pass'}
  }

  const possibleCases = alternatives
    .map(alternative => possibleRangeCase(alternative.cases))
    .filter(rangeCase => rangeCase != null)
  if (possibleCases.length > 0) {
    const proof = proveNumberInsideAnyRangeCase(value, range, possibleCases, assumptions)
    if (proof.kind === 'fail') {
      return {
        status: 'fail',
        reason: rangeProblemReason(value, range, possibleCases, proof, assumptions),
      }
    }
  }

  return {
    status: 'unknown',
    reason: `Numeric alternative budget exceeded: more than ${maxNumberCases} reachable dynamic range combinations`,
  }
}

function guaranteedRangeCase(cases: EvaluatedRangeCase[]): EvaluatedRangeCase | null {
  const first = cases[0]
  if (first == null) return null
  return {
    source: first.source,
    lower: exactRangeBound(Math.max(...cases.map(rangeCase => rangeCase.lower.max))),
    upper: exactRangeBound(Math.min(...cases.map(rangeCase => rangeCase.upper.min))),
    assumptions: [],
    branches: [],
    separateBranches: false,
  }
}

function possibleRangeCase(cases: EvaluatedRangeCase[]): EvaluatedRangeCase | null {
  const first = cases[0]
  if (first == null) return null
  return {
    source: first.source,
    lower: exactRangeBound(Math.min(...cases.map(rangeCase => rangeCase.lower.min))),
    upper: exactRangeBound(Math.max(...cases.map(rangeCase => rangeCase.upper.max))),
    assumptions: [],
    branches: [],
    separateBranches: false,
  }
}

function exactRangeBound(value: number) {
  return numberValue(
    value,
    value,
    gridOfNumber(value),
    String(value),
    Number.isFinite(value) ? linearConstant(value) : null,
  )
}

function rangeProblemReason(
  value: NumberValue,
  range: FitRange,
  cases: EvaluatedRangeCase[],
  proof: Exclude<RangeCasesProof, {kind: 'pass'}>,
  assumptions: Assumption[],
) {
  const reason = rangeSpecFailureReasonForCases(
    value,
    range,
    cases,
    assumptions,
    proof.status,
    proof.case,
  )
  if (proof.kind !== 'fail' || cases.length !== 1) return reason
  const witness = rangeCaseCounterexample(value, proof.case, proof.status, assumptions)
  return witness == null ? reason : `${reason}\n${witness}`
}

type EvaluatedRangeWorld = {
  cases: EvaluatedRangeCase[]
  assumptions: Assumption[]
  branches: BranchArm[]
  separateBranches: boolean
}

function evaluatedRangeWorlds(
  alternatives: ExpandedRangeAlternative[],
  assumptions: Assumption[],
): {kind: 'worlds'; worlds: EvaluatedRangeWorld[]} | {kind: 'overflow'} {
  let worlds: EvaluatedRangeWorld[] = [{
    cases: [],
    assumptions: [],
    branches: [],
    separateBranches: false,
  }]
  for (const alternative of alternatives) {
    const next: EvaluatedRangeWorld[] = []
    for (const world of worlds) {
      for (const rangeCase of alternative.cases) {
        const relationship = branchRelationship(
          [],
          world.branches,
          rangeCase.branches,
        )
        if (relationship === 'conflict') continue
        const separateBranches = world.separateBranches
          || rangeCase.separateBranches
          || relationship === 'separate'
        const combined = separateBranches
          ? mergeAssumptions(
              assumptions,
              sharedAssumptions([world.assumptions, rangeCase.assumptions]),
            )
          : mergeAssumptions(
              assumptions,
              world.assumptions,
              rangeCase.assumptions,
            )
        if (!separateBranches && !assumptionsAreReachable(combined)) continue
        next.push({
          cases: [...world.cases, rangeCase],
          assumptions: separateBranches
            ? sharedAssumptions([world.assumptions, rangeCase.assumptions])
            : mergeAssumptions(world.assumptions, rangeCase.assumptions),
          branches: mergeBranchArms(world.branches, rangeCase.branches),
          separateBranches,
        })
        if (next.length > maxNumberCases) return {kind: 'overflow'}
      }
    }
    worlds = next
  }
  return {kind: 'worlds', worlds}
}

function rangeCaseCounterexample(
  value: NumberValue,
  rangeCase: EvaluatedRangeCase,
  status: RangeCaseStatus,
  assumptions: Assumption[],
): string | null {
  const proofAssumptions = mergeAssumptions(assumptions, rangeCase.assumptions)
  const sides: {proof: {status: string}; op: ComparisonOperator; bound: NumberValue}[] = [
    {proof: status.lower, op: rangeCase.source.lowerInclusive ? '>=' : '>', bound: rangeCase.lower},
    {proof: status.upper, op: rangeCase.source.upperInclusive ? '<=' : '<', bound: rangeCase.upper},
  ]
  for (const side of sides) {
    if (side.proof.status === 'pass') continue
    const witness = comparisonCounterexample(value, side.op, side.bound, proofAssumptions)
    if (witness == null) continue
    return witness.kind === 'unbounded'
      ? `counterexample: the known facts put no bound on ${publicFitText(value.expr ?? formatRange(value))} in that direction`
      : `counterexample within the known facts: ${formatCounterexamplePoint(witness.point)}`
  }
  return null
}

function formatCounterexamplePoint(point: Map<string, Rational>): string {
  const entries = [...point.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${publicFitText(publicLinearName(name))} = ${rationalToNumber(value)}`)
  return entries.length > 6 ? `${entries.slice(0, 6).join(', ')}, …` : entries.join(', ')
}

type RangeCasesProof =
  | {kind: 'pass'}
  | {kind: 'unknown'; case: EvaluatedRangeCase; status: RangeCaseStatus}
  | {kind: 'fail'; case: EvaluatedRangeCase; status: RangeCaseStatus}

function proveNumberInsideAnyRangeCase(
  value: NumberValue,
  range: FitRange,
  cases: EvaluatedRangeCase[],
  assumptions: Assumption[],
): RangeCasesProof {
  let unknown: {case: EvaluatedRangeCase; status: RangeCaseStatus} | null = null
  for (const rangeCase of cases) {
    const status = proveNumberInsideRangeCase(value, range, rangeCase, assumptions)
    if (status.status === 'pass') return {kind: 'pass'}
    if (status.status === 'unknown' && unknown == null) unknown = {case: rangeCase, status}
  }
  if (unknown != null) return {kind: 'unknown', case: unknown.case, status: unknown.status}
  const first = cases[0]!
  return {kind: 'fail', case: first, status: proveNumberInsideRangeCase(value, range, first, assumptions)}
}

type RangeCaseStatus = {
  status: FitCheckStatus
  lower: ReturnType<typeof proveComparison>
  upper: ReturnType<typeof proveComparison>
  integer: {status: FitCheckStatus; reason?: string}
}

// FAIL is a disproof: every value the recorded facts allow violates the claim.
// A range that merely is not proven inside — partial overlap, an unknown
// value, an unproven integer-ness — reports unknown, with the missing piece
// named. The comparison layer already returns fail only on full violation.
function proveNumberInsideRangeCase(
  value: NumberValue,
  range: FitRange,
  rangeCase: EvaluatedRangeCase,
  assumptions: Assumption[],
): RangeCaseStatus {
  const proofAssumptions = mergeAssumptions(assumptions, rangeCase.assumptions)
  const lower = proveComparison(value, rangeCase.source.lowerInclusive ? '>=' : '>', rangeCase.lower, proofAssumptions)
  const upper = proveComparison(value, rangeCase.source.upperInclusive ? '<=' : '<', rangeCase.upper, proofAssumptions)
  const integer = integerClaimStatus(value, range)
  const status: FitCheckStatus = lower.status === 'pass' && upper.status === 'pass' && integer.status === 'pass'
    ? 'pass'
    : lower.status === 'fail' || upper.status === 'fail' || integer.status === 'fail'
      ? 'fail'
      : 'unknown'
  return {status, lower, upper, integer}
}

function integerClaimStatus(value: NumberValue, range: FitRange): {status: FitCheckStatus; reason?: string} {
  if (range.valueKind !== 'int' || finiteMembersAreIntegers(value)) return {status: 'pass'}
  const provablyFractional = value.min === value.max && Number.isFinite(value.min) && !Number.isInteger(value.min)
  return {
    status: provablyFractional ? 'fail' : 'unknown',
    reason: `need: ${value.expr ?? formatRange(value)} to be integer`,
  }
}

function rangeSpecFailureReasonForCases(
  value: NumberValue,
  range: FitRange,
  cases: EvaluatedRangeCase[],
  assumptions: Assumption[],
  status: RangeCaseStatus,
  rangeCase: EvaluatedRangeCase,
) {
  if (cases.length === 1) {
    return rangeSpecFailureReason(value, range, rangeCase.lower, rangeCase.upper, linearConstraints(mergeAssumptions(assumptions, rangeCase.assumptions)), {
      lower: status.lower.status !== 'pass',
      upper: status.upper.status !== 'pass',
      integer: status.integer.status !== 'pass',
    })
  }
  const lines = [`range was ${formatRange(value)}, expected inside ${formatRangeSpec(range)}`]
  const known = knownProofContextMany(
    [value, ...cases.flatMap(item => [item.lower, item.upper])],
    linearConstraints(assumptions),
  )
  if (known.length > 0) lines.push(`known:\n${known.map(line => `  ${line}`).join('\n')}`)
  lines.push(`missing: ${value.expr ?? formatRange(value)} in ${formatRangeSpec(range)}`)
  return lines.join('\n')
}

function emptyRangeSpecFailureReason(value: NumberValue, range: FitRange) {
  return [
    `range was ${formatRange(value)}, expected inside ${formatRangeSpec(range)}`,
    `missing: ${formatRangeSpec(range)} had no possible value`,
  ].join('\n')
}

function proveFiniteRangeSpec(
  value: NumberValue,
  range: FitRange,
  assumptions: Assumption[],
): {status: FitCheckStatus; reason?: string} {
  const expected = range.finiteValues ?? []
  const branches = reachableNumberCases(value, assumptions)
  const produced = finiteNumberSetFromBranches(branches.map(branch => branch.value))
  if (produced != null && produced.every(choice => expected.includes(choice))) return {status: 'pass'}
  if (value.caseLoss != null) {
    return {status: 'unknown', reason: numberCaseLossMessage(value.caseLoss)}
  }
  return {
    // A value that cannot be enumerated is unproven, not disproven.
    status: produced == null ? 'unknown' : 'fail',
    reason: finiteRangeSpecFailureReason(value, range, produced),
  }
}

function finiteNumberSetFromBranches(branches: NumberValue[]): number[] | null {
  const values: number[] = []
  for (const branch of branches) {
    const finite = finiteNumberSet(branch)
    if (finite == null) return null
    values.push(...finite)
  }
  return [...new Set(values)].sort((left, right) => left - right)
}

function rangeBoundNumberReason(bound: 'lower' | 'upper', value: Exclude<Value, NumberValue>, text: string) {
  return value.kind === 'unknown' ? value.reason : `Range ${bound} bound is not a number: ${text}`
}

function expectedNumberReason(value: Exclude<Value, NumberValue>) {
  if (value.kind === 'unknown') return value.reason
  if (value.kind === 'nullable') return `Nullable value ${value.expr ?? '<value>'} was not proven present`
  if (value.kind === 'null') return 'Expected a number, got null'
  if (value.kind === 'literal') return 'Expected a number, got a literal value'
  return value.kind === 'array' ? 'Expected a number, got an array' : 'Expected a number, got an object'
}

function specBoundIndexContext(context: EvalContext, hooks: CheckSpecHooks): BoundIndexContext {
  return {
    assumptions: context.assumptions,
    evaluateDomainPath: domainPath => hooks.evaluateDomainPath(domainPath, context),
    evaluateSpecExpression: text => evaluateSpecExpression(text, context, hooks),
    nondecreasingFailureReason,
    proveAdjacentComparison: (collectionPath, comparison) => {
      const collection = hooks.evaluateDomainPath(collectionPath, context)
      if (collection.kind !== 'array') return {status: 'unknown', reason: `${domainPathText(collectionPath)} expected an array`}
      const resolve = (text: string) => {
        const value = evaluateSpecExpression(text, context, hooks)
        return value.kind === 'number' ? value : null
      }
      if (proveAdjacentComparison(collection, comparison, resolve)) return {status: 'pass'}
      const collectionText = domainPathText(collectionPath)
      return {
        status: 'unknown',
        reason: adjacentComparisonFailureReason(adjacentComparisonText(collectionText, comparison), collectionText, collection),
      }
    },
  }
}

export function evaluateRangeBound(text: FitExpressionLike, context: EvalContext, hooks: CheckSpecHooks): Value {
  const sourceText = fitExpressionText(text)
  const printed = hooks.parsePrintedNumber(sourceText)
  if (printed != null) return numberValue(printed, printed, gridOfNumber(printed), sourceText, Number.isFinite(printed) ? linearConstant(printed) : null)
  return evaluateSpecExpression(text, context, hooks)
}

function checkWildcardComparisonShape(left: FitExpressionLike, right: FitExpressionLike): WildcardUse {
  const leftUse = wildcardUse(left)
  if (leftUse.kind === 'unsupported') return leftUse
  const rightUse = wildcardUse(right)
  if (rightUse.kind === 'unsupported') return rightUse

  if (leftUse.kind === 'one' && rightUse.kind === 'one') {
    if (leftUse.collection === rightUse.collection) return leftUse
    return {kind: 'unsupported', reason: 'Wildcard comparisons support one wildcard side and one scalar side'}
  }
  return leftUse.kind === 'one' ? leftUse : rightUse
}

function wildcardUse(text: FitExpressionLike): WildcardUse {
  const collections = new Set<string>()
  for (const domainPath of fitExpressionParsed(text).domainPaths.values()) {
    const itemCount = domainPath.segments.filter(segment => segment.kind === 'item').length
    if (itemCount === 0) continue
    collections.add(domainPathCollectionText(domainPath))
  }
  if (collections.size === 0) return {kind: 'none'}
  if (collections.size > 1) return {kind: 'unsupported', reason: `Wildcard comparisons support one collection at a time: ${fitExpressionText(text)}`}
  return {kind: 'one', collection: [...collections][0]!}
}

function domainPathCollectionText(domainPath: FitDomainPath) {
  const lastItemIndex = domainPath.segments.findLastIndex(segment => segment.kind === 'item')
  let collection = domainPath.root
  for (let index = 0; index <= lastItemIndex; index++) {
    const segment = domainPath.segments[index]!
    if (segment.kind === 'item') {
      collection = `${collection}[]`
      continue
    }
    collection = segment.kind === 'index'
      ? `${collection}[${segment.index}]`
      : `${collection}.${segment.name}`
  }
  return publicFitText(collection)
}

function domainPathText(domainPath: FitDomainPath) {
  let text = domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') {
      text += `.${segment.name}`
      continue
    }
    text += segment.kind === 'index' ? `[${segment.index}]` : '[]'
  }
  return publicFitText(text)
}

export function evaluateSpecExpression(text: FitExpressionLike, context: EvalContext, hooks: CheckSpecHooks): Value {
  const parsed = fitExpressionParsed(text)
  const scopedContext = fitExpressionScopeSourceId(text) == null ? context : hooks.contextForExpression?.(text, context) ?? context
  if (parsed.domainPaths.size === 0) return hooks.evaluateExpression(parsed.expression, scopedContext)

  const env = new Map(scopedContext.env)
  for (const [name, domainPath] of parsed.domainPaths) env.set(name, hooks.evaluateDomainPath(domainPath, context))
  return hooks.evaluateExpression(parsed.expression, {...scopedContext, env})
}

function verifyBooleanExpressionSpec(
  file: string,
  functionName: string,
  spec: FitExpressionCheckSpec,
  context: EvalContext,
  hooks: CheckSpecHooks,
): CheckSpecProof {
  if (booleanExpressionIsAssumed(context, spec.expression)) {
    return checkProof({
      file,
      ...(spec.line == null ? {} : {line: spec.line}),
      functionName,
      text: spec.text,
      status: 'pass',
    }, 'boolean', 'assumption', 'checked assumed boolean expression', [], context.assumptions)
  }
  const value = evaluateSpecExpression(spec.expression, context, hooks)
  const status = proveBooleanTrue(spec.text, value)
  return checkProof({
    file,
    ...(spec.line == null ? {} : {line: spec.line}),
    functionName,
    text: spec.text,
    status: status.status,
    ...(status.reason == null ? {} : {reason: status.reason}),
  }, 'boolean', 'expression', 'checked boolean expression', [value], context.assumptions)
}

function adjacentComparisonFailureReason(text: string, collectionText: string, rows: ArrayValue) {
  const knownRelations = arraySummary(rows)?.relations
    .filter(relation => relation.op === '==')
    .map(relation => sequenceRelationText(collectionText, relation)) ?? []
  const known = [
    `sequence facts: ${formatArraySummary(rows)}`,
    ...knownRelations.map(relation => `adjacent: ${relation}`),
  ]
  return [
    `${text} was not inferred`,
    'need: a matching adjacent sequence relation',
    `known:\n${known.map(line => `  ${line}`).join('\n')}`,
    'missing: recognized adjacent row relation',
  ].join('\n')
}
