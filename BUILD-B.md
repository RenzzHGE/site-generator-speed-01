# Entry B — build log

## Design
- **Templates: `new Function` codegen (chosen over op-list interpreter).**
  Each template is parsed once per case (same error messages as the
  reference) into a node tree, then compiled to a JS function
  `(V, L, out, depth, T, esc, txt, tru, pr, has)`. Text is emitted as
  `out.push(<literal>)`, vars as `out.push(esc(txt(<path>)))`, `if`/`for`
  as native JS control flow, includes as direct calls to the compiled
  callee. Loop scope is one shared null-prototype object `L` (save/restore
  around each `for`, incl. the `loop` record); names not bound by an
  enclosing `for` in the same template resolve dynamically
  (`has(L,name) ? L.name : V.name`) so an included template such as `card`
  sees the includer's loop variable `p`. Path tails use an own-property
  helper `pr()`. If `new Function` ever throws, the template falls back to
  a small node-tree interpreter (`renderNodesFb`) with identical semantics.
  Why codegen over an op-list interpreter: it removes the per-node dispatch
  and scope-chain walk entirely, and `new Function` is plain dependency-free
  JS (no WASM/native), allowed by the rules.
- **Markdown: single-pass, index-range renderer.** Lines are walked with
  `indexOf('\n')` (no `split`, no per-line regex); blocks classified by
  char-code checks; inline rendering is one left-to-right scan with a
  shared output array, run-flushing, and range-based recursion for
  strong/em/link (no string slicing for inner text). Escape uses a
  precomputed char-code scan with chunked pushes. `findUnescaped` /
  `findSingleStar` replicate the reference's escape-skipping exactly.
- **Front matter: hand scanner** (char-code key/value parse, same error
  strings, same order of checks). **Slugify: memoised per case** (Map);
  ASCII fast path skips NFKD/normalize, non-ASCII path mirrors the
  reference exactly. Reading minutes still uses `/\S+/g` (V8 regex, fast).
- Nothing is cached across cases; per-case memoisation (slug Map) only.

## Verification
- `node verify.mjs` → **3/3 identical** (JSON.stringify vs
  `practice/reference/expected.json`), re-checked after every fix.
- End-to-end driver check: `main.ts` with `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` writes `answers.json` matching expected exactly.
- Repo size 43,672 bytes total (limit 4 MiB).

## Benchmark (`node bench.mjs`, process.cpuUsage, warmup, 5 runs, median)
- g-0001: ~64,414 µs; g-0002: ~107,683 µs; g-0003: ~103,500 µs
- **Total median: ~275,597 µs** (repeat runs: ~245k–276k; per-run samples
  vary ~45k–141k, first runs slower — JIT warmup of the generated
  functions; steady-state 10-run average total ≈ 245k µs)
- Baseline reference: ~642,605 µs total → **≈ 2.3–2.6× faster**.

## Biggest remaining bottleneck
Markdown inline rendering + template compile per case: every `run()`
re-parses and `new Function`-compiles all ~27 templates (required — no
cross-case caching allowed), and the inline scanner is the largest
remaining per-byte cost. Further gains would come from a tighter inline
loop or avoiding `String.match(/\S+/g)` allocations for reading minutes.
