// contract-writing-v1's child modes (contract-writing.ts; registered/contract-writing-v1.json `scores`), run through worker.ts:
//   cw-prepare  one copy: every supported entry on every lattice input, through the m7 run's instrumented original, which decides
//               the run's domain, then through the writer's patched file P. It counts the domain (4a), P's behaviour against the
//               original (4c), the firing rows of added sites (4d) and the inputs added leading asserts reject (4e), and writes
//               per entry which inputs a kill can use.
//   cw-mutant   one mapped mutant M of P: on those inputs P, then M, as worker.ts runMutant calls the original and the mutant.
//               Site s kills on an input when M reaches level >= 3 there and P stays below 3.
// A kill can use an input the run's original keeps in its domain, where P isn't discarded, doesn't pass the step budget, doesn't
// throw where the run's original returned, and raises none of the entry's added leading asserts to level >= 2.
import {readFileSync, writeFileSync} from 'node:fs'
import {isCallerDiscard} from './callers.ts'
import {callEntry, causeOf, emit, entryFunction, findCopy, findEntry, findMutant, firstFiring, installRecorder, loadModules, newDifference, recordDifference, same, supportedEntries} from './child-calls.ts'
import {decodeJson, encodeJson} from './encode.ts'
import {compileLattice, DIGEST_START, digestValue, inputAt} from './lattice.ts'
import {decodePlan} from './plan-file.ts'
import {createRecorder, resetRecorder} from './recorder.ts'
import {CAUSES, type ContractKill, type ContractPlan, type ContractRow, type Plan} from './types.ts'

// Per lattice index of an entry, in the eligibility file: outside the run's domain, usable by a kill, or in the domain but not
// usable by a kill.
const OUTSIDE = 0
const USABLE = 1
const NOT_USABLE = 2

// entry name to one status byte per lattice index, base64-encoded
type Eligibility = {copy: string; statuses: Record<string, string>}

