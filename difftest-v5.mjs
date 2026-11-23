// Differential test: v4 (known-good) vs v5 (caller-bound V-direct codegen).
// Any output difference means the optimisation changed semantics (a bug).
import { run as runV4 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v4/solve.js';
import { run as runV5 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v5/solve.js';

const base = (templates, files) => ({
  site: { title: 'T', base_url: 'https://example.test/blog', per_page: 5, recent: 2 },
  templates, files,
});
const md = (path, body, extra = '') =>
  ({ path, content: `---\ntitle: "Title ${path}"\ndate: 2026-01-02\ntags: [alpha, beta]\n${extra}---\n${body}` });

const tests = {};
// 1. Include inside for reading loop var + site + page (the v5 naive-break case).
tests.cardinfor = base({
  index: '{% for p in posts %}{% include "card" %}{% endfor %}',
  card: '[{{ p.title }}|{{ site.title }}|{{ p.url }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n'), md('posts/b.md', 'two\n')]);
// 2. Include AFTER a for ends, reading the loop var (restore semantics:
//    at root L has no p, so {{ p.title }} must be empty, not V's).
tests.afterfor = base({
  index: '{% for p in posts %}X{% endfor %}[{{ p.title }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n')]);
// 3. Shadowing: outer for binds p; included template has its own for over p,
//    then includes another template reading p (must see the OUTER p again
//    after the inner for restores it).
tests.shadowrestore = base({
  index: '{% for p in posts %}{% include "w" %}{% endfor %}',
  w: '{% for p in recent %}{{ p.title }};{% endfor %}{% include "r" %}',
  r: '[{{ p.title }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n'), md('posts/b.md', 'two\n')]);
// 4. loop.* read inside an included template.
tests.loopininclude = base({
  index: '{% for p in posts %}{% include "c" %}{% endfor %}',
  c: '{{ loop.index }}/{{ loop.length }}{% if loop.first %}F{% endif %}{% if loop.last %}L{% endif %};',
  post: 'P',
}, [md('posts/a.md', 'one\n'), md('posts/b.md', 'two\n'), md('posts/c.md', 'three\n')]);
// 5. Include inside an if-branch inside a for, reading the loop var.
tests.ifbranchinfor = base({
  index: '{% for p in posts %}{% if p.title %}Y{% include "c" %}{% else %}N{% endif %}{% endfor %}',
  c: '[{{ p.title }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n'), md('posts/b.md', 'two\n')]);
// 6. Same template included from a for AND from root (different L states).
tests.twocontexts = base({
  index: '{% for p in posts %}{% include "c" %}{% endfor %}',
  page: '{% include "c" %}<p>{{ page.title }}</p>',
  c: '[{{ p.title }}|{{ site.title }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n'), md('x.md', 'hello\n')]);
// 7. Nested includes through a for (transitive caller-bound).
tests.nestedinc = base({
  index: '{% for p in posts %}{% include "w" %}{% endfor %}',
  w: 'W{% include "c" %}',
  c: '[{{ p.title }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n')]);
// 8. A V name that is also a for-var name elsewhere, but never at this
//    template's include sites (V-direct must apply, same output as v4).
tests.vnameelsewhere = base({
  page: '{{ tag.name }}|{{ site.title }}',
  tag: '{% for tag in tags %}{{ tag.name }};{% endfor %}',
}, [md('x.md', 'hello\n')]);
// 9. Two nested fors, include reads both vars + loop.
tests.twonested = base({
  index: '{% for p in posts %}{% for t in p.tags %}{% include "c" %}{% endfor %}{% endfor %}',
  c: '[{{ p.title }}|{{ t.name }}|{{ loop.index }}]',
  post: 'P',
}, [md('posts/a.md', 'one\n')]);
// 10. Include cycle through a for (depth cap still applies).
tests.cycleinfor = base({
  index: '{% for p in posts %}{% include "a" %}{% endfor %}',
  a: 'A[{{ p.title }}]{% include "a" %}',
  post: 'P',
}, [md('posts/a.md', 'one\n')]);

let fails = 0;
for (const [name, input] of Object.entries(tests)) {
  let a, b, ea, eb;
  try { a = runV4(structuredClone(input)); } catch (e) { ea = e.message; }
  try { b = runV5(structuredClone(input)); } catch (e) { eb = e.message; }
  const sa = ea ? 'ERR:' + ea : JSON.stringify(a);
  const sb = eb ? 'ERR:' + eb : JSON.stringify(b);
  if (sa === sb) console.log(name, 'OK');
  else { fails++; console.log(name, 'MISMATCH'); console.log(' v4:', sa.slice(0, 300)); console.log(' v5:', sb.slice(0, 300)); }
}
console.log(fails === 0 ? 'ALL V5 DIFFERENTIAL TESTS PASS' : fails + ' FAILURES');
