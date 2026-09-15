import {expect, test} from 'bun:test'
import {classifyMessage} from '../lib/census.ts'

// The messages are Freerange's own text (src/project.ts and formatUnsupportedReason in src/report/index.ts at 1dfafc5).
const names = {imports: new Set(['measureLineStats']), declared: new Set(['measureLineStats', 'canvasContext', 'clamp', 'data'])}

test('groups a function\'s not-lowered finding by its first unsupported construct', () => {
  const notChecked = (reason: string): string => `console.assert in render was not checked because ${reason}`
  expect(classifyMessage(notChecked('a write into an object (mutation is outside the subset; rebuilding a plain-data record may be suitable when identity and mutation are not observed)'), names).group).toBe('object-write')
  expect(classifyMessage(notChecked('function call document.createElement'), names)).toEqual({group: 'dom-or-platform', kind: 'call', subject: 'document.createElement'})
  expect(classifyMessage(notChecked('function call measureLineStats'), names).group).toBe('import')
  expect(classifyMessage(notChecked('function call canvasContext.moveTo'), names).group).toBe('other')
  expect(classifyMessage(notChecked('function call data.map (array methods are outside the subset; a for loop may suit simple dense-array aggregation)'), names).group).toBe('array-method')
  expect(classifyMessage(notChecked('value of type HTMLDivElement'), names)).toEqual({group: 'dom-or-platform', kind: 'value-of-type', subject: 'HTMLDivElement'})
  expect(classifyMessage(notChecked('condition of type number | undefined (compare explicitly, e.g. width > 0 or mode !== undefined)'), names)).toEqual({group: 'other', kind: 'condition-of-type', subject: 'number | undefined'})
  expect(classifyMessage(notChecked('expression (ArrowFunction)'), names).group).toBe('closure')
})

test('an assert outside a named top-level function is a closure stop, and an assert-form finding is its own group', () => {
  expect(classifyMessage('console.assert is only supported inside a named top-level function', names).group).toBe('closure')
  expect(classifyMessage('calculate or read the value before console.assert, then check the variable in render', names).group).toBe('assert-form')
})