export async function runContractPrepare(plan: Plan, contractPath: string, copyName: string, eligibilityPath: string) {
  const contract = decodeJson(readFileSync(contractPath, 'utf8')) as ContractPlan
  const runPlan = decodePlan(readFileSync(contract.runPlan, 'utf8'))
  const copy = findCopy(plan, copyName)
  const runCopy = findCopy(runPlan, copyName)
  const contractCopy = contract.copies.find((candidate) => candidate.copy === copyName)
  if (contractCopy == null) throw new Error(`no copy ${copyName} in ${contractPath}`)
  // Each tree keeps the recorder installed before its import (child-calls.ts installRecorder).
  const originalRecorder = createRecorder(runCopy.sites, runPlan.stepBudget)
  installRecorder(originalRecorder)
  const originals = await loadModules(runCopy.files, 'instrumented')
  const recorder = createRecorder(copy.sites, plan.stepBudget)
  installRecorder(recorder)
  const patched = await loadModules(copy.files, 'instrumented')
  const added = new Uint8Array(copy.sites.length)
  for (const site of contractCopy.addedSites) added[site] = 1
  const eligibility: Eligibility = {copy: copyName, statuses: {}}
  const budget = plan.settings.budget
  for (const entry of supportedEntries(copy)) {
    const entryStarted = performance.now()
    const runEntry = findEntry(runCopy, entry.name)
    const originalFn = entryFunction(originals, runEntry)
    const patchedFn = entryFunction(patched, entry)
    const lattice = compileLattice(entry, plan.settings)
    originalRecorder.setEntry(runEntry.discardSites)
    recorder.setEntry(entry.discardSites)
    const leading = new Uint8Array(copy.sites.length)
    for (const site of contractCopy.addedLeading.find((candidate) => candidate.entry === entry.name)?.sites ?? []) leading[site] = 1
    const leadingCounts = new Uint32Array(copy.sites.length)
    const status = new Uint8Array(budget).fill(OUTSIDE)
    const rows = new Array<ContractRow | null>(copy.sites.length * CAUSES.length).fill(null)
    const behavior = newDifference()
    const patchedOverBudget = newDifference()
    const patchedThrew = newDifference()
    let digest = DIGEST_START
    let discarded = 0
    let callerDiscarded = 0
    let overBudget = 0
    let inDomain = 0
    let usable = 0
    let addedLeadingRaised = 0
    let behaviorSkipped = 0
    for (let index = 0; index < budget; index++) {
      if ((index & 1023) === 0) emit({type: 'heartbeat', entry: entry.name, index})
      const input = inputAt(lattice, index)
      digest = digestValue(digest, input.args)
      if (isCallerDiscard(entry.callerRules, input.args)) {
        callerDiscarded += 1
        continue
      }
      resetRecorder(originalRecorder)
      const original = callEntry(originalFn, input.args)
      if (original.discarded) {
        discarded += 1
        continue
      }
      if (original.overBudget) {
        overBudget += 1
        continue
      }
      inDomain += 1
      resetRecorder(recorder)
      const outcome = callEntry(patchedFn, input.args)
      let addedRaised = false
      let leadingRaised = false
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = recorder.touched[touchedIndex]!
        if (recorder.levels[site]! < 2) continue
        if (added[site] === 1) addedRaised = true
        if (leading[site] === 1) {
          leadingRaised = true
          leadingCounts[site]! += 1
        }
      }
      if (leadingRaised) addedLeadingRaised += 1
      // 4c: inputs where an added site reaches level 2 are skipped; P past the step budget is counted apart, not as behaviour.
      if (addedRaised) {
        behaviorSkipped += 1
      } else if (outcome.discarded) {
        recordDifference(behavior, input, index, `the patched file discarded the input; the run's original ${original.thrown == null ? `returned ${encodeJson(original.value)}` : `threw ${original.thrown}`}`)
      } else if (!outcome.overBudget) {
        const differs = outcome.thrown != null || original.thrown != null ? (outcome.thrown == null) !== (original.thrown == null) : !same(original.value, outcome.value)
        if (differs) recordDifference(behavior, input, index, `original ${original.thrown ?? encodeJson(original.value)}; patched ${outcome.thrown ?? encodeJson(outcome.value)}`)
      }
      if (outcome.overBudget) recordDifference(patchedOverBudget, input, index, `the patched file passed the step budget of ${plan.stepBudget ?? Infinity} loop ticks where the run's original didn't`)
      if (outcome.thrown != null && original.thrown == null) recordDifference(patchedThrew, input, index, outcome.thrown)
      const canKill = !outcome.discarded && !outcome.overBudget && !(outcome.thrown != null && original.thrown == null) && !leadingRaised
      status[index] = canKill ? USABLE : NOT_USABLE
      if (canKill) usable += 1
      // 4d: firings of added sites other than the entry's added leading asserts, on inputs those leading asserts accept.
      if (leadingRaised || outcome.discarded || outcome.overBudget) continue
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = recorder.touched[touchedIndex]!
        if (added[site] !== 1 || leading[site] === 1 || recorder.levels[site]! < 3) continue
        const cause = causeOf(input.args, recorder.margins[site]!)
        const slot = site * CAUSES.length + CAUSES.indexOf(cause)
        const row = rows[slot] ?? null
        if (row == null) rows[slot] = {site, cause, count: 1, first: firstFiring(input, index, recorder.margins[site]!)}
        else row.count += 1
      }
    }
    eligibility.statuses[entry.name] = Buffer.from(status).toString('base64')
    const addedLeadingBySite: {site: number; count: number}[] = []
    leadingCounts.forEach((count, site) => {
      if (count > 0) addedLeadingBySite.push({site, count})
    })
    emit({
      type: 'cw-prepare', base: copy.copy, entry: entry.name, inputs: budget, digest, discarded, callerDiscarded, overBudget, inDomain, usable, addedLeadingRaised, addedLeadingBySite,
      behaviorSkipped, behavior, patchedOverBudget, patchedThrew, rows: rows.filter((row): row is ContractRow => row != null), ms: performance.now() - entryStarted,
    })
  }
  writeFileSync(eligibilityPath, JSON.stringify(eligibility))
}

