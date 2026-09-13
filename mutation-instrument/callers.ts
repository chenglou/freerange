// domain@v3-callers, the oracle arm of plan-a/decision-domain.md §3.2: hand-written caller rules that narrow an entry's
// domain to the values its production call sites pass. A rule applies by (family, copy, file, entry) after domain@v2's own
// rules and before the ±1e6 cap; an entry that no rule names keeps domain@v2 exactly. A rule is a list of conditions, each
// in one of four forms:
//   bound            sizes[i].width >= 0, as {path: [0, '[]', 'width'], op: '>=', constant: 0}; '[]' steps into array elements
//   integer          Number.isInteger(items[i].width)
//   offsetRelation   frame.topSidebar.left - 16 >= frame.content.left, as {left: [0, 'topSidebar', 'left'], offset: -16,
//                    op: '>=', right: [0, 'content', 'left']}, repaired after domain@v2's relation repair (lattice.ts)
//   callerDiscard    containerInnerSizeX - imagesGap * (cols - 1) > 0, checked on every generated input before the call
// Bounds and integer rules narrow the generated domain, so every generated input satisfies them. An input that still
// violates an offset relation after repair, or fails a discard predicate, is a caller discard: it's never called, and it's
// counted apart from leading-assert discards.
import {applyBound, applyIntegerRule, holds, type Comparison, type Domain, type NumberDomain, type TupleDomain, type Value} from './domain.ts'
import type {Path} from './types.ts'

export const ELEMENT_STEP = '[]'

export type Expression =
  | {kind: 'path'; path: Path}
  | {kind: 'constant'; value: number}
  | {kind: 'binary'; op: '+' | '-' | '*'; left: Expression; right: Expression}

export type CallerCondition =
  | {kind: 'bound'; path: Path; op: Comparison; constant: number}
  | {kind: 'integer'; path: Path}
  | {kind: 'offsetRelation'; left: Path; offset: number; op: Comparison; right: Path}
  | {kind: 'callerDiscard'; expression: Expression; op: Comparison; constant: number}

// One rule as it applies to an entry. The plan keeps it on the entry, with the call sites it cites (R-D4).
export type CallerRulePlan = {id: string; text: string; sources: string[]; conditions: CallerCondition[]}
export type CallerRuleEntry = {family: string; copy: string; file: string; entry: string}
export type CallerRule = CallerRulePlan & {entries: CallerRuleEntry[]}
export type CallerRuleFile = {version: string; rules: CallerRule[]}
// runs/w1-witness/drop-list.json: the rules R-D1(ii)'s witness check dropped, e.g. ['R-frames-1'] when some recorded
// caller-derived frame has topSidebar.left - 16 < content.left.
export type DropList = {dropped: string[]}

/** The number leaves a path names in a domain, e.g. [0, '[]', 'width'] names the width leaf of the first argument's array elements. */
export function ruleLeaves(domain: Domain, path: Path): NumberDomain[] {
  switch (domain.kind) {
    case 'union': return domain.members.flatMap((member) => ruleLeaves(member, path))
    case 'number': return path.length === 0 ? [domain] : []
    case 'choice': return []
    case 'record': {
      const field = domain.fields.find((candidate) => candidate.name === path[0])
      return field == null ? [] : ruleLeaves(field.domain, path.slice(1))
    }
    case 'tuple': {
      const head = path[0]
      const element = typeof head === 'number' ? domain.elements[head] : undefined
      return element == null ? [] : ruleLeaves(element, path.slice(1))
    }
    case 'array': return path[0] === ELEMENT_STEP ? ruleLeaves(domain.element, path.slice(1)) : []
  }
}

function formatPath(parameterNames: string[], path: Path): string {
  const head = path[0]
  let text = typeof head === 'number' ? parameterNames[head] ?? `argument ${head}` : String(head)
  for (const step of path.slice(1)) text += step === ELEMENT_STEP ? '[i]' : typeof step === 'number' ? `[${step}]` : `.${step}`
  return text
}

function formatExpression(parameterNames: string[], expression: Expression): string {
  switch (expression.kind) {
    case 'path': return formatPath(parameterNames, expression.path)
    case 'constant': return String(expression.value)
    case 'binary': return `(${formatExpression(parameterNames, expression.left)} ${expression.op} ${formatExpression(parameterNames, expression.right)})`
  }
}

/** e.g. `frame.topSidebar.left - 16 >= frame.content.left` */
export function formatCondition(parameterNames: string[], condition: CallerCondition): string {
  switch (condition.kind) {
    case 'bound': return `${formatPath(parameterNames, condition.path)} ${condition.op} ${condition.constant}`
    case 'integer': return `Number.isInteger(${formatPath(parameterNames, condition.path)})`
    case 'offsetRelation': return `${formatPath(parameterNames, condition.left)} ${condition.offset < 0 ? '-' : '+'} ${Math.abs(condition.offset)} ${condition.op} ${formatPath(parameterNames, condition.right)}`
    case 'callerDiscard': return `${formatExpression(parameterNames, condition.expression)} ${condition.op} ${condition.constant}`
  }
}

function formatNumberDomain(domain: NumberDomain) {
  return `${domain.minOpen ? '(' : '['}${domain.min}, ${domain.max}${domain.maxOpen ? ')' : ']'}${domain.integer ? ' integer' : ''}`
}

