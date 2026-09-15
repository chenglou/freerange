import {expect, test} from 'bun:test'
import {copyPaths, errorFindings, multisetDifference, planMutantTree, siteSetDifference} from '../lib/mutant-trees.ts'

const unitSources = [
  {path: 'geometry.ts', sha1: 'aaa'},
  {path: 'masonry.ts', sha1: 'bbb'},
  {path: 'types.ts', sha1: 'ccc'},
]
const copyFiles = [{file: 'geometry', sourceSha1: 'aaa'}, {file: 'masonry', sourceSha1: 'bbb'}]

test('a copy maps to corpus paths by sha1, and a copy with a foreign file maps to nothing', () => {
  expect(copyPaths(copyFiles, unitSources)).toEqual(new Map([['geometry', 'geometry.ts'], ['masonry', 'masonry.ts']]))
  expect(copyPaths([{file: 'geometry', sourceSha1: 'zzz'}], unitSources)).toBeNull()
})

test('a mutant tree replaces its changed files from the mutant sources', () => {
  const plan = planMutantTree(copyFiles, [
    {file: 'geometry', source: '/runs/m4/mutants/m01/geometry.ts', sourceSha1: 'mmm'},
    {file: 'masonry', source: '/experiments/packing/contracts/masonry.ts', sourceSha1: 'bbb'},
  ], ['geometry'], unitSources)
  expect(plan).toEqual({kind: 'tree', replacements: [{path: 'geometry.ts', from: '/runs/m4/mutants/m01/geometry.ts', sha1: 'mmm'}]})
})

test('check 1 refuses a changed file whose original is not the corpus file', () => {
  const plan = planMutantTree([{file: 'geometry', sourceSha1: 'old'}], [{file: 'geometry', source: '/m/geometry.ts', sourceSha1: 'mmm'}], ['geometry'], unitSources)
  expect(plan).toEqual({kind: 'refused', reason: 'check 1: the original of geometry (sha1 old) is not a corpus file of the unit'})
})

test('check 2 refuses a tree whose unchanged file differs from the corpus tree', () => {
  const plan = planMutantTree(copyFiles, [
    {file: 'geometry', source: '/m/geometry.ts', sourceSha1: 'mmm'},
    {file: 'masonry', source: '/m/masonry.ts', sourceSha1: 'edited'},
  ], ['geometry'], unitSources)
  expect(plan).toEqual({kind: 'refused', reason: 'check 2: the unchanged file masonry (sha1 edited) differs from the corpus tree'})
})

test('the site-set difference keeps keys only the mutant prints, once each', () => {
  expect(siteSetDifference(
    ['geometry.ts|packRows|x >= 0|0', 'geometry.ts|packRows|y >= 0|0', 'geometry.ts|packRows|y >= 0|0', 'masonry.ts|placeMasonryCard|itemWidth >= 0|0|layoutRows'],
    ['geometry.ts|packRows|x >= 0|0', 'masonry.ts|placeMasonryCard|itemWidth >= 0|0|layoutColumns'],
  )).toEqual(['geometry.ts|packRows|y >= 0|0', 'masonry.ts|placeMasonryCard|itemWidth >= 0|0|layoutRows'])
  expect(siteSetDifference(['a|f|x|0'], ['a|f|x|0'])).toEqual([])
})

test('the static finding difference is a multiset difference of error-level (rule, message) entries', () => {
  const original = errorFindings([
    'geometry.ts(10,3): error [console-assert]: could not prove console.assert condition in packRows: x >= 0',
    'geometry.ts(12,3): warning [console-assert-sweep]: console.assert condition failed on a generated input in packRows: x >= 0',
    '  input: packRows([])',
  ].join('\n'))
  expect(original).toEqual(['console-assert|could not prove console.assert condition in packRows: x >= 0'])
  const mutant = errorFindings([
    'geometry.ts(10,3): error [console-assert]: could not prove console.assert condition in packRows: x >= 0',
    'geometry.ts(11,3): error [console-assert]: could not prove console.assert condition in packRows: x >= 0',
  ].join('\n'))
  expect(multisetDifference(mutant, original)).toEqual(['console-assert|could not prove console.assert condition in packRows: x >= 0'])
  expect(multisetDifference(original, mutant)).toEqual([])
})
