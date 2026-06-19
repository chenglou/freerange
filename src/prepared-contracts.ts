import type * as ts from 'typescript'
import type {FitCheck, Program} from './check-types.ts'
import {
  contractPassesTypeCheck,
  contractTypeChecksForFunction,
  contractTypeChecksForTopLevel,
} from './contract-typecheck.ts'
import {
  functionContractSource,
  programContractSource,
  type BodyTypeContractIndex,
} from './function-contracts.ts'
import type {FitFunction} from './modules.ts'
import {
  fitSpecIsAssumption,
  fitSpecMentionsRoot,
  fitSpecIsProof,
  fitReturnInternalRoot,
  type FitBodySpecIndex,
  type FitCheckSpec,
  type FitFunctionCheckSpec,
  type FitGivenSpec,
  type FitInlineCheckSpec,
  type FitInlineSpecTemplate,
  type FitLoopSpec,
  type FitSpec,
} from './parser.ts'
import type {
  TypeContractResult,
  TypeContractUnsupported,
} from './type-contracts.ts'
import {
  unsupportedNamedIndexSpecReason,
} from './bound-index.ts'

export type PreparedUnsupportedSpec = {
  text: string
  reason: string
  line?: number
}

export type PreparedBodyContracts = {
  localSpecsByStatement: Map<ts.VariableStatement, FitInlineCheckSpec[]>
  returnSpecsByNode: Map<ts.Node, FitInlineCheckSpec[]>
  objectPropertyTemplatesByNode: Map<ts.PropertyAssignment | ts.ShorthandPropertyAssignment, FitInlineSpecTemplate[]>
  loopsByStatement: Map<ts.ForOfStatement | ts.ForStatement, PreparedLoopContracts>
  variableTypes: Map<ts.VariableDeclaration, TypeContractResult<FitCheckSpec>>
  returnTypes: Map<ts.Node, TypeContractResult<FitCheckSpec>>
  unsupportedPlacements: FitBodySpecIndex['unsupportedPlacements']
  hasExecutableClaims: boolean
  hasTypeBoundaries: boolean
  hasAnnotationSurface: boolean
}

export type PreparedLoopContracts = {
  specs: FitLoopSpec[]
  localSpecs: FitLoopSpec[]
  resultSpecs: FitLoopSpec[]
  recordsCalls: boolean
}

export type PreparedFunctionContracts = {
  contractSpecs: FitSpec[]
  assumptions: FitGivenSpec[]
  proofs: FitFunctionCheckSpec[]
  unsupportedSpecs: PreparedUnsupportedSpec[]
  typeChecks: FitCheck[]
  typeUnsupported: TypeContractUnsupported[]
  body: PreparedBodyContracts
  hasAnnotationSurface: boolean
  hasCallPreconditions: boolean
  needsBodyEvaluation: boolean
  recordsCallsites: boolean
}

export type PreparedTopLevelContracts = {
  typeChecks: FitCheck[]
  body: PreparedBodyContracts
  hasAnnotationSurface: boolean
}

export type PreparedProgramContracts = {
  functions: Map<FitFunction, PreparedFunctionContracts>
  topLevel: PreparedTopLevelContracts
}

const preparedProgramContractsCache = new WeakMap<Program, PreparedProgramContracts>()

export function preparedProgramContracts(program: Program): PreparedProgramContracts {
  const cached = preparedProgramContractsCache.get(program)
  if (cached != null) return cached
  const source = programContractSource(program)
  const functions = new Map<FitFunction, PreparedFunctionContracts>()
  for (const fn of program.functions.values()) {
    const functionSource = functionContractSource(program, fn)
    const preparedSpecs = prepareSpecs(program, functionSource.specs)
    const contractSpecs = preparedSpecs.specs
    const proofs = contractSpecs.filter(fitSpecIsProof)
    const body = prepareBodyContracts(program, fn.bodySpecs, functionSource.bodyTypes)
    const preparedImplicitAssumptions = contractSpecs.length > 0 || body.hasAnnotationSurface
      ? prepareSpecs(program, functionSource.implicitAssumptions)
      : {specs: [], unsupported: []}
    const assumptions = [...preparedImplicitAssumptions.specs, ...contractSpecs.filter(fitSpecIsAssumption)]
    functions.set(fn, {
      contractSpecs,
      assumptions,
      proofs,
      unsupportedSpecs: [...preparedSpecs.unsupported, ...preparedImplicitAssumptions.unsupported],
      typeChecks: contractTypeChecksForFunction(program, fn),
      typeUnsupported: functionSource.unsupported,
      body,
      hasAnnotationSurface: fn.explicitSpecs.length > 0
        || body.hasAnnotationSurface
        || functionSource.hasTypeContracts,
      hasCallPreconditions: assumptions.length > 0,
      needsBodyEvaluation: proofs.length > 0 || body.hasExecutableClaims || body.hasTypeBoundaries,
      recordsCallsites: proofs.length > 0,
    })
  }
  const topLevelBody = prepareBodyContracts(program, program.topLevelBodySpecs, source.topLevelBodyTypes)
  const topLevel = {
    typeChecks: contractTypeChecksForTopLevel(program),
    body: topLevelBody,
    hasAnnotationSurface: topLevelBody.hasAnnotationSurface,
  }
  const prepared = {functions, topLevel}
  preparedProgramContractsCache.set(program, prepared)
  return prepared
}

export function preparedFunctionContracts(program: Program, fn: FitFunction): PreparedFunctionContracts {
  const prepared = preparedProgramContracts(program).functions.get(fn)
  if (prepared == null) throw new Error(`Missing prepared contracts for ${fn.name}`)
  return prepared
}

