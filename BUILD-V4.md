# Entry B v4 — build log (optimiser pass on v3)

## Method
- Profiled with per-phase `process.cpuUsage()` marks and `node --cpu-prof`
  on cold single passes. Every change was verified with `node verify.mjs`
  (3/3 identical) after each step, plus `scratch-v4/test-if-branch-v4.mjs`
  (the v3 if-branch differential, re-pointed at v4) and
  `scratch-v4/difftest-v4.mjs` (v4 vs v3 on 9 synthetic tricky templates).
- This VM's timing noise is large (±15–20% run to run), so claims rest on
  interleaved A/B (same process, roles swapped) rather than separate-process
  `bench.mjs` medians, which swung 165k–207k for the same code in one
  session. `entry/`, `entry-b/`, `entry-v2/`, `entry-v3/` untouched.
  No submit, no login, no keys. Scratch work in `scratch-v4/`.

## Profile of v3 (per-phase marks, 10 passes, warm)
- Markdown 59–63% (inline ~40k, word count ~26–29k fused, block loop ~27k),
  template render ~15%, front matter ~5%, template parse+compile ~4%,
  rest (slugify, sorting, tag building, object creation, GC) ~11–14%.

## Changes kept (v3 -> v4)
1. **Word count as one whole-body pass (`countWords`)**: replaces the
   fused per-line `countRange` closure (called once per line, ~53k calls)
   with a single pass over the body. ASCII chars take the `c > 32` lane;
   the unicode-space check runs only for `c >= 128`. Exact for the full
   `\s` set: proven by `scratch-v4/test-countwords.mjs` (edge cases:
   every unicode space, control chars, lone surrogates, astral chars,
   empty input + 3000 fuzz strings vs reference `match(/\S+/g)`).
   Micro-bench (interleaved, 9 rounds): fused 29.2k -> inlineUS 22.6k
   per 3-case pass (~23% faster on the word-count pass).
2. **Include calls factored into a shared helper (`incTpl`)**: codegen
   used to inline ~95/230/430 chars of cache logic per include site;
   now each site emits one short `__inc(...)` call and the helper does
   the depth/cache work. Semantics identical (same depth<8, missing
   template, const/key plans). Generated code 53,782 -> 45,240 chars.
   Matters for the heat: each timed round is a fresh container, so V8's
   `new Function` source cache does not carry over; fresh-compile
   micro-bench (new sources every rep): 6,213 us -> 4,746 us.
3. **Compile only reachable templates (`reachableTemplates`)**: the kept
   sources' layouts + `index`/`tag`/`tags` and their transitive includes
   (walked over the parsed trees, `if` then/else included). Unreachable
   templates are still parsed (layout-exists check + dependency analysis)
   but never compiled. Practice set: 70 -> 51 templates compiled
   (27% skipped). The layout-exists check now reads `parsed[layout]`
   instead of `templates[layout]` (same condition: parses or not).
   Fresh compile after (2)+(3): 4,746 -> 3,731 us; generated code
   45,240 -> 36,070 chars.

## Changes tried and dropped
- **Inline fast paths** for `*`/`**`/`]` (inline `indexOf` + prev-char
  check, falling back to `findSingleStar`/`findUnescaped`): correct on
  all 33,347 real inputs + synthetic cases, but ~0–4% on the markup
  micro-bench — the `indexOf` work dominates either way. Not shipped.
- **Rope HTML instead of `blocks.join('\n')`**: 0.83x in a bench that
  discards output, but SLOWER (291k vs 254k) once `JSON.stringify` is
  included, as the real heat does (main.ts stringifies the answers
  inside the timed run). The join copy is real work; ropes only defer
  it into the serializer. Not shipped.
- **Head/meta multi-key include cache**: interleaved ceilings for
  head/meta/card/toc were all within noise (<= ~7k each); the
  generalisation (composite keys over read paths) was not worth the
  correctness risk. Not shipped.
- **Link memoisation**: only 30% repeat rate on (dir, target); ~0.4k.
  Not shipped.
- **Inline-input caching**: plain inputs repeat heavily (7,899 unique
  of 20,195) but are already ~1 regex exec each; markup inputs (the
  expensive ones) barely repeat (7,603 unique of 7,638). Not shipped.

## Verification
- `node verify.mjs` -> **3/3 identical** (after every change).
- `scratch-v4/test-if-branch-v4.mjs` -> **PASS** (v4 == v2 reference on
  the head-template if-branch case; the unfixed bug still reproduces).
- `scratch-v4/difftest-v4.mjs` -> **ALL 9 DIFFERENTIAL TESTS PASS**
  (cycles, loop.last, two loop vars, one loop var + site, constant
  wrapping varying, constant for-over-recent, free non-constant var).
- `scratch-v4/test-countwords.mjs` -> **OK on all edge cases + fuzz**.
- Repo size 69,528 bytes total (solve.js 49,729); limit 4 MiB.
  No submit, no login, no keys touched.

## Benchmarks
- Interleaved A/B, v3 vs v4, same process, 15 rounds each direction:
  v3-first: v4/v3 = **0.905x** (147,283 vs 162,809 median);
  v4-first: v4/v3 = **0.935x** (145,524 vs 155,588 median).
  Mean of the two directions: **~0.92x** (about 8% faster warm).
- Separate-process `bench.mjs` medians are too noisy on this VM to
  quote (165k–207k for identical code across runs in one session).
- Heat proxies (fresh node process per round, 9 rounds, trimmed mean):
  run-only v3 404,879 vs v4 372,774 (0.92x); full process incl. JSON
  parse/stringify/write v3 621,907 vs v4 598,311 (0.96x) in one run,
  but a 15-round interleaved full-process run gave 1.02–1.05x — the
  full-process proxy's round-to-round spread (±15%) swamps a ~4%
  difference, so treat the warm A/B (0.92x) as the claim and the heat
  proxies as consistent-with / not-contradicting it.
- Per-case warm medians (best bench.mjs run): g-0001 ~47–61k,
  g-0002 ~45–51k, g-0003 ~68–83k (noisy; see above).

## Biggest remaining bottleneck
Markdown inline (~40k warm) + block loop (~27k) still lead, then the
template render phase (~25k) and GC (~10% of a cold pass). The inline
scanner is near its floor in JS (per-match regex exec + string work);
the block loop's per-line `nextLine`/`peekLine` calls (~84k calls/pass)
are the next candidate, but inlining them is invasive for an estimated
~3k. Cold-pass profile also shows node startup/module loading (~10%)
inside the timed region, which no solve.js change can move.
