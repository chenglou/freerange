// Builds the corpus from the Plan A instrument runs, the replay harnesses' oracle reports and their snapshot sources.
//
//   bun eval/build-corpus.ts --scratch <scratchpad root> --out <new directory outside this repository>
//
// The corpus copies source files and asserts from private repositories, so it is built into a local directory and never
// committed here. The output directory must not exist. Every source file is copied verbatim and, where its run recorded
// one, checked against the recorded sha1. Every number is copied from a named run file. Provenance paths are written
// relative to the scratchpad root, as `S/...`. The builder only reads the scratchpad: files on disk, `git show` and
// `git archive` from the replay clones.
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import * as ts from 'typescript'
import {normalizeConditionText} from './lib/asserts.ts'
import {importClosure, type SourceReader} from './lib/closure.ts'
import {readJsonFile, type CorpusManifest, type CorpusUnit, type Example, type GroundTruthSite, type Slice} from './lib/manifest.ts'

type PlanFile = {file: string; path: string; source: string; sourceSha1: string}
type PlanSite = {index: number; file: string; line: number; functionName: string; leading: boolean; text: string; key: string}
type PlanEntry = {name: string; file: string}
type PlanCopy = {copy: string; files: PlanFile[]; sites: PlanSite[]; entries: PlanEntry[]}
type Plan = {copies: PlanCopy[]}
type BaselineFiring = {site: number; counts: number[][]; first: Array<{input: string} | null>; byCause: Record<string, number>}
type BaselineRecord = {type: string; base: string; entry: string; reached: number[]; firings: BaselineFiring[]}
type WitnessSite = {key: string; firing: number; reservoirs: Array<{firstVerified: string | null}>}
type WitnessFile = {sets: Array<{set: string}>; entries: Array<{name: string; sites: WitnessSite[]}>}
type LabelGroups = Record<string, number[]>
type M7Registration = {labels: {inScope: {precondition: LabelGroups; real: LabelGroups; realRestatedUnderStricter: LabelGroups; restated: LabelGroups}}}
type OracleContract = {key: string; headline: string | null; synthetic: boolean | null; firingAtC0?: number; firingAtC1?: number; firingAtC1p?: number; firingAtC2?: number; insideImpactC1: number; outsideImpactC1: number; insideImpactC1ClearedAtC2: number; examples?: {insideImpactC1?: string[]}}
type ReplayOracle = {stages: Record<string, unknown>; envs: {development: {contracts: OracleContract[]}}}
type GridAxis = {name: string; kind: string; values?: unknown[]}
type GridSite = {id: string; axes: GridAxis[]}
type Grid = {routes?: Array<{label: string; value: unknown}>; sites?: GridSite[]}
type ExternalCell = {present?: boolean; e1?: {failures: number; evaluations: number}; e3?: {agent?: {inside: number; outside: number}}}
type ExternalOracle = {stages: Record<string, string> & {repo?: string}; caught: string[]; caughtCaveats?: Record<string, string[]> | null; rows?: Array<{key: string; cells: Record<string, ExternalCell>}>}

const maxExamplesPerSite = 5
const maxReplayClosureFiles = 400

function argument(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] ?? null
}

const scratchArgument = argument('--scratch')
const outArgument = argument('--out')
if (scratchArgument == null || outArgument == null) throw new Error('Usage: bun eval/build-corpus.ts --scratch <scratchpad root> --out <new directory>')
const scratch: string = scratchArgument
const outRoot: string = outArgument
if (existsSync(outRoot)) throw new Error(`${outRoot} exists; the builder writes a fresh corpus`)

const scratchPath = (path: string): string => join(scratch, path)
const relativeToScratch = (path: string): string => path.startsWith(scratch) ? `S${path.slice(scratch.length)}` : path
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

function readTsv(path: string): Array<Record<string, string>> {
  const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0)
  const header = lines[0]!.split('\t')
  return lines.slice(1).map(line => {
    const cells = line.split('\t')
    const row: Record<string, string> = {}
    header.forEach((name, index) => {
      row[name] = cells[index] ?? ''
    })
    return row
  })
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as unknown as T)
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, text)
}

