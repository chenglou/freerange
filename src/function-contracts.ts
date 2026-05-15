import * as ts from 'typescript'
import {
  fitReturnPublicRoot,
  fitBodySpecIndexHasWork,
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
} from './type-contracts.ts'
import {isFunctionLikeWithBody} from './function-shape.ts'

export function functionHasBodyFitComment(program: Program, fn: FitFunction) {
  return fitBodySpecIndexHasWork(program.bodySpecsByFunction.get(fn.name))
}

export function functionHasTypeContracts(program: Program, fn: FitFunction) {
  return hasTypeContractWork(functionTypeGivenContract(program, fn))
    || hasTypeContractWork(functionTypeReturnContract(program, fn))
    || functionHasBodyTypeBoundary(program, fn)
}

export function functionContractSpecs(program: Program, fn: FitFunction, explicitSpecs: FitSpec[] = program.specsByFunction.get(fn.name) ?? []): FitSpec[] {
  return [
    ...functionTypeGivenSpecs(program, fn),
    ...explicitSpecs,
    ...functionTypeReturnSpecs(program, fn),
  ]
}

export function functionInputSpecs(program: Program, fn: FitFunction, explicitSpecs: FitSpec[] = program.specsByFunction.get(fn.name) ?? []): FitSpec[] {
  return [
    ...functionTypeGivenSpecs(program, fn),
    ...explicitSpecs,
  ]
}

function functionTypeGivenSpecs(program: Program, fn: FitFunction): FitGivenSpec[] {
  return functionTypeGivenContract(program, fn).specs
}

function functionTypeReturnSpecs(program: Program, fn: FitFunction): FitCheckSpec[] {
  return functionTypeReturnContract(program, fn).specs
}

function functionTypeGivenContract(program: Program, fn: FitFunction): TypeContractResult<FitGivenSpec> {
  return typeInputGivenContractForFunction(program, fn)
}

function functionTypeReturnContract(program: Program, fn: FitFunction): TypeContractResult<FitCheckSpec> {
  return typeReturnCheckContractForFunction(program, fn)
}

export function functionTypeUnsupported(program: Program, fn: FitFunction) {
  return [
    ...functionTypeGivenContract(program, fn).unsupported,
    ...functionTypeReturnContract(program, fn).unsupported,
  ]
}

export function hasTypeContractWork<T extends FitCheckSpec | FitGivenSpec>(contract: TypeContractResult<T>) {
  return contract.specs.length > 0 || contract.unsupported.length > 0
}

export function functionHasBodyTypeBoundary(program: Program, fn: FitFunction) {
  if (fn.node.body == null) return false
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (node !== fn.node.body && isFunctionLikeWithBody(node)) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (hasTypeContractWork(typeCheckContractForTypeNode(program, node.type, node.name.text))) {
        found = true
        return
      }
      if (node.initializer != null && hasTypeContractWork(typeCheckContractForExpressionBoundary(program, node.initializer, node.name.text))) {
        found = true
        return
      }
    }
    if (ts.isReturnStatement(node) && node.expression != null && hasTypeContractWork(typeCheckContractForExpressionBoundary(program, node.expression, fitReturnPublicRoot))) {
      found = true
      return
    }
    if (node === fn.node.body && ts.isExpression(node) && hasTypeContractWork(typeCheckContractForExpressionBoundary(program, node, fitReturnPublicRoot))) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(fn.node.body)
  return found
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

function expressionBoundaryType(expression: ts.Expression): ts.TypeNode | null {
  if (ts.isParenthesizedExpression(expression)) return expressionBoundaryType(expression.expression)
  if (ts.isNonNullExpression(expression)) return expressionBoundaryType(expression.expression)
  if (ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return expression.type
  return null
}
