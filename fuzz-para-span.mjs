// Fuzz the paragraph-span optimisation: random markdown bodies, v5 vs v6.
import { run as runV5 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v5/solve.js';
import { run as runV6 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v6/solve.js';
let seed = 20261123;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const words = ['hello', 'world', 'foo', 'bar', 'lorem', 'ipsum', '*em*', '**strong**', '`code`', '[link](posts/a.md)', '&amp;', 'a *b', 'x]y', 'a\\*b', '#tag', 'under_score', 'dash-ed', '123', ''];
const files = [];
for (let f = 0; f < 120; f++) {
  const lines = [];
  const n = 1 + Math.floor(rnd() * 14);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.08) { lines.push(''); continue; }
    if (r < 0.13) { lines.push(pick(['## Head', '### H3', '---', '```', 'code line', '```', '> quote', '- item', '1. one'])); continue; }
    let line = '';
    const nw = 1 + Math.floor(rnd() * 6);
    for (let w = 0; w < nw; w++) line += (w ? ' ' : '') + pick(words);
    if (rnd() < 0.3) line = ' '.repeat(Math.floor(rnd() * 4)) + line;
    if (rnd() < 0.3) line += ' '.repeat(Math.floor(rnd() * 4));
    if (rnd() < 0.1) line += '\t';
    lines.push(line);
  }
  files.push({ path: `f${f}.md`, content: `---\ntitle: "F ${f}"\ndate: 2026-01-02\ntags: [alpha]\n---\n` + lines.join('\n') + '\n' });
}
files.push({ path: 'posts/a.md', content: '---\ntitle: "A"\ndate: 2026-01-02\ntags: [alpha]\n---\ntarget\n' });
const input = {
  site: { title: 'T', base_url: 'https://example.test/blog', per_page: 5, recent: 2 },
  templates: { page: '<h1>{{ page.title }}</h1>{{ page.content }}' },
  files,
};
const a = JSON.stringify(runV5(input));
const b = JSON.stringify(runV6(input));
if (a === b) console.log('PARA-SPAN FUZZ PASS (120 files)');
else {
  console.log('PARA-SPAN FUZZ FAIL');
  const ja = JSON.parse(a), jb = JSON.parse(b);
  for (const k of Object.keys(ja)) if (ja[k] !== jb[k]) {
    console.log('diff key:', k);
    let j = 0; while (j < Math.min(ja[k].length, jb[k].length) && ja[k][j] === jb[k][j]) j++;
    console.log(' at', j, 'v5:', JSON.stringify(ja[k].slice(Math.max(0, j - 60), j + 100)));
    console.log(' at', j, 'v6:', JSON.stringify(jb[k].slice(Math.max(0, j - 60), j + 100)));
    break;
  }
  process.exit(1);
}