function sum(values: number[] | undefined): number {
  return (values ?? []).reduce((total, value) => total + value, 0)
}

function occurrenceOf(instrumentKey: string): number {
  return Number(instrumentKey.split('|').at(-1))
}

const units: CorpusUnit[] = []
const skipped: CorpusManifest['skipped'] = []
// Local node_modules directories by label, written to <corpus>/node-modules.json as the scorer's defaults.
const nodeModulesPaths: Record<string, string> = {'mj-gallery': scratchPath('wt/m7-prealpha-93b9935807/node_modules')}

function addUnit(unit: CorpusUnit, files: Map<string, string>, tsconfigText: string | null): void {
  const unitDir = join(outRoot, unit.slice, unit.id)
  for (const [path, text] of files) writeFile(join(unitDir, 'tree', path), text)
  if (tsconfigText != null) writeFile(join(unitDir, 'tree', 'tsconfig.json'), tsconfigText)
  writeFile(join(unitDir, 'unit.json'), `${JSON.stringify(unit, null, 1)}\n`)
  units.push(unit)
}

function planGroundTruth(copy: PlanCopy, options: {run: string; domain: string; baseline: BaselineRecord[]; kills: Array<Record<string, string>>; generatedMutants: boolean; witness: WitnessFile | null; witnessRun: string | null; labels: M7Registration['labels'] | null}): GroundTruthSite[] {
  const pathByLogical = new Map(copy.files.map(file => [file.file, file.path]))
  const entryFile = new Map(copy.entries.map(entry => [entry.name, pathByLogical.get(entry.file) ?? entry.file]))
  const inGroup = (groups: LabelGroups, site: PlanSite): boolean => (groups[site.file] ?? []).includes(site.line)
  return copy.sites.map(site => {
    const path = pathByLogical.get(site.file) ?? site.file
    const examples: Example[] = []
    const addExample = (example: Example): void => {
      if (examples.length < maxExamplesPerSite && !examples.some(existing => existing.entry === example.entry && existing.args === example.args)) examples.push(example)
    }

    let inputsReached = 0
    const firing = {none: 0, abs1e9: 0, literal: 0}
    const byCause: Record<string, number> = {}
    for (const record of options.baseline) {
      if (record.type !== 'baseline' || record.base !== copy.copy) continue
      inputsReached += record.reached[site.index] ?? 0
      for (const siteFiring of record.firings) {
        if (siteFiring.site !== site.index) continue
        firing.none += sum(siteFiring.counts[0])
        firing.abs1e9 += sum(siteFiring.counts[1])
        firing.literal += sum(siteFiring.counts[2])
        for (const [cause, count] of Object.entries(siteFiring.byCause)) byCause[cause] = (byCause[cause] ?? 0) + count
        const first = siteFiring.first[0]
        if (first != null) addExample({entryFile: entryFile.get(record.entry) ?? path, entry: record.entry, args: first.input, source: `lattice ${options.domain}, first firing input under noise@none`})
      }
    }

    let witness: GroundTruthSite['witness'] = null
    if (options.witness != null && options.witnessRun != null) {
      let witnessFiring = 0
      for (const entry of options.witness.entries) {
        for (const witnessSite of entry.sites) {
          if (witnessSite.key !== site.key) continue
          witnessFiring += witnessSite.firing
          for (const reservoir of witnessSite.reservoirs) {
            if (reservoir.firstVerified != null && entryFile.has(entry.name)) addExample({entryFile: entryFile.get(entry.name)!, entry: entry.name, args: reservoir.firstVerified, source: 'witness set, first verified firing input'})
          }
        }
      }
      witness = {run: options.witnessRun, sets: options.witness.sets.map(set => set.set), firing: witnessFiring}
    }

    const killing = options.kills.filter(row =>
      row['copy'] === copy.copy
      && row['kill_noise@abs1e-9'] === 'true'
      && Number(row['behavior_diffs']) > 0
      && (row['killing_lines'] ?? '').split(',').includes(`${site.file}:${site.line}`))
    const planted = killing.filter(row => options.generatedMutants ? false : row['planted'] == null || row['planted'] === 'true').length
    const kills = {
      run: options.run,
      rule: 'mutants killed under kill_noise@abs1e-9 with behavior_diffs > 0 whose killing_lines include the site',
      count: killing.length,
      generated: killing.length - planted,
      planted,
      mutants: killing.slice(0, 50).map(row => row['mutant'] ?? ''),
    }

    let labels: GroundTruthSite['labels'] = null
    if (options.labels != null) {
      const groups = options.labels.inScope
      const precondition = inGroup(groups.precondition, site)
      const real = inGroup(groups.real, site)
      const movedByStricter = inGroup(groups.realRestatedUnderStricter, site)
      const restated = inGroup(groups.restated, site)
      // A site in no label group, e.g. an assert of an excluded entry, has no labels.
      if (precondition || real || movedByStricter || restated) {
        labels = {
          reader: precondition ? 'precondition' : real || movedByStricter ? 'real' : 'restated',
          stricter: precondition ? 'precondition' : real ? 'real' : 'restated',
        }
      }
    }

    return {
      key: `${path}|${site.functionName}|${normalizeConditionText(site.text)}|${occurrenceOf(site.key)}`,
      file: path,
      line: site.line,
      owner: site.functionName,
      text: normalizeConditionText(site.text),
      labels,
      lattice: {run: options.run, domain: options.domain, inputsReached, firing, byCause},
      witness,
      kills,
      catching: kills.count > 0,
      replay: null,
      examples,
    }
  })
}

