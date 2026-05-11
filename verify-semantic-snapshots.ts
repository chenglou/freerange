import {verifyFitSource} from './src/reports.ts'
import {verifySnapshot} from './snapshot.ts'

const checks = verifyFitSource('semantic-snapshot.ts', `/** @fit
 * given value: 1..1
 * return: 1
 */
function helper(value: number) {
  return value
}

/** @fit
 * return: 1
 */
function caller() {
  const x = helper(1) // @fit 1
  return x
}

/** @fit
 * given value: 0..100
 * given max: 0..100
 * return <= max
 */
function capped(value: number, max: number) {
  return Math.min(value, max)
}
`)

const lines: string[] = []

for (const check of checks) {
  if (check.obligation == null || check.trace == null) continue
  lines.push(`${check.status.toUpperCase()} ${check.functionName}: ${check.text}`)
  lines.push(`  obligation: ${check.obligation.boundary} ${goalText(check.obligation.goal)}`)
  for (const step of check.trace.steps) {
    lines.push(`  step: ${step.domain}.${step.rule} - ${step.message}`)
  }
  if (check.trace.usedFacts.length > 0) {
    lines.push('  facts:')
    for (const fact of check.trace.usedFacts) lines.push(`    ${fact}`)
  }
}

if (!await verifySnapshot('semantic-snapshots.expected.txt', lines.join('\n'), 'semantic snapshots')) process.exitCode = 1

type SemanticGoal = NonNullable<typeof checks[number]['obligation']>['goal']

function goalText(goal: SemanticGoal) {
  switch (goal.kind) {
    case 'range':
      return `range ${goal.target} in ${goal.range}`
    case 'comparison':
      return `comparison ${goal.left} ${goal.op} ${goal.right}`
    case 'atom':
      return `atom ${goal.name}(${goal.args.join(', ')})`
    case 'call-precondition':
      return `call-precondition ${goal.requirement}`
    case 'audit':
      return `audit ${goal.text}`
  }
}
