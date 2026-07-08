// The style-slot pass: every numeric value written into a JSX style attribute, e.g.
// `style={{width: computedWidth}}`, is a place where a bad number fails silently — React
// stringifies NaN and Infinity into invalid CSS that the browser drops without an error,
// so the element just loses that declaration. The pass finds each such slot and lowers the
// slot's expression as its own synthetic function: free variables that live in an enclosing
// function (component locals, props, hook results) become parameters classified by their
// declared type, exactly the treatment a real parameter gets, and the whole existing
// engine analyzes the result. The verdict on each slot is therefore conditional the same
// way a function report is — it holds when the assumed kinds hold — and a flagged slot
// reads as the requires line the extract-to-.ts rewrite would surface.
//
// The pass is syntactic and separate from function lowering: JSX itself never lowers, and
// nothing here feeds back into function or module analysis. Slots are appended to
// ProgramIR.functions after all declared functions (so call instructions inside a slot
// resolve same-file callees by their real FunctionIDs) and are listed in
// ProgramIR.styleSlots, which the report uses to keep them out of the ordinary entries.

import * as ts from 'typescript'
import {nodeSpan, type FunctionIR, type FunctionLowering, type SourceSpan} from '../ir/program.ts'
import {assertAccepted} from './accept.ts'
import {addSite, LoweringStop, sealBlocks, terminate, unsupported, type FunctionContext, type MutableBlock, type TopLevelFunction} from './context.ts'
import {lowerExpression, valueKind} from './expression.ts'
import {declaredKind, type ModuleScan} from './module.ts'

export type LoweredStyleSlot = {property: string; lowering: FunctionLowering}

