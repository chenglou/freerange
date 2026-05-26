import type {
  EvalContext,
  FitCheck,
  FunctionContractProof,
  Program,
} from './check-types.ts'
import type {LinearConstraint, Value} from './domain.ts'
import {
  collectGivenAssumptions,
  type GivenEvaluators,
  validateGivenSpecs,
} from './givens.ts'
import {
  functionContractSpecs,
  functionInputSpecs,
} from './function-contracts.ts'
import {
  contractTypeChecksForFunction,
  filterTypeCheckedSpecs,
} from './contract-typecheck.ts'
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
  typeChecks: FitCheck[]
  assumptionChecks: FitCheck[]
  assumptions: LinearConstraint[]
  booleanAssumptions: Map<string, boolean>
}

export function prepareFunctionEvaluation(
  program: Program,
  fn: FitFunction,
  contractCache: Map<string, FunctionContractProof>,
  evaluators: GivenEvaluators,
): FunctionEvaluationSetup {
  const typeChecks = contractTypeChecksForFunction(program, fn)
  const inputSpecs = filterTypeCheckedSpecs(program, functionInputSpecs(program, fn))
  const contractSpecs = filterTypeCheckedSpecs(program, functionContractSpecs(program, fn))
  const env = programGlobalEnv(program)
  const inputRoots = functionInputRoots(program, fn)

  bindFunctionInputParameters(fn, program, env)

  if (typeChecks.some(check => check.status !== 'pass')) {
    return {
      inputSpecs,
      contractSpecs,
      env,
      inputRoots,
      givenChecks: [],
      typeChecks,
      assumptionChecks: [],
      assumptions: [],
      booleanAssumptions: new Map(),
    }
  }

  const {assumedGivens, checks: givenChecks} = validateGivenSpecs(program.file, fn.name, inputSpecs, inputRoots, 'function-given')
  const {assumptions, booleanAssumptions, checks: assumptionChecks} = collectGivenAssumptions(program.file, program, fn.name, env, inputRoots, assumedGivens, contractCache, evaluators)
  return {
    inputSpecs,
    contractSpecs,
    env,
    inputRoots,
    givenChecks,
    typeChecks,
    assumptionChecks,
    assumptions,
    booleanAssumptions,
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
    booleanAssumptions: setup.booleanAssumptions,
    contractCache,
    ...(options.callObligations == null ? {} : {callObligations: options.callObligations}),
    ...(options.inferLoops == null ? {} : {inferLoops: options.inferLoops}),
    ...(options.inferUnsupported == null ? {} : {inferUnsupported: options.inferUnsupported}),
  }
}
