import type * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {
  joinValues,
  unknown,
  type ArrayValue,
  type LinearConstraint,
  type Value,
} from '../domain.ts'
import type {FitFunction} from '../modules.ts'
import type {PreparedCall} from '../prepared-call.ts'

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

export type InterpreterOutput = {
  issues: InterpreterIssue[]
  effects: InterpreterEffect[]
  audits: InterpreterAudit[]
}

export type InterpreterPolicy = Readonly<{
  hooks?: InterpreterHooks
  checkRecording: 'record' | 'suppress'
}>

export type InterpreterFrame = {
  program: Program
  env: Map<string, Value>
  stateCases?: InterpreterStateCase[]
  output: InterpreterOutput
  policy: InterpreterPolicy
  stack: string[]
  activeCalls: Set<string>
  loopStack: LoopFrame[]
  conditionalDepth: number
  assumptions: LinearConstraint[]
  objectPath?: string[]
}

export type InterpreterState = {
  env: Map<string, Value>
  assumptions: LinearConstraint[]
}

export type InterpreterStateCase = InterpreterState & {
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
  prepared: PreparedCall
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
  appends: LoopAppend[]
}

// One recorded push during a symbolic loop run: the element value carries the
// linear forms the loop analysis derives sequence relations from.
export type LoopAppend = {
  arrayName: string
  element: Value | null
  base: ArrayValue
}

export type InterpreterFlow =
  | {kind: 'return'; value: Value}
  | {kind: 'return-cases'; cases: InterpreterReturnCase[]}
  | {kind: 'fallthrough'}
  | {kind: 'exit'}

export type InterpreterStart = {
  program: Program
  env: Map<string, Value>
  stack: string[]
  assumptions: LinearConstraint[]
  objectPath?: string[]
}

export function emptyInterpreterOutput(): InterpreterOutput {
  return {
    issues: [],
    effects: [],
    audits: [],
  }
}

export function interpreterPolicy(
  hooks?: InterpreterHooks,
  checkRecording: InterpreterPolicy['checkRecording'] = 'record',
): InterpreterPolicy {
  return {
    checkRecording,
    ...(hooks == null ? {} : {hooks}),
  }
}

export function rootFrame(start: InterpreterStart, policy = interpreterPolicy()): InterpreterFrame {
  return {
    program: start.program,
    env: new Map(start.env),
    output: emptyInterpreterOutput(),
    policy,
    stack: [...start.stack],
    activeCalls: new Set(),
    loopStack: [],
    conditionalDepth: 0,
    assumptions: [...start.assumptions],
    ...(start.objectPath == null ? {} : {objectPath: [...start.objectPath]}),
  }
}

type DerivedFrameOptions = {
  program?: Program
  env: Map<string, Value>
  stateCases: InterpreterStateCase[] | null
  stack?: string[]
  activeCalls?: Set<string>
  loopStack?: LoopFrame[]
  conditionalDepth?: number
  assumptions?: LinearConstraint[]
  objectPath?: string[] | null
  output?: InterpreterOutput
  policy?: InterpreterPolicy
}

export function deriveFrame(parent: InterpreterFrame, options: DerivedFrameOptions): InterpreterFrame {
  const objectPath = options.objectPath === undefined ? parent.objectPath : options.objectPath
  return {
    program: options.program ?? parent.program,
    env: options.env,
    ...(options.stateCases == null ? {} : {stateCases: options.stateCases}),
    output: options.output ?? parent.output,
    policy: options.policy ?? parent.policy,
    stack: options.stack ?? [...parent.stack],
    activeCalls: options.activeCalls ?? new Set(parent.activeCalls),
    loopStack: options.loopStack ?? [...parent.loopStack],
    conditionalDepth: options.conditionalDepth ?? parent.conditionalDepth,
    assumptions: options.assumptions ?? [...parent.assumptions],
    ...(objectPath == null ? {} : {objectPath: [...objectPath]}),
  }
}

export function childFrame(parent: InterpreterFrame, env: Map<string, Value>, name: string): InterpreterFrame {
  return deriveFrame(parent, {
    env,
    stateCases: null,
    stack: [...parent.stack, name],
  })
}

export function frameWithProgram(parent: InterpreterFrame, program: Program, env: Map<string, Value>, name: string): InterpreterFrame {
  return deriveFrame(parent, {
    program,
    env,
    stateCases: null,
    stack: [...parent.stack, name],
  })
}

export function frameWithActiveCall(parent: InterpreterFrame, key: string): InterpreterFrame {
  const activeCalls = new Set(parent.activeCalls)
  activeCalls.add(key)
  return deriveFrame(parent, {
    env: parent.env,
    stateCases: parent.stateCases ?? null,
    activeCalls,
  })
}

export function noteAudit(frame: InterpreterFrame, text: string, reason: string, node?: ts.Node) {
  frame.output.audits.push({
    kind: 'selector',
    stack: frame.stack,
    text,
    reason,
    ...(node == null ? {} : {line: lineNumberForNode(frame.program.sourceFile, node)}),
  })
}

export function noteEffect(frame: InterpreterFrame, message: string, node?: ts.Node) {
  frame.output.effects.push({
    kind: 'effect',
    message,
    stack: frame.stack,
    ...(node == null ? {} : {line: lineNumberForNode(frame.program.sourceFile, node)}),
  })
}

export function noteUnsupported(frame: InterpreterFrame, message: string, node?: ts.Node): Value {
  frame.output.issues.push({
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
