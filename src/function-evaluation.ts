import type {
  EvalContext,
  FitCheck,
  FunctionContractProof,
  Program,
} from './check-types.ts'
import type {LinearConstraint, Value} from './domain.ts'
import {
  applyGivenRangeSpec,
  collectGivenAssumptions,
  type GivenEvaluators,
  validateGivenSpecs,
} from './givens.ts'
import {
  functionContractSpecs,
  functionInputSpecs,
} from './function-contracts.ts'
import {bindFunctionInputParameters} from './function-inputs.ts'
import {functionInputRoots} from './function-shape.ts'
import type {FitFunction} from './modules.ts'
import type {FitSpec} from './parser.ts'
import {programGlobalEnv} from './program-env.ts'

export type FunctionEvaluationSetup = {
  inputSpecs: FitSpec[]
  contractSpecs: FitSpec[]
  env: Map<string, Value>
  inputRoots: string[]
  givenChecks: FitCheck[]
  assumptionChecks: FitCheck[]
  assumptions: LinearConstraint[]
}

export function prepareFunctionEvaluation(
  program: Program,
  fn: FitFunction,
  contractCache: Map<string, FunctionContractProof>,
  evaluators: GivenEvaluators,
): FunctionEvaluationSetup {
  const inputSpecs = functionInputSpecs(program, fn)
  const contractSpecs = functionContractSpecs(program, fn)
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, inputSpecs, program, env)

  const {assumedGivens, checks: givenChecks} = validateGivenSpecs(program.file, fn.name, inputSpecs, inputRoots, 'function-given')
  for (const given of assumedGivens) {
    if (given.kind === 'range') applyGivenRangeSpec(env, given.spec)
  }

  const {assumptions, checks: assumptionChecks} = collectGivenAssumptions(program.file, program, fn.name, env, inputRoots, assumedGivens, contractCache, evaluators)
  return {
    inputSpecs,
    contractSpecs,
    env,
    inputRoots,
    givenChecks,
    assumptionChecks,
    assumptions,
  }
}

export function functionEvalContext(
  program: Program,
  fn: FitFunction,
  setup: FunctionEvaluationSetup,
  contractCache: Map<string, FunctionContractProof>,
  options: {
    checks?: FitCheck[]
    callObligations?: EvalContext['callObligations']
    inferLoops?: EvalContext['inferLoops']
    inferUnsupported?: string[]
  } = {},
): EvalContext {
  return {
    program,
    file: program.file,
    env: setup.env,
    inputRoots: setup.inputRoots,
    stack: [fn.name],
    checks: options.checks ?? [],
    assumptions: setup.assumptions,
    contractCache,
    ...(options.callObligations == null ? {} : {callObligations: options.callObligations}),
    ...(options.inferLoops == null ? {} : {inferLoops: options.inferLoops}),
    ...(options.inferUnsupported == null ? {} : {inferUnsupported: options.inferUnsupported}),
  }
}
