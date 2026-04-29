import type * as ts from 'typescript'
import type {FitCheck} from './check-types.ts'

export type CheckBoundary = Pick<FitCheck, 'boundaryLine'>

export function lineNumberForNode(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

export function checkBoundaryForNode(sourceFile: ts.SourceFile, node: ts.Node): CheckBoundary {
  return {boundaryLine: lineNumberForNode(sourceFile, node)}
}
