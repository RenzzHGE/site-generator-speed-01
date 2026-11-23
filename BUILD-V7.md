# Entry B v7 — correctness hardening (differential fuzzing vs reference)

## Job
v6 passes practice 3/3, but the final set uses a different seed — any lurking
divergence from makefun-site 1.0.0 on unseen inputs fails the gate. This pass
is correctness only: fuzz v6 against the reference, fix divergences, re-verify.
No submit, no login, no keys. `entry/` … `entry-v6/` untouched; work in `entry-v7/`
(copied from v6).

## Harness (all in entry-v7/)
- `fuzz-v7.mjs` — kit generator (`sites.mjs` + reimplemented `rng.ts`
  xoshiro128** stream) over many seeds, 3 cases per seed (one per size band),
  ref vs v7, `JSON.stringify` compare; mismatches saved to `fuzz-mismatch/`.
- `edge-v7.mjs` — 161 hand-built cases: front matter (dates incl. leap years,
  slugs, tags, drafts, quoted-string escapes), unicode/combining/ligature/
  fullwidth titles, slug collisions, word count over every Unicode space +
  control chars, Markdown blocks (para span tricks, lists, quotes, fences,
  headings, inline soup).
- `tpl-v7.mjs` — 66 template cases: include cycles, depth cutoff (8/9/10),
  includes in fors over posts/tags/page.tags/page.toc/recent, includes
  reading loop vars / `loop`, two-deep includes, mid-template fors, includes
  inside if/else, for-var shadowing of V keys (`page`, `site`, `tags`,
  `loop`), nested same-name fors, unparseable templates, shadowed statics.
- `rand-v7.mjs` — random inline soup (800), random titles (150), random link
  targets (120). `tplrand-v7.mjs` — random templates from a grammar (300+600).

## Divergence found: 1 (fixed)
**D1 — backslash-escaped `>` not HTML-escaped (inlineCat).** v6's inline
`\`-escape branch wrote the escaped char raw (`out += s[i + 1]`); the
reference writes `escapeHtml(s[i + 1])`. Of the 14 escapable chars only `>`
is in the escape table, so only `\>` diverged: body `\>x` gave `<p>>x</p>`
instead of `<p>&gt;x</p>`. Found by the soup fuzzer (19/670 mismatches, all
this one cause — e.g. minimal `\>x`, `a\>b\&c`). The kit generator never
emits `\>` (its escapes are `\*` only), which is why 420 kit cases passed
while the soup fuzzer caught it.
Fix (`solve.js`, inlineCat `\` branch): `out += s[i+1] === '>' ? '&gt;' : s[i+1]`.
A near-miss checked and NOT a bug: front-matter `key:value` / `key:\tvalue`
looked divergent by reading, but the reference's `LINE` regex `$` anchor
makes both refuse with `line N is not "key: value"` — verified SAME by test.

## Fuzzing after the fix (all ref vs v7, JSON-identical)
- Kit generator: 420 cases (140 seeds × 3, seeds 0–139) — 0 mismatch.
- Edge: 161 — 0. Templates: 66 — 0. Random soup/titles/links: 1070 — 0.
- Random templates: 900 — 0.
- Prior suites re-run with the reference as the "old" side (adapted copies in
  /tmp/v7adapt): difftest-v4 ALL PASS, difftest-v5 ALL PASS,
  difftest-para-span 24 bodies PASS, fuzz-para-span 120 files PASS,
  fuzz-slug 300 titles PASS; test-if-branch-v4 as-is PASS.
- Practice: `node verify.mjs` 3/3 identical.
- Total: ~2,800+ differential cases post-fix, 0 mismatch.

## Notes
- The soup fuzzer's first LCG was broken (`seed * 1103515245` exceeds 2^53,
  so cases repeated with period ~171); fixed to `Math.imul` — re-ran clean.
- Speed: `bench.mjs` TOTAL median 153,055 µs vs v6 ~145k — inside v6's own
  138k–181k run-to-run spread; the fix is one ternary in the `\` branch only.
- No speed changes made. No other divergence found.