function recordedFindings(run: string, copy: PlanCopy): CorpusUnit['recordedFindings'] {
  const recorded: CorpusUnit['recordedFindings'] = []
  for (const file of copy.files) {
    const path = join(run, `fr-${copy.copy}-${file.file}.txt`)
    if (!existsSync(path)) continue
    const lines = readFileSync(path, 'utf8').split('\n')
    const revision = lines[0]?.startsWith('fr revision ') === true ? lines[0].slice('fr revision '.length) : ''
    recorded.push({file: file.path, revision, lines: lines.slice(revision === '' ? 0 : 1).filter(line => line.length > 0)})
  }
  return recorded
}

// ---- Slice mj-gallery: the 13 copies and 81 asserts of the Plan A m7 run at mj-gallery prealpha 93b9935807.
{
  const run = scratchPath('freerange-focus/plan-a/runs/20260914T072511Z-mj-prealpha-m7')
  const registration = readJsonFile<M7Registration>(scratchPath('freerange-focus/plan-a/registered/m7-mj-gallery.json'))
  const witnessRun = scratchPath('freerange-focus/plan-a/runs/20260914T072334Z-mj-prealpha-m7-witness')
  const worktree = scratchPath('wt/m7-prealpha-93b9935807')
  const plan = readJsonFile<Plan>(join(run, 'plan.json'))
  const baseline = readJsonl<BaselineRecord>(join(run, 'baseline.jsonl'))
  const kills = readTsv(join(run, 'kills.tsv'))
  const tsconfig = ts.parseConfigFileTextToJson('tsconfig.json', readFileSync(join(worktree, 'tsconfig.json'), 'utf8')).config as unknown as {compilerOptions: Record<string, unknown>}
  const unitTsconfig = `${JSON.stringify({compilerOptions: {...tsconfig.compilerOptions, types: []}, include: ['src']}, null, 2)}\n`
  const read: SourceReader = path => existsSync(join(worktree, path)) ? readFileSync(join(worktree, path), 'utf8') : null
  for (const copy of plan.copies) {
    const sources: CorpusUnit['provenance']['sources'] = []
    for (const file of copy.files) {
      const text = readFileSync(file.source, 'utf8')
      if (sha1(text) !== file.sourceSha1) throw new Error(`${file.source}: sha1 differs from the plan's ${file.sourceSha1}`)
    }
    const closure = importClosure(copy.files.map(file => file.path), read, {aliasPrefix: 'src'})
    if (closure.capped) throw new Error(`${copy.copy}: import closure past the cap`)
    for (const [path, text] of closure.files) sources.push({path, from: relativeToScratch(join(worktree, path)), sha1: sha1(text)})
    const witnessPath = join(witnessRun, `witness-mj-gallery-${copy.copy}.json`)
    const witness = existsSync(witnessPath) ? readJsonFile<WitnessFile>(witnessPath) : null
    addUnit({
      id: `mj-gallery-${copy.copy}`,
      slice: 'mj-gallery',
      family: 'mj-gallery',
      tree: `mj-gallery/mj-gallery-${copy.copy}/tree`,
      analyze: [...new Set(copy.sites.map(site => copy.files.find(file => file.file === site.file)!.path))],
      tsconfig: true,
      nodeModules: closure.packages.length > 0 ? 'mj-gallery' : null,
      packages: closure.packages,
      unresolvedImports: closure.unresolved,
      provenance: {
        sources,
        runs: [relativeToScratch(run), relativeToScratch(witnessRun)],
        notes: [
          'mj-gallery prealpha 93b9935807; files and their project-local import closure copied from S/wt/m7-prealpha-93b9935807',
          "tsconfig: mj-gallery's compilerOptions with types [] and include [\"src\"]; the m7 run analyzed the files inside the full worktree",
        ],
      },
      recordedFindings: recordedFindings(run, copy),
      groundTruth: planGroundTruth(copy, {run: relativeToScratch(run), domain: 'domain@v1b', baseline, kills, generatedMutants: false, witness, witnessRun: witness == null ? null : relativeToScratch(witnessRun), labels: registration.labels}),
    }, closure.files, unitTsconfig)
  }
}

