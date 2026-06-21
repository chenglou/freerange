import * as ts from 'typescript'
import type {Program} from './check-types.ts'
import {
  linearNameForExpression,
  numberValue,
  type NumberValue,
} from './domain.ts'
import {linearVariable} from './linear.ts'

type AmbientNumberBound = {
  min: number
  max: number
  isInteger: boolean
}

const nonnegativeInteger: AmbientNumberBound = {
  min: 0,
  // A shared unsigned-long envelope covers both signed and unsigned Web IDL
  // integer geometry attributes without losing their finite upper bound.
  max: 0xffff_ffff,
  isInteger: true,
}

const nonnegativeFiniteNumber: AmbientNumberBound = {
  min: 0,
  max: Number.MAX_VALUE,
  isInteger: false,
}

const nonnegativeUnrestrictedNumber: AmbientNumberBound = {
  min: 0,
  max: Number.POSITIVE_INFINITY,
  isInteger: false,
}

const ambientPropertyBounds = new Map<string, AmbientNumberBound>([
  ['Element.clientHeight', nonnegativeInteger],
  ['Element.clientWidth', nonnegativeInteger],
  ['Element.scrollHeight', nonnegativeInteger],
  ['Element.scrollWidth', nonnegativeInteger],
  ['HTMLElement.offsetHeight', nonnegativeInteger],
  ['HTMLElement.offsetWidth', nonnegativeInteger],
  ['HTMLCanvasElement.height', nonnegativeInteger],
  ['HTMLCanvasElement.width', nonnegativeInteger],
  ['HTMLImageElement.height', nonnegativeInteger],
  ['HTMLImageElement.naturalHeight', nonnegativeInteger],
  ['HTMLImageElement.naturalWidth', nonnegativeInteger],
  ['HTMLImageElement.width', nonnegativeInteger],
  ['HTMLVideoElement.height', nonnegativeInteger],
  ['HTMLVideoElement.videoHeight', nonnegativeInteger],
  ['HTMLVideoElement.videoWidth', nonnegativeInteger],
  ['HTMLVideoElement.width', nonnegativeInteger],
  ['PictureInPictureWindow.height', nonnegativeInteger],
  ['PictureInPictureWindow.width', nonnegativeInteger],
  ['ResizeObserverSize.blockSize', nonnegativeUnrestrictedNumber],
  ['ResizeObserverSize.inlineSize', nonnegativeUnrestrictedNumber],
  ['Screen.availHeight', nonnegativeInteger],
  ['Screen.availWidth', nonnegativeInteger],
  ['Screen.height', nonnegativeInteger],
  ['Screen.width', nonnegativeInteger],
  ['VisualViewport.height', nonnegativeFiniteNumber],
  ['VisualViewport.width', nonnegativeFiniteNumber],
  ['Window.innerHeight', nonnegativeInteger],
  ['Window.innerWidth', nonnegativeInteger],
  ['Window.outerHeight', nonnegativeInteger],
  ['Window.outerWidth', nonnegativeInteger],
])

const ambientGlobalBounds = new Map<string, AmbientNumberBound>([
  ['innerHeight', nonnegativeInteger],
  ['innerWidth', nonnegativeInteger],
  ['outerHeight', nonnegativeInteger],
  ['outerWidth', nonnegativeInteger],
])

export function ambientPropertyBound(expression: ts.PropertyAccessExpression, program: Program): NumberValue | null {
  const fact = ambientBoundForProperty(expression.name.text, expression.expression, program)
  return fact == null ? null : ambientNumberValue(expression.getText(program.sourceFile), fact)
}

export function ambientIdentifierBound(expression: ts.Identifier, program: Program): NumberValue | null {
  const fact = ambientGlobalBounds.get(expression.text)
  if (fact == null || !hasLibDomGlobalDeclaration(expression, program)) return null
  return ambientNumberValue(expression.text, fact)
}

function ambientNumberValue(expr: string, fact: AmbientNumberBound) {
  return numberValue(
    fact.min,
    fact.max,
    fact.isInteger ? 0 : null,
    expr,
    linearVariable(linearNameForExpression(expr)),
  )
}

function ambientBoundForProperty(propertyName: string, receiver: ts.Expression, program: Program): AmbientNumberBound | null {
  const checker = program.typeChecker
  if (checker == null) return null
  const type = checker.getTypeAtLocation(receiver)
  const members = type.isUnion() ? type.types : [type]
  const facts: AmbientNumberBound[] = []
  for (const member of members) {
    if (isNullishType(member)) return null
    const fact = typeMemberAmbientFact(member, propertyName, checker)
    if (fact == null) return null
    facts.push(fact)
  }
  return mergeAmbientNumberBounds(facts)
}

function mergeAmbientNumberBounds(facts: AmbientNumberBound[]): AmbientNumberBound | null {
  let result: AmbientNumberBound | null = null
  for (const fact of facts) {
    result = result == null
      ? fact
      : {
          min: Math.min(result.min, fact.min),
          max: Math.max(result.max, fact.max),
          isInteger: result.isInteger && fact.isInteger,
        }
  }
  return result
}

function typeMemberAmbientFact(type: ts.Type, propertyName: string, checker: ts.TypeChecker): AmbientNumberBound | null {
  const property = checker.getPropertyOfType(checker.getApparentType(type), propertyName)
  if (property == null) return null
  return ambientBoundForSymbol(property, propertyName)
}

function ambientBoundForSymbol(symbol: ts.Symbol, propertyName: string): AmbientNumberBound | null {
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (!isLibDomDeclaration(declaration)) continue
    const owner = declarationOwnerName(declaration)
    const fact = owner == null ? null : ambientPropertyBounds.get(`${owner}.${propertyName}`)
    if (fact != null) return fact
  }
  return null
}

function hasLibDomGlobalDeclaration(expression: ts.Identifier, program: Program) {
  const symbol = program.typeChecker?.getSymbolAtLocation(expression)
  if (symbol == null) return false
  return (symbol.getDeclarations() ?? []).some(declaration =>
    ts.isVariableDeclaration(declaration)
    && declaration.name.getText(declaration.getSourceFile()) === expression.text
    && isLibDomDeclaration(declaration),
  )
}

function declarationOwnerName(declaration: ts.Declaration): string | null {
  let current: ts.Node | undefined = declaration.parent
  while (current != null) {
    if (ts.isInterfaceDeclaration(current)) return current.name.text
    current = current.parent
  }
  return null
}

function isLibDomDeclaration(declaration: ts.Declaration) {
  const fileName = declaration.getSourceFile().fileName
  return fileName.endsWith('/lib.dom.d.ts') || fileName.endsWith('\\lib.dom.d.ts')
}

function isNullishType(type: ts.Type) {
  return (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
}
