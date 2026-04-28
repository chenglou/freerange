import * as ts from 'typescript'
import {type FitDoctorCheck} from './check-types.ts'
import {type FitFunction, type FitModule} from './modules.ts'
import {
  fitReturnPublicRoot,
  parseFitSpecLine,
  type FitSpec,
} from './parser.ts'
import {type NumberValue, type Value} from './domain.ts'

export type FitScoutCandidate = {
  file: string
  functionName: string
  fact: string
  requirements: string[]
}

export type FitScoutReport = {
  files: string[]
  candidates: FitScoutCandidate[]
  checks: FitDoctorCheck[]
  summary: {
    candidates: number
    pass: number
    fail: number
    requires: number
    unknown: number
  }
}

export function scoutNumericParameterNames(fn: FitFunction, env: Map<string, Value>): string[] {
  const names: string[] = []
  for (const param of fn.node.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    const value = env.get(param.name.text)
    if (value?.kind === 'number') names.push(param.name.text)
  }
  return names
}

export function scoutRequirementsFromReason(reason: string | undefined): string[] {
  if (reason == null) return []
  const requirements: string[] = []
  for (const line of reason.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('missing: given ')) continue
    const requirement = tryParseScoutRequirement(trimmed.slice('missing: '.length))
    if (requirement != null) requirements.push(requirement)
  }
  return [...new Set(requirements)]
}

export function uniqueScoutCandidates(candidates: FitScoutCandidate[]): FitScoutCandidate[] {
  const seen = new Set<string>()
  const unique: FitScoutCandidate[] = []
  for (const candidate of candidates) {
    const key = `${candidate.file}\0${candidate.functionName}\0${candidate.fact}\0${candidate.requirements.join('\0')}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}

export function scoutRequirementSpecsByFunction<Program extends FitModule<NumberValue>>(
  programs: Program[],
  candidates: FitScoutCandidate[],
): Map<Program, Map<string, FitSpec[]>> {
  const programsByFile = new Map(programs.map(program => [program.file, program]))
  const specsByProgram = new Map<Program, Map<string, FitSpec[]>>()
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const program = programsByFile.get(candidate.file)
    if (program == null) continue
    let specsByFunction = specsByProgram.get(program)
    if (specsByFunction == null) {
      specsByFunction = new Map()
      specsByProgram.set(program, specsByFunction)
    }
    const specs = specsByFunction.get(candidate.functionName) ?? []
    for (const requirement of candidate.requirements) {
      const key = `${candidate.file}\0${candidate.functionName}\0${requirement}`
      if (seen.has(key)) continue
      seen.add(key)
      specs.push(parseFitSpecLine(requirement))
    }
    specsByFunction.set(candidate.functionName, specs)
  }

  return specsByProgram
}

export type SavedFunctionSpecs<Program extends FitModule<NumberValue>> = Map<Program, Map<string, FitSpec[] | undefined>>

export function replaceFunctionSpecs<Program extends FitModule<NumberValue>>(
  programs: Program[],
  specsByProgram: Map<Program, Map<string, FitSpec[]>>,
): SavedFunctionSpecs<Program> {
  const saved: SavedFunctionSpecs<Program> = new Map()
  for (const program of programs) {
    const savedProgramSpecs = new Map<string, FitSpec[] | undefined>()
    saved.set(program, savedProgramSpecs)
    const scoutSpecs = specsByProgram.get(program) ?? new Map()
    for (const functionName of program.functions.keys()) {
      savedProgramSpecs.set(functionName, program.specsByFunction.get(functionName))
      const specs = scoutSpecs.get(functionName)
      if (specs == null || specs.length === 0) program.specsByFunction.delete(functionName)
      else program.specsByFunction.set(functionName, specs)
    }
  }
  return saved
}

export function restoreFunctionSpecs<Program extends FitModule<NumberValue>>(saved: SavedFunctionSpecs<Program>) {
  for (const [program, specsByFunction] of saved) {
    for (const [functionName, specs] of specsByFunction) {
      if (specs == null) program.specsByFunction.delete(functionName)
      else program.specsByFunction.set(functionName, specs)
    }
  }
}

function tryParseScoutRequirement(text: string): string | null {
  try {
    const spec = parseFitSpecLine(text)
    if (spec.kind !== 'given-range' && spec.kind !== 'given-comparison') return null
    if (spec.text.includes(fitReturnPublicRoot)) return null
    return spec.text
  } catch {
    return null
  }
}
