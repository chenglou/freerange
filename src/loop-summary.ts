import * as ts from 'typescript'
import {
  addNumbers,
  mergeElementValue,
  mergeOrigin,
  multiplyNumbers,
  nonNanExtrema,
  numberValue,
  subtractNumbers,
  unknownNumber,
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
  linearScale,
  linearVariable,
  sameExpressionText,
  sameLinear,
  unwrapExpression,
} from './linear.ts'
import {parseExpression} from './parser.ts'
import {proveComparison} from './proof.ts'

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
  topPath: string[] | null
  height: NumberValue | null
  cursorPaths: {path: string[]; targetName: string}[]
}

export type GuardedLoopPush = LoopPush & {
  segmentedStack: SegmentedStackPush | null
}

export type SegmentedStackPush = {
  cursorName: string
  topName: string
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
  path: string[]
  start: NumberValue
  advance: NumberValue
  size: NumberValue
}

export function runningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const exactIncrement = increment.min === increment.max ? increment.min : null
  const exactLinear = exactIncrement == null || start.linear == null || count.linear == null
    ? null
    : linearAdd(start.linear, linearScale(count.linear, exactIncrement))
  const linear = exactLinear ?? linearVariable(linearNameForExpression(targetName))
  if (count.min < 0 || increment.min < 0) return numberValue(
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    false,
    targetName,
    linear,
    null,
    mergeOrigin(start, count, increment),
  )
  const delta = multiplyNumbers(count, increment)
  const result = addNumbers(start, delta)
  return numberValue(
    result.min,
    result.max,
    start.isInteger && count.isInteger && increment.isInteger,
    targetName,
    linear,
    null,
    mergeOrigin(start, count, increment),
  )
}

export function conditionalRunningSumNumber(targetName: string, start: NumberValue, count: NumberValue, increment: NumberValue): NumberValue {
  const deltaBounds = nonNanExtrema([
    0,
    count.max * increment.min,
    count.max * increment.max,
  ])
  const delta = numberValue(deltaBounds.min, deltaBounds.max, count.isInteger && increment.isInteger, null, null, null, mergeOrigin(count, increment))
  const result = addNumbers(start, delta)
  return numberValue(
    result.min,
    result.max,
    start.isInteger && count.isInteger && increment.isInteger,
    targetName,
    linearVariable(targetName),
    null,
    mergeOrigin(start, count, increment),
  )
}

export function runningExtremumNumber(kind: 'min' | 'max', targetName: string, start: NumberValue, count: NumberValue, candidate: NumberValue): NumberValue {
  if (count.max <= 0) {
    return numberValue(start.min, start.max, start.isInteger, targetName, linearVariable(linearNameForExpression(targetName)), null, start.origin)
  }

  const hasItem = count.min >= 1
  const min = kind === 'max'
    ? hasItem ? Math.max(start.min, candidate.min) : start.min
    : Math.min(start.min, candidate.min)
  const max = kind === 'max'
    ? Math.max(start.max, candidate.max)
    : hasItem ? Math.min(start.max, candidate.max) : start.max

  return numberValue(
    min,
    max,
    start.isInteger && candidate.isInteger,
    targetName,
    linearVariable(linearNameForExpression(targetName)),
    null,
    mergeOrigin(start, count, candidate),
  )
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
    return mergeElementValue(element, target.element)
  }
  return mergeElementValue(target.element, element)
}

export function segmentedStackSummary(push: GuardedLoopPush, element: Value | null): ArraySummary | null {
  if (push.segmentedStack == null || element?.kind !== 'object') return null
  const height = element.props.get('height')
  if (height?.kind !== 'number') return null
  const advance = segmentedStackAdvance(height, push.segmentedStack.gap)
  const clock = appendClockFromElement(push.arrayName, push.length, element, {
    path: push.topPath ?? ['top'],
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
  if (push.topPath == null) return null
  const clock = appendClockFromElement(push.arrayName, push.length, push.element, {
    path: push.topPath,
    start: update.start,
    advance: update.increment,
    size: push.height,
  })
  return sequenceSummaryFromAppendClock(clock, {
    resolveNumber: options.resolveNumber,
    includeExtentEnd: true,
    assumptions: options.assumptions,
    cursorEnd: update.end,
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
    cursorEnd?: NumberValue
  },
): ArraySummary | null {
  const recurrence = clock.recurrence
  if (recurrence == null) return null
  const summary: ArraySummary = {relations: [], advances: [{prop: pathText(recurrence.path), value: recurrence.advance}], lastEnd: null, extentEnds: []}
  const advanceIsNonnegative = recurrence.advance.min >= 0
    && (options.assumptions == null
      || proveComparison(recurrence.advance, '>=', numberValue(0, 0, true, '0', linearConstant(0)), options.assumptions).status === 'pass')
  if (advanceIsNonnegative) addNondecreasingRelation(summary, recurrence.path)

  const advanceExpr = recurrence.advance.expr
  const sizeExpr = recurrence.size.expr
  if (advanceExpr == null || sizeExpr == null) return summary
  const gapExpr = spacedGapExpr(advanceExpr, sizeExpr)
  if (gapExpr == null) return summary

  addSpacedRelations(summary, clock, recurrence.path, sizeExpr, gapExpr)
  if (!options.includeExtentEnd) return summary

  const loopEndName = `lastEnd(${clock.arrayName})`
  const loopEnd = options.cursorEnd ?? nonEmptyLoopEnd(loopEndName, recurrence.start, recurrence.advance, clock.length)
  const nonEmptyEnd = lastEndFromLoopEnd(loopEnd, gapExpr, options.resolveNumber)
  if (clock.length.min >= 1) summary.lastEnd = nonEmptyEnd
  const extentEnd = extentEndFromLoopPush(clock.arrayName, recurrence.start, nonEmptyEnd)
  if (extentEnd != null) summary.extentEnds.push(extentEnd)
  return summary
}

function addNondecreasingRelation(summary: ArraySummary, path: string[]) {
  summary.relations.push({
    kind: 'adjacent-comparison',
    left: nextTerm(path),
    op: '>=',
    right: {terms: [previousTerm(path)], addends: []},
  })
}

function addSpacedRelations(summary: ArraySummary, clock: AppendClock, topPath: string[], sizeExpr: string, gapExpr: string) {
  const heightPath = pathForStreamValue(clock, sizeExpr)
  if (heightPath != null) {
    summary.relations.push({
      kind: 'adjacent-comparison',
      left: nextTerm(topPath),
      op: '==',
      right: {terms: [previousTerm(topPath), previousTerm(heightPath)], addends: addendsForGap(gapExpr)},
    })
  }

  const bottomPath = pathForStreamSum(clock, topPath, heightPath, sizeExpr)
  if (bottomPath != null) {
    summary.relations.push({
      kind: 'adjacent-comparison',
      left: nextTerm(topPath),
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

function pathText(path: string[]) {
  return path.join('.')
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
  if (tail.length === 0) props.set(head, replacement)
  else if (current != null) props.set(head, setObjectPathValue(current, tail, replacement))
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

function nonEmptyLoopEnd(targetName: string, start: NumberValue, advance: NumberValue, length: NumberValue): NumberValue {
  const nonEmptyLength = {...length, min: Math.max(1, length.min)}
  return runningSumNumber(targetName, start, nonEmptyLength, advance)
}

function extentEndFromLoopPush(
  arrayName: string,
  empty: NumberValue,
  nonEmptyEnd: NumberValue | null,
): ArraySummary['extentEnds'][number] | null {
  if (empty.expr == null || nonEmptyEnd == null) return null
  return {
    emptyExpr: empty.expr,
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
