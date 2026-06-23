import {describe, setDefaultTimeout, test} from 'bun:test'
import * as ts from 'typescript'
import {readTopLevelGlobal} from '../../src/check-core.ts'
import {unknown, unknownNotInferred} from '../../src/domain.ts'
import {
  deriveFrame,
  emptyInterpreterOutput,
  frameWithActiveCall,
  interpreterPolicy,
  rootFrame,
} from '../../src/interpreter/context.ts'
import {evaluateInterpreterFunction} from '../../src/interpreter/evaluate.ts'
import {callTargetImplementation, resolveCallTarget} from '../../src/interpreter/call-targets.ts'
import {expressionIsRepeatable} from '../../src/interpreter/expression-effects.ts'
import {frameForStateCase} from '../../src/interpreter/state-cases.ts'
import {buildFitSourceFile, loadFitProject} from '../../src/modules.ts'
import {valueAtTypeNodeBoundary} from '../../src/type-boundaries.ts'
import {testDiagnosticError} from '../test-diagnostics.ts'

setDefaultTimeout(300_000)

describe('interpreter', () => {
test('copies frame state while sharing policy and isolates analysis output', () => {
const frameProgram = buildFitSourceFile('frame-policy.ts', 'function f() { return 1 }', readTopLevelGlobal)
const policy = interpreterPolicy({}, 'suppress')
const root = rootFrame({
  program: frameProgram,
  env: new Map(),
  stack: ['f'],
  assumptions: [],
}, policy)
root.stateCases = [{
  env: new Map([['branch', {kind: 'unknown', reason: 'branch'}]]),
  assumptions: [],
  branches: [],
  caseAssumptions: [],
  changedRoots: new Set(),
  separateBranches: false,
}]
const child = deriveFrame(root, {env: new Map(root.env), stateCases: null})
const stateCase = frameForStateCase(child, {
  env: new Map(child.env),
  assumptions: [],
  branches: [],
  caseAssumptions: [],
  changedRoots: new Set(),
  separateBranches: false,
})
const activeCall = frameWithActiveCall(root, 'frame-policy.ts#f')
if (
  child.output !== root.output
  || child.policy !== policy
  || stateCase.output !== root.output
  || stateCase.policy !== policy
  || stateCase.policy.checkRecording !== 'suppress'
  || child.env === root.env
  || child.stack === root.stack
  || child.activeCalls === root.activeCalls
  || child.loopStack === root.loopStack
  || child.assumptions === root.assumptions
  || child.stateCases != null
  || activeCall.stateCases !== root.stateCases
) {
  throw testDiagnosticError('interpreter frames should copy state and preserve shared output and policy', {
    sharesOutput: child.output === root.output,
    sharesPolicy: child.policy === policy,
    stateCaseSharesOutput: stateCase.output === root.output,
    stateCaseSharesPolicy: stateCase.policy === policy,
    checkRecording: stateCase.policy.checkRecording,
    sharesEnv: child.env === root.env,
    sharesStack: child.stack === root.stack,
    sharesActiveCalls: child.activeCalls === root.activeCalls,
    sharesLoopStack: child.loopStack === root.loopStack,
    sharesAssumptions: child.assumptions === root.assumptions,
    childStateCases: child.stateCases,
    activeCallSharesStateCases: activeCall.stateCases === root.stateCases,
  })
}

const isolatedOutput = emptyInterpreterOutput()
const isolated = deriveFrame(root, {
  env: new Map(root.env),
  stateCases: null,
  output: isolatedOutput,
  policy: interpreterPolicy(undefined, 'suppress'),
  objectPath: null,
})
isolated.output.issues.push({kind: 'unsupported', message: 'isolated', stack: []})
if (
  root.output.issues.length !== 0
  || isolated.output === root.output
  || isolated.objectPath != null
) {
  throw testDiagnosticError('interpreter analysis frames should isolate findings and may clear scoped paths', {
    rootIssues: root.output.issues,
    isolatedIssues: isolated.output.issues,
    sharesOutput: isolated.output === root.output,
    objectPath: isolated.objectPath,
  })
}
})

test('uses tagged missing values for type fallback', () => {
const fallbackProgram = buildFitSourceFile('tagged-type-fallback.ts', `
let union: number | undefined
let plain: number
`, readTopLevelGlobal)
const fallbackDeclarations = fallbackProgram.sourceFile.statements
  .filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
const unionDeclaration = fallbackDeclarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'union')!
const plainDeclaration = fallbackDeclarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'plain')!
const unsupportedUnion = valueAtTypeNodeBoundary(unknown('unsupported operation'), 'union', unionDeclaration.type, unionDeclaration.name, fallbackProgram)
const unsupportedPlain = valueAtTypeNodeBoundary(unknown('unsupported operation'), 'plain', plainDeclaration.type, plainDeclaration.name, fallbackProgram)
const missingUnion = valueAtTypeNodeBoundary(unknownNotInferred('union was not inferred'), 'union', unionDeclaration.type, unionDeclaration.name, fallbackProgram)
if (
  unsupportedUnion.kind !== 'unknown'
  || unsupportedPlain.kind !== 'unknown'
  || missingUnion.kind !== 'nullable'
) {
  throw testDiagnosticError('type fallback should use tagged missing values, including through unions', {
    unsupportedUnion,
    unsupportedPlain,
    missingUnion,
  })
}
})

