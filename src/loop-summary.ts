import * as ts from 'typescript'
import {
  binaryExpr,
  mergeElementValue,
  mergeProvenance,
  numberValue,
  runningExtremumNumber,
  runningSumNumber,
  unknown,
  unknownNumber,
  unknownObject,
  linearNameForExpression,
  type ArraySummary,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type SequenceTerm,
  type Value,
} from './domain.ts'
import {
  linearAdd,
  linearConstant,
  linearSubtract,
  linearVariable,
  sameExpressionText,
  sameLinear,
  unwrapExpression,
} from './linear.ts'
import {parseExpression} from './parser.ts'
import {proveComparison} from './proof.ts'
import {valueWithStructuralFallback} from './shapes.ts'

export type LoopScalarUpdate = {
  start: NumberValue
  increment: NumberValue
  end: NumberValue
}

export type LoopExtremum = {
  targetName: string
  kind: 'min' | 'max'
  candidate: NumberValue
}

export type LoopPush = {
  arrayName: string
  length: NumberValue
  element: Value | null
  topName: string | null
  height: NumberValue | null
  cursorPaths: {path: string[]; targetName: string}[]
}

export type GuardedLoopPush = LoopPush & {
  segmentedStack: SegmentedStackPush | null
}

export type SegmentedStackPush = {
  cursorName: string
  topName: string
  bottomName: string
  gap: NumberValue
}

export type AppendStream = {
  path: string[]
  value: Value
}

export type AppendClock = {
  arrayName: string
  length: NumberValue
  streams: AppendStream[]
  recurrence: AppendRecurrence | null
}

export type AppendRecurrence = {
  prop: string
  start: NumberValue
  advance: NumberValue
  size: NumberValue
}

export function loopExtremaConflictWithAdds(extrema: Map<string, LoopExtremum>, adds: Map<string, NumberValue>) {
  for (const targetName of extrema.keys()) {
    if (adds.has(targetName)) return true
  }
  return false
}

export function applyLoopExtrema(extrema: Map<string, LoopExtremum>, length: NumberValue, env: Map<string, Value>, targetError: string): Value | null {
  for (const extremum of extrema.values()) {
    const start = env.get(extremum.targetName)
    if (start == null || start.kind !== 'number') return unknown(targetError)
    env.set(extremum.targetName, runningExtremumNumber(extremum.kind, extremum.targetName, start, length, extremum.candidate))
  }
  return null
}

export function conditionalPushLength(arrayName: string, sourceLength: NumberValue, startLength: NumberValue = numberValue(0, 0, true, '0', linearConstant(0))): NumberValue {
  return numberValue(startLength.min, startLength.max + sourceLength.max, true, `${arrayName}.length`, linearVariable(linearNameForExpression(`${arrayName}.length`)))
}

export function loopElementFromPush(
  push: LoopPush,
  updates: Map<string, LoopScalarUpdate>,
  extrema: Map<string, LoopExtremum>,
  length: NumberValue,
  env: Map<string, Value>,
  assumptions: LinearConstraint[],
): Value | null {
  if (push.element == null || (updates.size === 0 && extrema.size === 0)) return push.element
  let element = push.element
  for (const cursorPath of push.cursorPaths) {
    const update = updates.get(cursorPath.targetName)
    const expr = cursorPath.path.length === 0 ? `${push.arrayName}[]` : `${push.arrayName}[].${cursorPath.path.join('.')}`
    if (update != null) {
      element = setObjectPathValue(element, cursorPath.path, loopCursorElementValue(update, expr, assumptions))
      continue
    }
    const extremum = extrema.get(cursorPath.targetName)
    const start = env.get(cursorPath.targetName)
    if (extremum != null && start?.kind === 'number') {
      element = setObjectPathValue(element, cursorPath.path, runningExtremumNumber(extremum.kind, expr, start, length, extremum.candidate))
    }
  }
  return element
}

export function segmentedStackElement(push: GuardedLoopPush, element: Value | null, sourceLength: NumberValue, env: Map<string, Value>): Value | null {
  if (push.segmentedStack == null || element?.kind !== 'object') return element
  const props = new Map(element.props)
  const height = props.get('height')
  if (height?.kind !== 'number') return element
  const advance = segmentedStackAdvance(height, push.segmentedStack.gap)

  const top = segmentedStackTopValue(push, sourceLength, advance, env)
  const bottom = addNumbers(top, height)
  props.set('top', top)
  props.set('bottom', bottom)
  return {...element, props}
}

