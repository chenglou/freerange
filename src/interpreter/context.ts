import type {Program} from '../check-types.ts'
import {
  joinValues,
  unknown,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {programGlobalEnv} from '../program-env.ts'

export type InterpreterIssue = {
  kind: 'unsupported'
  message: string
  stack: string[]
}

export type InterpreterFrame = {
  program: Program
  env: Map<string, Value>
  issues: InterpreterIssue[]
  stack: string[]
  loopStack: LoopFrame[]
  conditionalDepth: number
  assumptions: LinearConstraint[]
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
  | {kind: 'fallthrough'}
  | {kind: 'exit'}

export function rootFrame(program: Program): InterpreterFrame {
  return {
    program,
    env: programGlobalEnv(program),
    issues: [],
    stack: [],
    loopStack: [],
    conditionalDepth: 0,
    assumptions: [],
  }
}

export function childFrame(parent: InterpreterFrame, env: Map<string, Value>, name: string): InterpreterFrame {
  return {
    program: parent.program,
    env,
    issues: parent.issues,
    stack: [...parent.stack, name],
    loopStack: [...parent.loopStack],
    conditionalDepth: parent.conditionalDepth,
    assumptions: [...parent.assumptions],
  }
}

export function frameWithProgram(parent: InterpreterFrame, program: Program, env: Map<string, Value>, name: string): InterpreterFrame {
  return {
    program,
    env,
    issues: parent.issues,
    stack: [...parent.stack, name],
    loopStack: [...parent.loopStack],
    conditionalDepth: parent.conditionalDepth,
    assumptions: [...parent.assumptions],
  }
}

export function noteUnsupported(frame: InterpreterFrame, message: string): Value {
  frame.issues.push({kind: 'unsupported', message, stack: frame.stack})
  return unknown(message)
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
