#!/usr/bin/env bun

import {runAudit, runFile, runProject, runProjectAudit} from './src/project.ts'
import {formatTypeScriptDiagnostics, TypeScriptDiagnosticsError} from './src/typescript/diagnostics.ts'

const arguments_ = process.argv.slice(2)
try {
  let hasTypeScriptErrors: boolean
  if (arguments_[0] === '--audit') {
    if (arguments_.length > 2) throw new Error('Usage: fr --audit [file]')
    hasTypeScriptErrors = arguments_.length === 1
      ? runProjectAudit(process.cwd())
      : runAudit(arguments_[1]!)
  } else {
    if (arguments_.length > 1) throw new Error('Usage: fr [file]')
    hasTypeScriptErrors = arguments_.length === 0
      ? runProject(process.cwd())
      : runFile(arguments_[0]!)
  }
  if (hasTypeScriptErrors) process.exitCode = 1
} catch (error) {
  if (error instanceof TypeScriptDiagnosticsError) {
    console.error(formatTypeScriptDiagnostics(error.diagnostics, error.options, error.currentDirectory).trimEnd())
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
}
