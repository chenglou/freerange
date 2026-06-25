#!/usr/bin/env bun

import {resolve} from 'node:path'
import {analyzeFile, formatReport} from './src/index.ts'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('Usage: bun run fr <file.ts> [...files]')
  process.exitCode = 1
} else {
  for (let index = 0; index < files.length; index++) {
    if (index > 0) console.log('')
    console.log(formatReport(analyzeFile(resolve(files[index]!))))
  }
}
