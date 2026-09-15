import {expect, test} from 'bun:test'
import {insertAssert, readNames} from '../lib/placement.ts'

const source = `let items: number[] = []

function render(now: number): boolean {
  let found = -1
  if (now > 0) {
    for (found = 0; found < items.length; found += 2) {
      if (items[found]! > now) break
    }
  }
  const late = found * 2
  return late > 0
}
`

test('inserts after the whole anchor statement, indented like it, when every name is in scope', () => {
  const insertion = insertAssert('file.ts', source, {function: 'render', anchor: 'for (found = 0;', position: 'after', condition: 'found < items.length', bindings: []})
  expect(insertion.kind).toBe('inserted')
  if (insertion.kind !== 'inserted') return
  expect(insertion.assertLine).toBe(9)
  expect(insertion.text.split('\n').slice(5, 10)).toEqual([
    '    for (found = 0; found < items.length; found += 2) {',
    '      if (items[found]! > now) break',
    '    }',
    '    console.assert(found < items.length)',
    '  }',
  ])
})

test('binds named values first, before the anchor statement', () => {
  const insertion = insertAssert('file.ts', source, {function: 'render', anchor: 'const late', position: 'before', condition: 'span >= 0', bindings: [{name: 'span', expression: 'items.length - found'}]})
  expect(insertion.kind).toBe('inserted')
  if (insertion.kind !== 'inserted') return
  expect(insertion.firstInsertedLine).toBe(10)
  expect(insertion.assertLine).toBe(11)
  expect(insertion.text.split('\n').slice(9, 12)).toEqual(['  const span = items.length - found', '  console.assert(span >= 0)', '  const late = found * 2'])
})

test('a name the file doesn\'t declare, or declares below the insertion point, is unresolved', () => {
  const unknown = insertAssert('file.ts', source, {function: 'render', anchor: 'for (found = 0;', position: 'after', condition: 'found < targetCount', bindings: []})
  expect(unknown).toEqual({kind: 'failed', reason: 'names-unresolved', detail: 'not in scope at file.ts:6: targetCount'})
  const later = insertAssert('file.ts', source, {function: 'render', anchor: 'for (found = 0;', position: 'after', condition: 'late >= 0', bindings: []})
  expect(later.kind === 'failed' && later.reason).toBe('names-unresolved')
})

test('a binding may not reuse a name in scope, and an anchor must match exactly one statement', () => {
  const taken = insertAssert('file.ts', source, {function: 'render', anchor: 'const late', position: 'before', condition: 'found >= 0', bindings: [{name: 'items', expression: 'found'}]})
  expect(taken.kind === 'failed' && taken.reason).toBe('binding-name-taken')
  const twice = `function f(a: number) {\n  const b = a\n  const c = a\n  return b + c\n}\n`
  const ambiguous = insertAssert('file.ts', twice, {function: 'f', anchor: 'const', position: 'after', condition: 'a >= 0', bindings: []})
  expect(ambiguous.kind === 'failed' && ambiguous.reason).toBe('anchor-ambiguous')
  const missing = insertAssert('file.ts', twice, {function: 'g', anchor: 'const b', position: 'after', condition: 'a >= 0', bindings: []})
  expect(missing.kind === 'failed' && missing.reason).toBe('function-not-found')
})

test('readNames skips property names', () => {
  expect(readNames('pushedX || near(left, x + 16) || data.length > anchor.top')).toEqual(['pushedX', 'near', 'left', 'x', 'data', 'anchor'])
})
