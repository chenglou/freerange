import * as ts from 'typescript'
import {
  fitReturnPublicRoot,
  type FitCheckSpec,
  type FitGivenSpec,
  type FitSpec,
} from './parser.ts'
import type {Program} from './check-types.ts'
import type {FitFunction} from './modules.ts'
import {
  typeCheckContractForTypeNode,
  typeInputGivenContractForFunction,
  typeReturnCheckContractForFunction,
  type TypeContractResult,
  type TypeContractUnsupported,
} from './type-contracts.ts'
import {isFunctionImplementation} from './function-shape.ts'

export type BodyTypeContractIndex = {
  variables: Map<ts.VariableDeclaration, TypeContractResult<FitCheckSpec>>
  returns: Map<ts.Node, TypeContractResult<FitCheckSpec>>
  hasWork: boolean
}

export type FunctionContractSource = {
  specs: FitSpec[]
  unsupported: TypeContractUnsupported[]
  bodyTypes: BodyTypeContractIndex
  hasTypeContracts: boolean
}

export type ProgramContractSource = {
  functions: Map<FitFunction, FunctionContractSource>
  topLevelBodyTypes: BodyTypeContractIndex
}

const programContractSourceCache = new WeakMap<Program, ProgramContractSource>()

export function programContractSource(program: Program): ProgramContractSource {
  const cached = programContractSourceCache.get(program)
  if (cached != null) return cached
  const functions = new Map<FitFunction, FunctionContractSource>()
  for (const fn of program.functions.values()) functions.set(fn, buildFunctionContractSource(program, fn))
  const built = {
    functions,
    topLevelBodyTypes: collectTopLevelBodyTypeContracts(program),
  }
  programContractSourceCache.set(program, built)
  return built
}

export function functionContractSource(program: Program, fn: FitFunction): FunctionContractSource {
  const source = programContractSource(program).functions.get(fn)
  if (source == null) throw new Error(`Missing contract source for ${fn.name}`)
  return source
}

export function typeCheckContractForExpressionBoundary(program: Program, expression: ts.Expression, root: string): TypeContractResult<FitCheckSpec> {
  const type = expressionBoundaryType(expression)
  return type == null ? emptyTypeContract() : typeCheckContractForTypeNode(program, type, root)
}

export function emptyTypeContract<T extends FitCheckSpec | FitGivenSpec>(): TypeContractResult<T> {
  return {specs: [], unsupported: []}
}

export function mergeTypeContracts<T extends FitCheckSpec | FitGivenSpec>(contracts: TypeContractResult<T>[]): TypeContractResult<T> {
  return {
    specs: contracts.flatMap(contract => contract.specs),
    unsupported: contracts.flatMap(contract => contract.unsupported),
  }
}

export function hasTypeContractWork<T extends FitCheckSpec | FitGivenSpec>(contract: TypeContractResult<T>) {
  return contract.specs.length > 0 || contract.unsupported.length > 0
}

function buildFunctionContractSource(program: Program, fn: FitFunction): FunctionContractSource {
  const typeGiven = typeInputGivenContractForFunction(program, fn)
  const typeReturn = typeReturnCheckContractForFunction(program, fn)
  const bodyTypes = collectFunctionBodyTypeContracts(program, fn)
  return {
    specs: [...typeGiven.specs, ...fn.explicitSpecs, ...typeReturn.specs],
    unsupported: [...typeGiven.unsupported, ...typeReturn.unsupported],
    bodyTypes,
    hasTypeContracts: hasTypeContractWork(typeGiven)
      || hasTypeContractWork(typeReturn)
      || bodyTypes.hasWork,
  }
}

function collectFunctionBodyTypeContracts(program: Program, fn: FitFunction): BodyTypeContractIndex {
  const index = emptyBodyTypeContractIndex()
  const body = fn.node.body
  if (ts.isArrowFunction(fn.node) && ts.isExpression(body)) {
    addReturnTypeContract(index, fn.node, typeCheckContractForExpressionBoundary(program, body, fitReturnPublicRoot))
    return index
  }
  collectBodyTypeContracts(program, body, index)
  return index
}

function collectTopLevelBodyTypeContracts(program: Program): BodyTypeContractIndex {
  const index = emptyBodyTypeContractIndex()
  const visit = (node: ts.Node) => {
    if (isFunctionImplementation(node)) return
    addVariableTypeContract(program, node, index)
    ts.forEachChild(node, visit)
  }
  for (const statement of program.sourceFile.statements) visit(statement)
  return index
}

function collectBodyTypeContracts(program: Program, root: ts.Node, index: BodyTypeContractIndex) {
  const visit = (node: ts.Node) => {
    if (node !== root && isFunctionImplementation(node)) return
    addVariableTypeContract(program, node, index)
    if (ts.isReturnStatement(node) && node.expression != null) {
      addReturnTypeContract(index, node, typeCheckContractForExpressionBoundary(program, node.expression, fitReturnPublicRoot))
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
}

function addVariableTypeContract(program: Program, node: ts.Node, index: BodyTypeContractIndex) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return
  const contract = mergeTypeContracts([
    typeCheckContractForTypeNode(program, node.type, node.name.text),
    node.initializer == null
      ? emptyTypeContract<FitCheckSpec>()
      : typeCheckContractForExpressionBoundary(program, node.initializer, node.name.text),
  ])
  if (!hasTypeContractWork(contract)) return
  index.variables.set(node, contract)
  index.hasWork = true
}

function addReturnTypeContract(
  index: BodyTypeContractIndex,
  node: ts.Node,
  contract: TypeContractResult<FitCheckSpec>,
) {
  if (!hasTypeContractWork(contract)) return
  index.returns.set(node, contract)
  index.hasWork = true
}

function emptyBodyTypeContractIndex(): BodyTypeContractIndex {
  return {
    variables: new Map(),
    returns: new Map(),
    hasWork: false,
  }
}

function expressionBoundaryType(expression: ts.Expression): ts.TypeNode | null {
  if (ts.isParenthesizedExpression(expression)) return expressionBoundaryType(expression.expression)
  if (ts.isNonNullExpression(expression)) return expressionBoundaryType(expression.expression)
  if (ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return expression.type
  return null
}
