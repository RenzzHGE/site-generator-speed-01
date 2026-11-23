// Benchmark entry-b solve.js: median CPU microseconds per case (process.cpuUsage).
import { readFileSync } from 'node:fs';
import { run } from './solve.js';

const KIT = '/home/hatch/workspace/makefun/site-generator-speed-01/site-generator-speed-01-run-20261122-kit';
const cases = JSON.parse(readFileSync(KIT + '/practice/input/cases.json', 'utf8'));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Warmup (also JITs the codegen'd template functions).
for (const c of cases) run(c.input);

let total = 0;
for (const c of cases) {
  const samples = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.cpuUsage();
    run(c.input);
    const d = process.cpuUsage(t0);
    samples.push(d.user + d.system);
  }
  const m = median(samples);
  total += m;
  console.log(c.id, 'median cpu_us:', m, 'samples:', samples.join(','));
}
console.log('TOTAL median cpu_us:', total);
