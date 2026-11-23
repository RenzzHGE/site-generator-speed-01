# Entry B v6 — build log (optimiser pass on v5)

## Method
- Profiled v5 fresh with `node --cpu-prof` (warm, 30 passes x 3 cases):
  countWords 16.2% self, renderMarkdown 14.8%, inlineCat ~10% + INLINE_RE
  ~4.8%, GC 6.9%, run 6.3%, link + resolvePath ~4.1%.
- Every change verified with `node verify.mjs` (3/3 identical) after each
  step, plus `scratch-v4/test-if-branch-v4.mjs`,
  `scratch-v4/difftest-v4.mjs` (9 tests), `scratch-v5/difftest-v5.mjs`
  (10 tests), `scratch-v5/fuzz-slug.mjs` (300 titles), and new
  `scratch-v6/difftest-para-span.mjs` (24 tricky bodies) +
  `scratch-v6/fuzz-para-span.mjs` (120 random files, v5 vs v6).
  No submit, no login, no keys. `entry/` … `entry-v5/` untouched.
  Scratch work in `scratch-v6/`.
- Measurement lesson: the in-process interleaved A/B is unusable here —
  identical v5-vs-v5 code gave per-round ratios spanning 0.77–1.47
  (median 0.985). All claims below use a fresh-process heat driver
  (`scratch-v6/heat-one.mjs`: 1 warmup pass + 1 timed pass, alternating
  order, 12 rounds per drive, median + 10% trimmed mean). `bench.mjs`
  totals are reported too but its run-to-run spread for identical code
  is 138k–181k, so it cannot resolve a ~7% difference.

## Changes kept (v5 -> v6)
1. **Lines-array cursor in renderMarkdown**: line starts/ends are built
   once in a tight `indexOf('\n')` scan (exactly `src.split('\n')`
   ranges — verified against the old closure's EOF behaviour, including
   the trailing empty line); `peekLine` is an array read, `nextLine` a
   counter bump. No more per-line indexOf or peek cache.
2. **Front matter without arrays**: two-pass scan — pass 1 finds the
   closing `---` (length + charCodeAt check, no slice), pass 2 processes
   key lines by re-scanning. Same error order as before (missing close
   beats a bad key line); `starts`/`ends` arrays gone.
3. **Paragraph span trick**: a multi-line paragraph whose lines needed
   no trimming is rendered from the raw source span
   `[pa[0], pb[last]]` instead of building a `parts` array and joining
   (the span is exactly the trimmed lines joined by `'\n'` when nothing
   was trimmed). Falls back to the join path whenever any line was
   trimmed (leading/trailing spaces/tabs). Proven by the span difftest
   (24 bodies: trailing/leading spaces and tabs, emphasis/code/link
   spanning line breaks, unicode spaces) and the 120-file fuzz.
   Blockquote was NOT given the same trick: its `> ` prefixes make the
   raw span differ from the joined text. List was considered and
   rejected on the same grounds in reverse: continuation lines always
   start with >=2 spaces, so they are always "trimmed" and the span
   branch could never fire.

## Changes tried and dropped
- **Per-run link cache** (Map keyed by `path + '\0' + target`): only
  ~26% of link calls repeat (1,219–2,232 unique of 1,580–3,142 calls
  per case). Isolated heat A/B (v6 vs v6-minus-cache, 24 paired rounds):
  without-cache was 0.885x / 0.957x median (0.924x / 0.941x trimmed)
  — the concat + Map ops on 100% of calls cost more than the hits
  saved, likely by keeping the small `link` closure from inlining.
  REVERTED; v6's `link` is byte-identical to v5's.
- **countWords variants**: not re-tried — v5's micro-benches already
  put the char loop at its floor (regex family ~50% slower); profile
  share is unchanged at 16.2% but the absolute time fell with the rest.

## Verification (final v6, after the cache revert)
- `node verify.mjs` -> **3/3 identical**.
- `scratch-v4/test-if-branch-v4.mjs` -> **PASS**.
- `scratch-v4/difftest-v4.mjs` -> **ALL 9 DIFFERENTIAL TESTS PASS**.
- `scratch-v5/difftest-v5.mjs` -> **ALL 10 V5 DIFFERENTIAL TESTS PASS**.
- `scratch-v5/fuzz-slug.mjs` -> **PASS (300 titles)**.
- `scratch-v6/difftest-para-span.mjs` -> **PASS (24 bodies)**.
- `scratch-v6/fuzz-para-span.mjs` -> **PASS (120 files)**.
- Repo size: entry-v6 total 83,669 bytes (solve.js 52,879) — well under
  the 4 MiB limit.

## Benchmarks (v5 vs v6, heat driver, fresh process, 1 warmup + 1 timed pass)
- Drive 1 (12 rounds): v5 median 239,758 / trim 243,664; v6 median
  223,604 / trim 222,203 -> **0.933x / 0.912x** (with link cache).
- Drive 2 (12 rounds): v5 median 251,343 / trim 247,364; v6 median
  226,431 / trim 232,818 -> **0.901x / 0.941x** (with link cache).
- Final, cache reverted, drive 1: v5 238,049 / 236,278; v6 225,920 /
  225,249 -> **0.949x / 0.953x**.
- Final, cache reverted, drive 2: v5 259,231 / 254,208; v6 229,374 /
  226,471 -> **0.885x / 0.891x**.
- **Combined final (24 rounds): v5 median 244,032 / trim 243,976;
  v6 median 225,920 / trim 226,398 -> 0.926x median / 0.928x trimmed
  (~7% faster than v5).**
- `bench.mjs` totals (noisy, same-code spread 138k–181k): v6 runs
  138,319 / 163,510 / 141,834 (with cache) and 155,661 / 158,410 /
  170,302 / 153,775 (final); same-day v5 runs 181,217 / 158,519 vs
  v5's logged 152,685 / 156,601. No clean sub-145k claim is possible
  from `bench.mjs` alone — the heat driver is the deciding metric.
  Latest final per-case medians (total 158,410 run): g-0001 39,376,
  g-0002 49,588, g-0003 69,446 us.

## Biggest remaining bottleneck
countWords is still ~16% and at its JS floor; renderMarkdown self
~14% and inlineCat ~11% lead the rest, then run (~6%) and GC (~5%,
down from ~7% — the span trick and fewer arrays helped). The three
kept changes together are worth ~7%; no further >5% idea was found.
The engine is now very close to its floor in plain JS: the remaining
cost is dominated by per-character work (word counting) and per-line /
per-special-char dispatch that has no cheaper exact equivalent.
