import {corpusProbes, corpusRoot, type CorpusProbe} from './corpus-probes.ts'
import {doctorFitFiles, verifyFitFiles} from './src/reports.ts'
import {verifySnapshot} from './snapshot.ts'

const expectedPath = 'corpus-probes.expected.txt'
const allProbePaths = corpusProbes.flatMap(probe => probe.paths)
const allProbePathsMissing = (await missingPaths(allProbePaths)).length === allProbePaths.length

if (allProbePathsMissing) {
  console.log(`corpus probes: skipped, missing ${corpusRoot}`)
} else {
  const lines: string[] = []
  for (const probe of corpusProbes) {
    const missing = await missingPaths(probe.paths)
    if (missing.length > 0) {
      lines.push(`${probe.kind} ${probe.name}: missing`)
      for (const path of missing) lines.push(`  ${displayFile(path)}`)
      continue
    }
    await addProbe(lines, probe)
  }
  if (!await verifySnapshot(expectedPath, lines.join('\n'), 'corpus probes')) process.exitCode = 1
}

async function addProbe(lines: string[], probe: CorpusProbe) {
  if (probe.kind === 'check') {
    const report = await verifyFitFiles(probe.paths)
    lines.push(`check ${probe.name}: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.unknown} unknown`)
    return
  }
  const report = await doctorFitFiles(probe.paths)
  lines.push(`doctor ${probe.name}: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.requires} requires, ${report.summary.unknown} unknown`)
}

async function missingPaths(paths: string[]) {
  const missing: string[] = []
  for (const path of paths) {
    if (!await readableFile(path)) missing.push(path)
  }
  return missing
}

async function readableFile(path: string) {
  try {
    await Bun.file(path).text()
    return true
  } catch {
    return false
  }
}

function displayFile(file: string) {
  const prefix = `${corpusRoot}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}
