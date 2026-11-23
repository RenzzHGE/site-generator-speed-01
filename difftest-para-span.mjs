// Differential test: v5 (join path) vs v6 (paragraph span trick) on synthetic
// markdown bodies designed to break the span optimisation: leading/trailing
// spaces and tabs on continuation lines, inline constructs spanning line
// breaks, empty-ish lines, emphasis/code/links across lines.
import { run as runV5 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v5/solve.js';
import { run as runV6 } from '/home/hatch/workspace/makefun/site-generator-speed-01/entry-v6/solve.js';

const base = (templates, files) => ({
  site: { title: 'T', base_url: 'https://example.test/blog', per_page: 5, recent: 2 },
  templates, files,
});
const tpl = { page: '<h1>{{ page.title }}</h1>{{ page.content }}' };
const md = (path, body) =>
  ({ path, content: `---\ntitle: "Title ${path}"\ndate: 2026-01-02\ntags: [alpha]\n---\n${body}` });

const bodies = {
  plain2: 'hello world\nsecond line here\n',
  plain3: 'one\ntwo\nthree\nfour\n',
  trailSpace: 'hello   \nsecond line\n',
  trailTab: 'hello\t\nsecond\n',
  leadSpace: 'hello\n  second indented\nthird\n',
  leadTab: 'hello\n\tsecond tabbed\n',
  leadAndTrail: '  hello  \n  world  \n',
  emAcross: 'some *emphasis\nspanning lines* here\n',
  strongAcross: 'some **bold\nspanning** here\n',
  codeAcross: 'text `code\nspan` end\n',
  linkAcross: 'see [link text\ncontinued](target.md) here\n',
  linkTarget: 'see [a](posts/a.md) and [b](posts/a.md) end\n',
  ampEntity: 'fish & chips\nmore & more\n',
  escape: 'a \\* b\nc \\[ d\n',
  mixed: 'first *em\n* line\nsecond **b\n** line\n`c\n` end\n',
  singleLineTrail: 'only line   \n',
  blankBetween: 'para one\n\npara two\npara two b\n',
  listAfter: 'para line\npara line 2\n\n- item one\n- item two\n',
  headingAfter: 'para\npara2\n\n## Head\n',
  quoteAfter: 'para\npara2\n\n> quote\n> quote2\n',
  fenceAfter: 'para\npara2\n\n```\ncode\n```\n',
  hrAfter: 'para\npara2\n\n---\n',
  unicodeWs: 'hello\u00a0world\nsecond\u2003line\n',
  crlf: 'hello\r\nsecond\r\n',
};
const files = Object.entries(bodies).map(([k, b], i) => md(`p${i}-${k}.md`, b));
files.push(md('posts/a.md', 'target body\n'));
const input = base(tpl, files);
const a = JSON.stringify(runV5(input));
const b = JSON.stringify(runV6(input));
if (a === b) console.log('PARA-SPAN DIFFTEST PASS (' + Object.keys(bodies).length + ' bodies)');
else {
  console.log('PARA-SPAN DIFFTEST FAIL');
  const ja = JSON.parse(a), jb = JSON.parse(b);
  for (const k of Object.keys(ja)) if (ja[k] !== jb[k]) {
    console.log('diff key:', k);
    let j = 0; while (j < Math.min(ja[k].length, jb[k].length) && ja[k][j] === jb[k][j]) j++;
    console.log(' at', j, 'v5:', JSON.stringify(ja[k].slice(Math.max(0, j - 60), j + 100)));
    console.log(' at', j, 'v6:', JSON.stringify(jb[k].slice(Math.max(0, j - 60), j + 100)));
  }
  process.exit(1);
}
