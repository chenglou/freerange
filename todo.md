## Current Priority

- **Transcendental and `**` policy**: ECMA leaves them implementation-approximated, so their endpoint hulls rest on a host-libm monotonicity assumption (and the checker runs JSC while checked code may run V8). Decide whether to keep the assumption documented, widen hulls by an ulp, or drop the hulls.
- **Repeated call expressions in branches and loops**: Freerange currently requires a helper call to be pure before analyzing the same expression again. Check whether the evaluator can keep the value from the first evaluation instead. This would avoid making purity responsible for branch and loop precision.
