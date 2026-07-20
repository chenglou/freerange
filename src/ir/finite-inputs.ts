import type {SiteID} from './ids.ts'
import type {DeclaredKind, FunctionIR} from './program.ts'
import type {NumericExpression} from '../requirements/model.ts'

export type FiniteInput = {
  parameter: number
  properties: string[]
  site: SiteID
}

// Plain number parameters and number leaves inside fixed records share one boundary rule.
// Conditional values and collections keep their existing, shape-specific assumptions.
export function finiteInputPaths(declared: DeclaredKind): string[][] {
  switch (declared.kind) {
    case 'number': return declared.interval == null ? [[]] : []
    case 'record': {
      const paths: string[][] = []
      for (const property of declared.properties) {
        for (const path of finiteInputPaths(property.declared)) {
          paths.push([property.name, ...path])
        }
      }
      return paths
    }
    case 'array':
    case 'boolean':
    case 'nullish':
    case 'opaque':
    case 'taggedUnion':
    case 'tuple': return []
  }
}

export function finiteInputs(fn: FunctionIR): FiniteInput[] {
  const inputs: FiniteInput[] = []
  for (let parameter = 0; parameter < fn.parameters.length; parameter++) {
    const current = fn.parameters[parameter]!
    for (const properties of finiteInputPaths(current.type)) {
      inputs.push({parameter, properties, site: current.site})
    }
  }
  return inputs
}

export function finiteInputExpression(input: FiniteInput): NumericExpression {
  let expression: NumericExpression = {kind: 'parameter', index: input.parameter}
  for (const property of input.properties) {
    expression = {kind: 'property', base: expression, name: property}
  }
  return expression
}
