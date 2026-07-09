import * as ts from 'typescript'

// The platform catalog: numeric facts about browser globals, the analyzer's trusted base
// the way lib.dom.d.ts is the type system's. Each entry is a deliberate, written decision —
// a wrong range here poisons everything downstream — and the ranges deliberately include
// platform quirks (scroll positions go negative during Safari rubber-banding, so no scroll
// entry claims nonnegativity). A matched read produces a FRESH value within the range on
// every evaluation: these are reads of outside mutable state, so two reads of clientWidth
// may differ and must never be treated as equal.
//
// Only number-valued entries live here; a nullable API would need an explicit guard before
// its numeric result could use a catalog fact.
// (Related known gap for then: lib.dom types document.body as non-null, but it is null
// before the body parses — a script running in <head> can throw on the scroll entries.
// Partial correctness tolerates the throw; nullability work should revisit the entry.)

export type PlatformFact = {
  lower: number
  upper: number
  integer: boolean
}

type PlatformEntry = {
  // Property path from a global root, e.g. ['document', 'documentElement', 'clientWidth'].
  path: string[]
  // Whether the final path element is called, e.g. performance.now().
  call: boolean
  fact: PlatformFact
}

const anyFinite = {lower: -Number.MAX_VALUE, upper: Number.MAX_VALUE}

const catalog: PlatformEntry[] = [
  // Element layout sizes are nonnegative integers (the spec rounds them).
  {path: ['document', 'documentElement', 'clientWidth'], call: false, fact: {lower: 0, upper: Number.MAX_VALUE, integer: true}},
  {path: ['document', 'documentElement', 'clientHeight'], call: false, fact: {lower: 0, upper: Number.MAX_VALUE, integer: true}},
  // Window sizes can be fractional under browser zoom.
  {path: ['window', 'innerWidth'], call: false, fact: {lower: 0, upper: Number.MAX_VALUE, integer: false}},
  {path: ['window', 'innerHeight'], call: false, fact: {lower: 0, upper: Number.MAX_VALUE, integer: false}},
  // Scroll positions are finite but NOT nonnegative: Safari rubber-banding reports negative
  // values at the edges, and fractional values appear under zoom.
  {path: ['window', 'scrollX'], call: false, fact: {...anyFinite, integer: false}},
  {path: ['window', 'scrollY'], call: false, fact: {...anyFinite, integer: false}},
  {path: ['document', 'body', 'scrollTop'], call: false, fact: {...anyFinite, integer: false}},
  {path: ['document', 'body', 'scrollLeft'], call: false, fact: {...anyFinite, integer: false}},
  // Monotonic clocks: finite, nonnegative, fractional (performance.now has sub-millisecond
  // resolution); Date.now is an integer count of milliseconds.
  {path: ['performance', 'now'], call: true, fact: {lower: 0, upper: Number.MAX_VALUE, integer: false}},
  {path: ['Date', 'now'], call: true, fact: {lower: 0, upper: Number.MAX_VALUE, integer: true}},
]

// Matches a property chain rooted at a global whose symbol resolves into a declaration
// file — the same shadowing defense the Math dispatch uses, so a local variable named
// `document` never matches.
export function platformFact(expression: ts.Expression, call: boolean, checker: ts.TypeChecker): PlatformFact | null {
  const parts: string[] = []
  let current: ts.Expression = expression
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (!ts.isIdentifier(current)) return null
  parts.unshift(current.text)
  const entry = catalog.find(candidate =>
    candidate.call === call
    && candidate.path.length === parts.length
    && candidate.path.every((segment, index) => segment === parts[index]))
  if (entry == null) return null
  if (!declaredOnlyInDeclarationFiles(checker.getSymbolAtLocation(current))) return null
  return entry.fact
}

// The shadowing defense shared by every trusted-global dispatch (this catalog, `Math`,
// `Infinity`): the identifier counts as the real global only when every declaration of its
// symbol lives in a declaration file, so a local or module binding of the same name never
// matches.
export function declaredOnlyInDeclarationFiles(symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.declarations
  if (declarations == null || declarations.length === 0) return false
  return declarations.every(declaration => declaration.getSourceFile().isDeclarationFile)
}
