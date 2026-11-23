# Entry B v3 — build log (optimiser pass on v2)

## Method
- Profiled with per-phase `process.cpuUsage()` marks and long `node --cpu-prof`
  runs (4970 samples). Every change was verified with `node verify.mjs`
  (3/3 identical) after each step.
- This VM's timing noise is large (±15% run to run), so full-pipeline A/B
  medians were cross-checked three ways: interleaved A/B (30 rounds),
  separate-process `bench.mjs` repeats, and stable micro-benchmarks on the
  exact real inputs. A control A/B (v2 vs an identical v2 copy) showed the
  interleaved harness itself favours the first-imported module by ~4–6%,
  so single-direction A/B ratios were corrected for that bias.
- /tmp was wiped mid-session (VM event); all scratch work was rebuilt under
  `~/workspace/makefun/site-generator-speed-01/scratch-v3/` (durable).
  `entry/`, `entry-b/`, `entry-v2/` untouched. No submit, no login, no keys.

## Profile of v2 (long cpu-prof, 4970 samples, 30 passes)
- Inline rendering ~20% (inlineRange 8.6%, inlineStr 7.4%, INLINE_RE 3.3%),
  wordCount ~14.8% (wordCount 5.9% + `/\s\S/` regex 8.9%), codegen'd template
  functions (anon) 11.1%, GC 7.3%, run self 6.1%, renderMarkdown self 6.9%,
  escStr 5.5%, link/resolvePath 4.3%, slugify 3.8%, front matter ~2.6%.

## Changes kept (v2 -> v3)
1. **Inline via single-scan string concat (`inlineCat`)**: replaces
   `inlineStr`'s construct-test + `escStr` fast path and `inlineRange`'s
   array-push + join with one regex-jump scan building the result with `+=`
   (V8 ropes); recursion returns strings. Micro-bench on the exact 12,919
   real inline inputs: 12,975 us vs 25,202 us (~48% faster, stable samples).
2. **Range-based line handling in `renderMarkdown`**: lines are index ranges
   `[la, lb)` of the body — no per-line substrings. Helpers (`trimR`,
   `isBlankR`, `fenceLang`, `fenceClose`, `headingOf`, `isHR`,
   `endsParagraph`) all take ranges. Fence bodies are escaped with a single
   `escInto` call over the contiguous body range. Single-line paragraphs /
   headings / list items / blockquotes render straight from the range
   (`inlineStrR`) with no join. Blockquote drops the per-line regex replace.
   Standalone A/B was neutral; kept because it enables (3) and removes
   ~60k per-line slice allocations per 3-case run.
3. **Word count fused into line extraction**: `renderMarkdown` counts words
   while extracting each line (exact for the full `\s` set: ASCII fast lanes,
   unicode spaces only for c ≥ 128) and returns `words`; `cardOf` uses
   `s.words`. Removes the separate `/\s\S/g` match pass and its ~400k-entry
   match array per 3-case run. Standalone the fused loop is ~15% slower than
   the regex, but it replaces a whole pass plus its allocation.
4. **`escStr` indexOf fast path**: strings < 64 chars with no `&<>"'` via
   five `indexOf` calls return as-is. Micro-bench on 3,644 real template
   values (avg 13.8 chars): 455 us vs 637 us (~29% faster).
5. **Include-output caching** (`analyzeDeps` / `includePlan` + `C` param in
   codegen): a conservative static dependency analysis over the parsed node
   trees decides per include site whether the output is cacheable —
   constant (free roots ⊆ {site, tags, recent}, no caller reads) cached per
   (template, depth), or keyed by one loop var's value (free roots ⊆ run
   constants, exactly one non-'loop' caller read) cached per (value, depth).
   'loop' is never a key (mutated per iteration); include cycles and any
   free root outside the run constants disable caching. Cache is per-run
   (`incCache`, created in `run()`), never shared across cases. Template
   function calls per 3-case run: 13,608 → 6,279 (card 1861→617,
   header/footer 1111→3, nav 843→2). Stub ceiling for card+header+footer+nav
   alone was ~8%.

## Changes tried and dropped
- Range-based lines alone: neutral in A/B (median 1.010) — kept only as the
  enabler for (3).
- Word-count fusion alone: standalone slower than the regex; kept only as
  part of the combined set (removes the match-array allocation).
- Codegen shortcut for top-level keys (`V.page` directly, skipping the
  `has(L,…)` check): not implemented — ~0.3% and a correctness risk if a
  hidden template binds a top-level name as a for var.

## Verification
- `node verify.mjs` -> **3/3 identical** (after every change, and on the
  final promoted file).
- Differential test `scratch-v3/difftest.mjs`: v2 vs v3 agree on 9 synthetic
  tricky cases (self/mutual include cycles, caller `loop.last`, two loop
  vars, one loop var + site, same template from two fors, constant template
  wrapping a varying one, constant for-over-recent, free non-constant var).
- Repo size 48,121 bytes for solve.js (limit 4 MiB). No submit, no login,
  no keys touched.

## Benchmarks (bench.mjs, process.cpuUsage, median of 5 per case)
- v2: 10 separate-process runs, totals 204,527–255,760, **median 218,820**.
- v3: 12 separate-process runs, totals 166,360–238,754, **median ~188,000**
  (entry-v3 runs: 172,007 / 166,360 / 195,923 / 186,043).
- **v3 ≈ 0.86x v2 (~14% faster)**, median under the 190,000 us target.
  Per-case (best entry-v3 run): g-0001 ~52k, g-0002 ~46k, g-0003 ~74k.
  (Local timing is noisy on this shared VM; the medians above are over
  10–12 independent runs.)

## Biggest remaining bottleneck
Markdown inline + block processing still leads (~20% inline, ~7%
renderMarkdown self), then word count (now fused, ~10% of the loop cost
inside renderMarkdown) and template rendering (~15%). The next idea if more
headroom is needed: cache `head`/`meta` output per page-title/tag-name
(they vary only by those), or memoise `escStr` for repeated template values
(site.title, tag names, dates).
