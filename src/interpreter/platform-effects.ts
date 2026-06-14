import type {DefaultLibraryOwner} from './call-targets.ts'

export type PlatformValueSource =
  | {kind: 'receiver'}
  | {kind: 'receiver-elements'}
  | {kind: 'argument'; index: number}

export type PlatformCallbackEffect = {
  argumentIndex: number
  thisSource: PlatformValueSource | null
  parameterSources: readonly (readonly PlatformValueSource[])[]
}

export type PlatformCallEffect = {
  mutatesReceiver: boolean
  mutatesArgumentIndexes: readonly number[]
  retainsArgumentIndexes: 'none' | 'all' | 'from-2' | readonly number[]
  callbacks: readonly PlatformCallbackEffect[]
  observesEnvironment: boolean
}

export type PlatformCallClassification =
  | {kind: 'supported'; effect: PlatformCallEffect}
  | {kind: 'unsupported'; reason: string}
  | {kind: 'unrecognized'}

const noPlatformEffects: PlatformCallEffect = {
  mutatesReceiver: false,
  mutatesArgumentIndexes: [],
  retainsArgumentIndexes: 'none',
  callbacks: [],
  observesEnvironment: false,
}

const arrayCallback = (argumentIndex: number, thisArgumentIndex: number | null): PlatformCallbackEffect => ({
  argumentIndex,
  thisSource: thisArgumentIndex == null ? null : {kind: 'argument', index: thisArgumentIndex},
  parameterSources: [
    [{kind: 'receiver-elements'}],
    [],
    [{kind: 'receiver'}],
  ],
})

const reduceCallback = (argumentIndex: number): PlatformCallbackEffect => ({
  argumentIndex,
  thisSource: null,
  parameterSources: [
    [{kind: 'receiver-elements'}, {kind: 'argument', index: 1}],
    [{kind: 'receiver-elements'}],
    [],
    [{kind: 'receiver'}],
  ],
})

const comparatorCallback = (argumentIndex: number): PlatformCallbackEffect => ({
  argumentIndex,
  thisSource: null,
  parameterSources: [
    [{kind: 'receiver-elements'}],
    [{kind: 'receiver-elements'}],
  ],
})

