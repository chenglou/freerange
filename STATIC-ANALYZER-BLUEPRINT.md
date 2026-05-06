We expect many more userland static analyzers in the future in the style of Freerange, thanks to AI having an easy time with verifiable tasks. Freerange will be the first of many attempts to make more domains, such as UI, verifiable. Due to the no free lunch theorem, we can't and won't bake everything into Freerange. Instead, future compilers should expose better APIs to allow, in the extreme case, just-in-time proof writing per commit

# STATIC ANALYZER BLUEPRINT

Freerange is one example, not the final checker. The general shape is:

1. Pick a domain with real pain and crisp failures.
   Layout sizes, geometry, animation bounds, editor state, accessibility, serialization, scheduling, and game rules all have facts that ordinary types do not express well.

2. Keep the public language tiny.
   A good analyzer lets users state the few facts source code cannot infer. It should not become a second programming language.

3. Use the compiler as substrate.
   Let TypeScript own parsing, syntax errors, project loading, module resolution, symbols, aliases, imports, re-exports, source locations, and editor integration. Do not rebuild that unless the compiler API cannot expose the needed boundary.

4. Own your domain meaning.
   The analyzer owns its abstract values, facts, summaries, proof rules, and failure model. TypeScript can tell you what symbol a call means; it cannot decide what "fits", "does not overlap", "stays visible", or "preserves order" means for your domain.

5. Separate attachment from proof.
   One layer attaches comments, contracts, or metadata to source nodes and symbols. Another parses the contract language. Another evaluates source. Another proves facts and writes reports. When these blur, every feature becomes a one-off.

6. Build one intentional abstract interpreter.
   Scattered recognizers eventually become an interpreter anyway. Make it explicit, small, and conservative. Unsupported code should produce unknown, not a guessed pass.

7. Prefer summaries over unrolling.
   Arrays, collections, loops, and external calls should usually become summaries. Unroll only for finite product shapes where the language already promises fixed slots, like tuples.

8. Treat diagnostics as product design.
   Reports should say what was required, what the caller or source proved, what is missing, and where to look next. A correct but unreadable checker will not survive real code.

9. Snapshot the behavior.
   Keep positive examples, negative examples, inferred-fact snapshots, corpus probes, and a loose performance guard. Static analyzers rot quietly without recordings.

10. Let agents write narrow proofs.
    In the extreme case, an agent can add a small analyzer or proof rule for the invariant a commit needs, run it in CI, and later delete, generalize, or promote it into the reusable checker.

11. Keep the no-free-lunch boundary honest.
    A domain analyzer should say what it proves today and what it refuses to guess. The future is not one universal proof engine; it is a healthy ecosystem of small analyzers sharing better compiler substrate.
