// v7 differential fuzzer: kit generator, many seeds, ref vs entry-v7.
// Usage: node fuzz-v7.mjs [nSeeds=70] [seedStart=0]
// Each seed draws 3 cases (one per size band). Mismatching inputs are
// saved under ./fuzz-mismatch/ for minimisation.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { generate } from '/home/hatch/workspace/makefun/site-generator-speed-01/site-generator-speed-01-run-20261122-kit/program/generator/subject/sites.mjs';
import { run as ref } from '/home/hatch/workspace/makefun/site-generator-speed-01/site-generator-speed-01-run-20261122-kit/baselines/makefun-site/solve.js';
import { run as v7 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v7/solve.js';

const rotl = (x, k) => (x << k) | (x >>> (32 - k));
class Rng {
  constructor(key) {
    const v = new DataView(key.buffer, key.byteOffset, 16);
    this.a = v.getUint32(0) | 0; this.b = v.getUint32(4) | 0;
    this.c = v.getUint32(8) | 0; this.d = v.getUint32(12) | 0;
  }
  u32() {
    const a = this.a, b = this.b;
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    let c = this.c ^ a, d = this.d ^ b;
    const nb = b ^ c, na = a ^ d;
    c ^= t; d = rotl(d, 11);
    this.a = na; this.b = nb; this.c = c; this.d = d;
    return r;
  }
  int(lo, hi) {
    const span = hi - lo + 1, limit = Math.floor(2 ** 32 / span) * span;
    let x = this.u32();
    while (x >= limit) x = this.u32();
    return lo + (x % span);
  }
  float() { return this.u32() / 2 ** 32; }
  pick(xs) { return xs[this.int(0, xs.length - 1)]; }
  chance(p) { return this.float() < p; }
}
const streamFor = (seed, label, index) =>
  new Rng(createHash('sha256').update(`makefun/speed-home/rng/v1\n${seed}\n${label}\n${index}`).digest());
const seedOf = (i) => createHash('sha256').update(`v7-fuzz-seed-${i}`).digest('hex');

export function diffSummary(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  const onlyA = ka.filter((k) => !(k in b)), onlyB = kb.filter((k) => !(k in a));
  if (onlyA.length || onlyB.length) return { onlyA: onlyA.slice(0, 5), onlyB: onlyB.slice(0, 5) };
  for (const k of ka) {
    if (a[k] !== b[k]) {
      const g = a[k], w = b[k];
      let j = 0;
      while (j < Math.min(g.length, w.length) && g[j] === w[j]) j++;
      return { key: k, at: j, gotLen: g.length, wantLen: w.length,
        got: g.slice(Math.max(0, j - 80), j + 120), want: w.slice(Math.max(0, j - 80), j + 120) };
    }
  }
  return { note: 'same keys and values but JSON differs (key order?)' };
}

const nSeeds = Number(process.argv[2] ?? 70);
const start = Number(process.argv[3] ?? 0);
const outDir = new URL('./fuzz-mismatch/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
let total = 0, bad = 0;
const t0 = Date.now();
for (let s = start; s < start + nSeeds; s++) {
  const seed = seedOf(s);
  for (let i = 0; i < 3; i++) {
    const input = generate(streamFor(seed, 'case', i), i);
    total++;
    let a, b, errA = null, errB = null;
    try { a = ref(input); } catch (e) { errA = String(e); }
    try { b = v7(input); } catch (e) { errB = String(e); }
    const same = errA === null && errB === null && JSON.stringify(a) === JSON.stringify(b);
    if (!same) {
      bad++;
      const id = `seed${s}-case${i}`;
      writeFileSync(outDir + id + '.json', JSON.stringify(input));
      console.log(`MISMATCH ${id} refErr=${errA} v7Err=${errB}`);
      if (errA === null && errB === null) console.log(' ', JSON.stringify(diffSummary(a, b)).slice(0, 600));
    }
  }
  if ((s - start + 1) % 10 === 0) console.log(`... ${s - start + 1}/${nSeeds} seeds, ${total} cases, ${bad} mismatch, ${Date.now() - t0}ms`);
}
console.log(`DONE ${total} cases, ${bad} mismatch, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(bad === 0 ? 0 : 1);
