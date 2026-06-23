import {describe, expect, test} from 'bun:test'
import * as ts from 'typescript'

async function moduleSpecifiers(filePath: string): Promise<string[]> {
  const source = ts.createSourceFile(
    filePath,
    await Bun.file(filePath).text(),
    ts.ScriptTarget.Latest,
    true,
  )
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier != null && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier != null && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

describe('numeric module boundary', () => {
  test('imports only other numeric modules', async () => {
    const numericRoot = new URL('../../src/numeric/', import.meta.url)
    const outsideImports: string[] = []
    const files = ts.sys.readDirectory(numericRoot.pathname, ['.ts'])
    for (const filePath of files) {
      const relativePath = filePath.slice(numericRoot.pathname.length)
      for (const specifier of await moduleSpecifiers(filePath)) {
        if (!specifier.startsWith('.')) {
          outsideImports.push(`${relativePath}: ${specifier}`)
          continue
        }
        const resolved = new URL(specifier, `file://${filePath}`)
        if (!resolved.pathname.startsWith(numericRoot.pathname)) {
          outsideImports.push(`${relativePath}: ${specifier}`)
        }
      }
    }
    expect(outsideImports).toEqual([])
  })

  test('keeps numeric tests independent from Freerange modules', async () => {
    const testRoot = new URL('./', import.meta.url)
    const sourceRoot = new URL('../../src/', import.meta.url)
    const numericRoot = new URL('../../src/numeric/', import.meta.url)
    const outsideImports: string[] = []
    const files = ts.sys.readDirectory(testRoot.pathname, ['.ts'])
      .filter(filePath => !filePath.endsWith('/architecture.test.ts'))
    for (const filePath of files) {
      for (const specifier of await moduleSpecifiers(filePath)) {
        if (!specifier.startsWith('.')) continue
        const resolved = new URL(specifier, `file://${filePath}`)
        if (resolved.pathname.startsWith(sourceRoot.pathname) && !resolved.pathname.startsWith(numericRoot.pathname)) {
          outsideImports.push(`${filePath.slice(testRoot.pathname.length)}: ${specifier}`)
        }
      }
    }
    expect(outsideImports).toEqual([])
  })
})
