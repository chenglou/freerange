import {rationalEquals, rationalOne} from './rational.ts'
import {
  addNumbers,
  arrayLength,
  arraySummary,
  numberValue,
  unknownNumber,
  withNumberCases,
  type Assumption,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type ObjectValue,
  type SequenceExpression,
  type SequenceAddition,
  type SequenceRelation,
  type SequenceTerm,
  type Value,
} from './domain.ts'
import {
  expressionKeyFromText,
  linearConstant,
  type LinearExpr,
} from './linear.ts'
import {comparisonConstraint, proveComparison} from './proof.ts'
import {sequenceAdditionText} from './sequence-relation.ts'

export function adjacentElementAccessFacts(
  target: ArrayValue,
  index: NumberValue,
  sourceName: string,
  indexText: string,
  accessExpr: string,
  assumptions: Assumption[],
): LinearConstraint[] {
  const summary = arraySummary(target)
  if (summary == null || summary.relations.length === 0) return []
  const zero = numberValue(0, 0, 0, '0', linearConstant(0))
  const one = numberValue(1, 1, 0, '1', linearConstant(1))
  const facts: LinearConstraint[] = []

  const hasPrevious = proveComparison(index, '>', zero, assumptions)
  if (hasPrevious.status === 'pass') {
    for (const previousAccessExpr of neighborAccessExprs(sourceName, index, indexText, -1)) {
      facts.push(...instantiateAdjacentFacts(accessExpr, previousAccessExpr, summary.relations))
    }
  }

  const nextIndex = addNumbers(index, one)
  const hasNext = proveComparison(nextIndex, '<', arrayLength(target), assumptions)
  if (hasNext.status === 'pass') {
    for (const nextAccessExpr of neighborAccessExprs(sourceName, index, indexText, 1)) {
      facts.push(...instantiateAdjacentFacts(nextAccessExpr, accessExpr, summary.relations))
    }
  }

  return dedupeFacts(facts)
}

function instantiateAdjacentFacts(nextAccessExpr: string, previousAccessExpr: string, relations: SequenceRelation[]): LinearConstraint[] {
  const facts: LinearConstraint[] = []
  for (const relation of relations) {
    if (relation.left.item !== 'next') continue
    const leftExpr = sequenceTermExpr(nextAccessExpr, previousAccessExpr, relation.left)
    const rightExpr = relation.kind === 'adjacent-comparison'
      ? sequenceExpressionExpr(nextAccessExpr, previousAccessExpr, relation.right)
      : sequenceAdditionExpr(nextAccessExpr, previousAccessExpr, relation.right)
    const fact = comparisonConstraint(unknownNumber(leftExpr), relation.op, unknownNumber(rightExpr), undefined, 'code')
    if (fact != null) facts.push(fact)
  }
  return facts
}

function sequenceAdditionExpr(accessExpr: string, previousAccessExpr: string, addition: SequenceAddition): string {
  return sequenceAdditionText(addition, term => sequenceTermExpr(accessExpr, previousAccessExpr, term))
}

function neighborAccessExprs(sourceName: string, index: NumberValue, indexText: string, offset: -1 | 1): string[] {
  const canonical = shiftedLinearIndexText(index.linear, offset)
  const text = canonical ?? `${indexText} ${offset < 0 ? '-' : '+'} 1`
  return [`${sourceName}[${text}]`]
}

function shiftedLinearIndexText(linear: LinearExpr | null, offset: -1 | 1): string | null {
  if (linear == null || linear.terms.size !== 1) return null
  const term = [...linear.terms.entries()][0]
  if (term == null) return null
  const [name, coefficient] = term
  if (!rationalEquals(coefficient, rationalOne)) return null
  if (linear.constant.den !== 1n) return null
  const constant = linear.constant.num + BigInt(offset)
  if (constant === 0n) return name
  return constant > 0n ? `${name} + ${constant}` : `${name} - ${-constant}`
}

