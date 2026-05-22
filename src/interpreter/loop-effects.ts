import * as ts from 'typescript'
import {
  mergeArraySummary,
  mergeElementValue,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {mergeAssumptions} from '../assumptions.ts'
import {
  conditionalRunningSumNumber,
  runningExtremumNumber,
  runningSumNumber,
  sequenceSummaryFromLoopPush,
  type LoopExtremum,
  type LoopScalarUpdate,
} from '../loop-summary.ts'
import {runningSumFacts} from '../proof.ts'
import {
  identifierTargetName,
  isIdentifierNamed,
  isSideEffectFreeExpression,
  referencesAnyIdentifier,
  referencesIdentifier,
  scalarIncrementExpression,
  unwrapExpression,
} from './source-syntax.ts'
import {noteUnsupported, type InterpreterFrame, type LoopFrame} from './context.ts'
import {
  loopAppendElementWithCursorUpdates,
  loopAppendShapeWithCursorUpdates,
} from './loop-values.ts'
import {writePath} from './value-path.ts'

export type PendingLoopScalarAdd = {
  increment: NumberValue
  order: number
  node: ts.Node
}

type PendingConditionalLoopScalarAdd = PendingLoopScalarAdd

type PendingLoopExtremum = LoopExtremum & {
  candidateExpression: ts.Expression
}

export type PendingLoopEffects = {
  scalarAdds: Map<string, PendingLoopScalarAdd>
  conditionalScalarAdds: Map<string, PendingConditionalLoopScalarAdd>
  extrema: Map<string, PendingLoopExtremum>
}

export type LoopEffectCapture =
  | {kind: 'captured'}
  | {kind: 'unsupported'; value: Value}
  | {kind: 'none'}

type LoopScalarAdd = {
  targetName: string
  increment: NumberValue
  incrementExpression: ts.Expression
}

export type EvaluateLoopExpression = (expression: ts.Expression, frame: InterpreterFrame) => Value

export function pendingLoopEffects(): PendingLoopEffects {
  return {
    scalarAdds: new Map(),
    conditionalScalarAdds: new Map(),
    extrema: new Map(),
  }
}

export function captureLoopBodyEffect(
  statement: ts.Statement,
  order: number,
  effects: PendingLoopEffects,
  loopLabel: string,
  frame: InterpreterFrame,
  evaluateExpression: EvaluateLoopExpression,
): LoopEffectCapture {
  if (isUnsupportedConditionalLoopScalarElse(statement, frame, evaluateExpression)) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} conditional running sums do not support else branches`, statement)}
  }
  const conditionalAdd = readConditionalLoopScalarAdd(statement, frame, evaluateExpression)
  if (conditionalAdd != null) return captureLoopScalarAdd(conditionalAdd, order, effects, loopLabel, frame, true)

  const scalarAdd = readLoopScalarAdd(statement, frame, evaluateExpression)
  if (scalarAdd != null) return captureLoopScalarAdd(scalarAdd, order, effects, loopLabel, frame, false)

  const extremum = readLoopExtremumAssignment(statement, frame, evaluateExpression)
  if (extremum == null) return {kind: 'none'}
  if (loopEffectTargetAlreadyUpdated(extremum.targetName, effects)) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar cursor already updates ${extremum.targetName}`, extremum.candidateExpression)}
  }
  if (referencesAnyIdentifier(extremum.candidateExpression, loopEffectTargets(effects))) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar extrema candidates cannot depend on an earlier scalar update`, extremum.candidateExpression)}
  }
  effects.extrema.set(extremum.targetName, extremum)
  return {kind: 'captured'}
}

export function finalizeLoopEffects(
  loop: LoopFrame,
  effects: PendingLoopEffects,
  loopLabel: string,
  frame: InterpreterFrame,
): Value | null {
  if (effects.scalarAdds.size === 0 && effects.conditionalScalarAdds.size === 0 && effects.extrema.size === 0) return null
  if (effects.conditionalScalarAdds.size > 0 && (effects.scalarAdds.size > 0 || effects.extrema.size > 0 || loop.appends.length > 0)) {
    return noteUnsupported(frame, `${loopLabel} conditional running sums support guarded scalar updates only`, firstLoopEffectNode(effects))
  }
  if (effects.extrema.size > 0 && (effects.scalarAdds.size > 0 || loop.appends.length > 0)) {
    return noteUnsupported(frame, `${loopLabel} scalar extrema support extrema updates only`, firstLoopEffectNode(effects))
  }
  const updates = new Map<string, LoopScalarUpdate>()
  for (const [targetName, pending] of effects.scalarAdds) {
    const start = frame.env.get(targetName)
    if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar cursor expected ${targetName} to be a number`, pending.node)
    const end = runningSumNumber(targetName, start, loop.source.length, pending.increment)
    updates.set(targetName, {start, increment: pending.increment, end})
    frame.assumptions = mergeAssumptions(frame.assumptions, runningSumFacts(end, start, loop.source.length, pending.increment))
  }
  for (const [targetName, pending] of effects.conditionalScalarAdds) {
    const start = frame.env.get(targetName)
    if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar cursor expected ${targetName} to be a number`, pending.node)
    const end = conditionalRunningSumNumber(targetName, start, loop.source.length, pending.increment)
    updates.set(targetName, {start, increment: pending.increment, end})
    frame.assumptions = mergeAssumptions(frame.assumptions, runningSumFacts(end, start, loop.source.length, pending.increment))
  }
  for (const [targetName, extremum] of effects.extrema) {
    const start = frame.env.get(targetName)
    if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar extremum expected ${targetName} to be a number`, extremum.candidateExpression)
    frame.env.set(targetName, runningExtremumNumber(extremum.kind, targetName, start, loop.source.length, extremum.candidate))
  }

  const cursorError = applyLoopCursorFacts(loop, effects.scalarAdds, updates, loopLabel, frame)
  if (cursorError != null) return cursorError
  for (const [targetName, update] of updates) frame.env.set(targetName, update.end)
  return null
}

