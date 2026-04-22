import {verifyFitFiles} from './src/reports.ts'

const paths = Bun.argv.slice(2)

if (paths.length === 0) {
  console.error('Usage: bun verify.ts <file.ts> ...')
  process.exitCode = 1
} else {
  const report = await verifyFitFiles(paths)
  console.log(JSON.stringify(report, null, 2))
  if (report.phase !== 'ready') process.exitCode = 1
}
