// JSON at process boundaries. Plain JSON turns `undefined` array elements into null and -0 into 0, which would change
// an optional parameter's generated value or a comparison against 0, so those values travel as `{"$fr": ...}` tags.
import type {Value} from './domain.ts'

type Tag = 'undefined' | '-0' | 'NaN' | 'Infinity' | '-Infinity'

function tagOf(value: unknown): Tag | null {
  if (value === undefined) return 'undefined'
  if (typeof value !== 'number') return null
  if (Object.is(value, -0)) return '-0'
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'Infinity'
  if (value === -Infinity) return '-Infinity'
  return null
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    const tag = tagOf(child)
    return tag == null ? child : {$fr: tag}
  })
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive)
  if (value == null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const tag = record['$fr']
  switch (tag) {
    case 'undefined': return undefined
    case '-0': return -0
    case 'NaN': return NaN
    case 'Infinity': return Infinity
    case '-Infinity': return -Infinity
    default: {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(record)) result[key] = revive(record[key])
      return result
    }
  }
}

export function decodeJson(text: string): unknown {
  return revive(JSON.parse(text))
}

export function formatValue(value: Value): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`
  return `{${Object.keys(value).map((key) => `${key}: ${formatValue(value[key])}`).join(', ')}}`
}

/** e.g. `placeBadge(0, 0, 1, null, 0)`; trailing undefined arguments are dropped. */
export function formatCall(name: string, args: Value[]): string {
  let length = args.length
  while (length > 0 && args[length - 1] === undefined) length -= 1
  return `${name}(${args.slice(0, length).map(formatValue).join(', ')})`
}
