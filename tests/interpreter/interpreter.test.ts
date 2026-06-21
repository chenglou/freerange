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
import {frameForStateCase} from '../../src/interpreter/state-cases.ts'
import {buildFitSourceFile} from '../../src/modules.ts'
import {valueAtTypeNodeBoundary} from '../../src/type-boundaries.ts'
import {testSuite} from '../test-suite.ts'

testSuite('interpreter suite', async suite => {
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
  console.error('interpreter frames should copy state and preserve shared output and policy')
  suite.fail()
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
  console.error('interpreter analysis frames should isolate findings and may clear scoped paths')
  suite.fail()
}

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
  console.error('type fallback should use tagged missing values, including through unions')
  console.error({unsupportedUnion, unsupportedPlain, missingUnion})
  suite.fail()
}

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
  console.error('interpreter effects should distinguish block locals from same-named module bindings')
  console.error(shadowResult.output.effects)
  suite.fail()
}

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
  console.error('expected lexical bindings to win over same-spelled blocks and globals')
  console.error(Object.fromEntries(lexicalResults))
  console.error({globalUndefined, dollarMutation, uninitializedFunctionScopedVar, newUninitializedFunctionScopedVar})
  suite.fail()
}

})
