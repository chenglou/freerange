import type {ArithmeticOperator} from '../ir/instructions.ts'

export type NumericExpression =
  | {kind: 'parameter'; index: number}
  | {kind: 'constant'; value: number}
  | {kind: 'binary'; operator: ArithmeticOperator; left: NumericExpression; right: NumericExpression}

export type InferredPrecondition = {
  kind: 'nonzero'
  expression: NumericExpression
}
