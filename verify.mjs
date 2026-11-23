// Verify entry-b solve.js against practice expected answers.
import { readFileSync } from 'node:fs';
import { run } from './solve.js';

const KIT = '/home/hatch/workspace/makefun/site-generator-speed-01/site-generator-speed-01-run-20261122-kit';
const cases = JSON.parse(readFileSync(KIT + '/practice/input/cases.json', 'utf8'));
const expected = JSON.parse(readFileSync(KIT + '/practice/reference/expected.json', 'utf8'));

let pass = 0;
for (let i = 0; i < cases.length; i++) {
  const got = run(cases[i].input);
  const want = expected.cases[i].output;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    pass++;
    console.log(cases[i].id, 'OK');
  } else {
    console.log(cases[i].id, 'MISMATCH got', a.length, 'want', b.length);
    const gk = Object.keys(got);
    const wk = Object.keys(want);
    const onlyG = gk.filter((k) => !(k in want));
    const onlyW = wk.filter((k) => !(k in got));
    console.log('  only-got:', onlyG.slice(0, 10), 'only-want:', onlyW.slice(0, 10));
    for (const k of gk) {
      if (k in want && got[k] !== want[k]) {
        console.log('  first diff key:', k);
        const g = got[k], w = want[k];
        let j = 0;
        while (j < Math.min(g.length, w.length) && g[j] === w[j]) j++;
        console.log('  at', j, 'got:', JSON.stringify(g.slice(Math.max(0, j - 80), j + 120)));
        console.log('  at', j, 'want:', JSON.stringify(w.slice(Math.max(0, j - 80), j + 120)));
        break;
      }
    }
  }
}
console.log(pass + '/' + cases.length + ' identical');
process.exit(pass === cases.length ? 0 : 1);
