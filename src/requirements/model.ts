import type {SiteID} from '../ir/ids.ts'
import type {ArithmeticOperator, ComparisonOperator} from '../ir/instructions.ts'

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
  // What is accepted without proof at the site: an asserted element read is in bounds, or a
  // divisor the requirement language cannot express over the caller's arguments (a join,
  // a module read, an element read, a call result — or an exhausted expression walk) is
  // nonzero. The divisor case is the fallback for what used to be the divisorUnknown
  // stop: one honest assumes line instead of losing everything downstream of the division.
  kind: 'elementInBounds' | 'nonzeroDivisor'
}

export type InferredPrecondition =
  | {
      kind: 'nonzero'
      expression: NumericExpression
      // Which operation needs the divisor nonzero — division or remainder — for the prose.
      operation: 'division' | 'remainder'
      // Propagated records keep the callee's site, so a caller's report points at the
      // actual operation even when the requirement surfaces two calls up.
      site: SiteID
    }
  // An asserted element read (data[i]!) whose bounds the engine could not prove, with
  // both the index and the sequence nameable over the caller's arguments. The caller-
  // actionable upgrade of BoundsAssumption below: the condition is
  // Number.isInteger(index) && 0 <= index < sequence.length.
  | {
      kind: 'inBounds'
      index: NumericExpression
      sequence: NumericExpression
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
      operation: 'division' | 'remainder'
      site: SiteID
    }
  // A leading console.assert requirement after substituting the current caller's
  // expressions. Structured operands keep propagation independent of source text.
  | {
      kind: 'declaredComparison'
      operator: ComparisonOperator
      left: NumericExpression
      right: NumericExpression
      site: SiteID
    }
  | {
      kind: 'declaredNumberCheck'
      predicate: 'integer' | 'finite' | 'nan'
      expression: NumericExpression
      site: SiteID
      purpose?: 'finiteInput'
    }
