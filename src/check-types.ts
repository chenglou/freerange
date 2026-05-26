import type * as ts from 'typescript'
import type {
  ConstraintSource,
  LinearConstraint,
  Value,
} from './domain.ts'
import type {FitInferFact} from './facts.ts'
import type {
  FitImportBinding,
  FitFile,
} from './modules.ts'
import type {
  FitObligation,
  FitProofTrace,
} from './obligations.ts'
import type {
  FitComparisonGivenSpec,
  FitExpressionGivenSpec,
  FitRangeGivenSpec,
} from './parser.ts'

export type FitCheckStatus = 'pass' | 'fail' | 'requires' | 'unknown'
export type FitProofStatus = Exclude<FitCheckStatus, 'requires'>

export type FitCheck = {
  file: string
  line?: number
  boundaryLine?: number
  functionName: string
  text: string
  status: FitCheckStatus
  reason?: string
  detail?: FitCheckDetail
  obligation?: FitObligation
  trace?: FitProofTrace
}

export type FitAudit = {
  file: string
  line?: number
  functionName: string
  text: string
  reason: string
  obligation?: FitObligation
  trace?: FitProofTrace
}

export type FitCheckDetail =
  | {
      kind: 'call-precondition'
      callText: string
      requirement: string
      callerPassed: string
      missing: string[]
      definiteFailure: boolean
      unsupported: boolean
    }

export type FitInferSpecStatus = 'checked' | 'assumed' | 'not-inferred'

export type FitInferSpec = {
  text: string
  status: FitInferSpecStatus
  reason?: string
}

export type FitInferRedundantSpec = {
  text: string
  reason: string
}

export type FitInferLoopSpec = FitInferSpec

export type FitInferLoopReport = {
  line: number
  kind: 'for-of' | 'for'
  header: string
  facts: FitInferFact[]
  specs: FitInferLoopSpec[]
  redundant: FitInferRedundantSpec[]
  unsupported: string[]
}

export type FitInferFunctionReport = {
  file: string
  functionName: string
  facts: FitInferFact[]
  locals: FitInferFact[]
  specs: FitInferSpec[]
  redundant: FitInferRedundantSpec[]
  loops: FitInferLoopReport[]
  unsupported: string[]
}

export type FitInferReport = {
  files: string[]
  functions: FitInferFunctionReport[]
}

export type FitInferSummary = {
  files: string[]
  functions: number
  facts: {
    return: number
    locals: number
    loop: number
  }
  specs: {
    checked: number
    assumptions: number
    notInferred: number
    redundant: number
  }
  unsupported: {
    stops: number
    noisiest: FitInferSummaryFunction[]
    topReasons: FitInferSummaryReason[]
  }
}

export type FitInferSummaryFunction = {
  file: string
  functionName: string
  count: number
}

export type FitInferSummaryReason = {
  reason: string
  count: number
}

export type Program = FitFile<Value>

export type ImportedBinding = FitImportBinding<Program>

export type ResolvedCallTarget =
  | {
      kind: 'math'
      name: string
    }
  | {
      kind: 'function'
      program: Program
      functionName: string
      imported?: {
        localName: string
        binding: Extract<ImportedBinding, {kind: 'resolved'}>
      }
    }
  | {
      kind: 'unresolved'
      reason: string
    }

export type FunctionContractProof =
  | {status: 'verifying'}
  | {status: FitProofStatus; checks: FitCheck[]}

export type EvalContext = {
  program: Program
  file: string
  env: Map<string, Value>
  inputRoots: string[]
  stack: string[]
  checks: FitCheck[]
  assumptions: LinearConstraint[]
  booleanAssumptions?: Map<string, boolean>
  contractCache: Map<string, FunctionContractProof>
  callObligations?: 'record' | 'silent'
  contractExpression?: true
  contractExpressionProblems?: string[]
  objectPath?: string[]
  inferLoops?: FitInferLoopReport[]
  inferUnsupported?: string[]
  insideLoop?: true
}

export type ArrayCallbackFunction = ts.ArrowFunction | ts.FunctionExpression

export type LocalizeOptions = {
  preserveLinear?: boolean
}

export type AssumedGivenSpec =
  | {kind: 'range'; spec: FitRangeGivenSpec; source: Extract<ConstraintSource, 'function-given' | 'loop-given'>}
  | {kind: 'comparison'; spec: FitComparisonGivenSpec; source: Extract<ConstraintSource, 'function-given' | 'loop-given'>}
  | {kind: 'expression'; spec: FitExpressionGivenSpec; source: Extract<ConstraintSource, 'function-given' | 'loop-given'>}

export type ImportedContractSource = {
  sourceFile: string
  sourceFunctionName: string
}

export type FunctionContractSource = ImportedContractSource & {
  kind: 'imported' | 'local'
}