// ---- Slice families: the Plan A m1d, m2b, m3b and m4b runs over the four families' contract copies.
{
  const witnessRun = scratchPath('freerange-focus/plan-a/runs/w1-witness')
  const familyRuns: Array<{family: string; run: string; generatedMutants: boolean}> = [
    {family: 'virtualization', run: '20260913T202201Z-virtualization-src-m1d', generatedMutants: true},
    {family: 'popovers', run: '20260913T202457Z-popovers-m2b', generatedMutants: false},
    {family: 'frames', run: '20260913T202638Z-frames-m3b', generatedMutants: false},
    {family: 'packing', run: '20260913T202815Z-packing-m4b', generatedMutants: false},
  ]
  for (const familyRun of familyRuns) {
    const run = scratchPath(`freerange-focus/plan-a/runs/${familyRun.run}`)
    const plan = readJsonFile<Plan>(join(run, 'plan.json'))
    const baseline = readJsonl<BaselineRecord>(join(run, 'baseline.jsonl'))
    const kills = readTsv(join(run, 'kills.tsv'))
    for (const copy of plan.copies) {
      const files = new Map<string, string>()
      const sources: CorpusUnit['provenance']['sources'] = []
      for (const file of copy.files) {
        const text = readFileSync(file.source, 'utf8')
        if (sha1(text) !== file.sourceSha1) throw new Error(`${file.source}: sha1 differs from the plan's ${file.sourceSha1}`)
        files.set(file.path, text)
        sources.push({path: file.path, from: relativeToScratch(file.source), sha1: file.sourceSha1})
      }
      const closure = importClosure([...files.keys()], path => files.get(path) ?? null, {aliasPrefix: 'src'})
      const tsconfigPath = join(run, 'work', 'original', copy.copy, 'tsconfig.json')
      const tsconfigText = existsSync(tsconfigPath) ? readFileSync(tsconfigPath, 'utf8') : null
      const witnessPath = join(witnessRun, `witness-${familyRun.family}-${copy.copy}.json`)
      const witness = existsSync(witnessPath) ? readJsonFile<WitnessFile>(witnessPath) : null
      addUnit({
        id: `families-${familyRun.family}-${copy.copy}`,
        slice: 'families',
        family: familyRun.family,
        tree: `families/families-${familyRun.family}-${copy.copy}/tree`,
        analyze: [...new Set(copy.sites.map(site => copy.files.find(file => file.file === site.file)!.path))],
        tsconfig: tsconfigText != null,
        nodeModules: null,
        packages: closure.packages,
        unresolvedImports: closure.unresolved,
        provenance: {
          sources,
          runs: [relativeToScratch(run), ...(witness == null ? [] : [relativeToScratch(witnessRun)])],
          notes: [tsconfigText == null ? 'no tsconfig: the run analyzed these files as a single-file program' : "tsconfig copied from the run's work/original copy"],
        },
        recordedFindings: recordedFindings(run, copy),
        groundTruth: planGroundTruth(copy, {run: relativeToScratch(run), domain: 'the run\'s registered lattice domain', baseline, kills, generatedMutants: familyRun.generatedMutants, witness, witnessRun: witness == null ? null : relativeToScratch(witnessRun), labels: null}),
      }, files, tsconfigText)
    }
  }
}