const arrayMethodEffects = new Map<string, PlatformCallEffect>([
  ['at', noPlatformEffects],
  ['slice', noPlatformEffects],
  ['indexOf', noPlatformEffects],
  ['lastIndexOf', noPlatformEffects],
  ['includes', noPlatformEffects],
  ['keys', noPlatformEffects],
  ['values', noPlatformEffects],
  ['entries', noPlatformEffects],
  ['flat', noPlatformEffects],
  ['toReversed', noPlatformEffects],
  ['toSpliced', noPlatformEffects],
  ['with', noPlatformEffects],
  ['map', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['filter', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['every', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['some', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['forEach', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['find', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['findIndex', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['findLast', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['findLastIndex', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['flatMap', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['reduce', {...noPlatformEffects, callbacks: [reduceCallback(0)]}],
  ['reduceRight', {...noPlatformEffects, callbacks: [reduceCallback(0)]}],
  ['toSorted', {...noPlatformEffects, callbacks: [comparatorCallback(0)]}],
  ['push', {...noPlatformEffects, mutatesReceiver: true, retainsArgumentIndexes: 'all'}],
  ['unshift', {...noPlatformEffects, mutatesReceiver: true, retainsArgumentIndexes: 'all'}],
  ['splice', {...noPlatformEffects, mutatesReceiver: true, retainsArgumentIndexes: 'from-2'}],
  ['fill', {...noPlatformEffects, mutatesReceiver: true, retainsArgumentIndexes: [0]}],
  ['pop', {...noPlatformEffects, mutatesReceiver: true}],
  ['shift', {...noPlatformEffects, mutatesReceiver: true}],
  ['reverse', {...noPlatformEffects, mutatesReceiver: true}],
  ['sort', {...noPlatformEffects, mutatesReceiver: true, callbacks: [comparatorCallback(0)]}],
  ['copyWithin', {...noPlatformEffects, mutatesReceiver: true}],
])

const readonlyArrayMethodEffects = new Map(
  [...arrayMethodEffects].filter(([, effect]) => !effect.mutatesReceiver),
)

const mapMethodEffects = new Map<string, PlatformCallEffect>([
  ['get', noPlatformEffects],
  ['has', noPlatformEffects],
  ['keys', noPlatformEffects],
  ['values', noPlatformEffects],
  ['entries', noPlatformEffects],
  ['set', {...noPlatformEffects, mutatesReceiver: true, retainsArgumentIndexes: [0, 1]}],
  ['delete', {...noPlatformEffects, mutatesReceiver: true}],
  ['clear', {...noPlatformEffects, mutatesReceiver: true}],
])
const readonlyMapMethodEffects = readonlyMethods(mapMethodEffects)

const setMethodEffects = new Map<string, PlatformCallEffect>([
  ['has', noPlatformEffects],
  ['keys', noPlatformEffects],
  ['values', noPlatformEffects],
  ['entries', noPlatformEffects],
  ['add', {...noPlatformEffects, mutatesReceiver: true, retainsArgumentIndexes: [0]}],
  ['delete', {...noPlatformEffects, mutatesReceiver: true}],
  ['clear', {...noPlatformEffects, mutatesReceiver: true}],
])
const readonlySetMethodEffects = readonlyMethods(setMethodEffects)

const stringMethodEffects = new Map<string, PlatformCallEffect>([
  ['slice', noPlatformEffects],
  ['indexOf', noPlatformEffects],
  ['lastIndexOf', noPlatformEffects],
  ['includes', noPlatformEffects],
  ['startsWith', noPlatformEffects],
  ['endsWith', noPlatformEffects],
  ['toString', noPlatformEffects],
])

const globalEffects = new Map<string, Map<string, PlatformCallEffect>>([
  ['Number', new Map([
    ['isFinite', noPlatformEffects],
    ['isInteger', noPlatformEffects],
    ['isNaN', noPlatformEffects],
    ['isSafeInteger', noPlatformEffects],
    ['parseFloat', noPlatformEffects],
    ['parseInt', noPlatformEffects],
  ])],
  ['console', new Map([['*', {...noPlatformEffects, observesEnvironment: true}]])],
  ['Date', new Map([
    ['now', {...noPlatformEffects, observesEnvironment: true}],
    ['UTC', noPlatformEffects],
  ])],
  ['performance', new Map([['now', {...noPlatformEffects, observesEnvironment: true}]])],
  ['Object', new Map([
    ['keys', noPlatformEffects],
    ['isFrozen', noPlatformEffects],
    ['getOwnPropertyNames', noPlatformEffects],
    ['freeze', {...noPlatformEffects, mutatesArgumentIndexes: [0]}],
  ])],
  ['Array', new Map([
    ['isArray', noPlatformEffects],
    ['of', noPlatformEffects],
  ])],
])

const unsupportedGlobalCallReasons = new Map<string, string>([
  ['Array.from', 'Array.from is unsupported because it can call an iterator or mapper supplied by user code'],
  ['JSON.parse', 'JSON.parse is unsupported because its result values are not modeled and its optional callback can run user code'],
  ['JSON.stringify', 'JSON.stringify is unsupported because it can run getters or toJSON methods'],
  ['Object.entries', 'Object.entries is unsupported because reading property values can run getters'],
  ['Object.values', 'Object.values is unsupported because reading property values can run getters'],
  ['Date.parse', "Date.parse is unsupported because some date strings depend on the machine's time zone or accepted formats"],
])

export function classifyPlatformMethodCall(
  owner: DefaultLibraryOwner,
  name: string,
  argumentCount: number,
): PlatformCallClassification {
  if ((owner === 'Array' || owner === 'ReadonlyArray') && (name === 'sort' || name === 'toSorted') && argumentCount === 0) {
    return {
      kind: 'unsupported',
      reason: `Array.${name} without a comparator is unsupported because default sorting converts elements to strings and can run user code`,
    }
  }
  const effects = switchMethodEffects(owner)
  const effect = effects?.get(name) ?? null
  return effect == null ? {kind: 'unrecognized'} : {kind: 'supported', effect}
}

export function isPlatformGlobalNamespace(name: string): boolean {
  return platformGlobalNamespaces.has(name)
}

export function classifyPlatformGlobalCall(
  base: string,
  member: string,
  _argumentCount: number,
): PlatformCallClassification {
  if (base === 'Math') {
    return {
      kind: 'supported',
      effect: member === 'random'
        ? {...noPlatformEffects, observesEnvironment: true}
        : noPlatformEffects,
    }
  }
  const members = globalEffects.get(base)
  const effect = members?.get(member) ?? members?.get('*')
  if (effect != null) return {kind: 'supported', effect}
  const reason = unsupportedGlobalCallReasons.get(`${base}.${member}`)
  return reason == null ? {kind: 'unrecognized'} : {kind: 'unsupported', reason}
}

export function retainedArgumentIndexes(
  effect: PlatformCallEffect,
  argumentCount: number,
): number[] {
  if (effect.retainsArgumentIndexes === 'none') return []
  if (effect.retainsArgumentIndexes === 'all') {
    return Array.from({length: argumentCount}, (_, index) => index)
  }
  if (effect.retainsArgumentIndexes === 'from-2') {
    return Array.from({length: Math.max(0, argumentCount - 2)}, (_, index) => index + 2)
  }
  return [...effect.retainsArgumentIndexes]
}

function switchMethodEffects(owner: DefaultLibraryOwner): Map<string, PlatformCallEffect> | null {
  switch (owner) {
    case 'Array':
      return arrayMethodEffects
    case 'ReadonlyArray':
      return readonlyArrayMethodEffects
    case 'Map':
      return mapMethodEffects
    case 'ReadonlyMap':
      return readonlyMapMethodEffects
    case 'Set':
      return setMethodEffects
    case 'ReadonlySet':
      return readonlySetMethodEffects
    case 'String':
      return stringMethodEffects
    case 'TypedArray':
    case 'Other':
      return null
  }
}

function readonlyMethods(effects: Map<string, PlatformCallEffect>) {
  return new Map([...effects].filter(([, effect]) => !effect.mutatesReceiver))
}

const platformGlobalNamespaces = new Set([
  'Array',
  'Boolean',
  'Date',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Set',
  'String',
  'WeakMap',
  'WeakSet',
  'console',
  'performance',
])
