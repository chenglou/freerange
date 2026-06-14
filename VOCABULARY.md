**STALE DOCS, PLEASE IGNORE**

## Array predicate expressions

These TypeScript forms reduce to array-wide claims and counts:

- `arr.every(item => P(item))` means every item satisfies `P`.
- `arr.some(item => P(item))` means at least one item satisfies `P`.
- `arr.filter(P).length` counts the items satisfying `P`. The result is bounded by `arr.length`, and the bound becomes tighter when Freerange can decide `P` from the known item facts.

There is no separate `count(...)`, `forall(...)`, or `exists(...)` contract syntax.

## Sequence built-in boundaries

`spaced` recognizes scalar sequences and object rows using `y/height`, `x/width`, `top/height`, or `start/size`. `lastEnd`, `extentEnd`, and `noOverlap` use those object row pairs. If an object has more than one recognized axis pair, map it to one pair first.

`noOverlap(rows)` is proved from recognized adjacent row spacing with a nonnegative gap. It does not check every possible pair of freely positioned boxes.

## Outside

Freerange reports these as unsupported or unknown rather than guessing:

- Arbitrary-pair claims such as `for distinct i != j: P(arr[i], arr[j])`, except for the adjacent and same-index forms documented elsewhere.
- General polynomial inequalities such as `dx * dx + dy * dy <= radius * radius`.
- Claims that need the full shape of transcendental functions rather than the documented range and monotonic rules.
- Set and multiset cardinality claims that do not reduce to `filter(predicate).length`.
- Calls and mutations without a written rule. For example, `sort()` without a comparison function is unsupported.
