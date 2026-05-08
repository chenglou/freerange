#!/usr/bin/env bun

import {inferFitFiles} from './src/check-core.ts'
import {printInferReport} from './src/infer-output.ts'
import {type FitAudit, type FitCheck, verifyFitFiles} from './src/reports.ts'
import {resolveFitProjectPaths} from './src/modules.ts'

const [command, ...args] = Bun.argv.slice(2)

try {
  switch (command) {
    case '--help':
    case '-h':
    case 'help':
      printUsage()
      break
    case 'check':
      await runCheck(args)
      break
    case 'infer':
      await runInfer(args)
      break
    default:
      printUsage()
      process.exitCode = 2
  }
} catch (error) {
  console.error(`fr: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}

async function runCheck(args: string[]) {
  const parsed = parseCheckArgs(args)
  if (parsed == null) return
  const {paths, annotationsOnly, audit} = parsed
  const input = resolveInputPaths(paths)
  if (input == null) return
  const report = await verifyFitFiles(input.paths, {annotationsOnly, audit})
  const failed = report.checks.filter(check => check.status !== 'pass')
  for (const check of failed) printCheck(check)
  if (audit) {
    for (const item of report.audits) printAudit(item)
  }
  printCheckSummary(checkLabel({annotationsOnly, audit}), input.paths.length, report.summary, audit)
  if (report.phase !== 'ready') process.exitCode = 1
}

async function runInfer(args: string[]) {
  const parsed = parseInferArgs(args)
  if (parsed == null) return
  const {paths, functionName, all, annotationsOnly} = parsed
  if (paths.length === 0 && all !== true) {
    console.error('fr infer: pass a file path, or use --all for project-wide debug inventory.')
    printUsage()
    process.exitCode = 2
    return
  }
  const input = resolveInputPaths(paths)
  if (input == null) return
  const report = inferFitFiles(input.paths, {
    ...(functionName == null ? {} : {functionName}),
    all: all || annotationsOnly !== true,
  })
  if (functionName != null && report.functions.length === 0) {
    console.error(`fr infer: no function named ${functionName}`)
    process.exitCode = 1
    return
  }
  printInferReport(report)
}

function parseInferArgs(args: string[]) {
  let functionName: string | undefined
  let all = false
  let annotationsOnly = false
  const paths: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--function') {
      functionName = args[++index]
      continue
    }
    if (arg.startsWith('--function=')) {
      functionName = arg.slice('--function='.length)
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg === '--annotations-only') {
      annotationsOnly = true
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`fr infer: unknown option ${arg}`)
      process.exitCode = 2
      return null
    }
    paths.push(arg)
  }
  if (all && annotationsOnly) {
    console.error('fr infer: --all and --annotations-only cannot be combined')
    process.exitCode = 2
    return null
  }
  return {paths, functionName, all, annotationsOnly}
}

function parseCheckArgs(args: string[]) {
  let annotationsOnly = false
  let audit = false
  const paths: string[] = []
  for (const arg of args) {
    if (arg === '--annotations-only') {
      annotationsOnly = true
      continue
    }
    if (arg === '--audit') {
      audit = true
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`fr check: unknown option ${arg}`)
      process.exitCode = 2
      return null
    }
    paths.push(arg)
  }
  return {paths, annotationsOnly, audit}
}

function resolveInputPaths(args: string[]): {paths: string[]; configFile: string | null} | null {
  const input = resolveFitProjectPaths(args)
  if (args.length === 0 && input.configFile == null) {
    console.error('fr: could not find tsconfig.json')
    process.exitCode = 2
    return null
  }
  return input
}

function printCheck(check: FitCheck) {
  console.log(formatCheckLocation(check))
  console.log(`  ${formatCheckStatusLine(check)}`)
  if (check.boundaryLine != null && check.boundaryLine !== check.line) console.log(`  checked at: line ${check.boundaryLine}`)
  printReason(check.reason)
  printFollowUp(check)
}

function printAudit(audit: FitAudit) {
  console.log(formatCheckLocation(audit))
  console.log(`  AUDIT ${audit.text}`)
  printLines(audit.reason, '  ')
}

function printReason(reason: string | undefined) {
  if (reason == null) return
  printLines(reason, '  ')
}

function printLines(text: string, indent: string) {
  for (const line of text.split('\n')) console.log(`${indent}${line}`)
}

function isCallReport(check: FitCheck) {
  return check.detail?.kind === 'call-precondition'
}

function printFollowUp(check: FitCheck) {
  if (check.status === 'pass') return
  const followUp = adoptionFollowUp(check)
  if (followUp == null) return
  console.log(`  next: ${followUp}`)
}

function adoptionFollowUp(check: FitCheck) {
  const inferCommand = inferCommandForCheck(check)
  if (isCallReport(check)) {
    if (check.status === 'requires') {
      return inferCommand == null
        ? 'add a caller given, validate before this call, or wrap the helper behind a narrower contract'
        : `add a caller given, validate before this call, or run ${inferCommand} to see caller facts`
    }
    if (check.status === 'fail') {
      return inferCommand == null
        ? 'fix the call arguments or repair the callee precondition'
        : `fix the call arguments, or run ${inferCommand} to inspect the caller facts`
    }
    return inferCommand == null
      ? 'inspect the callsite; the callee precondition could not be proved'
      : `run ${inferCommand} to see why the caller facts did not prove the callee precondition`
  }

  if (inferCommand != null) return `run ${inferCommand} to compare inferred facts with this claim`
  return hasCheckBoundary(check)
    ? 'move the construction into a small named helper if you want inferred facts'
    : 'move the fact into a small named helper if you want inferred facts'
}

function hasCheckBoundary(check: FitCheck) {
  return 'boundaryLine' in check && check.boundaryLine != null
}

function inferCommandForCheck(check: {file: string; functionName: string}) {
  const functionName = check.functionName.split(' > ')[0]
  if (functionName == null || functionName === '<top-level>') return null
  return `fr infer --function ${shellArg(functionName)} ${shellArg(check.file)}`
}

function shellArg(value: string) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function formatCheckLocation(check: {file: string; line?: number; functionName: string}) {
  return check.line == null
    ? `${check.file}:${check.functionName}`
    : `${check.file}:${check.line}:${check.functionName}`
}

function formatCheckStatusLine(check: FitCheck) {
  if (check.detail?.kind === 'call-precondition') return `${check.status.toUpperCase()}: ${check.detail.callText}: ${check.detail.requirement}`
  return check.status === 'unknown'
    ? `UNKNOWN could not prove ${check.text}`
    : check.status === 'requires'
      ? `REQUIRES ${check.text}`
    : `${check.status.toUpperCase()} ${check.text}`
}

function printCheckSummary(label: string, files: number, summary: {pass: number; fail: number; requires: number; unknown: number; audit?: number}, includeAudit = false) {
  console.log(`${label}: ${files} files, ${summary.pass} pass, ${summary.fail} fail, ${summary.requires} requires, ${summary.unknown} unknown${includeAudit ? `, ${summary.audit ?? 0} audit` : ''}`)
}

function checkLabel(options: {annotationsOnly: boolean; audit: boolean}) {
  const flags = [
    options.annotationsOnly ? '--annotations-only' : null,
    options.audit ? '--audit' : null,
  ].filter(flag => flag != null)
  return flags.length === 0 ? 'fr check' : `fr check ${flags.join(' ')}`
}

function printUsage() {
  console.error('Usage:')
  console.error('  fr check [--annotations-only] [--audit] [file.ts ...]')
  console.error('  fr infer [--function name] [--annotations-only] [--all] file.ts ...')
}