export function lowerStyleSlots(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
): LoweredStyleSlot[] {
  const slots: LoweredStyleSlot[] = []
  const slotName = (property: string | null, node: ts.Node): string => {
    const {line, character} = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${property == null ? 'style' : `style.${property}`} at ${line + 1}:${character + 1}`
  }
  const recordSkip = (property: string | null, node: ts.Node, reason: LoweringStop['reason']): void => {
    sites.push(nodeSpan(sourceFile, node))
    slots.push({
      property: property ?? '(whole object)',
      lowering: {kind: 'unsupported', name: slotName(property, node), site: sites.length - 1, reason},
    })
  }
  const lowerSlot = (property: string, expression: ts.Expression): void => {
    try {
      slots.push({
        property,
        lowering: lowerSlotFunction(slotName(property, expression), expression, sourceFile, checker, functionsBySymbol, scan, sites),
      })
    } catch (error) {
      if (!(error instanceof LoweringStop)) throw error
      sites.push(nodeSpan(sourceFile, error.node))
      slots.push({property, lowering: {kind: 'unsupported', name: slotName(property, expression), site: sites.length - 1, reason: error.reason}})
    }
  }
  // A slot is checked when its value's type is a plain number — that is the trigger, not a
  // property-name list, because a NaN stringifies to invalid CSS on every property. String
  // values are left alone except for their template interpolations: in
  // `width: `${percentage}%`` the interpolated number carries the same silent failure.
  const visitSlotValue = (property: string, value: ts.Expression): void => {
    if (ts.isTemplateExpression(value)) {
      for (const span of value.templateSpans) {
        if (valueKind(checker.getTypeAtLocation(span.expression), checker) === 'number') lowerSlot(property, span.expression)
      }
      return
    }
    if (valueKind(checker.getTypeAtLocation(value), checker) === 'number') lowerSlot(property, value)
  }
  const visitStyleAttribute = (attribute: ts.JsxAttribute): void => {
    const initializer = attribute.initializer
    if (initializer == null || !ts.isJsxExpression(initializer) || initializer.expression == null) return
    // Only a DOM tag (lowercase intrinsic name: div, span, canvas) renders its style
    // values as CSS. On a component, style is an ordinary prop — it usually reaches a DOM
    // tag eventually, but following it there is component-body analysis, deliberately not
    // taken on; the named skip keeps the census honest about how much rides on components.
    const tagName = attribute.parent.parent.tagName
    if (!ts.isIdentifier(tagName) || !/^[a-z]/.test(tagName.text)) {
      recordSkip(null, attribute, {kind: 'styleOnComponent'})
      return
    }
    const styleValue = initializer.expression
    // `style={precomputedStyle}` — the object is built elsewhere; nothing here names the
    // slots. Recorded so the coverage tally is honest about what the pass never saw.
    if (!ts.isObjectLiteralExpression(styleValue)) {
      recordSkip(null, styleValue, {kind: 'expressionForm', syntax: ts.SyntaxKind[styleValue.kind]})
      return
    }
    // A spread (or any other member form) can override the slots written after it at
    // runtime, so the whole object is skipped rather than checking slots that may not be
    // the effective values.
    const members: Array<ts.PropertyAssignment | ts.ShorthandPropertyAssignment> = []
    for (const member of styleValue.properties) {
      if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
        recordSkip(null, member, {kind: 'expressionForm', syntax: ts.SyntaxKind[member.kind]})
        return
      }
      members.push(member)
    }
    for (const member of members) {
      if (ts.isShorthandPropertyAssignment(member)) {
        visitSlotValue(member.name.text, member.name)
        continue
      }
      if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
        recordSkip(null, member.name, {kind: 'computedPropertyName'})
        continue
      }
      visitSlotValue(member.name.text, member.initializer)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'style') {
      visitStyleAttribute(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return slots
}

function lowerSlotFunction(
  name: string,
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
  scan: ModuleScan,
  sites: SourceSpan[],
): FunctionIR {
  assertAccepted(expression)
  const entry: MutableBlock = {loopHeader: null, parameters: [], instructions: [], terminator: null}
  const context: FunctionContext = {
    sourceFile,
    checker,
    functionsBySymbol,
    moduleBindingsBySymbol: scan.bindingsBySymbol,
    sites,
    nextValue: 0,
    currentBlock: entry,
    blocks: [entry],
    bindings: new Map(),
    parameters: [],
  }
  for (const [symbol, use] of freeLocalVariables(expression, sourceFile, checker, scan, functionsBySymbol)) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? use
    const declared = declaredKind(checker.getTypeAtLocation(declaration), checker, [])
    if (declared == null) {
      throw unsupported(use, {kind: 'parameterType', typeText: checker.typeToString(checker.getTypeAtLocation(declaration))})
    }
    const value = context.nextValue++
    context.bindings.set(symbol, value)
    context.parameters.push({value, name: use.text, type: declared})
  }
  const value = lowerExpression(expression, context)
  terminate(context.currentBlock, {kind: 'return', value, site: addSite(context, expression)})
  return {kind: 'lowered', name, parameters: context.parameters, returnPropertyNames: null, entry: 0, blocks: sealBlocks(context.blocks, name)}
}

// The free variables of a slot expression that live in an enclosing function — component
// locals, props, hook results. Each becomes a parameter of the slot's synthetic function.
// Everything else is deliberately NOT collected, so the ordinary identifier resolution
// handles it: module constants read exactly through the scan, same-file top-level functions
// resolve as callees, lib globals (Math, window, Infinity) go through their existing arms,
// and anything unresolvable rejects by name.
function freeLocalVariables(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  scan: ModuleScan,
  functionsBySymbol: Map<ts.Symbol, TopLevelFunction>,
): Map<ts.Symbol, ts.Identifier> {
  const free = new Map<ts.Symbol, ts.Identifier>()
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return
    if (ts.isIdentifier(node)) {
      // Not value uses: the `b` of `a.b`, and non-shorthand property names in literals.
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return
      if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node)
      // No symbol: leave the identifier for lowering, which records its own missingSymbol.
      if (symbol == null) return
      if (scan.bindingsBySymbol.has(symbol) || functionsBySymbol.has(symbol)) return
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (declaration == null) return
      // Imports and lib globals: their declarations live in other files.
      if (declaration.getSourceFile() !== sourceFile) return
      // Declared inside the slot expression itself (an arrow parameter): bound locally,
      // not free — and the arrow will reject the slot on its own.
      if (declaration.pos >= expression.pos && declaration.end <= expression.end) return
      if (!free.has(symbol)) free.set(symbol, node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return free
}
