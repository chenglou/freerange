import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import type {DefaultLibraryOwner} from './call-targets.ts'
import {callExpressionsForPosition} from './call-arguments.ts'
import {unwrapExpression} from './source-syntax.ts'

export type PlatformValueSource =
  | {kind: 'receiver'}
  | {kind: 'receiver-elements'}
  | {kind: 'argument'; index: number}

export type PlatformResultEffect =
  | {kind: 'none'}
  | {kind: 'fresh'}
  | {kind: 'receiver'}
  | {kind: 'argument'; index: number}
  | {kind: 'unknown'; reason: string}

export type PlatformCallbackEffect = {
  argumentIndex: number
  thisArgumentIndex: number | null
  parameterSources: readonly (readonly PlatformValueSource[])[]
}

export type PlatformCallEffect = {
  mutatesReceiver: boolean
  mutatesArgumentIndexes: readonly number[]
  retainedParameters: readonly {index: number; rest: boolean}[]
  callbacks: readonly PlatformCallbackEffect[]
  observesEnvironment: boolean
  result: PlatformResultEffect
}

export type PlatformCallClassification =
  | {kind: 'supported'; effect: PlatformCallEffect}
  | {kind: 'unsupported'; reason: string; throws?: true}
  | {kind: 'unrecognized'}

const noResult: PlatformResultEffect = {kind: 'none'}
const freshResult: PlatformResultEffect = {kind: 'fresh'}
const receiverResult: PlatformResultEffect = {kind: 'receiver'}

const noPlatformEffects: PlatformCallEffect = {
  mutatesReceiver: false,
  mutatesArgumentIndexes: [],
  retainedParameters: [],
  callbacks: [],
  observesEnvironment: false,
  result: noResult,
}

const arrayCallback = (argumentIndex: number, thisArgumentIndex: number | null): PlatformCallbackEffect => ({
  argumentIndex,
  thisArgumentIndex,
  parameterSources: [
    [{kind: 'receiver-elements'}],
    [],
    [{kind: 'receiver'}],
  ],
})

const comparatorCallback = (argumentIndex: number): PlatformCallbackEffect => ({
  argumentIndex,
  thisArgumentIndex: null,
  parameterSources: [
    [{kind: 'receiver-elements'}],
    [{kind: 'receiver-elements'}],
  ],
})

const arrayMethodEffects = new Map<string, PlatformCallEffect>([
  ['at', {...noPlatformEffects, result: {kind: 'unknown', reason: 'Array.at can expose a stored element directly'}}],
  ['slice', {...noPlatformEffects, result: freshResult}],
  ['indexOf', noPlatformEffects],
  ['lastIndexOf', noPlatformEffects],
  ['includes', noPlatformEffects],
  ['keys', {...noPlatformEffects, result: freshResult}],
  ['toReversed', {...noPlatformEffects, result: freshResult}],
  ['toSpliced', {...noPlatformEffects, retainedParameters: [{index: 2, rest: true}], result: freshResult}],
  ['with', {...noPlatformEffects, retainedParameters: [{index: 1, rest: false}], result: freshResult}],
  ['map', {
    ...noPlatformEffects,
    callbacks: [arrayCallback(0, 1)],
    result: freshResult,
  }],
  ['filter', {
    ...noPlatformEffects,
    callbacks: [arrayCallback(0, 1)],
    result: freshResult,
  }],
  ['every', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['some', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['forEach', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['find', {
    ...noPlatformEffects,
    callbacks: [arrayCallback(0, 1)],
    result: {kind: 'unknown', reason: 'Array.find can expose a stored element directly'},
  }],
  ['findIndex', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['findLast', {
    ...noPlatformEffects,
    callbacks: [arrayCallback(0, 1)],
    result: {kind: 'unknown', reason: 'Array.findLast can expose a stored element directly'},
  }],
  ['findLastIndex', {...noPlatformEffects, callbacks: [arrayCallback(0, 1)]}],
  ['toSorted', {
    ...noPlatformEffects,
    callbacks: [comparatorCallback(0)],
    result: freshResult,
  }],
  ['push', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    retainedParameters: [{index: 0, rest: true}],
  }],
  ['unshift', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    retainedParameters: [{index: 0, rest: true}],
  }],
  ['splice', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    retainedParameters: [{index: 2, rest: true}],
    result: freshResult,
  }],
  ['fill', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    retainedParameters: [{index: 0, rest: false}],
    result: receiverResult,
  }],
  ['pop', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    result: {kind: 'unknown', reason: 'Array.pop can expose a stored element directly'},
  }],
  ['shift', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    result: {kind: 'unknown', reason: 'Array.shift can expose a stored element directly'},
  }],
  ['reverse', {...noPlatformEffects, mutatesReceiver: true, result: receiverResult}],
  ['sort', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    callbacks: [comparatorCallback(0)],
    result: receiverResult,
  }],
  ['copyWithin', {...noPlatformEffects, mutatesReceiver: true, result: receiverResult}],
])

const readonlyArrayMethodEffects = new Map(
  [...arrayMethodEffects].filter(([, effect]) => !effect.mutatesReceiver),
)

const mapMethodEffects = new Map<string, PlatformCallEffect>([
  ['get', {...noPlatformEffects, result: {kind: 'unknown', reason: 'Map.get can expose a stored value directly'}}],
  ['has', noPlatformEffects],
  ['keys', {...noPlatformEffects, result: freshResult}],
  ['values', {...noPlatformEffects, result: freshResult}],
  ['entries', {...noPlatformEffects, result: freshResult}],
  ['set', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    retainedParameters: [{index: 0, rest: false}, {index: 1, rest: false}],
    result: receiverResult,
  }],
  ['delete', {...noPlatformEffects, mutatesReceiver: true}],
  ['clear', {...noPlatformEffects, mutatesReceiver: true}],
])
const readonlyMapMethodEffects = readonlyMethods(mapMethodEffects)