test('distinguishes block locals from same-named module bindings in effects', () => {
const shadowProgram = buildFitSourceFile('effect-shadow.ts', `
let total = 0

function f() {
  {
    let total = 0
    total = 1
  }
  total = 2
  return total
}
`, readTopLevelGlobal)
const shadowResult = evaluateInterpreterFunction({program: shadowProgram, functionName: 'f'})
if (
  shadowResult.output.effects.length !== 1
  || shadowResult.output.effects[0]?.message.includes('total = 2') !== true
) {
  throw testDiagnosticError('interpreter effects should distinguish block locals from same-named module bindings', shadowResult.output.effects)
}
})

test('resolves lexical bindings before same-spelled blocks and globals', () => {
const lexicalIdentityProgram = buildFitSourceFile('lexical-identity.ts', `
function blockShadow() {
  const value = 5
  {
    const value = 1
    void value
  }
  return value
}

function functionScopedVar() {
  var value = 1
  {
    var value = 2
  }
  return value
}

function uninitializedFunctionScopedVar(value: number) {
  {
    var value: number
  }
  return value
}

function newUninitializedFunctionScopedVar() {
  var value: number | undefined
  return value
}

function numericObjectWrite() {
  const input: {0: number, 1.5: number} = {0: 1, 1.5: 2}
  input[0] = 5
  input[1.5] = 6
  return input[0] + input[1.5]
}

function shadowInfinity() {
  const Infinity = 1
  return Infinity
}

function shadowUndefined() {
  const undefined = 2
  return undefined
}

function shadowNaN() {
  const NaN = 3
  return NaN
}

function globalUndefined() {
  return undefined
}

function grow($box: {size: number}) {
  $box.size = 100
}

function dollarMutation() {
  const $box = {size: 1}
  const before = $box.size
  grow($box)
  const after = $box.size
  return before - after
}
`, readTopLevelGlobal)
const lexicalResults = new Map<string, ReturnType<typeof evaluateInterpreterFunction>>()
const exactResult = (name: string, expected: number) => {
  const result = evaluateInterpreterFunction({program: lexicalIdentityProgram, functionName: name})
  lexicalResults.set(name, result)
  const value = result.value
  return value.kind === 'number' && value.min === expected && value.max === expected
}
const globalUndefined = evaluateInterpreterFunction({program: lexicalIdentityProgram, functionName: 'globalUndefined'}).value
const dollarMutation = evaluateInterpreterFunction({program: lexicalIdentityProgram, functionName: 'dollarMutation'}).value
const uninitializedFunctionScopedVar = evaluateInterpreterFunction({program: lexicalIdentityProgram, functionName: 'uninitializedFunctionScopedVar'}).value
const newUninitializedFunctionScopedVar = evaluateInterpreterFunction({program: lexicalIdentityProgram, functionName: 'newUninitializedFunctionScopedVar'}).value
if (
  !exactResult('blockShadow', 5)
  || !exactResult('functionScopedVar', 2)
  || uninitializedFunctionScopedVar.kind !== 'number'
  || uninitializedFunctionScopedVar.expr !== 'value'
  || newUninitializedFunctionScopedVar.kind !== 'null'
  || newUninitializedFunctionScopedVar.expr !== 'undefined'
  || !exactResult('numericObjectWrite', 11)
  || !exactResult('shadowInfinity', 1)
  || !exactResult('shadowUndefined', 2)
  || !exactResult('shadowNaN', 3)
  || (dollarMutation.kind === 'number' && dollarMutation.min === 0 && dollarMutation.max === 0)
  || globalUndefined.kind !== 'null'
  || globalUndefined.expr !== 'undefined'
) {
  throw testDiagnosticError('expected lexical bindings to win over same-spelled blocks and globals', {
    lexicalResults: Object.fromEntries(lexicalResults),
    globalUndefined,
    dollarMutation,
    uninitializedFunctionScopedVar,
    newUninitializedFunctionScopedVar,
  })
}
})

