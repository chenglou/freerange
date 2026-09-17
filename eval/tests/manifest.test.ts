import {expect, test} from 'bun:test'
import {validateManifest} from '../lib/manifest.ts'

test('refuses a manifest above the unit cap', () => {
  const unit = (id: string) => ({id, slice: 'synthetic', family: 'widths', unitFile: `${id}.json`})
  expect(() => validateManifest({version: 'v', builtAt: '', scratchRoot: '', counting: {}, slices: {}, skipped: [], units: [unit('a'), unit('b'), unit('c')]}, 2)).toThrow('above the cap')
})
