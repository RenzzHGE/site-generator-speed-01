// Differential test: v2 (uncached) vs v4 (cached) on synthetic tricky templates.
// Any output difference means the caching changed semantics (a bug).
import { run as runV2 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v3/solve.js';
import { run as runV4 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v4/solve.js';

const base = (templates, files) => ({
  site: { title: 'T', base_url: 'https://example.test/blog', per_page: 5, recent: 2 },
  templates, files,
});
const md = (path, body, extra = '') =>
  ({ path, content: `---\ntitle: "Title ${path}"\ndate: 2026-01-02\ntags: [alpha, beta]\n${extra}---\n${body}` });

const tests = {};
// 1. Self-including template (cycle) — must not be cached.
tests.cycle = base({
  page: '{% include "a" %}<p>{{ page.title }}</p>',
  a: 'A{% include "a" %}B',
}, [md('x.md', 'hello\n')]);
// 2. Mutual include cycle.
tests.mutual = base({
  page: '{% include "a" %}<p>{{ page.title }}</p>',
  a: 'A{% include "b" %}',
  b: 'B{% include "a" %}',
}, [md('x.md', 'hello\n')]);
// 3. Include reading the caller's loop var at top level (loop.last).
tests.looplast = base({
  index: '{% for p in posts %}{% include "c" %}{% endfor %}',
  c: '{% if loop.last %}LAST{% endif %}[{{ p.title }}]',
  post: 'P',
}, [
  md('posts/a.md', 'one\n'),
  md('posts/b.md', 'two\n'),
  md('posts/c.md', 'three\n'),
]);
// 4. Include reading two different loop vars.
tests.twovars = base({
  index: '{% for p in posts %}{% for t in p.tags %}{% include "c" %}{% endfor %}{% endfor %}',
  c: '[{{ p.title }}|{{ t.name }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n')]);
// 5. Include reading one loop var + site (keyed, cacheable).
tests.onevar = base({
  index: '{% for p in posts %}{% include "c" %}{% endfor %}',
  c: '[{{ p.title }}|{{ site.title }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n'), md('posts/b.md', 'two\n')]);
// 6. Same template included from two different fors with different var names.
tests.twosites = base({
  index: '{% for p in posts %}{% include "c" %}{% endfor %}',
  tag: '{% for q in tag.posts %}{% include "c" %}{% endfor %}',
  c: '[{{ p.title }}{{ q.title }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n'), md('posts/b.md', 'two\n')]);
// 7. Constant template that itself includes a varying one (must not be cached).
tests.constwrap = base({
  page: '{% include "w" %}<p>{{ page.title }}</p>',
  w: 'W[{{ site.title }}]{% include "v" %}',
  v: 'V[{{ page.title }}]',
}, [md('x.md', 'hello\n')]);
// 8. Constant template with a for over recent + loop.last inside (cacheable).
tests.constloop = base({
  page: '{% include "w" %}<p>{{ page.title }}</p>',
  w: '{% for p in recent %}{% if loop.last %}L{% endif %}{{ p.title }};{% endfor %}',
}, [md('posts/a.md', 'one\n'), md('posts/b.md', 'two\n'), md('x.md', 'hello\n')]);
// 9. Include of a template that reads a free var that is NOT a run constant.
tests.freevar = base({
  page: '{% include "w" %}<p>{{ page.title }}</p>',
  w: 'W[{{ page.slug }}]',
}, [md('x.md', 'hello\n')]);

let fails = 0;
for (const [name, input] of Object.entries(tests)) {
  let a, b, ea, eb;
  try { a = runV2(structuredClone(input)); } catch (e) { ea = e.message; }
  try { b = runV4(structuredClone(input)); } catch (e) { eb = e.message; }
  const sa = ea ? 'ERR:' + ea : JSON.stringify(a);
  const sb = eb ? 'ERR:' + eb : JSON.stringify(b);
  if (sa === sb) console.log(name, 'OK');
  else { fails++; console.log(name, 'MISMATCH'); console.log(' v2:', sa.slice(0, 400)); console.log(' v3:', sb.slice(0, 400)); }
}
console.log(fails === 0 ? 'ALL DIFFERENTIAL TESTS PASS' : fails + ' FAILURES');
