export const meta = {
  name: 'review-round',
  description: 'One adversarial review round over a commit: N finder lenses, optional per-finding verification',
  whenToUse: 'After landing feature or soundness-bearing work. args: {commit, context, lenses: [{key, prompt}], verify?: boolean}. Repeat with fresh lenses until a round returns zero confirmed findings.',
  phases: [
    { title: 'Attack', detail: 'one agent per lens' },
    { title: 'Verify', detail: 'adversarial re-check of each finding (when verify is set)' },
  ],
}

// The standing disciplines, learned the hard way:
// - A died agent returns null, and `?? []` would launder that into a clean round — a
//   review process whose failure mode is indistinguishable from success. Every lens
//   returns probesRun so an empty findings list proves a sweep happened, and null
//   agents surface as AGENT-DIED instead of green.
// - Findings need reproduced runtime contradictions or crashes; assumes lines are taken
//   on faith, and honest stops and imprecision are not findings. The shared preamble
//   states this so lenses do not drift into hunting exotic spellings.

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'probesRun'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'claim', 'probe', 'observed'],
        properties: {
          title: {type: 'string'},
          severity: {type: 'string', enum: ['unsound', 'crash', 'wrongProse', 'realisticGap']},
          claim: {type: 'string'},
          probe: {type: 'string'},
          observed: {type: 'string'},
        },
      },
    },
    probesRun: {type: 'number', description: 'probe files actually run — distinguishes an empty sweep from an aborted one'},
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reasoning'],
  properties: {isReal: {type: 'boolean'}, reasoning: {type: 'string'}},
}

const PREAMBLE = [
  'Repo: the current Freerange checkout — TypeScript static analyzer publishing',
  'per-function contracts. assumes lines are taken on faith: a claim is unsound only if',
  'falsifiable at runtime while EVERY printed assumes line holds. Honest stops and',
  'imprecision are not findings; findings need a reproduced runtime contradiction or an',
  'analyzer crash on diagnostic-clean TypeScript. Run: bun fr.ts <file.ts> (repo-internal',
  'imports need the survey harness: bun survey.ts <repo> <outdir>). Write probes under',
  'the scratchpad probes directory printed by your environment, or /tmp if none. Do NOT',
  'edit source or tests. Regression floor: bun test must pass before you attribute a',
  'failure to the commit under review.',
].join('\n')

// The harness can deliver args as a JSON string (observed when the skill invocation
// round-trips through a resume); accept both forms.
const roundArgs = typeof args === 'string' ? JSON.parse(args) : args
if (roundArgs == null || roundArgs.commit == null || roundArgs.lenses == null) {
  throw new Error('review-round needs args {commit, context, lenses: [{key, prompt}]}')
}

const header = `${PREAMBLE}\n\nUnder review: commit ${roundArgs.commit} (git show ${roundArgs.commit}).\n${roundArgs.context ?? ''}\n`

phase('Attack')
const attacks = await parallel(roundArgs.lenses.map(lens => () =>
  agent(`${header}\nLens: ${lens.prompt}\nCap 4 findings; return probesRun. An empty list with a real probesRun count is a fine answer.`,
    {label: `find:${lens.key}`, phase: 'Attack', schema: FINDINGS_SCHEMA, effort: 'high'})))

const dead = attacks.filter(found => found == null).length
const raw = []
for (let index = 0; index < attacks.length; index++) {
  const found = attacks[index]
  if (found == null) continue
  for (const finding of found.findings) raw.push({...finding, lens: roundArgs.lenses[index].key})
}
log(`${raw.length} raw findings, ${dead} dead lens agents, probes: ${attacks.filter(Boolean).map(found => found.probesRun).join('+')}`)

if (roundArgs.verify === false || raw.length === 0) {
  return {verdict: dead > 0 ? 'INCOMPLETE-DEAD-LENSES' : 'completed', deadLenses: dead, confirmed: raw, refuted: []}
}

phase('Verify')
const verdicts = await parallel(raw.map(finding => () =>
  agent(`${header}\nAdversarially verify this finding from lens "${finding.lens}". Default to refuted unless the probe reproduces AND the contradiction is real under the assumes-on-faith rule.\nFinding: ${JSON.stringify(finding)}\nReturn {isReal, reasoning}.`,
    {label: `verify:${finding.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high'})
    .then(verdict => ({...finding, verdict}))))

const checked = verdicts.filter(Boolean)
const confirmed = checked.filter(finding => finding.verdict.isReal)
const deadVerifiers = verdicts.length - checked.length
log(`${confirmed.length} confirmed, ${checked.length - confirmed.length} refuted, ${deadVerifiers} dead verifiers`)
return {
  verdict: dead + deadVerifiers > 0 ? 'INCOMPLETE-DEAD-LENSES' : 'completed',
  deadLenses: dead + deadVerifiers,
  confirmed,
  refuted: checked.filter(finding => !finding.verdict.isReal).map(finding => finding.title),
}
