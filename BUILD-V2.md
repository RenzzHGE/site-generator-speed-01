# Entry B v2 — build log (optimiser pass on v1)

## Method
- Profiled with per-phase `process.cpuUsage()` marks, `node --cpu-prof`,
  and micro-benchmarks of individual functions on the practice bodies.
- Every change was A/B-tested against the previous best with an interleaved
  harness (both versions in one process, alternating, forced GC, 16 rounds
  x 5 inner runs). This VM's timing noise is large (identical setups swing
  ~+/-10%), so a change was kept only if it won in both directions of the
  A/B (roles swapped). Reverted as neutral-or-worse: `"x" in L` codegen
  (variant 2, ~3% worse), cached card-tag/link views + paragraph
  first-line trick (v5, ~5-10% worse), fused `escTxt` (neutral),
  JS-local loop vars in codegen (neutral), inlined `truthy()` (repeats the
  path expression ~6x, 6-15% worse).

## Profile of v1 (per case, avg of 5)
- Markdown 34-48%, template rendering 31-48%, cards/tags 10-12%,
  front matter 3-4%, file sort 3%, template parse+compile 1-3%.
- Hot functions: `inlineRange` 16%, `renderMarkdown` 13%, `cardOf` +
  `/\S+/g` ~15% combined, template render ~15%, `escStr` 6%, GC ~5%.

## Changes kept (v1 -> v2)
1. **Escape via regex jump** (`escStr`/`escInto`): scan with
   `/[&<>"']/g` exec instead of a per-char loop. Micro-bench 2.2x faster.
2. **Inline scanner via regex jump**: `inlineRange` jumps to the next
   special char with `/[\\`*\[&<>"']/g` instead of stepping char by char;
   `ESCAPABLE_CC` Set replaced by a `Uint8Array` table. Construct-free
   strings take a fast path (`inlineStr`: no constructs -> `escStr` only).
3. **`findUnescaped`/`findSingleStar` via `indexOf`**: candidates found
   with `indexOf`, escaped-ness decided by odd/even backslash run before
   the candidate (proved equivalent: pairs never straddle a run boundary).
4. **Word count via transitions**: `reading_minutes` from
   `(s.match(/\s\S/g) || []).length` + first-char test instead of
   `match(/\S+/g)`. Micro-bench ~25% faster; manual scan, sticky-exec,
   replace-callback and indexOf variants all lost to it.
5. **Template codegen uses string concat**: generated functions build
   `let s = ""` with `s += ...` and return `s` (includes return strings)
   instead of `out.push(...)` + `out.join('')`. A/B ~7-8% faster.
6. **Markdown first-char dispatch**: main loop computes `c0` once and
   only calls `fenceLang`/`headingOf`/`isHR` when the first char can
   match; `endsParagraph` dispatches on first char (space-start lines
   only need the blank check); single-line `join` fast paths;
   `blocks.join('\n') + '\n'` instead of `blocks.map(b => b + '\n')`.
   A/B ~7-9% faster.
7. **Small wins**: peek-line cache in `renderMarkdown`; front matter
   single scan (line ranges recorded during the close scan, reused for
   the data scan); `trimLine` fast path (no edge whitespace -> return
   the line as-is); fence bodies built with array + `join`; CRLF
   fast path (`indexOf('\r') === -1` skips the replace); `resolvePath`
   fast path for `..`-free targets; single `bySource.get` in `link`;
   `toc: s.toc` (reference `md.toc` entries are exactly
   `{level, id, html}`, so the map was a no-op copy).

## Verification
- `node verify.mjs` -> **3/3 identical** (after every change).
- Repo size 51,330 bytes (limit 4 MiB). No submit, no login, no keys
  touched. `entry/` and `entry-b/` untouched.

## Benchmarks (process.cpuUsage, warmed)
- Interleaved A/B, 16 rounds: v1 median 179,805 us total vs v2 median
  142,044 us total -> **v2 is 0.79x v1 (~21% faster)**.
- `node bench.mjs` (parent's metric, median of 5): v2 totals 196,336 /
  225,797 / 226,585 us across three runs (v1: 245,078 / 260,720 on the
  same metric; parent's v1 figure 253,810). Per-case (best run):
  g-0001 ~43-59k, g-0002 ~61-70k, g-0003 ~87-106k.
- Warmed 15-sample harness: v2 total 157,534 (g-0001 41,798;
  g-0002 55,552; g-0003 60,184) vs v1 187,539.

## Biggest remaining bottleneck
Markdown inline + block processing (~45-50% of runtime): `inlineRange`
+ `inlineStr` + `wordCount` regex + `renderMarkdown` self. `wordCount`
(+ its regex) alone is ~14%; every alternative counter (manual scan,
sticky-exec, replace-callback, indexOf skipping) measured slower than
the `/\s\S/g` transitions regex. Next ideas if more headroom is needed:
range-based (slice-free) line handling in `renderMarkdown`, or fusing
the construct test and the escape scan in `inlineStr` into one pass.
