// The benchmark dataset's records, as far as this harness reads them: every line of entries.jsonl, and the curated check
// readings file that says which recorded checks give a console.assert condition and where it goes. Both are read at every
// command, so entries added later are picked up.
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

export type Reach = 'static' | 'sweep' | 'browser'

export type Check = {kind: string; role: string; status: string; statement: string}

export type Entry = {
  id: string
  reach: Reach
  split: string
  location: {repo: string; snapshotCommit: string | null; fixCommit: string | null}
  checks: Check[]
}

type JsonRecord = Record<string, unknown>

function record(value: unknown, where: string): JsonRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected an object`)
  return value as JsonRecord
}

function text(object: JsonRecord, key: string, where: string): string {
  const value = object[key]
  if (typeof value !== 'string') throw new Error(`${where}: ${key} must be a string`)
  return value
}

function nullableText(object: JsonRecord, key: string, where: string): string | null {
  const value = object[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${where}: ${key} must be a string or null`)
  return value
}

function list(object: JsonRecord, key: string, where: string): unknown[] {
  const value = object[key]
  if (!Array.isArray(value)) throw new Error(`${where}: ${key} must be an array`)
  return value
}

function parseEntry(line: string, lineNumber: number): Entry {
  const where = `entries.jsonl:${lineNumber}`
  const object = record(JSON.parse(line), where)
  const reach = text(object, 'reach', where)
  if (reach !== 'static' && reach !== 'sweep' && reach !== 'browser') throw new Error(`${where}: unknown reach ${reach}`)
  const location = record(object['location'], `${where} location`)
  return {
    id: text(object, 'id', where),
    reach,
    split: text(object, 'split', where),
    location: {
      repo: text(location, 'repo', where),
      snapshotCommit: nullableText(location, 'snapshot_commit', where),
      fixCommit: nullableText(location, 'fix_commit', where),
    },
    checks: list(object, 'checks', where).map((value, index) => {
      const check = record(value, `${where} checks[${index}]`)
      return {kind: text(check, 'kind', where), role: text(check, 'role', where), status: text(check, 'status', where), statement: text(check, 'statement', where)}
    }),
  }
}

export type EntriesFile = {path: string; sha1: string; entries: Entry[]}

export function readEntries(path: string): EntriesFile {
  const content = readFileSync(path, 'utf8')
  const entries = content.split('\n').map((line, index) => ({line, index})).filter(({line}) => line.trim().length > 0).map(({line, index}) => parseEntry(line, index + 1))
  return {path, sha1: sha1(content), entries}
}

// A named value the check itself defines, bound with `const <name> = <expression>` right before the assert, because
// Freerange reads a console.assert over values calculated before it.
export type Binding = {name: string; expression: string}

// Where the assert goes, the same on the snapshot tree and on the fix tree: `before` or `after` the one statement inside
// function `function` of `path` whose source text starts with `anchor`.
export type Placement = {repo: string; path: string; function: string; anchor: string; position: 'before' | 'after'; note: string}

// A curator's reading of one recorded check: the console.assert condition its statement gives, verbatim, or null with why
// it gives none; and where that condition goes in the entry's code, or null with why no code site holds its terms.
export type CheckReading = {index: number; statementSha1: string; condition: string | null; bindings: Binding[]; placement: Placement | null; why: string}

export type ReadingsFile = {path: string; sha1: string; rule: string; by: string; date: string; entries: Map<string, CheckReading[]>}

export function readReadings(path: string): ReadingsFile {
  const content = readFileSync(path, 'utf8')
  const object = record(JSON.parse(content), path)
  const entries = new Map<string, CheckReading[]>()
  for (const [id, value] of Object.entries(record(object['entries'], `${path} entries`))) {
    const where = `${path} entries.${id}`
    entries.set(id, (Array.isArray(value) ? value : []).map((item, position) => {
      const reading = record(item, `${where}[${position}]`)
      const index = reading['index']
      if (typeof index !== 'number') throw new Error(`${where}[${position}]: index must be a number`)
      const placementValue = reading['placement']
      let placement: Placement | null = null
      if (placementValue != null) {
        const placementRecord = record(placementValue, `${where}[${position}] placement`)
        const positionText = text(placementRecord, 'position', where)
        if (positionText !== 'before' && positionText !== 'after') throw new Error(`${where}[${position}]: position must be before or after`)
        placement = {repo: text(placementRecord, 'repo', where), path: text(placementRecord, 'path', where), function: text(placementRecord, 'function', where), anchor: text(placementRecord, 'anchor', where), position: positionText, note: text(placementRecord, 'note', where)}
      }
      return {
        index,
        statementSha1: text(reading, 'statementSha1', where),
        condition: nullableText(reading, 'condition', where),
        bindings: list(reading, 'bindings', where).map(binding => {
          const bindingRecord = record(binding, `${where} binding`)
          return {name: text(bindingRecord, 'name', where), expression: text(bindingRecord, 'expression', where)}
        }),
        placement,
        why: text(reading, 'why', where),
      }
    }))
  }
  return {path, sha1: sha1(content), rule: text(object, 'rule', path), by: text(object, 'by', path), date: text(object, 'date', path), entries}
}
