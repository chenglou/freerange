import {expect, test} from 'bun:test'
import {importClosure} from '../lib/closure.ts'
import {validateManifest} from '../lib/manifest.ts'

const files: Record<string, string> = {
  'src/a.ts': "import {b} from './b'\nimport type {XY} from '@/MidUI/MidUI'\nimport {prepare} from '@chenglou/pretext'\nexport const a = b",
  'src/b.ts': "export {c as b} from './c'",
  'src/c.ts': "import {d} from './d.js'\nexport const c = d",
  'src/d.ts': 'export const d = 1',
  'src/MidUI/MidUI.ts': 'export type XY = {x: number; y: number}',
}
const read = (path: string): string | null => files[path] ?? null

test('follows relative and aliased imports and lists packages', () => {
  const closure = importClosure(['src/a.ts'], read, {aliasPrefix: 'src'})
  expect([...closure.files.keys()].sort()).toEqual(['src/MidUI/MidUI.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])
  expect(closure.packages).toEqual(['@chenglou/pretext'])
  expect(closure.capped).toBe(false)
})

test('stops at the file cap and says so', () => {
  const closure = importClosure(['src/a.ts'], read, {aliasPrefix: 'src', maxFiles: 2})
  expect(closure.files.size).toBe(2)
  expect(closure.capped).toBe(true)
})

test('refuses a manifest above the unit cap', () => {
  const unit = (id: string) => ({id, slice: 'families' as const, family: 'packing', unitFile: `${id}.json`})
  expect(() => validateManifest({version: 'v', builtAt: '', scratchRoot: '', counting: {}, slices: {}, skipped: [], units: [unit('a'), unit('b'), unit('c')]}, 2)).toThrow('above the cap')
})
