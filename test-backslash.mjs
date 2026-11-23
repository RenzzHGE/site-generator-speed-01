const v7 = await import('/home/hatch/workspace/makefun/site-generator-speed-01/entry-v7/solve.js');
const ref = await import('/home/hatch/workspace/makefun/site-generator-speed-01/site-generator-speed-01-run-20261122-kit/baselines/makefun-site/solve.js');
const v6 = await import('/home/hatch/workspace/makefun/site-generator-speed-01/entry-v6/solve.js');
const body = '\\>x \\*y \\\\z \\`c\\` \\!q \\#h \\+p \\-m \\.d \\(e\\) \\[f\\] \\_u \\>w\n';
const input = { site: { title: 'T', base_url: 'https://x.example', per_page: 10, recent: 3 },
  templates: { page: '{{ page.content }}' },
  files: [{ path: 'a.md', content: '---\ntitle: A\n---\n' + body }] };
const a = v7.run(input), b = ref.run(input), c = v6.run(input);
console.log('v7 :', JSON.stringify(a['a/index.html']));
console.log('ref:', JSON.stringify(b['a/index.html']));
console.log('v6 :', JSON.stringify(c['a/index.html']));
console.log('v7 == ref ?', JSON.stringify(a) === JSON.stringify(b));
console.log('v6 == ref ?', JSON.stringify(c) === JSON.stringify(b));
