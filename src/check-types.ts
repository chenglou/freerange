import type * as ts from 'typescript'
import type {
  FactSource,
  LinearConstraint,
  NullishKind,
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
import type {FitSpec} from './parser.ts'

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

export type FitInferLoopSpecStatus = FitInferSpecStatus
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

export type FitShapeInsight = {
  file: string
  functionName: string
  subject: string
  freerange: string[]
  typescript: string[]
}

export type FitShapeReport = {
  files: string[]
  insights: FitShapeInsight[]
}

export type FitShapeOptions = {
  functionName?: string
  all?: boolean
  calls?: boolean
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
  contractCache: Map<string, FunctionContractProof>
  callObligations?: 'record' | 'silent'
  contractExpression?: true
  contractExpressionProblems?: string[]
  objectPath?: string[]
  inferLoops?: FitInferLoopReport[]
  inferUnsupported?: string[]
  insideLoop?: true
}

export type EvalFlow =
  | {kind: 'return'; value: Value}
  | {kind: 'exit'}
  | {kind: 'fallthrough'}

export type ArrayCallbackFunction = ts.ArrowFunction | ts.FunctionExpression

export type PresenceGuard = {
  target: ts.Expression
  nullish: NullishKind
  presentWhenTrue: boolean
}

export type LocalizeOptions = {
  preserveLinear?: boolean
}

export type AssumedGivenSpec =
  | {kind: 'range'; spec: Extract<FitSpec, {kind: 'given-range'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}
  | {kind: 'comparison'; spec: Extract<FitSpec, {kind: 'given-comparison'}>; source: Extract<FactSource, 'function-given' | 'loop-given'>}

export type ImportedContractSource = {
  sourceFile: string
  sourceFunctionName: string
}

export type FunctionContractSource = ImportedContractSource & {
  kind: 'imported' | 'local'
}
