// Differential test for the v3 include-cache if-branch bug.
// Pattern: included template "head" reads page.title ONLY inside an if-branch
// whose condition reads only site.title (a run-constant). The unfixed
// analyzeDeps never walked if-branches, so it planned "head" as const and
// cached the FIRST page's title for every page. The fix walks then/else.
// v2 has no include cache at all, so it is the correct reference.
const input = {
  site: { title: 'My Site', base_url: 'https://example.com', per_page: 10, recent: 3 },
  templates: {
    page: '{% include "head" %}\n{{ page.content }}',
    head: '{% if site.title %}<title>{{ page.title }}</title>{% endif %}',
  },
  files: [
    { path: 'a.md', content: '---\ntitle: Alpha\n---\n# Hello A\n' },
    { path: 'b.md', content: '---\ntitle: Beta\n---\n# Hello B\n' },
  ],
};
const v2 = await import('/home/hatch/workspace/makefun/site-generator-speed-01/entry-v2/solve.js');
const unfixed = await import('/home/hatch/workspace/makefun/site-generator-speed-01/scratch-v3/solve-v3-unfixed.mjs');
const fixed = await import('/home/hatch/workspace/makefun/site-generator-speed-01/entry-v4/solve.js');
const a2 = v2.run(input), au = unfixed.run(input), af = fixed.run(input);
const show = (o) => [o['alpha/index.html'], o['beta/index.html']].map((s) => (s.match(/<title>[^<]*<\/title>/) || ['(no title)'])[0]).join(' | ');
console.log('v2 (reference):', show(a2));
console.log('v3 unfixed   :', show(au));
console.log('v4 fixed     :', show(af));
console.log('unfixed == v2 ?', JSON.stringify(au) === JSON.stringify(a2), '(expect false — bug reproduced)');
console.log('v4 == v2     ?', JSON.stringify(af) === JSON.stringify(a2), '(expect true — fix works)');
if (JSON.stringify(au) === JSON.stringify(a2)) { console.log('NOTE: bug did NOT reproduce on this case'); process.exit(2); }
if (JSON.stringify(af) !== JSON.stringify(a2)) { console.log('FAIL: v4 still differs from v2'); process.exit(1); }
console.log('PASS');