function expressionPaths(expression: Expression, output: Path[]) {
  switch (expression.kind) {
    case 'path': output.push(expression.path); break
    case 'constant': break
    case 'binary':
      expressionPaths(expression.left, output)
      expressionPaths(expression.right, output)
      break
  }
}

/**
 * Narrows `args` in place with the bound and integer conditions of `rules`, and returns one provenance line per narrowed
 * leaf, relation and predicate, e.g. `caller-rule@R-pack-1 <- PillToggle.tsx:82-92: sizes[i].width >= 0 narrows
 * [-Infinity, Infinity] to [0, Infinity] before the cap`. A path that names no number leaf is an error in the rule file.
 */
export function applyCallerRules(args: TupleDomain, parameterNames: string[], rules: CallerRulePlan[]): string[] {
  const provenance: string[] = []
  for (const rule of rules) {
    const origin = `caller-rule@${rule.id} <- ${rule.sources.join('; ')}`
    for (const condition of rule.conditions) {
      const text = formatCondition(parameterNames, condition)
      switch (condition.kind) {
        case 'bound':
        case 'integer': {
          const leaves = ruleLeaves(args, condition.path)
          if (leaves.length === 0) throw new Error(`${origin}: ${text} names no number leaf`)
          for (const leaf of leaves) {
            const before = formatNumberDomain(leaf)
            if (condition.kind === 'bound') applyBound(leaf, condition.op, condition.constant)
            else applyIntegerRule(leaf)
            provenance.push(`${origin}: ${text} narrows ${before} to ${formatNumberDomain(leaf)} before the cap`)
          }
          break
        }
        case 'offsetRelation':
        case 'callerDiscard': {
          const paths: Path[] = []
          if (condition.kind === 'offsetRelation') paths.push(condition.left, condition.right)
          else expressionPaths(condition.expression, paths)
          for (const path of paths) {
            if (path.includes(ELEMENT_STEP) || ruleLeaves(args, path).length !== 1) throw new Error(`${origin}: ${text}: ${formatPath(parameterNames, path)} is not one number leaf outside arrays`)
          }
          provenance.push(condition.kind === 'offsetRelation'
            ? `${origin}: ${text}, repaired by copying one side with the offset; an input still violating it is a caller discard`
            : `${origin}: ${text}, checked before the call; an input where it's false is a caller discard`)
          break
        }
      }
    }
  }
  return provenance
}

// -- Checking one input -------------------------------------------------------

/** Every value `path` reaches in one input, e.g. each element's width for [0, '[]', 'width']. */
function valuesAt(value: Value, path: Path, start: number, output: Value[]) {
  if (start === path.length) {
    output.push(value)
    return
  }
  if (value == null || typeof value !== 'object') return
  const step = path[start]!
  if (step === ELEMENT_STEP) {
    if (Array.isArray(value)) for (const element of value) valuesAt(element, path, start + 1, output)
    return
  }
  valuesAt((value as Record<string | number, Value>)[step], path, start + 1, output)
}

function numberAt(args: Value[], path: Path): number {
  const values: Value[] = []
  valuesAt(args, path, 0, values)
  const value = values[0]
  return values.length === 1 && typeof value === 'number' ? value : NaN
}

function evaluate(expression: Expression, args: Value[]): number {
  switch (expression.kind) {
    case 'path': return numberAt(args, expression.path)
    case 'constant': return expression.value
    case 'binary': {
      const left = evaluate(expression.left, args)
      const right = evaluate(expression.right, args)
      switch (expression.op) {
        case '+': return left + right
        case '-': return left - right
        case '*': return left * right
      }
    }
  }
}

/** Whether one input satisfies a condition. A path that reaches no number fails it, e.g. a bound on an element width that is a string. */
export function conditionHolds(condition: CallerCondition, args: Value[]): boolean {
  switch (condition.kind) {
    case 'bound':
    case 'integer': {
      const values: Value[] = []
      valuesAt(args, condition.path, 0, values)
      for (const value of values) {
        if (typeof value !== 'number') return false
        if (condition.kind === 'bound' ? !holds(value, condition.op, condition.constant) : !Number.isInteger(value)) return false
      }
      return true
    }
    case 'offsetRelation': return holds(numberAt(args, condition.left) + condition.offset, condition.op, numberAt(args, condition.right))
    case 'callerDiscard': return holds(evaluate(condition.expression, args), condition.op, condition.constant)
  }
}

/** Ids of the rules one input violates, in rule order, e.g. ['R-pack-2'] for packMasonry([{width: 0.5, height: 2, isStyle: false}], …). */
export function violatedRules(rules: CallerRulePlan[], args: Value[]): string[] {
  const result: string[] = []
  for (const rule of rules) if (rule.conditions.some((condition) => !conditionHolds(condition, args))) result.push(rule.id)
  return result
}

/** Whether a generated input is a caller discard: an offset relation that repair couldn't satisfy, or a false discard predicate. */
export function isCallerDiscard(rules: CallerRulePlan[], args: Value[]): boolean {
  for (const rule of rules) {
    for (const condition of rule.conditions) {
      switch (condition.kind) {
        case 'bound':
        case 'integer':
          break
        case 'offsetRelation':
        case 'callerDiscard':
          if (!conditionHolds(condition, args)) return true
          break
      }
    }
  }
  return false
}
