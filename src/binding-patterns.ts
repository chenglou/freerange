import * as ts from 'typescript'

export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) names.push(...bindingNames(element.name))
  }
  if (ts.isArrayBindingPattern(name)) {
    forEachArrayBindingElement(name, elementName => names.push(...bindingNames(elementName)))
  }
  return names
}

export function forEachArrayBindingElement(
  pattern: ts.ArrayBindingPattern,
  visit: (name: ts.BindingName, index: number, isRest: boolean) => void,
) {
  pattern.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) return
    visit(element.name, index, element.dotDotDotToken != null)
  })
}

export function bindingElementPropertyName(element: ts.BindingElement): string | null {
  if (element.propertyName == null) return ts.isIdentifier(element.name) ? element.name.text : null
  if (ts.isIdentifier(element.propertyName)) return element.propertyName.text
  if (ts.isStringLiteral(element.propertyName) || ts.isNumericLiteral(element.propertyName)) return element.propertyName.text
  return null
}