function captureLoopScalarAdd(
  add: LoopScalarAdd,
  order: number,
  effects: PendingLoopEffects,
  loopLabel: string,
  frame: InterpreterFrame,
  conditional: boolean,
): LoopEffectCapture {
  if (loopEffectTargetAlreadyUpdated(add.targetName, effects)) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar cursor already updates ${add.targetName}`, add.incrementExpression)}
  }
  if (referencesAnyIdentifier(add.incrementExpression, loopEffectTargets(effects))) {
    return {kind: 'unsupported', value: noteUnsupported(frame, `${loopLabel} scalar cursor increments cannot depend on an earlier cursor update`, add.incrementExpression)}
  }
  const target = {increment: add.increment, order, node: add.incrementExpression}
  if (conditional) effects.conditionalScalarAdds.set(add.targetName, target)
  else effects.scalarAdds.set(add.targetName, target)
  return {kind: 'captured'}
}

function readLoopScalarAdd(statement: ts.Statement, frame: InterpreterFrame, evaluateExpression: EvaluateLoopExpression): LoopScalarAdd | null {
  if (!ts.isExpressionStatement(statement)) return null
  const expression = unwrapExpression(statement.expression)
  if (!ts.isBinaryExpression(expression)) return null
  const targetName = identifierTargetName(expression.left)
  if (targetName == null) return null
  const incrementExpression = scalarIncrementExpression(expression, targetName)
  if (incrementExpression == null || referencesIdentifier(incrementExpression, targetName)) return null
  const increment = evaluateExpression(incrementExpression, frame)
  return increment.kind === 'number' ? {targetName, increment, incrementExpression} : null
}

function readConditionalLoopScalarAdd(statement: ts.Statement, frame: InterpreterFrame, evaluateExpression: EvaluateLoopExpression): LoopScalarAdd | null {
  if (!ts.isIfStatement(statement) || statement.elseStatement != null || !isSideEffectFreeExpression(statement.expression)) return null
  return readLoopScalarAdd(singleStatement(statement.thenStatement), frame, evaluateExpression)
}

function readLoopExtremumAssignment(statement: ts.Statement, frame: InterpreterFrame, evaluateExpression: EvaluateLoopExpression): PendingLoopExtremum | null {
  if (!ts.isExpressionStatement(statement)) return null
  const expression = unwrapExpression(statement.expression)
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const targetName = identifierTargetName(expression.left)
  if (targetName == null) return null
  const call = unwrapExpression(expression.right)
  if (!ts.isCallExpression(call)) return null
  const target = unwrapExpression(call.expression)
  if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression) || target.expression.text !== 'Math') return null
  if (target.name.text !== 'min' && target.name.text !== 'max') return null
  if (call.arguments.length !== 2) return null
  const left = call.arguments[0]!
  const right = call.arguments[1]!
  const candidateExpression =
    isIdentifierNamed(left, targetName) ? right
      : isIdentifierNamed(right, targetName) ? left
        : null
  if (candidateExpression == null || referencesIdentifier(candidateExpression, targetName)) return null
  const candidate = evaluateExpression(candidateExpression, frame)
  return candidate.kind === 'number'
    ? {targetName, kind: target.name.text, candidate, candidateExpression}
    : null
}

function isUnsupportedConditionalLoopScalarElse(statement: ts.Statement, frame: InterpreterFrame, evaluateExpression: EvaluateLoopExpression): boolean {
  return ts.isIfStatement(statement)
    && statement.elseStatement != null
    && isSideEffectFreeExpression(statement.expression)
    && readLoopScalarAdd(singleStatement(statement.thenStatement), frame, evaluateExpression) != null
}

function singleStatement(statement: ts.Statement): ts.Statement {
  return ts.isBlock(statement) && statement.statements.length === 1 ? statement.statements[0]! : statement
}

function firstLoopEffectNode(effects: PendingLoopEffects): ts.Node | undefined {
  return effects.scalarAdds.values().next().value?.node
    ?? effects.conditionalScalarAdds.values().next().value?.node
    ?? effects.extrema.values().next().value?.candidateExpression
}

function loopEffectTargets(effects: PendingLoopEffects): Set<string> {
  return new Set([...effects.scalarAdds.keys(), ...effects.conditionalScalarAdds.keys(), ...effects.extrema.keys()])
}

function loopEffectTargetAlreadyUpdated(targetName: string, effects: PendingLoopEffects): boolean {
  return effects.scalarAdds.has(targetName) || effects.conditionalScalarAdds.has(targetName) || effects.extrema.has(targetName)
}

function applyLoopCursorFacts(
  loop: LoopFrame,
  pendingAdds: Map<string, PendingLoopScalarAdd>,
  updates: Map<string, LoopScalarUpdate>,
  loopLabel: string,
  frame: InterpreterFrame,
): Value | null {
  const arrayNames = new Set(loop.appends.map(push => push.arrayName))
  for (const arrayName of arrayNames) {
    const target = frame.env.get(arrayName)
    if (target?.kind !== 'array') continue
    let summary = target.summary
    const appends = loop.appends.filter(item => item.arrayName === arrayName)
    let element = appends[0]?.base.element ?? null
    for (const append of appends) {
      const loopPush = loopAppendShapeWithCursorUpdates(append, updates)
      for (const cursorPath of loopPush.cursorPaths) {
        const pending = pendingAdds.get(cursorPath.targetName)
        if (pending != null && pending.order <= append.order) {
          return noteUnsupported(frame, `${loopLabel} scalar cursor ${cursorPath.targetName} must be pushed before it is updated`, pending.node)
        }
      }
      element = mergeElementValue(element, loopAppendElementWithCursorUpdates(append, updates, frame.assumptions))
      if (!append.conditional) {
        const update = loopPush.topName == null ? undefined : updates.get(loopPush.topName)
        summary = mergeArraySummary(summary, sequenceSummaryFromLoopPush(loopPush, update, {
          assumptions: frame.assumptions,
          resolveNumber: expr => resolveNumberFromEnv(expr, frame),
        }))
      }
    }
    writePath({root: arrayName, segments: []}, {
      ...target,
      element,
      summary,
    }, frame)
  }
  return null
}

function resolveNumberFromEnv(expr: string, frame: InterpreterFrame): NumberValue | null {
  const value = frame.env.get(expr)
  return value?.kind === 'number' ? value : null
}
