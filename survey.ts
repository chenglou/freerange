#!/usr/bin/env bun
// Thin wrapper over project mode with an explicit output directory — the scratch-run
// spelling (`bun fr.ts` with no arguments is the in-repo spelling, writing to
// ./freerange-report).
// Usage: bun survey.ts <repo-root> <output-dir>

import {runProject} from './src/project.ts'

const [repoRoot, outputDirectory] = process.argv.slice(2)
if (repoRoot == null || outputDirectory == null) {
  console.error('Usage: bun survey.ts <repo-root> <output-dir>')
  process.exit(1)
}
runProject(repoRoot, outputDirectory)
