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
  // A property read off a nameable record, e.g. grid.columnCount. Sound to name because
  // values are immutable after construction: the property cannot change between function
  // entry and the operation that needs the requirement.
  | {kind: 'property'; base: NumericExpression; name: string}

// An element read the engine could not prove in bounds: arr[i]! asserts presence, and
// when the index interval does not sit inside the length interval, the entry's guarantees
// rest on the read actually being in bounds. The peer of InferredPrecondition, minus the
// expression language (an assumption line needs only its site).
export type BoundsAssumption = {
  site: SiteID
}

export type InferredPrecondition =
  | {
      kind: 'nonzero'
      expression: NumericExpression
      // The operation that needs the requirement (today always a division). Propagated
      // records keep the callee's site, so a caller's report points at the actual division
      // even when the requirement surfaces two calls up.
      site: SiteID
    }
  // The peeled form of a nonzero obligation: dividing by `width - 4` requires width to
  // not be 4. Produced only by float-exact peeling (see peelNonzero), so the biconditional
  // holds: the printed condition is neither weaker nor stronger than the divisor being
  // nonzero.
  | {
      kind: 'notEqualConstant'
      expression: NumericExpression
      value: number
      site: SiteID
    }
