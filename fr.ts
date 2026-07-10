#!/usr/bin/env bun

import {runFiles, runProject} from './src/project.ts'
import {formatTypeScriptDiagnostics, TypeScriptDiagnosticsError} from './src/typescript/diagnostics.ts'

const files = process.argv.slice(2)
try {
  const hasTypeScriptErrors = files.length === 0
    ? runProject(process.cwd()).hasTypeScriptErrors
    : runFiles(files)
  if (hasTypeScriptErrors) process.exitCode = 1
} catch (error) {
  if (error instanceof TypeScriptDiagnosticsError) {
    console.error(formatTypeScriptDiagnostics(error.diagnostics, error.options, error.currentDirectory).trimEnd())
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
}
