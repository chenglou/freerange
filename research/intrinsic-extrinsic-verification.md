# Intrinsic And Extrinsic Verification

This came from the photo-gallery annotation thread, but the idea is broader than Freerange.

The useful question is:

> Where does the reason something is true live?

Intrinsic verification puts the reason in the representation. Extrinsic verification puts the reason in the computation, contract, or check that produced the value.

Nearby names:

- correctness by construction vs correctness by verification
- intrinsic vs extrinsic proof
- canonical representation vs representation invariant
- design by contract
- refinement types

Another way to say it:

- intrinsic: the value shape carries the guarantee downstream
- extrinsic: the producing edge proves the guarantee, and callers rely on that edge

Intrinsic verification is often an extrinsic proof that got packaged into a construction. Someone proved once that `[T, ...T[]]` is nonempty; after that, every value of that shape carries the guarantee without each caller reproving it.

## The Tradeoff

Intrinsic restricts the state space. Fewer states are representable, so local reasoning gets easier.

Extrinsic preserves the ordinary state space. More constructions can succeed, but someone has to prove the boundary fact.

So it is not just "intrinsic good" or "extrinsic good":

- intrinsic: fewer programs accepted, less downstream proof burden
- extrinsic: more programs accepted, more proof/search/report burden

Freerange's bet is that agents make the extrinsic side more attractive. If the final contracts are crisp, the agent can write freer intermediate code and let the checker reject the bad paths. The verifier lowers entropy at the boundary instead of forcing every intermediate construction through a human-designed API.

## Memory And Computation

This also looks like a memory/computation tradeoff.

Put persistent truths in memory. Put ephemeral truths in computation.

If a guarantee is stable wherever the value goes, carry it in the data shape:

```ts
type NonEmpty<T> = [T, ...T[]]
```

If a guarantee is true because a helper produced this value in this way, check the helper:

```ts
const rows = stackRows(items, gap)
// rows[$i + 1].top >= rows[$i].bottom + gap
```

The row spacing is not a timeless property of every `Row[]`. It can disappear after `sort`, `filter`, `push`, or mutation. Naming the type `StackedRows` is only honest if the module also controls the construction and mutation paths. Otherwise the algorithm history is pretending to be data.

## Dataflow

In dataflow terms:

- intrinsic says the value node carries a guarantee downstream
- extrinsic says this computation edge produced a guarantee

This matters for UI because many interesting truths are phase-local:

- after layout, rows are spaced
- after hit testing, the selected index is in bounds
- after route parsing, the route union is valid
- during spring settling, only `pos` and `v` mutate
- after render projection, DOM geometry should match model geometry

Trying to bake all of those into permanent types often creates fake structure. Proving the producer or phase boundary is cleaner.

## Spring Example

For `springStep`, the useful facts are not just scalar ranges:

- `k > 0` and `b > 0` are preserved
- only `pos` and `v` mutate
- post-state `v` and `pos` follow the spring equations
- rest state stays fixed: if `pos == dest && v == 0`, then it remains so
- spring force pulls toward `dest`; damping opposes `v`

Current Freerange can infer local formulas like `newV == ...` and `newPos == ...`, but it cannot state `post(config.v) == newV`, `post(config.pos) == newPos`, `preserves config.k`, or conditional postconditions. That is effect-summary / old-post-state territory.

`springGoToEnd` is similar. The implementation is tiny:

```ts
config.pos = config.dest
config.v = 0
```

The real contract would be post-state facts, not a return value.

## Games

Game programming often lives on the extrinsic side for simulation facts.

Stable identity/resource facts go intrinsic:

- entity ids
- component presence
- asset schemas
- animation state enums
- command buffers

Moment-to-moment simulation facts usually come from the frame pipeline:

- grounded this frame
- hitbox overlaps hurtbox during this phase
- animation owns movement until a cancel frame
- projectile is active until collision or despawn
- transform is valid after physics and before render

The rigor is often in update order, systems, assertions, debug overlays, replays, and phase boundaries, not only in the static data model.

UI has a similar shape. Many useful truths are "after this pass" truths.

## Neural Nets

Neural nets are further toward extrinsic evidence.

The knowledge is stored in weights, but not as human-readable invariants. So normal practice leans on:

- evals
- held-out tests
- adversarial probes
- monitoring
- output schemas
- guardrails
- external checkers

Constrained decoding can make JSON shape intrinsic-ish, but semantic correctness still needs an external check. A model can be forced to output `{ "targetIndex": 3 }`; another system still has to prove `targetIndex < items.length` and that it picked the right item.

That is the useful agent architecture:

```txt
neural generation for search and expression
symbolic verification for guarantees
```

## Heuristic

Use intrinsic structure when the guarantee is:

- stable
- reusable
- local to the value
- worth carrying everywhere

Use extrinsic checks when the guarantee is:

- phase-local
- algorithm-shaped
- about a transformation
- too awkward to name as a reusable data shape

A type should say what a value is. A contract should say what a computation did.
