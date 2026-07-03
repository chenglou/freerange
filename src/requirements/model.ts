import type {SiteID} from '../ir/ids.ts'
import type {ArithmeticOperator} from '../ir/instructions.ts'

export type NumericExpression =
  | {kind: 'parameter'; index: number}
  | {kind: 'constant'; value: number}
  | {kind: 'binary'; operator: ArithmeticOperator; left: NumericExpression; right: NumericExpression}
  // Math.floor over a nameable expression. Lets a division by a floored value mint a
  // requirement instead of stopping — and a floored divisor is an integer, so under the
  // nonzero requirement its magnitude is at least 1 and the quotient stays finite.
  | {kind: 'floor'; operand: NumericExpression}

export type InferredPrecondition = {
  kind: 'nonzero'
  expression: NumericExpression
  // The operation that needs the requirement (today always a division). Propagated records
  // keep the callee's site, so a caller's report points at the actual division even when
  // the requirement surfaces two calls up.
  site: SiteID
}
