#!/usr/bin/env bun

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
  console.log(`${check.file}:${check.functionName}`)
  console.log(`  ${check.status.toUpperCase()} ${check.text}`)
  printReason(check.reason)
}

function printDoctorCheck(check: FitDoctorCheck) {
  console.log(`${check.file}:${check.functionName}`)
  console.log(`  ${check.status.toUpperCase()} ${check.text}`)
  printReason(check.reason)
}

function printReason(reason: string | undefined) {
  if (reason == null) return
  for (const line of reason.split('\n')) console.log(`  ${line}`)
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
}
