// astmut@v1 generation (plan-a/registered/m7-mj-gallery.json `operators`): astmut-rows.ts's operator mutants for every in-scope
// mj-gallery file at the pinned commit, written as one table. No function under test runs.
// usage: bun mutation-instrument/astmut.ts --rules <registered/m7-mj-gallery.json>
//   writes table.json and table.tsv into plan-a/m7-prep/astmut/, which must not exist yet
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {astmutFile} from './astmut-rows.ts'
import {decodeJson} from './encode.ts'
import {ASTMUT_DIR, checkedFile, worktreeOf, type AstmutCopy, type AstmutRow, type AstmutTable, type MjGalleryRegistration} from './mj-gallery.ts'

const INSTRUMENT_DIR = dirname(realpathSync(new URL(import.meta.url).pathname))

function sha1(text: string | Buffer) {
  return createHash('sha1').update(text).digest('hex')
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] ?? null
}

const rulesPath = option('--rules')
if (rulesPath == null) throw new Error('usage: bun mutation-instrument/astmut.ts --rules <registered/m7-mj-gallery.json>')
const registrationText = readFileSync(rulesPath, 'utf8')
const registration = decodeJson(registrationText) as MjGalleryRegistration
const scratch = registration.data.scratch
const outDir = join(scratch, ASTMUT_DIR)
if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`)
const worktreeDir = join(scratch, worktreeOf(registration))

const rows: AstmutRow[] = []
const copies: AstmutCopy[] = []
const checks: string[] = []
for (const copy of registration.copies.list) {
  for (const file of copy.files.filter((candidate) => candidate.entries)) {
    const generated = astmutFile({copy: copy.id, file: file.path, path: join(worktreeDir, file.path), text: checkedFile(registration, file.path), exportShim: copy.exportShim ?? [], excluded: copy.excludedEntries ?? []})
    rows.push(...generated.rows)
    copies.push(generated.copy)
  }
}
checks.push(`every row's lines hold no console.assert token in the pinned file: ${rows.length} rows`)
checks.push(`every change rule's from occurs exactly once in the pinned file and reproduces the mutated file with String.replace: ${rows.length} rows`)
checks.push(`every valid mutant keeps the file's line count, parses under Bun's transpiler, and has the copy's site keys and lines: ${rows.filter((row) => row.status === 'valid').length} mutants`)

const instrumentFiles = readdirSync(INSTRUMENT_DIR).filter((name) => name.endsWith('.ts')).sort()
const table: AstmutTable = {
  version: 'astmut@v1',
  registration: {path: rulesPath, sha1: sha1(registrationText)},
  generator: {
    commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim(),
    dirty: Bun.spawnSync(['git', 'status', '--porcelain', '--', '.'], {cwd: INSTRUMENT_DIR}).stdout.toString().trim() !== '',
    sha1: sha1(instrumentFiles.map((name) => `${name}\n${readFileSync(join(INSTRUMENT_DIR, name), 'utf8')}`).join('\n')),
  },
  copies,
  rows,
  checks,
}
mkdirSync(outDir, {recursive: true})
const tableText = `${JSON.stringify(table, null, 1)}\n`
writeFileSync(join(outDir, 'table.json'), tableText)
const tsvCell = (value: string | number | boolean | null) => String(value).replaceAll('\t', ' ').replaceAll('\n', '\\n')
const tsv = [['id', 'copy', 'file', 'function', 'line', 'column', 'operator', 'before', 'after', 'status', 'duplicate_of', 'sha1', 'from', 'to', 'widened_across_lines'].join('\t')]
for (const row of rows) tsv.push([row.id, row.copy, row.file, row.function, row.line, row.column, row.operator, row.before, row.after, row.status, row.duplicateOf, row.sha1, row.change.from, row.change.to, row.widenedAcrossLines].map(tsvCell).join('\t'))
writeFileSync(join(outDir, 'table.tsv'), `${tsv.join('\n')}\n`)
for (const copy of copies) console.log(`${copy.copy}: generated ${copy.generated}, valid ${copy.valid}, E1 duplicates ${copy.duplicates}, E2 invalid ${copy.invalid}, O3 unchanged text dropped ${copy.droppedUnchangedText}; scope ${[...copy.scopeFunctions, ...copy.scopeConstants].join(', ')}`)
console.log(`table.json sha1 ${sha1(tableText)}: ${rows.length} rows, ${rows.filter((row) => row.status === 'valid').length} valid, ${rows.filter((row) => row.widenedAcrossLines).length} change rules widened across lines`)
