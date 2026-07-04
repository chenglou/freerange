import type {ValueID} from '../ir/ids.ts'
import type {InstructionIR} from '../ir/instructions.ts'
import type {FunctionIR} from '../ir/program.ts'
import type {InferredPrecondition, NumericExpression} from './model.ts'

export type ExpressionContext = {
  parameterExpressions: Array<NumericExpression | null>
  parameterIndexByValue: Array<number | undefined>
  instructionByValue: Array<InstructionIR | undefined>
}

export function createExpressionContext(
  fn: FunctionIR,
  parameterExpressions: Array<NumericExpression | null>,
): ExpressionContext {
  const context: ExpressionContext = {
    parameterExpressions,
    parameterIndexByValue: [],
    instructionByValue: [],
  }
  for (let index = 0; index < fn.parameters.length; index++) {
    context.parameterIndexByValue[fn.parameters[index]!.value] = index
  }
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) context.instructionByValue[instruction.result] = instruction
  }
  return context
}

export function numericExpression(value: ValueID, context: ExpressionContext): NumericExpression | null {
  const parameterIndex = context.parameterIndexByValue[value]
  if (parameterIndex != null) return context.parameterExpressions[parameterIndex] ?? null
  const instruction = context.instructionByValue[value]
  if (instruction == null) return null
  switch (instruction.kind) {
    case 'constant': return {kind: 'constant', value: instruction.value}
    case 'binary': {
      const left = numericExpression(instruction.left, context)
      const right = numericExpression(instruction.right, context)
      return left == null || right == null
        ? null
        : {kind: 'binary', operator: instruction.operator, left, right}
    }
    case 'floor': {
      const operand = numericExpression(instruction.value, context)
      return operand == null ? null : {kind: 'floor', operand}
    }
    // A module write's result is the assigned value, so the written expression carries over.
    case 'moduleWrite': return numericExpression(instruction.value, context)
    // Requirement expressions name only the function's own parameters; a module binding is
    // not caller-visible, so a requirement cannot name it.
    case 'moduleRead':
    case 'moduleHavoc':
    case 'platformValue':
    case 'booleanConstant':
    case 'not':
    case 'absolute':
    case 'call':
    case 'compare':
    case 'maximum':
    case 'minimum':
    case 'object':
    case 'nullishConstant':
    case 'nullishCheck':
    case 'arrayLiteral':
    case 'arrayIndex': return null
    // An array's length is fixed at construction (no push in the subset), so a length
    // read over a nameable array could join the expression language later; not yet.
    case 'arrayLength': return null
    case 'property': {
      const base = numericExpression(instruction.object, context)
      return base == null ? null : {kind: 'property', base, name: instruction.property}
    }
  }
}

export function addPrecondition(preconditions: InferredPrecondition[], candidate: InferredPrecondition): void {
  if (!preconditions.some(precondition => samePrecondition(precondition, candidate))) preconditions.push(candidate)
}

// Deduplication is by expression only: when two operations need the same requirement, the
// first causing site wins. Switching to one record per operation is deferred until reports
// group requirements per operation.
function samePrecondition(left: InferredPrecondition, right: InferredPrecondition): boolean {
  return sameExpression(left.expression, right.expression)
}

function sameExpression(left: NumericExpression, right: NumericExpression): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'parameter': return left.index === (right as Extract<NumericExpression, {kind: 'parameter'}>).index
    case 'constant': return left.value === (right as Extract<NumericExpression, {kind: 'constant'}>).value
    case 'binary': {
      const other = right as Extract<NumericExpression, {kind: 'binary'}>
      return left.operator === other.operator
        && sameExpression(left.left, other.left)
        && sameExpression(left.right, other.right)
    }
    case 'floor': return sameExpression(left.operand, (right as Extract<NumericExpression, {kind: 'floor'}>).operand)
    case 'property': {
      const other = right as Extract<NumericExpression, {kind: 'property'}>
      return left.name === other.name && sameExpression(left.base, other.base)
    }
  }
}