test('resolves only stable source function implementations', async () => {
const sourceProgram = buildFitSourceFile('function-targets.ts', `
function declaration() { return 1 }
function reassignedDeclaration() { return 10 }
;(reassignedDeclaration satisfies typeof reassignedDeclaration) = () => 20
async function asyncDeclaration() { return 0 }
const functionBinding = () => 2
const alias = functionBinding
let mutableBinding = () => 3
mutableBinding = () => 30
var mutableAlias = declaration
const holder = {declaration}
const functions = [declaration]
function makeFunction() { return declaration }
function callableEffects() { return (Math.random(), declaration)() }
class Counter { method() { return 1 } }

function inspect(condition: boolean, counter: Counter) {
  function nestedDeclaration() { return 4 }
  const nestedBinding = function () { return 5 }
  const nestedAlias = nestedDeclaration
  const targets = [
    declaration,
    functionBinding,
    alias,
    nestedDeclaration,
    nestedBinding,
    nestedAlias,
    () => 6,
    function () { return 7 },
    mutableBinding,
    mutableAlias,
    reassignedDeclaration,
    holder.declaration,
    functions[0]!,
    condition ? declaration : functionBinding,
    makeFunction(),
    Counter,
    counter.method,
    declaration.call,
    declaration.apply,
    declaration.bind,
    asyncDeclaration,
    async () => 8,
    function* () { yield 9 },
  ]
  return targets.length
}
`, readTopLevelGlobal)
const sourceTargets = namedArrayElements(sourceProgram.sourceFile, 'targets')
const sourceResults = sourceTargets.map(target =>
  callTargetImplementation(resolveCallTarget(target, sourceProgram)))
const resolvedTexts = sourceResults.map(result => result?.node.getText(result.program.sourceFile) ?? null)
const mutableCallTarget = resolveCallTarget(sourceTargets[8]!, sourceProgram)
const nestedCallTarget = resolveCallTarget(sourceTargets[3]!, sourceProgram)
const indexedCallTarget = resolveCallTarget(sourceTargets[1]!, sourceProgram)
const asyncCallTarget = resolveCallTarget(sourceTargets[20]!, sourceProgram)
const callableEffects = sourceProgram.functions.get('callableEffects')
const callableReturn = callableEffects != null && ts.isBlock(callableEffects.node.body)
  ? callableEffects.node.body.statements.find(ts.isReturnStatement)?.expression
  : null
if (
  sourceResults.slice(0, 8).some(result => result == null)
  || sourceResults.slice(8).some(result => result != null)
  || !sourceProgram.functions.has('mutableBinding')
  || sourceProgram.functions.has('mutableAlias')
  || !sourceProgram.functions.has('functionBinding')
  || !sourceProgram.functions.has('asyncDeclaration')
  || mutableCallTarget.kind !== 'unresolved'
  || nestedCallTarget.kind !== 'function'
  || nestedCallTarget.interpretation !== 'effects-only'
  || indexedCallTarget.kind !== 'function'
  || indexedCallTarget.interpretation !== 'interpreted'
  || asyncCallTarget.kind !== 'unresolved'
  || callableReturn == null
  || expressionIsRepeatable(callableReturn, sourceProgram)
) {
  throw testDiagnosticError('source function resolution should accept only stable declarations and const aliases', {
    targets: sourceTargets.map(target => target.getText(sourceProgram.sourceFile)),
    resolvedTexts,
    indexedFunctions: [...sourceProgram.functions.keys()],
    mutableCallTarget,
    nestedCallTarget,
    indexedCallTarget,
    asyncCallTarget,
  })
}

const fixtureDir = pathJoin('/tmp', `freerange-function-targets-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`)
const mkdir = Bun.spawnSync({cmd: ['mkdir', '-p', fixtureDir]})
if (mkdir.exitCode !== 0) throw new Error(`Could not create ${fixtureDir}`)
try {
  await Bun.write(pathJoin(fixtureDir, 'tsconfig.json'), JSON.stringify({compilerOptions: {
    strict: true,
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    allowImportingTsExtensions: true,
    noEmit: true,
  }}))
  await Bun.write(pathJoin(fixtureDir, 'helpers.ts'), `
export function original() { return 1 }
export const bound = () => 2
export const alias = original
export let mutable = () => 3
export default () => 4
`)
  await Bun.write(pathJoin(fixtureDir, 'barrel.ts'), `
export {default, default as defaultRenamed, original as renamed, bound, alias, mutable} from './helpers.ts'
`)
  const callerPath = pathJoin(fixtureDir, 'caller.ts')
  await Bun.write(callerPath, `
import defaultHelper, {defaultRenamed, renamed, bound, alias, mutable} from './barrel.ts'
import * as helpers from './barrel.ts'
const importedAlias = renamed
const targets = [renamed, bound, alias, importedAlias, helpers.renamed, defaultHelper, defaultRenamed, helpers.default, mutable]
`)
  const project = loadFitProject([callerPath], readTopLevelGlobal)
  const caller = project.entries[0]!
  const importedTargets = namedArrayElements(caller.sourceFile, 'targets')
  const importedResults = importedTargets.map(target =>
    callTargetImplementation(resolveCallTarget(target, caller)))
  if (
    importedResults.slice(0, 8).some(result => result == null || !result.program.file.endsWith('helpers.ts'))
    || importedResults[8] != null
    || importedResults.slice(0, 8).some(result => result!.node.getSourceFile() !== result!.program.sourceFile)
  ) {
    throw testDiagnosticError('imported function resolution should preserve the implementation source program', {
      targets: importedTargets.map(target => target.getText(caller.sourceFile)),
      results: importedResults.map(result => result == null ? null : {
        file: result.program.file,
        node: result.node.getText(result.program.sourceFile),
        ownsNode: result.node.getSourceFile() === result.program.sourceFile,
      }),
    })
  }
} finally {
  Bun.spawnSync({cmd: ['rm', '-rf', fixtureDir]})
}
})

})

function namedArrayElements(sourceFile: ts.SourceFile, name: string): ts.Expression[] {
  const pending: ts.Node[] = [sourceFile]
  while (pending.length > 0) {
    const node = pending.pop()!
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
      && node.initializer != null
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      return [...node.initializer.elements].filter(ts.isExpression)
    }
    ts.forEachChild(node, child => {
      pending.push(child)
    })
  }
  throw new Error(`expected array declaration ${name}`)
}

function pathJoin(first: string, ...rest: string[]) {
  let path = first.endsWith('/') ? first.slice(0, -1) : first
  for (const part of rest) path += '/' + part.replace(/^\/+/, '')
  return path
}