export async function runContractMutant(plan: Plan, key: string, eligibilityPath: string) {
  const {mutant, copy} = findMutant(plan, key)
  const eligibility = decodeJson(readFileSync(eligibilityPath, 'utf8')) as Eligibility
  const recorder = createRecorder(copy.sites, plan.stepBudget)
  installRecorder(recorder)
  const patched = await loadModules(copy.files, 'instrumented')
  const mutants = await loadModules(mutant.files, 'instrumented')
  const patchedLevels = new Uint8Array(copy.sites.length)
  const budget = plan.settings.budget
  for (const entry of supportedEntries(copy)) {
    const entryStarted = performance.now()
    const patchedFn = entryFunction(patched, entry)
    const mutantFn = entryFunction(mutants, entry)
    const encoded = eligibility.statuses[entry.name]
    if (encoded == null) throw new Error(`${eligibilityPath} has no statuses for ${entry.name}`)
    const status = Buffer.from(encoded, 'base64')
    if (status.length !== budget) throw new Error(`${eligibilityPath}: ${entry.name} has ${status.length} statuses for a budget of ${budget}`)
    const lattice = compileLattice(entry, plan.settings)
    recorder.setEntry(entry.discardSites)
    const kills = new Array<ContractKill | null>(copy.sites.length).fill(null)
    const throws = newDifference()
    const behavior = newDifference()
    const mutantOverBudget = newDifference()
    let digest = DIGEST_START
    let usable = 0
    let eligibilityMismatches = 0
    let mutantOnlyDiscards = 0
    for (let index = 0; index < budget; index++) {
      if ((index & 1023) === 0) emit({type: 'heartbeat', entry: entry.name, index})
      const input = inputAt(lattice, index)
      digest = digestValue(digest, input.args)
      if (status[index] !== USABLE) continue
      usable += 1
      resetRecorder(recorder)
      const original = callEntry(patchedFn, input.args)
      // cw-prepare saw P return or throw here; anything else is nondeterminism between the two children.
      if (original.discarded || original.overBudget) {
        eligibilityMismatches += 1
        continue
      }
      patchedLevels.fill(0)
      let quietFile = true
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = recorder.touched[touchedIndex]!
        patchedLevels[site] = recorder.levels[site]!
        if (recorder.levels[site]! >= 3) quietFile = false
      }
      resetRecorder(recorder)
      const mutated = callEntry(mutantFn, input.args)
      if (mutated.discarded) {
        mutantOnlyDiscards += 1
        continue
      }
      if (mutated.overBudget) {
        recordDifference(mutantOverBudget, input, index, `the mutant passed the step budget of ${plan.stepBudget ?? Infinity} loop ticks where the patched file ${original.thrown == null ? 'returned' : 'threw'}`)
        continue
      }
      for (let touchedIndex = 0; touchedIndex < recorder.touchedCount; touchedIndex++) {
        const site = recorder.touched[touchedIndex]!
        if (recorder.levels[site]! < 3 || patchedLevels[site]! >= 3) continue
        const kill = kills[site] ?? null
        if (kill == null) {
          kills[site] = {site, count: 1, quietFileCount: quietFile ? 1 : 0, first: firstFiring(input, index, recorder.margins[site]!)}
        } else {
          kill.count += 1
          if (quietFile) kill.quietFileCount += 1
        }
      }
      if (mutated.thrown != null && original.thrown == null) recordDifference(throws, input, index, mutated.thrown)
      const differs = mutated.thrown != null || original.thrown != null ? (mutated.thrown == null) !== (original.thrown == null) : !same(original.value, mutated.value)
      if (differs) recordDifference(behavior, input, index, `patched ${original.thrown ?? encodeJson(original.value)}; mutant ${mutated.thrown ?? encodeJson(mutated.value)}`)
    }
    emit({type: 'cw-result', mutant: mutant.key, base: copy.copy, entry: entry.name, inputs: budget, digest, usable, eligibilityMismatches, mutantOnlyDiscards, mutantOverBudget, kills: kills.filter((kill): kill is ContractKill => kill != null), throws, behavior, ms: performance.now() - entryStarted})
  }
}
