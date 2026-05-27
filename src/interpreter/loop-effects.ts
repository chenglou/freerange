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

type PendingLoopScalarAddBase = {
  increment: NumberValue
  order: number
  node: ts.Node
}

export type PendingLoopScalarAdd = PendingLoopScalarAddBase & {
  effectKind: 'scalar-add'
}

type PendingConditionalLoopScalarAdd = PendingLoopScalarAddBase & {
  effectKind: 'conditional-scalar-add'
}

type PendingLoopExtremum = LoopExtremum & {
  effectKind: 'extremum'
  candidateExpression: ts.Expression
}

export type PendingLoopEffect = PendingLoopScalarAdd | PendingConditionalLoopScalarAdd | PendingLoopExtremum

export type PendingLoopEffects = Map<string, PendingLoopEffect>

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
  return new Map()
}

export function hasPendingLoopEffects(effects: PendingLoopEffects) {
  return effects.size > 0
}

export function pendingLoopEffectsHaveScalarAdds(effects: PendingLoopEffects) {
  for (const effect of effects.values()) {
    if (effect.effectKind === 'scalar-add' || effect.effectKind === 'conditional-scalar-add') return true
  }
  return false
}

export function pendingLoopEffectsAreOnlyExtrema(effects: PendingLoopEffects) {
  if (effects.size === 0) return false
  for (const effect of effects.values()) {
    if (effect.effectKind !== 'extremum') return false
  }
  return true
}

export function pendingLoopEffectTargetNames(effects: PendingLoopEffects) {
  return effects.keys()
}

export function pendingLoopExtrema(effects: PendingLoopEffects): Map<string, LoopExtremum> {
  const extrema = new Map<string, LoopExtremum>()
  for (const [targetName, effect] of effects) {
    if (effect.effectKind === 'extremum') extrema.set(targetName, effect)
  }
  return extrema
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
  effects.set(extremum.targetName, extremum)
  return {kind: 'captured'}
}

export function finalizeLoopEffects(
  loop: LoopFrame,
  effects: PendingLoopEffects,
  loopLabel: string,
  frame: InterpreterFrame,
): Value | null {
  if (!hasPendingLoopEffects(effects)) return null
  const counts = pendingLoopEffectCounts(effects)
  if (counts.conditionalScalarAdds > 0 && (counts.scalarAdds > 0 || counts.extrema > 0 || loop.appends.length > 0)) {
    return noteUnsupported(frame, `${loopLabel} conditional running sums support guarded scalar updates only`, firstLoopEffectNode(effects))
  }
  if (counts.extrema > 0 && (counts.scalarAdds > 0 || loop.appends.length > 0)) {
    return noteUnsupported(frame, `${loopLabel} scalar extrema support extrema updates only`, firstLoopEffectNode(effects))
  }
  const updates = new Map<string, LoopScalarUpdate>()
  for (const [targetName, effect] of effects) {
    switch (effect.effectKind) {
      case 'scalar-add':
      case 'conditional-scalar-add': {
        const start = frame.env.get(targetName)
        if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar cursor expected ${targetName} to be a number`, effect.node)
        const end = effect.effectKind === 'conditional-scalar-add'
          ? conditionalRunningSumNumber(targetName, start, loop.source.length, effect.increment)
          : runningSumNumber(targetName, start, loop.source.length, effect.increment)
        updates.set(targetName, {start, increment: effect.increment, end})
        frame.assumptions = mergeAssumptions(frame.assumptions, runningSumFacts(end, start, loop.source.length, effect.increment))
        break
      }
      case 'extremum': {
        const start = frame.env.get(targetName)
        if (start?.kind !== 'number') return noteUnsupported(frame, `${loopLabel} scalar extremum expected ${targetName} to be a number`, effect.candidateExpression)
        frame.env.set(targetName, runningExtremumNumber(effect.kind, targetName, start, loop.source.length, effect.candidate))
        break
      }
    }
  }

  const cursorError = applyLoopCursorFacts(loop, effects, updates, loopLabel, frame)
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
  effects.set(add.targetName, {
    effectKind: conditional ? 'conditional-scalar-add' : 'scalar-add',
    increment: add.increment,
    order,
    node: add.incrementExpression,
  })
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
    ? {targetName, effectKind: 'extremum', kind: target.name.text, candidate, candidateExpression}
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
  for (const effect of effects.values()) {
    if (effect.effectKind === 'scalar-add') return effect.node
  }
  for (const effect of effects.values()) {
    if (effect.effectKind === 'conditional-scalar-add') return effect.node
  }
  for (const effect of effects.values()) {
    if (effect.effectKind === 'extremum') return effect.candidateExpression
  }
  return undefined
}

function loopEffectTargets(effects: PendingLoopEffects): Set<string> {
  return new Set(effects.keys())
}

function loopEffectTargetAlreadyUpdated(targetName: string, effects: PendingLoopEffects): boolean {
  return effects.has(targetName)
}

function pendingLoopEffectCounts(effects: PendingLoopEffects) {
  const counts = {scalarAdds: 0, conditionalScalarAdds: 0, extrema: 0}
  for (const effect of effects.values()) {
    switch (effect.effectKind) {
      case 'scalar-add':
        counts.scalarAdds++
        break
      case 'conditional-scalar-add':
        counts.conditionalScalarAdds++
        break
      case 'extremum':
        counts.extrema++
        break
    }
  }
  return counts
}

function applyLoopCursorFacts(
  loop: LoopFrame,
  effects: PendingLoopEffects,
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
        const pending = pendingScalarAdd(effects, cursorPath.targetName)
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

function pendingScalarAdd(effects: PendingLoopEffects, targetName: string): PendingLoopScalarAdd | null {
  const effect = effects.get(targetName)
  return effect?.effectKind === 'scalar-add' ? effect : null
}

function resolveNumberFromEnv(expr: string, frame: InterpreterFrame): NumberValue | null {
  const value = frame.env.get(expr)
  return value?.kind === 'number' ? value : null
}