export function pushedElementValue(target: ArrayValue, element: Value | null): Value | null {
  if (target.length.min === 0 && target.length.max === 0) {
    return element == null ? target.element : valueWithStructuralFallback(element, target.element)
  }
  return mergeElementValue(target.element, element)
}

export function segmentedStackSummary(push: GuardedLoopPush, element: Value | null): ArraySummary | null {
  if (push.segmentedStack == null || element?.kind !== 'object') return null
  const height = element.props.get('height')
  if (height?.kind !== 'number') return null
  const advance = segmentedStackAdvance(height, push.segmentedStack.gap)
  const clock = appendClockFromElement(push.arrayName, push.length, element, {
    prop: 'top',
    start: unknownNumber(`${push.arrayName}[].top`),
    advance,
    size: height,
  })
  return sequenceSummaryFromAppendClock(clock, {resolveNumber: () => null, includeExtentEnd: false})
}

export function applySegmentedStackCursorUpdate(push: GuardedLoopPush, element: Value | null, sourceLength: NumberValue, env: Map<string, Value>) {
  if (push.segmentedStack == null || element?.kind !== 'object') return
  const height = element.props.get('height')
  if (height?.kind !== 'number') return
  const advance = segmentedStackAdvance(height, push.segmentedStack.gap)
  const start = env.get(push.segmentedStack.cursorName)
  if (start?.kind !== 'number') return
  env.set(push.segmentedStack.cursorName, segmentedStackCursorValue(push.segmentedStack.cursorName, start, sourceLength, advance))
}

export function indexedLoopElementFromPush(push: LoopPush, indexName: string, sourceLength: NumberValue): Value | null {
  if (push.element == null) return null
  return indexedLoopValueFromPush(push.element, indexName, sourceLength, `${push.arrayName}[]`)
}

export function indexedElementValue(arrayName: string, prop: string, sourceLength: NumberValue): NumberValue {
  return indexedElementPathValue(`${arrayName}[].${prop}`, sourceLength)
}

