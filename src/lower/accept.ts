import * as ts from 'typescript'
import {unsupported} from './context.ts'

// The early acceptance check from current-decisions.md ("What TypeScript code does the
// analyzer accept?"): the wholesale structural rules — property writes (values are
// immutable after construction) and `var` — checked before lowering ever sees the code.
// (`any`-typed values and type assertions used to be rejected here too; both are carried
// claim-free now — see valueKind's opaque arm and unwrap's assertion peeling.) Called once
// per function declaration and once per top-level statement of the module initializer; a
// violation throws LoweringStop and is caught like any other rejection.
export function assertAccepted(root: ts.Node): void {
  const visit = (node: ts.Node): void => {
    // Type annotations hold no runtime values, so there is nothing to check inside them.
    if (ts.isTypeNode(node)) return
    // JSX never lowers (the expression catch-all names it), but its tag names and
    // attribute slots answer `any` to getTypeAtLocation even in diagnostic-clean files —
    // an SVG-heavy component would otherwise misfile under any-typed instead of its real
    // JSX rejection. Only the embedded {expressions} hold checkable runtime values.
    // (`any`-typed values themselves are carried claim-free since the opaque-carry
    // change, so this skip is about honest rejection reasons, not soundness.)
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      visitJsxValues(node)
      return
    }
    // Values are immutable after construction: any write through a property access —
    // plain, compound, or ++/-- — is rejected with rebinding as the suggested rewrite.
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isPropertyAccessExpression(node.left)
    ) {
      throw unsupported(node, {kind: 'propertyWrite'})
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isPropertyAccessExpression(node.operand)
    ) {
      throw unsupported(node, {kind: 'propertyWrite'})
    }
    // `var` hoists: one variable can have several declaration sites, and a nested
    // redeclaration writes a binding declared elsewhere. `let` and `const` express the
    // same programs without that.
    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      throw unsupported(node, {kind: 'varDeclaration'})
    }
    ts.forEachChild(node, visit)
  }
  const visitJsxValues = (jsx: ts.Node): void => {
    if (ts.isJsxExpression(jsx)) {
      if (jsx.expression != null) visit(jsx.expression)
      return
    }
    ts.forEachChild(jsx, visitJsxValues)
  }
  visit(root)
}

// The other file-wide rule: a `@ts-ignore`, `@ts-expect-error`, or `@ts-nocheck` comment
// turns off type checking somewhere in the file, and every guarantee is built on the
// checker's word — e.g. `// @ts-expect-error` above `let width: number = true` puts a
// boolean where every number invariant applies, with no `any` in sight. A full-text scan
// deliberately over-rejects (the directive could sit inside a string); rejecting a file
// that merely spells the directive is the cheap side of the trade.
const suppressionDirective = /@ts-(?:nocheck|ignore|expect-error)/
export function typeCheckSuppressionMention(sourceFile: ts.SourceFile): {start: number; end: number} | null {
  const match = suppressionDirective.exec(sourceFile.getFullText())
  return match == null ? null : {start: match.index, end: match.index + match[0].length}
}

// The eval file-wide rule: any mention of `eval` puts the whole file outside the subset,
// because an eval string can rewrite bindings that every function's report depends on.
// A plain identifier scan deliberately over-rejects (e.g. a variable named eval shadowing
// the global) — the spellings that matter, like `(eval)(...)`, all contain the identifier,
// and no detection of call shapes or TypeScript wrappers is needed.
export function evalMention(sourceFile: ts.SourceFile): ts.Node | null {
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (found != null) return
    if (ts.isIdentifier(node) && node.text === 'eval') {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}
