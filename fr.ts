#!/usr/bin/env bun

import {resolve} from 'node:path'
import {analyzeFile, formatReport} from './src/index.ts'
import {runProject} from './src/project.ts'

const files = process.argv.slice(2)
if (files.length === 0) {
  // Project mode: audit the repo the working directory's tsconfig describes, reports
  // under ./freerange-report (one file per source file, LEGEND.txt and SUMMARY.txt once).
  runProject(process.cwd(), resolve('freerange-report'))
} else {
  for (let index = 0; index < files.length; index++) {
    if (index > 0) console.log('')
    console.log(formatReport(analyzeFile(resolve(files[index]!))))
  }
}