function dedupeFacts(facts: LinearConstraint[]): LinearConstraint[] {
  const seen = new Set<string>()
  const result: LinearConstraint[] = []
  for (const fact of facts) {
    const key = `${expressionFactKey(fact.leftExpr)}:${fact.op}:${expressionFactKey(fact.rightExpr)}:${fact.text ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(fact)
  }
  return result
}

function expressionFactKey(expression: string | undefined) {
  return expression == null ? '?' : expressionKeyFromText(expression)
}

export function valueWithRebasedElementPath(
  value: Value,
  sourceElementExpr: string,
  accessExpr: string,
  branchSuffix: string = accessExpr,
): Value {
  if (value.kind === 'number') return numberWithRebasedElementPath(value, sourceElementExpr, accessExpr, branchSuffix)
  if (value.kind === 'literal') return {...value, expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
  if (value.kind === 'object') return objectWithRebasedElementPath(value, sourceElementExpr, accessExpr, branchSuffix)
  if (value.kind === 'array') {
    const expr = rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)
    return value.layout === 'tuple'
      ? {
          ...value,
          elements: value.elements.map(element => valueWithRebasedElementPath(element, sourceElementExpr, accessExpr, branchSuffix)),
          expr,
        }
      : {
          ...value,
          length: numberWithRebasedElementPath(value.length, sourceElementExpr, accessExpr, branchSuffix),
          element: value.element == null ? null : valueWithRebasedElementPath(value.element, sourceElementExpr, accessExpr, branchSuffix),
          expr,
        }
  }
  if (value.kind === 'nullable') {
    return {...value, present: valueWithRebasedElementPath(value.present, sourceElementExpr, accessExpr, branchSuffix), expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
  }
  if (value.kind === 'null') return {...value, expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
  return value
}

function objectWithRebasedElementPath(value: ObjectValue, sourceElementExpr: string, accessExpr: string, branchSuffix: string): ObjectValue {
  const props = new Map<string, Value>()
  for (const [name, prop] of value.props) props.set(name, valueWithRebasedElementPath(prop, sourceElementExpr, accessExpr, branchSuffix))
  return {...value, props, expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
}

function numberWithRebasedElementPath(value: NumberValue, sourceElementExpr: string, accessExpr: string, branchSuffix: string): NumberValue {
  const expr = rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)
  const rebased = {
    ...numberValue(
      value.min,
      value.max,
      value.grid,
      expr,
      expr === value.expr ? value.linear : null,
      null,
      value.origin,
    ),
    ...(value.neverNaN === true ? {neverNaN: true as const} : {}),
    ...(value.caseLoss == null ? {} : {caseLoss: value.caseLoss}),
  }
  if (value.cases == null) return rebased
  return withNumberCases(rebased, value.cases.map(branch => ({
    value: numberWithRebasedElementPath(branch.value, sourceElementExpr, accessExpr, branchSuffix),
    assumptions: branch.assumptions.map(assumption =>
      rebaseElementAssumption(assumption, sourceElementExpr, accessExpr)),
    branches: branch.branches.map(arm => ({
      ...arm,
      path: [...(arm.path ?? []), branchSuffix],
    })),
  })))
}

function rebaseElementAssumption(
  assumption: Assumption,
  sourceElementExpr: string,
  accessExpr: string,
): Assumption {
  const leftExpr = assumption.leftExpr == null
    ? undefined
    : rebaseElementText(assumption.leftExpr, sourceElementExpr, accessExpr)
  const rightExpr = assumption.rightExpr == null
    ? undefined
    : rebaseElementText(assumption.rightExpr, sourceElementExpr, accessExpr)
  const expressionChanged = leftExpr !== assumption.leftExpr
    || rightExpr !== assumption.rightExpr
  return {
    ...assumption,
    diff: expressionChanged ? null : assumption.diff,
    ...(leftExpr == null ? {} : {leftExpr}),
    ...(rightExpr == null ? {} : {rightExpr}),
  }
}

function rebaseElementExpr(expr: string | null, sourceElementExpr: string, accessExpr: string) {
  return expr == null ? null : rebaseElementText(expr, sourceElementExpr, accessExpr)
}

function rebaseElementText(text: string, sourceElementExpr: string, accessExpr: string) {
  return text.replaceAll(sourceElementExpr, accessExpr)
}

function sequenceExpressionExpr(accessExpr: string, previousAccessExpr: string, expression: SequenceExpression): string {
  const parts = expression.terms.map(term => sequenceTermExpr(accessExpr, previousAccessExpr, term))
  parts.push(...expression.addends)
  if (parts.length === 0) return '0'
  return parts.join(' + ')
}

function sequenceTermExpr(accessExpr: string, previousAccessExpr: string, term: SequenceTerm): string {
  const base = term.item === 'next' ? accessExpr : previousAccessExpr
  return term.path.length === 0 ? base : `${base}.${term.path.join('.')}`
}
