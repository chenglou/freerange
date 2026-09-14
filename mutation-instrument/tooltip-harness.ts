// Replay adapter for mj-gallery's planted tooltip mutants (registered/m7-mj-gallery.json criterion1.planted): reads the
// examples a recorded tt sweep printed for one plant, and turns each into an entry call. It is used only to replay planted
// catches a run missed; no input the lattice generates passes through it. A recorded output holds one section per flag set:
//   === sweep --plant-origin
//   {"flags":["--plant-origin"],"evaluations":74400366,"latticeEvaluations":69400366,"seconds":7.2}
//   tooltipLayout.ts:567:11 1215457 {"viewportWidth":320,…,"inPlace":{…}}
//     {"viewportWidth":320,…}
// Examples name their entry by shape:
//   {naturals, minimums, available}   shrinkRow(naturals, minimums, available)
//   {…, inPlace}                       tooltipInPlacePosition(input)
//   any other record                   tooltipPosition(input); a missing anchor reads as undefined, as JSON dropped it
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import type {Value} from './domain.ts'
import {decodeJson} from './encode.ts'

type PlantExample = {source: string; entry: string; args: Value[]}

function harnessCall(example: Record<string, Value>): {entry: string; args: Value[]} {
  if ('naturals' in example) return {entry: 'shrinkRow', args: [example['naturals'], example['minimums'], example['available']]}
  if ('inPlace' in example) return {entry: 'tooltipInPlacePosition', args: [example]}
  return {entry: 'tooltipPosition', args: [example]}
}

/**
 * Every example printed in the recorded output's section whose flags are exactly `flag`. `recorded` is the plant's registered
 * record, which starts with the output's path and names the output's sha1 where the registration recorded one, e.g.
 * `tt/sweep-final-2.txt sha1 177c6ca0…: 5,026,865 failures at :525 …`; a sha1 that differs aborts.
 */
export function plantExamples(scratch: string, flag: string, recorded: string): PlantExample[] {
  const path = (recorded.split(' ')[0] ?? '').replace(/:$/, '')
  const text = readFileSync(join(scratch, path), 'utf8')
  const registeredSha1 = /sha1 ([0-9a-f]{40})/.exec(recorded)?.[1] ?? null
  const actualSha1 = createHash('sha1').update(text).digest('hex')
  if (registeredSha1 != null && registeredSha1 !== actualSha1) throw new Error(`${path}: sha1 ${actualSha1} differs from the registered ${registeredSha1}`)
  const lines = text.split('\n')
  const examples: PlantExample[] = []
  let inSection = false
  let failure = ''
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.startsWith('=== ')) {
      const header = lines[index + 1] ?? ''
      const flags = header.startsWith('{') ? (decodeJson(header) as {flags: string[]}).flags : []
      inSection = flags.length === 1 && flags[0] === flag
      failure = ''
      index += 1
      continue
    }
    if (!inSection) continue
    const failureMatch = /^(tooltipLayout\.ts:\d+:\d+) (\d+) (\{.*\})$/.exec(line)
    const exampleMatch = /^ {2}(\{.*\})$/.exec(line)
    if (failureMatch != null) failure = `${failureMatch[1]} x${failureMatch[2]}`
    const encoded = failureMatch?.[3] ?? exampleMatch?.[1] ?? null
    if (encoded == null) continue
    examples.push({source: `${path} ${flag} ${failure}`, ...harnessCall(decodeJson(encoded) as Record<string, Value>)})
  }
  return examples
}