const setMethodEffects = new Map<string, PlatformCallEffect>([
  ['has', noPlatformEffects],
  ['keys', {...noPlatformEffects, result: freshResult}],
  ['values', {...noPlatformEffects, result: freshResult}],
  ['entries', {...noPlatformEffects, result: freshResult}],
  ['add', {
    ...noPlatformEffects,
    mutatesReceiver: true,
    retainedParameters: [{index: 0, rest: false}],
    result: receiverResult,
  }],
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
  ['console', new Map([['*', {
    ...noPlatformEffects,
    observesEnvironment: true,
  }]])],
  ['Date', new Map([
    ['now', {...noPlatformEffects, observesEnvironment: true}],
    ['UTC', noPlatformEffects],
  ])],
  ['performance', new Map([['now', {
    ...noPlatformEffects,
    observesEnvironment: true,
  }]])],
  ['Object', new Map([
    ['keys', {...noPlatformEffects, result: freshResult}],
    ['isFrozen', noPlatformEffects],
    ['getOwnPropertyNames', {...noPlatformEffects, result: freshResult}],
  ])],
  ['Array', new Map([
    ['isArray', noPlatformEffects],
    ['of', {...noPlatformEffects, retainedParameters: [{index: 0, rest: true}], result: freshResult}],
  ])],
])

const unsupportedGlobalCalls = new Map<string, {reason: string; throws?: true}>([
  ['Array.from', {reason: 'Array.from is unsupported because it can call an iterator or mapper supplied by user code'}],
  ['JSON.parse', {
    reason: 'JSON.parse is unsupported because its result values are not modeled and its optional callback can run user code',
    throws: true,
  }],
  ['JSON.stringify', {reason: 'JSON.stringify is unsupported because it can run getters or toJSON methods'}],
  ['Object.entries', {reason: 'Object.entries is unsupported because reading property values can run getters'}],
  ['Object.values', {reason: 'Object.values is unsupported because reading property values can run getters'}],
  ['Object.freeze', {reason: 'Object.freeze is unsupported because freezing some built-in objects can throw'}],
  ['Date.parse', {reason: "Date.parse is unsupported because some date strings depend on the machine's time zone or accepted formats"}],
])

export function classifyPlatformMethodCall(
  owner: DefaultLibraryOwner,
  name: string,
  arguments_: readonly ts.Expression[],
  program: Program,
): PlatformCallClassification {
  if ((owner === 'Array' || owner === 'ReadonlyArray') && name === 'concat') {
    return {
      kind: 'unsupported',
      reason: 'Array.concat is unsupported because it can read Symbol.isConcatSpreadable or indexed getters',
    }
  }
  if ((owner === 'Array' || owner === 'ReadonlyArray') && (name === 'flat' || name === 'flatMap')) {
    return {
      kind: 'unsupported',
      reason: `Array.${name} is unsupported because flattening can read indexed getters`,
    }
  }
  if ((owner === 'Array' || owner === 'ReadonlyArray') && (name === 'entries' || name === 'values')) {
    return {
      kind: 'unsupported',
      reason: `Array.${name} is unsupported because iterating the result can read indexed getters`,
    }
  }
  if ((owner === 'Array' || owner === 'ReadonlyArray') && (name === 'reduce' || name === 'reduceRight')) {
    return {
      kind: 'unsupported',
      reason: `Array.${name} is unsupported because each callback result becomes the next callback input`,
    }
  }
  if (
    (owner === 'Array' || owner === 'ReadonlyArray')
    && (name === 'sort' || name === 'toSorted')
    && usesDefaultSort(arguments_, program)
  ) {
    return {
      kind: 'unsupported',
      reason: `Array.${name} without a comparator is unsupported because default sorting converts elements to strings and can run user code`,
    }
  }
  const effects = switchMethodEffects(owner)
  const effect = effects?.get(name) ?? null
  return effect == null ? {kind: 'unrecognized'} : {kind: 'supported', effect}
}

function usesDefaultSort(arguments_: readonly ts.Expression[], program: Program) {
  const mapped = callExpressionsForPosition(arguments_, 0)
  if (mapped.inexactSpread) return true
  const comparator = mapped.expressions[0]
  if (comparator == null) return true
  const current = unwrapExpression(comparator)
  if (ts.isVoidExpression(current)) return true
  const checker = program.typeChecker
  if (checker == null) return ts.isIdentifier(current) && current.text === 'undefined'
  try {
    return typeIncludesUndefined(checker.getTypeAtLocation(current))
  } catch {
    return true
  }
}

function typeIncludesUndefined(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(typeIncludesUndefined)
  return (type.flags & ts.TypeFlags.Undefined) !== 0
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
  const unsupported = unsupportedGlobalCalls.get(`${base}.${member}`)
  return unsupported == null ? {kind: 'unrecognized'} : {kind: 'unsupported', ...unsupported}
}

export function retainedArgumentIndexes(
  effect: PlatformCallEffect,
  argumentCount: number,
): number[] {
  const indexes: number[] = []
  for (const position of effect.retainedParameters) {
    const end = position.rest ? argumentCount : Math.min(argumentCount, position.index + 1)
    for (let index = position.index; index < end; index++) indexes.push(index)
  }
  return indexes
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
