import * as ts from 'typescript'
import {unsupported} from './context.ts'

// The early acceptance check from current-decisions.md ("What TypeScript code does the
// analyzer accept?"). Everything here rejects code where the checker's word is void, before
// lowering ever sees it, so lowering and the engine can key everything to static types.
// Called once per function declaration and once per top-level statement of the module
// initializer; a violation throws LoweringStop and is caught like any other rejection.
export function assertAccepted(root: ts.Node, checker: ts.TypeChecker): void {
  const visit = (node: ts.Node): void => {
    // Type annotations hold no runtime values, and their inner nodes confuse the expression
    // check below — the literal in `let stepped: 1 | 2` is a numeric-literal node that the
    // checker types as `any` when asked out of value position. Statement labels and
    // `export default` are outside the subset regardless, but their inner nodes confuse the
    // checker the same way, so lowering's own catch-alls report them under accurate names.
    if (ts.isTypeNode(node) || ts.isExportAssignment(node)) return
    if (ts.isLabeledStatement(node)) {
      visit(node.statement)
      return
    }
    if (ts.isBreakOrContinueStatement(node)) return
    // TypeScript accepts an `any`-typed value in every position, so a fully type-checked
    // function can still put a boolean into a `number` variable, e.g. `count = value` with
    // `value: any`. Rejecting the `any`-typed expression itself covers every position the
    // value could flow into.
    if (ts.isExpression(node) && (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any) !== 0) {
      throw unsupported(node, {kind: 'anyTyped'})
    }
    // An assertion changes the static type without changing the value, e.g.
    // `true as unknown as number` puts a boolean where every downstream computation
    // expects a number. `as const` is the exception that cannot lie: TypeScript only
    // permits it on literals, and it narrows the literal to its own literal type, e.g.
    // `24 as const` has type 24 — so it passes. The non-null assertion `x!` is not
    // rejected here either; lowering accepts it while it does not change the value kind.
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !ts.isConstTypeReference(node.type)) {
      throw unsupported(node, {
        kind: 'typeAssertion',
        typeText: checker.typeToString(checker.getTypeAtLocation(node)),
      })
    }
    // `var` hoists: one variable can have several declaration sites, and a nested
    // redeclaration writes a binding declared elsewhere. `let` and `const` express the
    // same programs without that.
    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      throw unsupported(node, {kind: 'varDeclaration'})
    }
    ts.forEachChild(node, visit)
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

// The one file-wide rule: any mention of `eval` puts the whole file outside the subset,
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
