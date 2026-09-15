import {expect, test} from 'bun:test'
import {copyPaths, errorFindings, exportShimLines, planMutantTree, removeExportShim} from '../lib/mutant-trees.ts'

const unitSources = [
  {path: 'geometry.ts', sha1: 'aaa'},
  {path: 'masonry.ts', sha1: 'bbb'},
  {path: 'types.ts', sha1: 'ccc'},
]
const copyFiles = [{file: 'geometry', sourceSha1: 'aaa'}, {file: 'masonry', sourceSha1: 'bbb'}]
const paths = new Map([['geometry', 'geometry.ts'], ['masonry', 'masonry.ts']])

test('a copy maps to corpus paths by path, else by sha1, and a copy with a foreign file maps to nothing', () => {
  expect(copyPaths(copyFiles, unitSources)).toEqual(paths)
  expect(copyPaths([{file: 'tooltipLayout', sourceSha1: 'shimmed', path: 'src/tooltipLayout.ts'}], [{path: 'src/tooltipLayout.ts', sha1: 'original'}])).toEqual(new Map([['tooltipLayout', 'src/tooltipLayout.ts']]))
  expect(copyPaths([{file: 'geometry', sourceSha1: 'zzz'}], unitSources)).toBeNull()
})

test('a mutant tree replaces its changed files from the mutant sources', () => {
  const plan = planMutantTree(copyFiles, [
    {file: 'geometry', source: '/runs/m4/mutants/m01/geometry.ts', sourceSha1: 'mmm'},
    {file: 'masonry', source: '/experiments/packing/contracts/masonry.ts', sourceSha1: 'bbb'},
  ], ['geometry'], unitSources, paths)
  expect(plan).toEqual({kind: 'tree', replacements: [{path: 'geometry.ts', from: '/runs/m4/mutants/m01/geometry.ts', sha1: 'mmm'}]})
})

test('check 1 refuses a changed file whose original is not the corpus file', () => {
  const plan = planMutantTree([{file: 'tooltipLayout', sourceSha1: 'shimmed', path: 'src/tooltipLayout.ts'}], [{file: 'tooltipLayout', source: '/m/tooltipLayout.ts', sourceSha1: 'mmm'}], ['tooltipLayout'],
    [{path: 'src/tooltipLayout.ts', sha1: 'original'}], new Map([['tooltipLayout', 'src/tooltipLayout.ts']]))
  expect(plan).toEqual({kind: 'refused', reason: 'check 1: the original of tooltipLayout has sha1 shimmed, the corpus file src/tooltipLayout.ts original'})
})

test('check 2 refuses a tree whose unchanged file differs from the corpus tree', () => {
  const plan = planMutantTree(copyFiles, [
    {file: 'geometry', source: '/m/geometry.ts', sourceSha1: 'mmm'},
    {file: 'masonry', source: '/m/masonry.ts', sourceSha1: 'edited'},
  ], ['geometry'], unitSources, paths)
  expect(plan).toEqual({kind: 'refused', reason: 'check 2: the unchanged file masonry (sha1 edited) differs from the corpus tree'})
})

const corpusText = 'function shrinkRow(naturals: number[]): number[] {\n  return naturals\n}\n\nexport function tooltipWidth(): number {\n  return 0\n}\n'
const shimmedText = 'export function shrinkRow(naturals: number[]): number[] {\n  return naturals\n}\n\nexport function tooltipWidth(): number {\n  return 0\n}\n'

test('an export-shimmed copy differs from its corpus file only by `export ` before some lines', () => {
  expect(exportShimLines(shimmedText, corpusText)).toEqual([1])
  expect(exportShimLines(corpusText, corpusText)).toEqual([])
  // Any other difference, e.g. a changed statement or an extra line, is not a shim.
  expect(exportShimLines(shimmedText.replace('return 0', 'return 1'), corpusText)).toBeNull()
  expect(exportShimLines(`${shimmedText}\n`, corpusText)).toBeNull()
  expect(exportShimLines(corpusText, shimmedText)).toBeNull()
})

test('removing the shim from a mutant of the shimmed copy gives the corpus file with the mutation', () => {
  const mutant = 'export function shrinkRow(naturals: number[]): number[] {\n  return naturals.slice(1)\n}\n\nexport function tooltipWidth(): number {\n  return 0\n}\n'
  expect(removeExportShim(mutant, [1])).toBe('function shrinkRow(naturals: number[]): number[] {\n  return naturals.slice(1)\n}\n\nexport function tooltipWidth(): number {\n  return 0\n}\n')
  // A mutant whose shim line no longer starts with `export ` can't be mapped back.
  expect(removeExportShim(mutant.replace('export function shrinkRow', 'function shrinkRow'), [1])).toBeNull()
  expect(removeExportShim(mutant, [9])).toBeNull()
})

test('error-level findings of fr stdout become rule|message entries; warnings and detail lines are skipped', () => {
  expect(errorFindings([
    'geometry.ts(10,3): error [console-assert]: could not prove console.assert condition in packRows: x >= 0',
    'geometry.ts(12,3): warning [console-assert-sweep]: console.assert condition failed on a generated input in packRows: x >= 0',
    '  input: packRows([])',
    'geometry.ts(14,5): error [declared-requirement]: call to placeItem makes its declared requirement definitely false',
  ].join('\n'))).toEqual([
    'console-assert|could not prove console.assert condition in packRows: x >= 0',
    'declared-requirement|call to placeItem makes its declared requirement definitely false',
  ])
})
