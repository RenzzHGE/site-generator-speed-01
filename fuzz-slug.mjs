// Fuzz slugify end-to-end: random tricky titles through v4 vs v5 run().
import { run as runV4 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v4/solve.js';
import { run as runV5 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v5/solve.js';
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pieces = ['Hello', 'WORLD', 'foo-bar', 'a', 'Z', '123', ' ', '-', '--', '  ', '.', '_', 'café', 'naïve', 'Ångström', 'é', '😀', 'Ω', 'ß', 'ﬀ', 'x'.repeat(70), 'a-'.repeat(40), 'MiXeD CaSe', '\t', 'a_b', '0', '---', 'ü'];
let fails = 0;
for (let t = 0; t < 300; t++) {
  let title = '';
  const k = 1 + Math.floor(rnd() * 6);
  for (let j = 0; j < k; j++) title += pick(pieces);
  const input = {
    site: { title: 'T', base_url: 'https://example.test/blog', per_page: 5, recent: 2 },
    templates: { page: '<h1>{{ page.title }}</h1><p>{{ page.slug }}</p>' },
    files: [{ path: 'x.md', content: `---\ntitle: "${title.replace(/"/g, '')}"\ndate: 2026-01-02\n---\n# ${title.replace(/\n/g, ' ')}\nbody\n` }],
  };
  // also exercise heading slugs with the same title as a heading
  const a = runV4(structuredClone(input));
  const b = runV5(structuredClone(input));
  if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log('MISMATCH title:', JSON.stringify(title)); console.log(' v4:', JSON.stringify(a).slice(0, 300)); console.log(' v5:', JSON.stringify(b).slice(0, 300)); if (fails > 3) break; }
}
console.log(fails === 0 ? 'SLUG FUZZ PASS (300 titles)' : fails + ' FAILURES');
