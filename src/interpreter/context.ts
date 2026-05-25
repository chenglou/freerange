import type * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {
  joinValues,
  unknown,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from '../domain.ts'
import type {FitFunction} from '../modules.ts'
import {programGlobalEnv} from '../program-env.ts'

export type InterpreterIssue = {
  kind: 'unsupported'
  message: string
  stack: string[]
  line?: number
}

export type InterpreterEffect = {
  kind: 'effect'
  message: string
  stack: string[]
  line?: number
}

export type InterpreterAudit = {
  kind: 'selector'
  stack: string[]
  line?: number
  text: string
  reason: string
}

export type InterpreterFrame = {
  program: Program
  env: Map<string, Value>
  stateCases?: InterpreterStateCase[]
  issues: InterpreterIssue[]
  effects: InterpreterEffect[]
  audits: InterpreterAudit[]
  stack: string[]
  activeCalls: Set<string>
  localBindings: Set<string>
  loopStack: LoopFrame[]
  conditionalDepth: number
  assumptions: LinearConstraint[]
  hooks?: InterpreterHooks
  objectPath?: string[]
}

export type InterpreterStateCase = {
  env: Map<string, Value>
  assumptions: LinearConstraint[]
  label?: string
}

export type InterpreterReturnCase = InterpreterStateCase & {
  value: Value
}

export type InterpreterHooks = {
  evaluateCall?: (call: InterpreterCall, frame: InterpreterFrame) => Value | null
  evaluatePath?: (expression: ts.Expression, frame: InterpreterFrame) => Value | null
  evaluateClaim?: (claim: InterpreterClaim, frame: InterpreterFrame, evaluate: () => Value) => Value
  afterClaim?: (claim: InterpreterClaim, value: Value, frame: InterpreterFrame) => void
  evaluateLoop?: (claim: InterpreterLoopClaim, frame: InterpreterFrame, evaluate: () => InterpreterFlow) => InterpreterFlow
}

export type InterpreterClaim =
  | {kind: 'variable'; statement: ts.VariableStatement; declaration: ts.VariableDeclaration}
  | {kind: 'return'; node: ts.Node; expression: ts.Expression}
  | {kind: 'object-property'; property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment; path: string[]}

export type InterpreterCall = {
  expression: ts.CallExpression | ts.PropertyAccessExpression
  callName: string
  program: Program
  functionName: string
  fn: FitFunction
  argumentValues: Value[]
  fallback: Value | null
  imported?: {
    localName: string
    binding: Extract<import('../check-types.ts').ImportedBinding, {kind: 'resolved'}>
  }
  thisValue?: Value
}

export type InterpreterLoopClaim = {
  kind: 'for-of' | 'for'
  statement: ts.ForOfStatement | ts.ForStatement
  factRoots: Set<string>
}

export type LoopFrame = {
  source: ArrayValue
  sourceExpr: string
  mode: 'finite' | 'symbolic'
  statementIndex: number
  appends: LoopAppend[]
}

export type LoopAppend = {
  arrayName: string
  order: number
  conditional: boolean
  length: NumberValue
  element: Value | null
  base: ArrayValue
  cursorPaths: {path: string[]; targetName: string}[]
}

export type InterpreterFlow =
  | {kind: 'return'; value: Value}
  | {kind: 'return-cases'; cases: InterpreterReturnCase[]}
  | {kind: 'fallthrough'}
  | {kind: 'exit'}

export function rootFrame(program: Program, hooks?: InterpreterHooks): InterpreterFrame {
  return {
    program,
    env: programGlobalEnv(program),
    issues: [],
    effects: [],
    audits: [],
    stack: [],
    activeCalls: new Set(),
    localBindings: new Set(),
    loopStack: [],
    conditionalDepth: 0,
    assumptions: [],
    ...(hooks == null ? {} : {hooks}),
  }
}

export function childFrame(parent: InterpreterFrame, env: Map<string, Value>, name: string): InterpreterFrame {
  return {
    program: parent.program,
    env,
    issues: parent.issues,
    effects: parent.effects,
    audits: parent.audits,
    stack: [...parent.stack, name],
    activeCalls: new Set(parent.activeCalls),
    localBindings: new Set(parent.localBindings),
    loopStack: [...parent.loopStack],
    conditionalDepth: parent.conditionalDepth,
    assumptions: [...parent.assumptions],
    ...(parent.hooks == null ? {} : {hooks: parent.hooks}),
    ...(parent.objectPath == null ? {} : {objectPath: [...parent.objectPath]}),
  }
}

export function frameWithProgram(parent: InterpreterFrame, program: Program, env: Map<string, Value>, name: string): InterpreterFrame {
  return {
    program,
    env,
    issues: parent.issues,
    effects: parent.effects,
    audits: parent.audits,
    stack: [...parent.stack, name],
    activeCalls: new Set(parent.activeCalls),
    localBindings: new Set(),
    loopStack: [...parent.loopStack],
    conditionalDepth: parent.conditionalDepth,
    assumptions: [...parent.assumptions],
    ...(parent.hooks == null ? {} : {hooks: parent.hooks}),
    ...(parent.objectPath == null ? {} : {objectPath: [...parent.objectPath]}),
  }
}

export function frameWithActiveCall(parent: InterpreterFrame, key: string): InterpreterFrame {
  const activeCalls = new Set(parent.activeCalls)
  activeCalls.add(key)
  return {
    ...parent,
    activeCalls,
  }
}

export function noteAudit(frame: InterpreterFrame, text: string, reason: string, node?: ts.Node) {
  frame.audits.push({
    kind: 'selector',
    stack: frame.stack,
    text,
    reason,
    ...(node == null ? {} : {line: lineNumberForNode(frame.program.sourceFile, node)}),
  })
}

export function noteEffect(frame: InterpreterFrame, message: string, node?: ts.Node) {
  frame.effects.push({
    kind: 'effect',
    message,
    stack: frame.stack,
    ...(node == null ? {} : {line: lineNumberForNode(frame.program.sourceFile, node)}),
  })
}

export function noteUnsupported(frame: InterpreterFrame, message: string, node?: ts.Node): Value {
  frame.issues.push({
    kind: 'unsupported',
    message,
    stack: frame.stack,
    ...(node == null ? {} : {line: lineNumberForNode(frame.program.sourceFile, node)}),
  })
  return unknown(message)
}

function lineNumberForNode(sourceFile: ts.SourceFile, node: ts.Node) {
  const nodeSourceFile = node.getSourceFile() ?? sourceFile
  return nodeSourceFile.getLineAndCharacterOfPosition(node.getStart(nodeSourceFile)).line + 1
}

export function joinFrameEnvs(left: Map<string, Value>, right: Map<string, Value>): Map<string, Value> {
  const next = new Map<string, Value>()
  const names = new Set([...left.keys(), ...right.keys()])
  for (const name of names) {
    const leftValue = left.get(name)
    const rightValue = right.get(name)
    next.set(name, leftValue == null || rightValue == null ? unknown(`Local ${name} exists on only one branch`) : joinValues(leftValue, rightValue))
  }
  return next
}
