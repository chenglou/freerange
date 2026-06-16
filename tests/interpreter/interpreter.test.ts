import {readTopLevelGlobal} from '../../src/check-core.ts'
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
} else {
  console.log('interpreter: frames copy state and share output and policy')
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
} else {
  console.log('interpreter: analysis frames isolate output')
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
} else {
  console.log('interpreter: assignment effects follow TypeScript bindings')
}

})
