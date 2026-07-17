import type {FunctionID, ModuleBindingID} from './ids.ts'
import type {ProgramIR} from './program.ts'

export type FunctionUsage = {
  callees: FunctionID[]
  moduleBindings: ModuleBindingID[]
}

export function functionUsage(program: ProgramIR): FunctionUsage[] {
  return program.functions.map(fn => {
    const callees = new Set<FunctionID>()
    const moduleBindings = new Set<ModuleBindingID>()
    if (fn.kind === 'lowered') {
      for (const block of fn.blocks) {
        for (const instruction of block.instructions) {
          if (instruction.kind === 'call') callees.add(instruction.function)
          if (instruction.kind === 'moduleRead') moduleBindings.add(instruction.binding)
        }
      }
    }
    return {callees: [...callees], moduleBindings: [...moduleBindings]}
  })
}

export function transitiveModuleBindings(
  usage: FunctionUsage[],
  direct: ReadonlyArray<ReadonlySet<ModuleBindingID>> = usage.map(fn => new Set(fn.moduleBindings)),
): Set<ModuleBindingID>[] {
  const callers: FunctionID[][] = usage.map(() => [])
  for (let caller = 0; caller < usage.length; caller++) {
    for (const callee of usage[caller]!.callees) callers[callee]!.push(caller)
  }

  const bindings = direct.map(items => new Set(items))
  const queue: Array<{functionID: FunctionID; binding: ModuleBindingID}> = []
  for (let functionID = 0; functionID < bindings.length; functionID++) {
    for (const binding of bindings[functionID]!) queue.push({functionID, binding})
  }
  let index = 0
  while (index < queue.length) {
    const {functionID, binding} = queue[index++]!
    for (const caller of callers[functionID]!) {
      if (!bindings[caller]!.has(binding)) {
        bindings[caller]!.add(binding)
        queue.push({functionID: caller, binding})
      }
    }
  }
  return bindings
}