export function indexedElementPathValue(expr: string, sourceLength: NumberValue): NumberValue {
  return numberValue(
    0,
    Math.max(0, sourceLength.max - 1),
    true,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}

export function sequenceSummaryFromLoopPush(
  push: LoopPush,
  update: LoopScalarUpdate | undefined,
  options: {assumptions: LinearConstraint[]; resolveNumber: (expr: string) => NumberValue | null},
): ArraySummary | null {
  if (push.topName == null || push.height == null || update == null) return null
  const clock = appendClockFromElement(push.arrayName, push.length, push.element, {
    prop: 'top',
    start: update.start,
    advance: update.increment,
    size: push.height,
  })
  return sequenceSummaryFromAppendClock(clock, {
    resolveNumber: options.resolveNumber,
    includeExtentEnd: true,
    assumptions: options.assumptions,
  })
}

function appendClockFromElement(
  arrayName: string,
  length: NumberValue,
  element: Value | null,
  recurrence: AppendRecurrence | null,
): AppendClock {
  return {
    arrayName,
    length,
    streams: element == null ? [] : appendStreamsFromValue(element),
    recurrence,
  }
}

function appendStreamsFromValue(value: Value, path: string[] = []): AppendStream[] {
  if (value.kind !== 'object') return [{path, value}]
  const streams: AppendStream[] = []
  for (const [name, prop] of value.props) streams.push(...appendStreamsFromValue(prop, [...path, name]))
  return streams
}

function sequenceSummaryFromAppendClock(
  clock: AppendClock,
  options: {
    resolveNumber: (expr: string) => NumberValue | null
    includeExtentEnd: boolean
    assumptions?: LinearConstraint[]
  },
): ArraySummary | null {
  const recurrence = clock.recurrence
  if (recurrence == null) return null
  const summary: ArraySummary = {relations: [], nondecreasingProps: [], advances: [{prop: recurrence.prop, value: recurrence.advance}], spaced: [], lastEnd: null, extentEnds: []}
  const advanceIsNonnegative = recurrence.advance.min >= 0
    && (options.assumptions == null
      || proveComparison(recurrence.advance, '>=', numberValue(0, 0, true, '0', linearConstant(0)), options.assumptions).status === 'pass')
  if (advanceIsNonnegative) addNondecreasingRelation(summary, recurrence.prop)

  const advanceExpr = recurrence.advance.expr
  const sizeExpr = recurrence.size.expr
  if (advanceExpr == null || sizeExpr == null) return summary
  const gapExpr = spacedGapExpr(advanceExpr, sizeExpr)
  if (gapExpr == null) return summary

  summary.spaced.push({gapExpr, heightExpr: sizeExpr, advanceExpr})
  addSpacedRelations(summary, clock, recurrence.prop, sizeExpr, gapExpr)
  if (!options.includeExtentEnd) return summary

  const nonEmptyEnd = lastEndFromLoopEnd(nonEmptyLoopEnd(recurrence.start, recurrence.advance, clock.length), gapExpr, options.resolveNumber)
  if (clock.length.min >= 1) summary.lastEnd = nonEmptyEnd
  const extentEnd = extentEndFromLoopPush(clock.arrayName, recurrence.start, nonEmptyEnd)
  if (extentEnd != null) summary.extentEnds.push(extentEnd)
  return summary
}

function addNondecreasingRelation(summary: ArraySummary, prop: string) {
  summary.nondecreasingProps.push(prop)
  summary.relations.push({
    kind: 'adjacent-comparison',
    left: nextTerm([prop]),
    op: '>=',
    right: {terms: [previousTerm([prop])], addends: []},
  })
}

function addSpacedRelations(summary: ArraySummary, clock: AppendClock, topProp: string, sizeExpr: string, gapExpr: string) {
  const heightPath = pathForStreamValue(clock, sizeExpr)
  if (heightPath != null) {
    summary.relations.push({
      kind: 'adjacent-comparison',
      left: nextTerm([topProp]),
      op: '==',
      right: {terms: [previousTerm([topProp]), previousTerm(heightPath)], addends: addendsForGap(gapExpr)},
    })
  }

  const bottomPath = pathForStreamSum(clock, [topProp], heightPath, sizeExpr)
  if (bottomPath != null) {
    summary.relations.push({
      kind: 'adjacent-comparison',
      left: nextTerm([topProp]),
      op: '==',
      right: {terms: [previousTerm(bottomPath)], addends: addendsForGap(gapExpr)},
    })
  }
}

function pathForStreamValue(clock: AppendClock, expr: string): string[] | null {
  const stream = clock.streams.find(item => item.value.kind === 'number' && item.value.expr != null && sameExpressionText(item.value.expr, expr))
  return stream?.path ?? null
}

function pathForStreamSum(clock: AppendClock, leftPath: string[], rightPath: string[] | null, rightExpr: string) {
  const left = pathValue(clock, leftPath)
  const right = rightPath == null ? null : pathValue(clock, rightPath)
  if (left?.kind !== 'number') return null
  for (const stream of clock.streams) {
    if (stream.value.kind !== 'number') continue
    const sum = right?.kind === 'number' ? linearAdd(left.linear, right.linear) : null
    if (stream.value.linear != null && sum != null && sameLinear(stream.value.linear, sum)) return stream.path
    if (stream.value.expr != null && sameExpressionText(stream.value.expr, `${left.expr ?? ''} + ${rightExpr}`)) return stream.path
  }
  return null
}

function pathValue(clock: AppendClock, path: string[]): Value | null {
  return clock.streams.find(stream => samePath(stream.path, path))?.value ?? null
}

function samePath(left: string[], right: string[]) {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function addendsForGap(gapExpr: string) {
  return sameExpressionText(gapExpr, '0') ? [] : [gapExpr]
}

function nextTerm(path: string[]): SequenceTerm {
  return {item: 'next', path}
}

function previousTerm(path: string[]): SequenceTerm {
  return {item: 'previous', path}
}

function setObjectPathValue(value: Value, path: string[], replacement: Value): Value {
  const [head, ...tail] = path
  if (head == null) return replacement
  if (value.kind !== 'object') return value
  const props = new Map(value.props)
  const current = props.get(head)
  props.set(head, setObjectPathValue(current ?? unknownObject(head), tail, replacement))
  return {...value, props}
}

function indexedLoopValueFromPush(value: Value, indexName: string, sourceLength: NumberValue, expr: string): Value {
  if (value.kind === 'number' && value.expr === indexName) return indexedElementPathValue(expr, sourceLength)
  if (value.kind === 'array') {
    return {
      ...value,
      elements: value.elements == null ? null : value.elements.map((element, index) => indexedLoopValueFromPush(element, indexName, sourceLength, `${expr}[${index}]`)),
      element: value.element == null ? null : indexedLoopValueFromPush(value.element, indexName, sourceLength, `${expr}[]`),
    }
  }
  if (value.kind !== 'object') return value
  const props = new Map<string, Value>()
  for (const [name, prop] of value.props) {
    props.set(name, indexedLoopValueFromPush(prop, indexName, sourceLength, `${expr}.${name}`))
  }
  return {...value, props}
}

function loopCursorElementValue(
  update: LoopScalarUpdate,
  expr: string,
  assumptions: LinearConstraint[],
): NumberValue {
  if (update.increment.min < 0) return unknownNumber(expr)
  const startMin = proveComparison(update.start, '>=', numberValue(0, 0, true, '0', linearConstant(0)), assumptions).status === 'pass'
    ? Math.max(0, update.start.min)
    : update.start.min
  return numberValue(
    startMin,
    update.end.max,
    update.start.isInteger && update.increment.isInteger,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}

function segmentedStackAdvance(height: NumberValue, gap: NumberValue): NumberValue {
  return addNumbers(height, gap)
}

function segmentedStackTopValue(push: GuardedLoopPush, sourceLength: NumberValue, advance: NumberValue, env: Map<string, Value>): NumberValue {
  const start = push.segmentedStack == null ? null : env.get(push.segmentedStack.cursorName)
  if (start?.kind !== 'number') return unknownNumber(`${push.arrayName}[].top`)
  const bounds = repeatedAdvanceBounds(sourceLength, advance)
  return numberValue(
    start.min + bounds.min,
    start.max + bounds.max,
    start.isInteger && advance.isInteger,
    `${push.arrayName}[].top`,
    linearVariable(linearNameForExpression(`${push.arrayName}[].top`)),
  )
}

function segmentedStackCursorValue(name: string, start: NumberValue, sourceLength: NumberValue, advance: NumberValue): NumberValue {
  const bounds = repeatedAdvanceBounds(sourceLength, advance)
  return numberValue(
    start.min + bounds.min,
    start.max + bounds.max,
    start.isInteger && advance.isInteger,
    name,
    linearVariable(linearNameForExpression(name)),
  )
}

function repeatedAdvanceBounds(length: NumberValue, advance: NumberValue): {min: number; max: number} {
  const maxCount = Math.max(0, length.max)
  return {
    min: advance.min < 0 ? advance.min * maxCount : 0,
    max: advance.max > 0 ? advance.max * maxCount : 0,
  }
}

function nonEmptyLoopEnd(start: NumberValue, advance: NumberValue, length: NumberValue): NumberValue {
  const nonEmptyLength = {...length, min: Math.max(1, length.min)}
  return runningSumNumber(start, nonEmptyLength, advance)
}

function extentEndFromLoopPush(
  arrayName: string,
  empty: NumberValue,
  nonEmptyEnd: NumberValue | null,
): ArraySummary['extentEnds'][number] | null {
  if (empty.expr == null || nonEmptyEnd?.expr == null) return null
  return {
    emptyExpr: empty.expr,
    nonEmptyExpr: nonEmptyEnd.expr,
    value: numberValue(
      Math.min(empty.min, nonEmptyEnd.min),
      Math.max(empty.max, nonEmptyEnd.max),
      empty.isInteger && nonEmptyEnd.isInteger,
      `extentEnd(${arrayName}, ${empty.expr})`,
    ),
  }
}

function spacedGapExpr(incrementExpr: string, heightExpr: string): string | null {
  if (sameExpressionText(incrementExpr, heightExpr)) return '0'
  const expression = unwrapExpression(parseExpression(incrementExpr))
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
  if (sameExpressionText(expression.left.getText(), heightExpr)) return expression.right.getText()
  if (sameExpressionText(expression.right.getText(), heightExpr)) return expression.left.getText()
  return null
}

function lastEndFromLoopEnd(end: NumberValue, gapExpr: string, resolveNumber: (expr: string) => NumberValue | null): NumberValue | null {
  if (sameExpressionText(gapExpr, '0')) return end
  const gap = resolveNumber(gapExpr)
  return gap == null ? null : subtractNumbers(end, gap)
}

function addNumbers(left: NumberValue, right: NumberValue): NumberValue {
  return numberValue(left.min + right.min, left.max + right.max, left.isInteger && right.isInteger, binaryExpr(left, '+', right), linearAdd(left.linear, right.linear), null, mergeProvenance(left, right))
}

function subtractNumbers(left: NumberValue, right: NumberValue): NumberValue {
  return numberValue(left.min - right.max, left.max - right.min, left.isInteger && right.isInteger, binaryExpr(left, '-', right), linearSubtract(left.linear, right.linear), null, mergeProvenance(left, right))
}
