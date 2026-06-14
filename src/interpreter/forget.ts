// Conservative invalidation for state that may have changed.
import {
  unknown,
  unknownArrayLength,
  unknownNumber,
  unknownObject,
  type NumberComputation,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {assumptionMentionsRoot} from '../assumptions.ts'
import {replaceRootValueEverywhere} from './value-path.ts'

export function forgetRoot(env: Map<string, Value>, root: string) {
  const current = env.get(root)
  if (current?.kind === 'array') {
    replaceRootValueEverywhere(env, root, {...current, length: unknownArrayLength(current.expr ?? root), elements: null, element: null, summary: null})
  } else if (current?.kind === 'object') {
    replaceRootValueEverywhere(env, root, unknownObject(root))
  } else if (current?.kind === 'number') {
    env.set(root, unknownNumber(root))
  } else {
    env.set(root, unknown(`Unsupported mutation changed ${root}`))
  }
  forgetSymbolicReferences(env, root)
}

// A regex matching the root as a standalone identifier inside an expression
// text, so a path or computation reading through it is recognized: `box`,
// `box.v`, and `Math.min(box, y)` all match `box`, but `boxes` and `mybox` do
// not. Build once per root and reuse across a forget, not once per lookup.
export function rootMentionPattern(root: string): RegExp {
  return new RegExp(`(?<![\\p{ID_Continue}$])${root}(?![\\p{ID_Continue}$])`, 'u')
}

// A value read before a mutation keeps the mutated path's symbolic identity:
// `const a = box.v` stays both linearly and by expression text `box.v`. Once
// `box` is forgotten that identity is stale — a later read of `box.v` is a
// different value — so the snapshot must not still prove `a == box.v` (by text)
// or `a - box.v == 0` (by linear form). Drop the symbolic identity from any
// other value naming a path under the root, keeping its proven numeric range.
function forgetSymbolicReferences(env: Map<string, Value>, root: string) {
  const mentionsRoot = rootMentionPattern(root)
  for (const [name, value] of env) {
    if (name === root || value.kind !== 'number') continue
    let linearStale = false
    if (value.linear != null) {
      for (const term of value.linear.terms.keys()) {
        if (mentionsRoot.test(term)) {
          linearStale = true
          break
        }
      }
    }
    const exprStale = value.expr != null && mentionsRoot.test(value.expr)
    const computationStale = computationMentionsRoot(value.computation, mentionsRoot)
    const casesStale = value.cases?.some(choice =>
      numberMentionsRoot(choice.value, mentionsRoot)
      || choice.assumptions.some(assumption => assumptionMentionsRoot(assumption, mentionsRoot))) === true
    if (linearStale || exprStale || computationStale || casesStale) {
      const next: NumberValue = {
        ...value,
        linear: linearStale ? null : value.linear,
        expr: exprStale ? null : value.expr,
        computation: computationStale ? null : value.computation,
        cases: casesStale ? null : value.cases,
      }
      env.set(name, next)
    }
  }
}

function computationMentionsRoot(computation: NumberComputation | null, pattern: RegExp): boolean {
  if (computation == null) return false
  return computation.kind === 'unary'
    ? numberMentionsRoot(computation.operand, pattern)
    : numberMentionsRoot(computation.left, pattern) || numberMentionsRoot(computation.right, pattern)
}

function numberMentionsRoot(value: NumberValue, pattern: RegExp): boolean {
  if (value.expr != null && pattern.test(value.expr)) return true
  if (value.linear != null) {
    for (const term of value.linear.terms.keys()) {
      if (pattern.test(term)) return true
    }
  }
  if (value.cases?.some(choice =>
    numberMentionsRoot(choice.value, pattern)
    || choice.assumptions.some(assumption => assumptionMentionsRoot(assumption, pattern))) === true) return true
  return computationMentionsRoot(value.computation, pattern)
}
