# site-generator-speed-01 — faster drop-in for makefun-site 1.0.0

Entry for the make.fun bounty **"Build a static site faster, 22 November 2026"**
(`site-generator-speed-01-run-20261122`).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
the answer makefun-site 1.0.0 returns for one generated site
(`{ site, templates, files }`), byte for byte. `main.ts` is the harness driver:
it reads `/input/cases.json`, answers each case alone with `run`, and writes
`/output/answers.json`.

## Approach

- Templates are parsed once per case and compiled with `new Function` into
  native JS (`out.push` literals, JS control flow for `if`/`for`, direct calls
  for `{% include %}`), with a small node-tree interpreter as fallback.
- Markdown renders in a single pass over index ranges (no per-line split or
  regex); front matter is a hand scanner; `slugify` is memoised per case with
  an ASCII fast path.
- Nothing is cached from one case to the next.

## Local results (practice set, 3 cases)

- Verification: 3/3 byte-identical to the reference (`node verify.mjs`).
- CPU time (median, `process.cpuUsage`, warmed): ~254,000 µs total across the
  3 cases, vs ~643,000 µs for the makefun-site 1.0.0 baseline — about 2.5x
  faster.

## License

MIT — see LICENSE.
