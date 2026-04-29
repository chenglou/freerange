import * as ts from 'typescript'
import type {Program} from './check-types.ts'
import type {FitFunction} from './modules.ts'
import {bindingNames} from './binding-patterns.ts'

export function isFunctionLikeWithBody(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
}

export function functionInputRoots(program: Program, fn: FitFunction): string[] {
  const roots = [...program.globals.keys()]
  if (functionHasInstanceThisInput(fn)) roots.push('this')
  for (const param of fn.node.parameters) {
    roots.push(...bindingNames(param.name))
  }
  return [...new Set(roots)]
}

export function functionHasInstanceThisInput(fn: FitFunction): boolean {
  return (ts.isMethodDeclaration(fn.node) || ts.isGetAccessorDeclaration(fn.node))
    && !hasModifier(fn.node, ts.SyntaxKind.StaticKeyword)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}
