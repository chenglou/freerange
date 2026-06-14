import * as ts from 'typescript'
import type {Program} from './check-types.ts'
import type {FitFunction} from './modules.ts'
import {bindingNames} from './binding-patterns.ts'

export type InlineFunctionNode = ts.FunctionExpression | ts.ArrowFunction

export type ClassFunctionNode =
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

export type FunctionImplementationNode =
  | (ts.FunctionDeclaration & {body: ts.Block})
  | InlineFunctionNode
  | (ts.MethodDeclaration & {body: ts.Block})
  | (ts.ConstructorDeclaration & {body: ts.Block})
  | (ts.GetAccessorDeclaration & {body: ts.Block})
  | (ts.SetAccessorDeclaration & {body: ts.Block})

export type FunctionImplementationRef = Readonly<{
  program: Program
  node: FunctionImplementationNode
}>

export function isFunctionImplementation(node: ts.Node): node is FunctionImplementationNode {
  return (
    ts.isFunctionDeclaration(node)
    || isInlineFunction(node)
    || isClassFunctionNode(node)
  ) && node.body != null
}

export function isInlineFunction(node: ts.Node): node is InlineFunctionNode {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

export function isClassFunctionNode(node: ts.Node): node is ClassFunctionNode {
  return ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}

export function functionImplementationReference(
  program: Program,
  node: FunctionImplementationNode,
): FunctionImplementationRef {
  assertFunctionImplementationReference({program, node})
  return {program, node}
}

export function assertFunctionImplementationReference(ref: FunctionImplementationRef) {
  if (ref.node.getSourceFile() === ref.program.sourceFile) return
  throw new Error(`Function implementation does not belong to ${ref.program.file}`)
}

export function functionImplementationForDeclaration(declaration: ts.Declaration): FunctionImplementationNode | null {
  if (isFunctionImplementation(declaration)) return declaration
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer == null) return null
  return isInlineFunction(declaration.initializer) ? declaration.initializer : null
}

export function classMemberFunctionName(className: string, member: ClassFunctionNode): string | null {
  if (ts.isConstructorDeclaration(member)) return `${className}.constructor`
  if (!ts.isIdentifier(member.name)) return null
  const owner = hasModifier(member, ts.SyntaxKind.StaticKeyword) ? `${className}.static` : className
  if (ts.isSetAccessorDeclaration(member)) return `${owner}.set.${member.name.text}`
  return `${owner}.${member.name.text}`
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
  return isClassFunctionNode(fn.node) && !hasModifier(fn.node, ts.SyntaxKind.StaticKeyword)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}
