#!/usr/bin/env bun

import {inferFitFiles} from './src/check.ts'
import {printInferReport} from './src/infer-output.ts'
import {doctorFitFiles, type FitCheck, type FitDoctorCheck, verifyFitFiles} from './src/reports.ts'
import {resolveFitProjectPaths} from './src/modules.ts'

const [command, ...args] = Bun.argv.slice(2)

switch (command) {
  case 'check':
    await runCheck(args)
    break
  case 'doctor':
    await runDoctor(args)
    break
  case 'infer':
    await runInfer(args)
    break
  default:
    printUsage()
    process.exitCode = 2
}

async function runCheck(args: string[]) {
  const input = resolveInputPaths(args)
  if (input == null) return
  const report = await verifyFitFiles(input.paths)
  const failed = report.checks.filter(check => check.status !== 'pass')
  for (const check of failed) printCheck(check)
  printCheckSummary('fr check', input.paths.length, report.summary)
  if (report.phase !== 'ready') process.exitCode = 1
}

async function runDoctor(args: string[]) {
  const input = resolveInputPaths(args)
  if (input == null) return
  const report = await doctorFitFiles(input.paths)
  const notable = report.checks.filter(check => check.status !== 'pass')
  for (const check of notable) printDoctorCheck(check)
  printDoctorSummary('fr doctor', input.paths.length, report.summary)
  if (report.phase !== 'ready') process.exitCode = 1
}

async function runInfer(args: string[]) {
  const {paths, functionName, all} = parseInferArgs(args)
  const input = resolveInputPaths(paths)
  if (input == null) return
  const report = inferFitFiles(input.paths, {
    ...(functionName == null ? {} : {functionName}),
    all,
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
    paths.push(arg)
  }
  return {paths, functionName, all}
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
  console.log(`  ${check.status.toUpperCase()} ${check.text}`)
  printReason(check.reason)
}

function printDoctorCheck(check: FitDoctorCheck) {
  console.log(formatCheckLocation(check))
  console.log(`  ${check.status.toUpperCase()} ${check.text}`)
  printReason(check.reason)
}

function printReason(reason: string | undefined) {
  if (reason == null) return
  printLines(reason, '  ')
}

function printLines(text: string, indent: string) {
  for (const line of text.split('\n')) console.log(`${indent}${line}`)
}

function formatCheckLocation(check: {file: string; line?: number; functionName: string}) {
  return check.line == null
    ? `${check.file}:${check.functionName}`
    : `${check.file}:${check.line}:${check.functionName}`
}

function printCheckSummary(label: string, files: number, summary: {pass: number; fail: number; unknown: number}) {
  console.log(`${label}: ${files} files, ${summary.pass} pass, ${summary.fail} fail, ${summary.unknown} unknown`)
}

function printDoctorSummary(label: string, files: number, summary: {pass: number; fail: number; requires: number; unknown: number}) {
  console.log(`${label}: ${files} files, ${summary.pass} pass, ${summary.fail} fail, ${summary.requires} requires, ${summary.unknown} unknown`)
}

function printUsage() {
  console.error('Usage:')
  console.error('  fr check [file.ts ...]')
  console.error('  fr doctor [file.ts ...]')
  console.error('  fr infer [--function name] [--all] [file.ts ...]')
}
