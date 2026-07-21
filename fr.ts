#!/usr/bin/env node

// Two commands. `fr` checks the project for warnings and errors; `fr --audit` prints
// every function's contracts and refactoring suggestions. Both take an optional file that
// narrows the output to that file. Findings mode is the CI gate: it fails on error-level
// findings and TypeScript errors. Audit mode is informational and fails only on
// TypeScript errors.
import {runFileAudit, runFileFindings, runProjectAudit, runProjectFindings} from './src/project.ts'
import {formatTypeScriptDiagnostics, TypeScriptDiagnosticsError} from './src/typescript/diagnostics.ts'

const arguments_ = process.argv.slice(2)
try {
  let failed: boolean
  if (arguments_[0] === '--audit') {
    if (arguments_.length > 2) throw new Error('Usage: fr --audit [file]')
    failed = arguments_.length === 1
      ? runProjectAudit(process.cwd())
      : runFileAudit(arguments_[1]!)
  } else {
    if (arguments_.length > 1) throw new Error('Usage: fr [file]')
    failed = arguments_.length === 0
      ? runProjectFindings(process.cwd())
      : runFileFindings(arguments_[0]!)
  }
  if (failed) process.exitCode = 1
} catch (error) {
  if (error instanceof TypeScriptDiagnosticsError) {
    console.error(formatTypeScriptDiagnostics(error.diagnostics, error.options, error.currentDirectory).trimEnd())
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
}
