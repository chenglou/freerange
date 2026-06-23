import {describe, expect, test} from 'bun:test'
import * as ts from 'typescript'

describe('numeric module boundary', () => {
  test('imports only other numeric modules', async () => {
    const numericRoot = new URL('../../src/numeric/', import.meta.url)
    const outsideImports: string[] = []
    const files = ts.sys.readDirectory(numericRoot.pathname, ['.ts'])
    for (const filePath of files) {
      const relativePath = filePath.slice(numericRoot.pathname.length)
      const source = ts.createSourceFile(
        filePath,
        await Bun.file(filePath).text(),
        ts.ScriptTarget.Latest,
        true,
      )
      const checkSpecifier = (specifier: ts.Expression) => {
        if (!ts.isStringLiteralLike(specifier)) return
        if (!specifier.text.startsWith('.')) {
          outsideImports.push(`${relativePath}: ${specifier.text}`)
          return
        }
        const resolved = new URL(specifier.text, `file://${filePath}`)
        if (!resolved.pathname.startsWith(numericRoot.pathname)) {
          outsideImports.push(`${relativePath}: ${specifier.text}`)
        }
      }
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier != null) checkSpecifier(node.moduleSpecifier)
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const [specifier] = node.arguments
          if (specifier != null) checkSpecifier(specifier)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(outsideImports).toEqual([])
  })
})
