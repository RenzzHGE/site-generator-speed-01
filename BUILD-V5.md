# Entry B v5 — build log (optimiser pass on v4)

## Method
- Profiled v4 fresh with `node --cpu-prof` (warm, 30 passes x 3 cases):
  countWords 15.2% self, renderMarkdown self 13.4%, run self 7.4%, GC 7.4%,
  inlineCat ~9% + INLINE_RE ~4.3%, link 2.5% + resolvePath 1.9%,
  slugify ~3.1%, nextLine/peekLine ~2.1% combined.
- Every change verified with `node verify.mjs` (3/3 identical) after each
  step, plus `scratch-v4/test-if-branch-v4.mjs`, `scratch-v4/difftest-v4.mjs`
  (9 tests) and new `scratch-v5/difftest-v5.mjs` (10 tests) + `fuzz-slug.mjs`
  (300 random tricky titles). No submit, no login, no keys.
  `entry/`, `entry-b/`, `entry-v2/`, `entry-v3/`, `entry-v4/` untouched.
  Scratch work in `scratch-v5/`.

## Changes kept (v4 -> v5)
1. **V-direct codegen for provably-unbound names (`callerBoundSets`)**:
   new fixpoint analysis over the include graph: for each template, the set
   of names that may be in L from a caller (for-vars bound at include sites,
   transitively; 'loop' included when includable from inside a for). Codegen
   emits `V.x` directly for names neither locally bound nor caller-bound,
   keeps the `has(L,x)?L.x:V.x` check otherwise. Generated code 36,070 ->
   32,354 chars; `has(L,` sites 240 -> 80. Isolated ABBA (25 rounds, v5 vs
   v5-minus-this-change): **0.978x median / 0.959x trimmed mean**.
2. **escStr fast path is one regex test** (`/[&<>"']/.test(s)` instead of
   five `indexOf` calls). Micro-bench on real strings: 410 -> 287 us/pass.
3. **slugify ASCII path run-based + single-pass**: maximal alnum runs are
   sliced/lowercased/joined (was per-char `String.fromCharCode` appends),
   and the ASCII pre-scan is gone — the run scan bails to the NFKD path on
   the first non-ASCII char. Proven by `fuzz-slug.mjs` (300 titles: unicode,
   combining marks, astral, 64-char cut edges). Micro-bench on titles:
   1,041 -> 778 us/pass.
4. **Fence code blocks escape via `escStr`** instead of `escInto`
   (push/join). Micro-bench on real fence content (735 blocks, 150k chars):
   3,612 -> 2,002 us/pass. `escInto` deleted (was fence-only).

## Changes tried and dropped
- **Naive V-direct for ALL names** (drop the hasOwn check everywhere):
  BROKE correctness — included templates read caller loop vars through the
  shared L object, so index cards went blank (`verify.mjs` 0/3). This is
  exactly why change (1) needs the caller-bound analysis. The broken
  version's ceiling was ~0.91x, so the safe version leaves ~half of that
  gain on the table (the hot card reads keep their check) — accepted.
- **countWords variants** (regex `match`/`exec`, split, indexOf skip,
  lookup table, reordered branches): current char loop is fastest
  (20.3k/pass vs 29.9k+ for regex family; table/reorder within noise).
  At its floor; not touched.
- **txt() inline in codegen var/raw nodes** (`typeof(__v=EXPR)==='string'`):
  correct (3/3 + all difftests pass) but SLOWER — ABBA 1.050x median /
  1.031x trim. Reverted the same hour.
- **nextLine/peekLine inlining**: not attempted after profiling showed
  their self time (2.1% combined) already includes the indexOf work;
  the pure call overhead is a fraction of ~1k. Not worth the risk.

## Verification
- `node verify.mjs` -> **3/3 identical** (after every change).
- `scratch-v4/test-if-branch-v4.mjs` -> **PASS**.
- `scratch-v4/difftest-v4.mjs` -> **ALL 9 DIFFERENTIAL TESTS PASS**.
- `scratch-v5/difftest-v5.mjs` -> **ALL 10 V5 DIFFERENTIAL TESTS PASS**
  (card-in-for, after-for restore, shadowing + restore, loop-in-include,
  if-branch-in-for, two-context include, nested includes, V-name-elsewhere,
  two nested fors, cycle-in-for).
- `scratch-v5/fuzz-slug.mjs` -> **PASS (300 titles)**.
- Repo size: solve.js ~50k; entry-v5 total well under the 4 MiB limit.

## Benchmarks (v4 vs v5)
- Warm ABBA, 30 rounds, same process: v4 median 128,352 / trimmean
  127,897; v5 median 116,580 / trimmean 125,188 -> **0.908x median /
  0.979x trimmed mean**. The two estimators disagree (median says ~9%,
  trim says ~2%); the isolated per-change ABBAs multiply to ~0.95x, so
  the honest claim is **~0.95x warm (~4-5% faster than v4)**.
- Heat proxy (fresh node process per round, 9 rounds, trimmed mean):
  v4 366,193 vs v5 342,585 -> **0.935x**.
- Separate-process `bench.mjs` medians (noisy): 152,685 and 156,601 total
  (g-0001 ~43-54k, g-0002 ~42-45k, g-0003 ~61-64k) vs v4's ~170,000.
  Target <155,000 us: met on one run, missed on the next — within noise
  of the target, not a solid margin.

## Biggest remaining bottleneck
countWords (~15%, at its JS floor — every variant tried is slower) and
Markdown inline (~20% incl. regex) + block loop (~13% self) still lead,
then template render and GC (~6%). The inline scanner is near its floor
in JS; the remaining wins, if any, are sub-2% micro-opts each. A solid
further jump would need a different inline/block algorithm, not tuning.