function prepareBodyContracts(
  program: Program,
  body: FitBodySpecIndex,
  bodyTypes: BodyTypeContractIndex,
): PreparedBodyContracts {
  const unsupportedPlacements = [...body.unsupportedPlacements]
  const localSpecsByStatement = new Map<ts.VariableStatement, FitInlineCheckSpec[]>()
  for (const [statement, specs] of body.localSpecsByStatement) {
    const prepared = prepareSpecs(program, specs)
    localSpecsByStatement.set(statement, prepared.specs)
    unsupportedPlacements.push(...requiredLineProblems(prepared.unsupported))
  }
  const returnSpecsByNode = new Map<ts.Node, FitInlineCheckSpec[]>()
  for (const [node, specs] of body.returnSpecsByNode) {
    const prepared = prepareSpecs(program, specs)
    returnSpecsByNode.set(node, prepared.specs)
    unsupportedPlacements.push(...requiredLineProblems(prepared.unsupported))
  }
  const objectPropertyTemplatesByNode = new Map<ts.PropertyAssignment | ts.ShorthandPropertyAssignment, FitInlineSpecTemplate[]>()
  for (const [property, templates] of body.objectPropertyTemplatesByNode) {
    objectPropertyTemplatesByNode.set(property, acceptedTemplates(program, templates))
  }
  const loopsByStatement = new Map<ts.ForOfStatement | ts.ForStatement, PreparedLoopContracts>()
  for (const [statement, specs] of body.loopSpecsByStatement) {
    const prepared = prepareSpecs(program, specs)
    const accepted = prepared.specs
    unsupportedPlacements.push(...requiredLineProblems(prepared.unsupported))
    const localSpecs: FitLoopSpec[] = []
    const resultSpecs: FitLoopSpec[] = []
    for (const spec of accepted) {
      if (fitSpecMentionsRoot(spec, fitReturnInternalRoot)) resultSpecs.push(spec)
      else localSpecs.push(spec)
    }
    loopsByStatement.set(statement, {
      specs: accepted,
      localSpecs,
      resultSpecs,
      recordsCalls: localSpecs.some(fitSpecIsProof),
    })
  }
  const variableTypes = prepareTypeContracts(program, bodyTypes.variables)
  const returnTypes = prepareTypeContracts(program, bodyTypes.returns)
  const hasExecutableClaims = hasMapValues(localSpecsByStatement)
    || hasMapValues(returnSpecsByNode)
    || hasMapValues(objectPropertyTemplatesByNode)
    || hasPreparedLoops(loopsByStatement)
  const hasTypeBoundaries = hasTypeContractValues(variableTypes) || hasTypeContractValues(returnTypes)
  const hasSourceAnnotationSurface = body.localSpecsByStatement.size > 0
    || body.returnSpecsByNode.size > 0
    || body.objectPropertyTemplatesByNode.size > 0
    || body.loopSpecsByStatement.size > 0
    || bodyTypes.hasWork
    || body.unsupportedPlacements.length > 0
  return {
    localSpecsByStatement,
    returnSpecsByNode,
    objectPropertyTemplatesByNode,
    loopsByStatement,
    variableTypes,
    returnTypes,
    unsupportedPlacements,
    hasExecutableClaims,
    hasTypeBoundaries,
    hasAnnotationSurface: hasSourceAnnotationSurface,
  }
}

function prepareTypeContracts<K>(
  program: Program,
  contracts: Map<K, TypeContractResult<FitCheckSpec>>,
): Map<K, TypeContractResult<FitCheckSpec>> {
  const prepared = new Map<K, TypeContractResult<FitCheckSpec>>()
  for (const [node, contract] of contracts) {
    const specs = prepareSpecs(program, contract.specs)
    prepared.set(node, {
      specs: specs.specs,
      unsupported: [...contract.unsupported, ...specs.unsupported],
    })
  }
  return prepared
}

function prepareSpecs<T extends FitSpec>(
  program: Program,
  specs: T[],
): {specs: T[]; unsupported: PreparedUnsupportedSpec[]} {
  const accepted: T[] = []
  const unsupported: PreparedUnsupportedSpec[] = []
  for (const spec of specs) {
    if (!contractPassesTypeCheck(program, spec)) continue
    const reason = unsupportedNamedIndexSpecReason(spec)
    if (reason == null) {
      accepted.push(spec)
      continue
    }
    unsupported.push({
      text: spec.text,
      reason,
      ...(spec.line == null ? {} : {line: spec.line}),
    })
  }
  return {specs: accepted, unsupported}
}

function acceptedTemplates<T extends FitInlineSpecTemplate>(program: Program, templates: T[]): T[] {
  return templates.filter(template => contractPassesTypeCheck(program, template))
}

function requiredLineProblems(problems: PreparedUnsupportedSpec[]) {
  return problems.map(problem => {
    if (problem.line == null) throw new Error(`Body @fit problem is missing a line: ${problem.text}`)
    return {...problem, line: problem.line}
  })
}

function hasMapValues<K, V>(map: Map<K, V[]>) {
  for (const values of map.values()) {
    if (values.length > 0) return true
  }
  return false
}

function hasTypeContractValues<K>(map: Map<K, TypeContractResult<FitCheckSpec>>) {
  for (const contract of map.values()) {
    if (contract.specs.length > 0 || contract.unsupported.length > 0) return true
  }
  return false
}

function hasPreparedLoops(map: Map<ts.ForOfStatement | ts.ForStatement, PreparedLoopContracts>) {
  for (const loop of map.values()) {
    if (loop.specs.length > 0) return true
  }
  return false
}
