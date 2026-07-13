import type {FunctionID, ModuleBindingID} from './ids.ts'
import type {ProgramIR} from './program.ts'

export type FunctionUsage = {
  callees: FunctionID[]
  moduleBindings: ModuleBindingID[]
}

export function functionUsage(program: ProgramIR): FunctionUsage[] {
  return program.functions.map(fn => {
    const callees: FunctionID[] = []
    const moduleBindings: ModuleBindingID[] = []
    if (fn.kind === 'lowered') {
      for (const block of fn.blocks) {
        for (const instruction of block.instructions) {
          if (instruction.kind === 'call' && !callees.includes(instruction.function)) {
            callees.push(instruction.function)
          }
          if (instruction.kind === 'moduleRead' && !moduleBindings.includes(instruction.binding)) {
            moduleBindings.push(instruction.binding)
          }
        }
      }
    }
    return {callees, moduleBindings}
  })
}

export function functionsReadingModules(usage: FunctionUsage[]): boolean[] {
  const readsModules = usage.map(fn => fn.moduleBindings.length > 0)
  let changed = true
  while (changed) {
    changed = false
    for (let caller = 0; caller < usage.length; caller++) {
      if (readsModules[caller] === true) continue
      if (usage[caller]!.callees.some(callee => readsModules[callee] === true)) {
        readsModules[caller] = true
        changed = true
      }
    }
  }
  return readsModules
}
