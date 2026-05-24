# Vocabulary Demos

One file per vocabulary group in `VOCABULARY.md`. Each demo is small enough to read alone, with examples that exercise the analyzer's recognized shapes. Failing demos (intentionally outside the vocabulary) are kept commented out as documentation of the boundary.

Run any file with `bun fr.ts check research/focused-tests/<name>.ts`.

- `vocab-core.ts` — comparisons, ranges, per-element claims on input arrays.
- `vocab-sequences.ts` — `spaced`, `nondecreasing`, `lastEnd`, `extentEnd`, `noOverlap` on loop-built arrays.
- `vocab-array-methods.ts` — `arr.every(p)`, `arr.some(p)`, `arr.filter(p).length` as quantifier-flavored claims.
- `vocab-math.ts` — Math catalog (rounding, monotonic, bounded outputs).
