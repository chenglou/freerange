import * as ts from 'typescript'
import type {
  FitShapeInsight,
  FitShapeOptions,
  Program,
} from './check-types.ts'
import {
  factsFromValue,
  type FitEqualityFact,
  type FitInferFact,
  type FitRangeFact,
} from './facts.ts'
import type {NumberValue, Value} from './domain.ts'
import type {FitFunction} from './modules.ts'
import {
  fitReturnPublicRoot,
  publicFitText,
} from './parser.ts'
import {
  structuralShape,
  valueFromCallReturnShape,
  valueFromFunctionReturnShape,
  valueFromNodeShape,
  valueFromSyntaxTypeShape,
} from './shapes.ts'

export type ShapeInspectState = {
  baseEnv: Map<string, Value>
  env: Map<string, Value>
  result: Value
}

type ShapeFact =
  | FitRangeFact
  | FitEqualityFact
  | {
      kind: 'generic-number'
      text: string
      path: string
    }

export function inspectFunctionShapeInsights(
  program: Program,
  fn: FitFunction,
  state: ShapeInspectState | null,
  options: FitShapeOptions,
): FitShapeInsight[] {
  const functionName = fn.name
  const insights: FitShapeInsight[] = []

  for (const param of fn.node.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    const subject = `param ${param.name.text}`
    const freerange = state?.baseEnv.get(param.name.text) ?? valueFromSyntaxTypeShape(param.name.text, param.type, program, new Set())
    const typescript = valueFromNodeShape(param.name.text, param.name, program)
    addShapeInsight(insights, program, functionName, subject, param.name.text, freerange, typescript)
  }

  const syntaxReturn = valueFromSyntaxTypeShape(fitReturnPublicRoot, fn.node.type, program, new Set())
  const tsReturn = valueFromFunctionReturnShape(fitReturnPublicRoot, fn.node, program)
  addShapeInsight(insights, program, functionName, 'return type', fitReturnPublicRoot, state?.result ?? syntaxReturn, tsReturn)

  if (fn.node.body != null && (state != null || options.calls === true)) {
    collectShapeInsightsFromNode(fn.node.body, program, functionName, state, options, insights)
  }

  return insights
}

function collectShapeInsightsFromNode(
  node: ts.Node,
  program: Program,
  functionName: string,
  state: ShapeInspectState | null,
  options: FitShapeOptions,
  insights: FitShapeInsight[],
) {
  if (node !== program.sourceFile && isNestedFunctionLike(node)) return

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const freerange = state?.env.get(node.name.text) ?? valueFromSyntaxTypeShape(node.name.text, node.type, program, new Set())
    const typescript = valueFromNodeShape(node.name.text, node.name, program)
    addShapeInsight(insights, program, functionName, `local ${node.name.text}`, node.name.text, freerange, typescript)
  }

  if (options.calls === true && ts.isCallExpression(node)) {
    const typescript = structuralShape(valueFromCallReturnShape('shape', node, program))
    addShapeInsight(insights, program, functionName, `call ${compactNodeText(node, program.sourceFile)}`, 'shape', null, typescript)
  }

  ts.forEachChild(node, child => collectShapeInsightsFromNode(child, program, functionName, state, options, insights))
}

function isNestedFunctionLike(node: ts.Node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

function addShapeInsight(
  insights: FitShapeInsight[],
  program: Program,
  functionName: string,
  subject: string,
  root: string,
  freerangeValue: Value | null,
  typescriptValue: Value | null,
) {
  const typescript = shapeFacts(root, typescriptValue)
  if (typescript.length === 0) return
  const freerange = shapeFacts(root, freerangeValue)
  const extra = typescript.filter(fact => !freerangeFactsImply(freerange, fact))
  if (extra.length === 0) return
  insights.push({
    file: program.file,
    functionName,
    subject,
    freerange: shapeFactTexts(freerange),
    typescript: shapeFactTexts(extra),
  })
}

function freerangeFactsImply(facts: ShapeFact[], fact: ShapeFact) {
  if (facts.some(candidate => candidate.text === fact.text)) return true
  if (fact.kind === 'generic-number') {
    return facts.some(candidate => candidate.path === fact.path && isNumericShapeFact(candidate))
  }
  if (fact.kind === 'range' && fact.isInteger && fact.min === 0 && fact.max === Number.POSITIVE_INFINITY) {
    return facts.some(candidate => factAtPathImpliesNonnegativeInteger(candidate, fact.path))
  }
  return false
}

function factAtPathImpliesNonnegativeInteger(fact: ShapeFact, path: string) {
  if (fact.path !== path) return false
  if (fact.kind === 'range') return fact.isInteger && fact.min >= 0
  return fact.kind === 'equality' && expressionIsClearlyNonnegativeInteger(fact.expression)
}

function isNumericShapeFact(fact: ShapeFact) {
  return fact.kind === 'generic-number' || fact.kind === 'range' || fact.kind === 'equality'
}

function expressionIsClearlyNonnegativeInteger(expression: string) {
  if (/^\d+$/.test(expression)) return true
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\])*\.(?:length)$/.test(expression)
}

function shapeFacts(root: string, value: Value | null): ShapeFact[] {
  if (value == null) return []
  return uniqueShapeFacts(shapeFactsFromValue(root, value))
}

function uniqueShapeFacts(facts: ShapeFact[]): ShapeFact[] {
  const seen = new Set<string>()
  const unique: ShapeFact[] = []
  for (const fact of facts) {
    if (seen.has(fact.text)) continue
    seen.add(fact.text)
    unique.push(fact)
  }
  return unique
}

function shapeFactTexts(facts: ShapeFact[]): string[] {
  return facts.map(fact => fact.text)
}

function shapeFactsFromValue(path: string, value: Value): ShapeFact[] {
  if (value.kind === 'number') {
    if (!isStructuralShapePath(path)) return []
    return numericShapeFacts(path, value, true)
  }
  if (value.kind === 'object') {
    const facts: ShapeFact[] = []
    for (const [name, prop] of [...value.props.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      facts.push(...shapeFactsFromValue(`${path}.${name}`, prop))
    }
    return facts
  }
  if (value.kind === 'array') {
    const facts = numericShapeFacts(`${path}.length`, value.length, false)
    if (value.element != null) facts.push(...shapeFactsFromValue(`${path}[]`, value.element))
    return facts
  }
  return []
}

function numericShapeFacts(path: string, value: NumberValue, fallbackGeneric: boolean): ShapeFact[] {
  const facts = factsFromValue(path, value).filter(isRangeOrEqualityFact)
  return facts.length === 0 && fallbackGeneric
    ? [{kind: 'generic-number', path: publicFitText(path), text: `${publicFitText(path)}: number`}]
    : facts
}

function isRangeOrEqualityFact(fact: FitInferFact): fact is FitRangeFact | FitEqualityFact {
  return fact.kind === 'range' || fact.kind === 'equality'
}

function isStructuralShapePath(path: string) {
  return path.includes('.') || path.includes('[]')
}

function compactNodeText(node: ts.Node, sourceFile: ts.SourceFile) {
  return node.getText(sourceFile)
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ ,/g, ',')
    .replace(/, \)/g, ')')
    .replace(/ \)/g, ')')
    .trim()
}