function gitReader(clone: string, commit: string): SourceReader {
  const cache = new Map<string, string | null>()
  return path => {
    const cached = cache.get(path)
    if (cached !== undefined) return cached
    const shown = spawnSync('git', ['-C', clone, 'show', `${commit}:${path}`], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    const text = shown.status === 0 ? shown.stdout : null
    cache.set(path, text)
    return text
  }
}

function extractArchive(clone: string, commit: string, paths: string[], destination: string): void {
  mkdirSync(destination, {recursive: true})
  const archive = spawnSync('git', ['-C', clone, 'archive', '--format=tar', commit, ...paths], {maxBuffer: 1024 * 1024 * 1024})
  if (archive.status !== 0) throw new Error(`git archive ${commit} failed: ${archive.stderr.toString()}`)
  const extracted = spawnSync('tar', ['-x', '-C', destination], {input: archive.stdout})
  if (extracted.status !== 0) throw new Error(`tar -x into ${destination} failed: ${extracted.stderr.toString()}`)
}

// The replay checkers' wrapper rule, applied to the copied config: TypeScript 6 rejects moduleResolution node, node10
// and classic without ignoreDeprecations, and defaults rootDir to the config's directory when an output directory is set.
function stageTsconfig(text: string | null): string {
  const config = text == null ? {} : ts.parseConfigFileTextToJson('tsconfig.json', text).config as unknown as {compilerOptions?: Record<string, unknown>}
  const options: Record<string, unknown> = {...config.compilerOptions}
  const moduleResolution = options['moduleResolution']
  if (typeof moduleResolution === 'string' && ['node', 'node10', 'classic'].includes(moduleResolution.toLowerCase())) options['ignoreDeprecations'] = '6.0'
  if (['outDir', 'declarationDir', 'sourceRoot', 'mapRoot'].some(name => options[name] != null) && options['rootDir'] == null) options['rootDir'] = '.'
  return `${JSON.stringify({...config, compilerOptions: options}, null, 2)}\n`
}

function decodeDirectExample(example: string, grid: Grid, stageFile: string): Example | null {
  if (!example.startsWith('direct:')) return null
  const parts = example.split('|')
  const siteID = parts[0]!
  const window = /^y=(\S+) x=(-?[\d.]+)/.exec(parts.at(-1) ?? '')
  const signature = /#([A-Za-z_$][\w$]*)\(([^)]*)\)$/.exec(siteID)
  const site = grid.sites?.find(candidate => candidate.id === siteID)
  if (window == null || signature == null || site == null) return null
  const values = new Map<string, string>()
  for (const part of parts.slice(1, -1)) {
    const separator = part.indexOf('=')
    if (separator > 0) values.set(part.slice(0, separator), part.slice(separator + 1))
  }
  const argumentTexts: string[] = []
  for (const parameter of signature[2]!.split(',').filter(name => name.length > 0)) {
    const axis = site.axes.find(candidate => candidate.name === parameter)
    if (axis == null) return null
    if (axis.kind === 'window') {
      argumentTexts.push(`{x: ${Number(window[2])}, y: ${Number(window[1])}}`)
      continue
    }
    const value = values.get(parameter)
    if (value == null) return null
    if (axis.kind === 'route') {
      const route = grid.routes?.find(candidate => candidate.label === value)
      if (route == null) return null
      argumentTexts.push(JSON.stringify(route.value))
      continue
    }
    if (value === 'undefined') {
      argumentTexts.push('undefined')
      continue
    }
    try {
      argumentTexts.push(JSON.stringify(JSON.parse(value)))
    } catch {
      return null
    }
  }
  return {entryFile: stageFile, entry: signature[1]!, args: `[${argumentTexts.join(', ')}]`, source: `replay sweep state inside the C1 impact set: ${example}`}
}

// ---- Slice replay, mj-gallery harness: contracts an oracle credits with firings inside the C1 impact states.
{
  const clone = scratchPath('replay/mj-gallery')
  const reports = [
    {cid: 'ga-v1', caseID: '4e835add49', path: 'replay/reports/ga-v1/4e835add49/v3/oracle.json', grid: 'replay/grids/ga-v1/c2a54c1f66/v3/grid.json'},
    {cid: 'gb-v1', caseID: '4e835add49', path: 'replay/reports/gb-v1/4e835add49/v3/oracle.json', grid: 'replay/grids/gb-v1/c2a54c1f66/v3/grid.json'},
    {cid: 'pilot', caseID: '4e835add49', path: 'replay/reports/pilot/4e835add49/oracle.json', grid: 'replay/grids/pilot/c2a54c1f66.json'},
    {cid: 'pilot', caseID: '676c37635b', path: 'replay/reports/pilot/676c37635b/oracle.json', grid: 'replay/grids/pilot/8d18c41c30.json'},
  ]
  for (const report of reports) {
    const oracle = readJsonFile<ReplayOracle>(scratchPath(report.path))
    const grid = existsSync(scratchPath(report.grid)) ? readJsonFile<Grid>(scratchPath(report.grid)) : {}
    const credited = oracle.envs.development.contracts.filter(contract => contract.insideImpactC1 > 0)
    const stageFiles = [...new Set(credited.map(contract => contract.key.split('|')[0]!))]
    for (const stage of ['c0', 'c1']) {
      const commit = oracle.stages[stage] as string
      const id = `replay-${report.cid}-${report.caseID}-${stage}`
      const read = gitReader(clone, commit)
      // Layout.ts's project-local import closure passes 400 files (Route.ts imports app contexts), so these units are
      // the stage's whole src/ tree, analyzed the way the replay checkers analyze a stage.
      const packageJson = read('package.json') ?? ''
      const cacheHash = createHash('sha256').update(packageJson + (read('bun.lock') ?? '')).digest('hex').slice(0, 16)
      const nodeModulesLabel = `replay-cache-${cacheHash}`
      nodeModulesPaths[nodeModulesLabel] = scratchPath(`replay/cache/node_modules/${cacheHash}/node_modules`)
      const fileOfContract = (contract: OracleContract): string => contract.key.split('|')[0]!
      const groundTruth: GroundTruthSite[] = credited.map(contract => {
        const [path, owner, text, occurrence] = contract.key.split('|') as [string, string, string, string]
        const firingAtStage = stage === 'c0' ? contract.firingAtC0 ?? 0 : contract.firingAtC1 ?? contract.insideImpactC1
        return {
          key: `${path}|${owner}|${normalizeConditionText(text)}|${occurrence}`,
          file: path,
          line: null,
          owner,
          text: normalizeConditionText(text),
          labels: null,
          lattice: null,
          witness: null,
          kills: null,
          catching: true,
          replay: {
            report: `S/${report.path}`,
            stage,
            stageCommit: commit,
            firesAtStage: firingAtStage > 0,
            evidence: {
              headline: contract.headline, synthetic: contract.synthetic, firingAtC0: contract.firingAtC0 ?? null, firingAtC1: contract.firingAtC1 ?? null,
              firingAtC1p: contract.firingAtC1p ?? null, firingAtC2: contract.firingAtC2 ?? null, insideImpactC1: contract.insideImpactC1,
              outsideImpactC1: contract.outsideImpactC1, insideImpactC1ClearedAtC2: contract.insideImpactC1ClearedAtC2,
            },
          },
          examples: stage === 'c1'
            ? (contract.examples?.insideImpactC1 ?? []).map(example => decodeDirectExample(example, grid, fileOfContract(contract))).filter(example => example != null).slice(0, maxExamplesPerSite)
            : [],
        }
      })
      const treeDirectory = join(outRoot, 'replay', id, 'tree')
      extractArchive(clone, commit, ['src', 'tsconfig.json', 'package.json'], treeDirectory)
      writeFile(join(treeDirectory, 'tsconfig.json'), stageTsconfig(read('tsconfig.json')))
      addUnit({
        id,
        slice: 'replay',
        family: `mj-replay ${report.cid} ${report.caseID}`,
        tree: `replay/${id}/tree`,
        analyze: stageFiles,
        tsconfig: true,
        nodeModules: nodeModulesLabel,
        packages: [],
        unresolvedImports: [],
        provenance: {
          sources: stageFiles.map(path => ({path, from: `S/replay/mj-gallery ${commit}:${path}`, sha1: sha1(read(path) ?? '')})),
          runs: [`S/${report.path}`],
          notes: [
            `stage ${stage} of ${report.cid} ${report.caseID}, carried-contract commit ${commit}; src/ tree ${spawnSync('git', ['-C', clone, 'rev-parse', `${commit}:src`], {encoding: 'utf8'}).stdout.trim()} via git archive`,
            'tsconfig: the stage config, plus ignoreDeprecations 6.0 when moduleResolution is node, node10 or classic, and rootDir when an output directory is set (the replay checkers\' wrapper rule)',
          ],
        },
        recordedFindings: [],
        groundTruth,
      }, new Map(), null)
    }
  }
}

// ---- Slice replay, external harness: contracts an oracle marks caught, at the snapshot and introducing stages.
{
  const reports = [
    'blind-v1-oracle-v3/tv-e6504e7',
    'mechanics-oracle-v3/tv-e6504e7',
    'review-mechanics-oracle-v3/tv-1e3b908',
    'review-v1/tv-1e3b908',
    'review-v1/tv-ace7d93',
    'review-v1/rrp-7761b1d',
    'review-followup-7761/rrp-7761b1d',
    'mechanics/rrp-7761b1d',
  ]
  const externalTsconfig = `${JSON.stringify({compilerOptions: {target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', lib: ['ESNext', 'DOM', 'DOM.Iterable'], strict: true, skipLibCheck: true, noEmit: true, types: []}, include: ['**/*.ts', '**/*.tsx']}, null, 2)}\n`
  for (const reportPath of reports) {
    const path = `external-replay/reports/${reportPath}/oracle.json`
    const oracle = readJsonFile<ExternalOracle>(scratchPath(path))
    const repo = oracle.stages.repo ?? ''
    const clone = scratchPath(`external-replay/${repo}`)
    const files = [...new Set(oracle.caught.map(key => key.split('|')[0]!))]
    const stages = oracle.stages['c0'] === oracle.stages['c1'] ? [{label: 'c0=c1', commit: oracle.stages['c1']!}] : [{label: 'c0', commit: oracle.stages['c0']!}, {label: 'c1', commit: oracle.stages['c1']!}]
    for (const stage of stages) {
      const id = `replay-${reportPath.replace('/', '-')}-${stage.label.replace('=', '')}`
      const closure = importClosure(files, gitReader(clone, stage.commit), {aliasPrefix: null, maxFiles: maxReplayClosureFiles})
      if (closure.capped) {
        skipped.push({id, reason: `import closure passes ${maxReplayClosureFiles} files`})
        continue
      }
      const groundTruth: GroundTruthSite[] = oracle.caught.map(key => {
        const [keyPath, owner, text, occurrence] = key.split('|') as [string, string, string, string]
        const row = oracle.rows?.find(candidate => candidate.key === key)
        const cells: Record<string, unknown> = {}
        let firesAtStage = false
        for (const [cellStage, cell] of Object.entries(row?.cells ?? {})) {
          cells[cellStage] = {e1: cell.e1 ?? null, e3Agent: cell.e3?.agent == null ? null : {inside: cell.e3.agent.inside, outside: cell.e3.agent.outside}}
          const failures = (cell.e1?.failures ?? 0) + (cell.e3?.agent?.inside ?? 0) + (cell.e3?.agent?.outside ?? 0)
          if (stage.label.split('=').includes(cellStage) && failures > 0) firesAtStage = true
        }
        return {
          key: `${keyPath}|${owner}|${normalizeConditionText(text)}|${occurrence}`,
          file: keyPath,
          line: null,
          owner,
          text: normalizeConditionText(text),
          labels: null,
          lattice: null,
          witness: null,
          kills: null,
          catching: true,
          replay: {report: `S/${path}`, stage: stage.label, stageCommit: stage.commit, firesAtStage, evidence: {cells, caveats: oracle.caughtCaveats?.[key] ?? []}},
          examples: [],
        }
      })
      addUnit({
        id,
        slice: 'replay',
        family: `external-replay ${reportPath}`,
        tree: `replay/${id}/tree`,
        analyze: files,
        tsconfig: true,
        nodeModules: null,
        packages: closure.packages,
        unresolvedImports: closure.unresolved,
        provenance: {
          sources: [...closure.files].map(([sourcePath, text]) => ({path: sourcePath, from: `S/external-replay/${repo} ${stage.commit}:${sourcePath}`, sha1: sha1(text)})),
          runs: [`S/${path}`],
          notes: [`stage ${stage.label} of ${reportPath}; firings come from unit tests and probes, so no example input is stored`, 'tsconfig: a strict default with types []; packages listed in `packages` are not provided'],
        },
        recordedFindings: [],
        groundTruth,
      }, closure.files, externalTsconfig)
    }
  }
}

const planCScore = scratchPath('freerange-focus/plan-c/score.md')
const countBy = (slice: Slice): number => units.filter(unit => unit.slice === slice).length
const manifest: CorpusManifest = {
  version: 'night-eval@v1',
  builtAt: new Date().toISOString(),
  scratchRoot: 'S = the Freerange focus scratchpad root the builder was given',
  counting: {
    site: 'every console.assert call found by the TypeScript AST in a unit\'s analyzed files',
    groundTruthSite: 'a site whose key (path|owner|condition text with whitespace collapsed|occurrence) matches a record the builder wrote',
    latticeFiring: 'baseline.jsonl firing counts of the unmutated copy over the run\'s lattice inputs, summed over producers and entries, per noise rule',
    witnessFiring: 'firing inputs of the unmutated copy in the run\'s caller-shaped witness sets (w1-witness, or the m7 witness run)',
    kills: 'rows of the run\'s kills.tsv with kill_noise@abs1e-9 true and behavior_diffs > 0 whose killing_lines include `<logical file>:<line>`',
    catching: 'kills >= 1; for replay units, a contract the oracle credits (insideImpactC1 > 0, or listed as caught)',
  },
  slices: {
    'mj-gallery': {status: 'built', units: countBy('mj-gallery'), description: 'Plan A m7: 13 copies of mj-gallery layout files at prealpha 93b9935807 with the 81 in-scope asserts, lattice firings, witness firings, kills and the reader\'s labels'},
    families: {status: 'built', units: countBy('families'), description: 'Plan A m1d/m2b/m3b/m4b: virtualization, popovers, frames and packing contract copies with lattice firings, witness firings and kills'},
    replay: {status: 'built', units: countBy('replay'), description: 'Contracts the replay oracles credit, at their snapshot and introducing stages: mj-gallery harness units are whole stage src/ trees, external harness units are import closures'},
    writers: {status: existsSync(planCScore) ? 'not built: plan-c/score.md exists but this builder has no writers step yet' : 'not built: S/freerange-focus/plan-c/score.md did not exist at build time', units: 0, description: 'Plan C scored contract writers\' patches (optional)'},
  },
  skipped,
  units: units.map(unit => ({id: unit.id, slice: unit.slice, family: unit.family, unitFile: `${unit.slice}/${unit.id}/unit.json`})),
}
writeFile(join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)
writeFile(join(outRoot, 'node-modules.json'), `${JSON.stringify(nodeModulesPaths, null, 1)}\n`)
console.log(`${units.length} units written to ${outRoot}; ${skipped.length} skipped`)
for (const entry of skipped) console.log(`skipped ${entry.id}: ${entry.reason}`)
