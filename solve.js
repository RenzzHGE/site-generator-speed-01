// site-generator-speed-01 entry B v5: fast reimplementation of makefun-site 1.0.0.
// Dependency-free ES module. Strategies: template codegen via `new Function`
// (string-concat accumulator; flat op-list interpreter fallback if codegen
// ever throws), single-pass Markdown over index ranges, hand-scanned front
// matter, memoised slugify. v3 optimisations over v2: inline rendering via a
// single-scan string-concat scanner (inlineCat), range-based (slice-free)
// line handling in renderMarkdown, an indexOf fast path in escStr for short
// strings, and include-output caching (constant templates cached per depth;
// templates reading one loop var cached per that var's value) driven by a
// conservative static dependency analysis (analyzeDeps/includePlan).
// v4 optimisations over v3: word count as one whole-body pass (countWords,
// exact for the full \s set, no per-line closure calls); include calls
// factored into a shared runtime helper (incTpl) so `new Function` compiles
// less code; only reachable templates are compiled (reachableTemplates over
// kept layouts + index/tag/tags and their transitive includes).
// v5 optimisations over v4: codegen reads V directly for names provably
// never in L (callerBoundSets fixpoint over the include graph — a naive
// V-direct for ALL names breaks includes reading caller loop vars, see
// BUILD-V5.md); escStr fast path is one regex test; slugify ASCII path is
// run-based and single-pass (bails to the NFKD path on first non-ASCII
// char); fence code blocks escape via escStr instead of escInto.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const hasOwn = Object.hasOwn;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** HTML-escape `s` to a new string. Short strings take a regex fast path. */
export function escStr(s) {
  if (s.length < 64 && !ESC_TEST.test(s)) return s;
  let out = '', last = 0, m;
  ESC_RE.lastIndex = 0;
  while ((m = ESC_RE.exec(s)) !== null) {
    const i = m.index, c = s.charCodeAt(i);
    out += s.slice(last, i) + (c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    last = i + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Non-ASCII slug path (reference: NFKD, drop combining marks). */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '', gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out[e - 1] === '-') e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, exactly as the reference (NFKD, drop combining marks,
// A-Z lowered, runs of other chars one '-', cut to 64, 'untitled' if empty).
// Single pass: the run scan bails to the unicode path on the first
// non-ASCII char instead of pre-scanning the whole string. */
function slugifyRaw(text) {
  // ASCII fast path: slice maximal alnum runs (lowercased) and join with '-'.
  const parts = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let c = text.charCodeAt(i);
    if (c > 127) return slugifyUnicode(text);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      let j = i + 1;
      while (j < n) {
        c = text.charCodeAt(j);
        if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57))) break;
        j++;
      }
      parts.push(text.slice(i, j).toLowerCase());
      i = j;
    } else i++;
  }
  let out = parts.join('-').slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function slugify(text, memo) {
  let r = memo.get(text);
  if (r === undefined) { r = slugifyRaw(text); memo.set(text, r); }
  return r;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

/** A template value as text (reference textOf). */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a template value counts as true in an if (reference truthy). */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Own-property step of a template path (reference lookup tail). */
function pr(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}

// ---------------------------------------------------------------- front matter
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) { return c >= 48 && c <= 57; }

/** A quoted/bare string value, or { error } (reference stringOf). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or { error } (reference valueOf). */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') {
            return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false }
        : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
          return { error: 'key "layout": not a template name' };
        }
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/** Parse front matter: { data, body } or { error } (reference parseFrontMatter). */
function parseFrontMatter(text) {
  let p0 = text.indexOf('\n');
  const first = p0 === -1 ? text : text.slice(0, p0);
  if (first !== '---') return { error: 'no front matter' };
  let pos = p0 === -1 ? text.length : p0 + 1;
  let closeLine = -1;
  let closeStart = -1;
  let closeEnd = -1;
  let lineNo = 2;
  const starts = [];
  const ends = [];
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(pos, end) === '---') { closeLine = lineNo; closeStart = pos; closeEnd = end; break; }
    starts.push(pos);
    ends.push(end);
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < starts.length; k++) {
    const line = text.slice(starts[k], ends[k]);
    const lineNo = k + 2;
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      const key = line.slice(0, j);
      let raw = null;
      if (j === 0 || line.charCodeAt(j) !== 58) raw = null;
      else if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
      if (raw === null) return { error: 'line ' + lineNo + ' is not "key: value"' };
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c === 32 || c === 9) e--;
        else break;
      }
      raw = raw.slice(0, e);
      if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown
const ESCAPABLE = new Uint8Array(128);
for (const cc of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[cc] = 1;
const INLINE_RE = /[\\`*\[&<>"']/g;

// Trimmed range of s[a..b) is left in _ta/_tb (space/tab edges only).
let _ta = 0, _tb = 0;
function trimR(s, a, b) {
  let x = a, y = b;
  while (x < y && (s.charCodeAt(x) === 32 || s.charCodeAt(x) === 9)) x++;
  while (y > x && (s.charCodeAt(y - 1) === 32 || s.charCodeAt(y - 1) === 9)) y--;
  _ta = x; _tb = y;
}

function isBlankR(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
    || c === 95 || c === 43 || c === 45;
}

/** Fence-open language of s[a..b), or null (reference FENCE_OPEN). */
function fenceLang(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b && isLangChar(s.charCodeAt(i))) i++;
  const langEnd = i;
  while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i === b ? s.slice(a + 3, langEnd) : null;
}

function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** { depth, ta, tb } of a heading line, or null (reference headingOf). */
function headingOf(s, a, b) {
  let n = 0;
  while (a + n < b && s.charCodeAt(a + n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (a + n >= b) return null;
  const c = s.charCodeAt(a + n);
  if (c !== 32 && c !== 9) return null;
  trimR(s, a + n + 1, b);
  if (_ta === _tb) return null;
  return { depth: n, ta: _ta, tb: _tb };
}

function isHR(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a), c1 = s.charCodeAt(a + 1), c2 = s.charCodeAt(a + 2);
  if (!((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42))) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(s, a, b) {
  if (a === b) return true;
  const c0 = s.charCodeAt(a);
  if (c0 === 32 || c0 === 9) return isBlankR(s, a, b);
  if (c0 === 96) return fenceLang(s, a, b) !== null;
  if (c0 === 35) return headingOf(s, a, b) !== null;
  if (c0 === 45 || c0 === 42) return isHR(s, a, b);
  return false;
}

/** Whether the char at `j` is escaped by an odd run of backslashes in [from, j). */
function isEscaped(s, from, j) {
  let n = 0;
  for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) n++;
  return (n & 1) === 1;
}

/** First unescaped `what` at/after `from` and before `end`, or -1. */
function findUnescaped(s, what, from, end) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= end) {
    if (!isEscaped(s, from, j)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** First single `*` at/after `from` and before `end`, or -1. */
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (isEscaped(s, from, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** Inline-render a whole string. */
function inlineStr(s, env) {
  return inlineCat(s, 0, s.length, env);
}

/** Inline-render s[a..b). */
function inlineStrR(s, a, b, env) {
  return inlineCat(s, a, b, env);
}

/** Whether char code c is \s (exact for a single char). */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
    || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Inline-render s[a..b) to a string (reference inline, index-range form).
 *  Single regex-jump scan; string-concat accumulator (V8 ropes). */
function inlineCat(s, a, b, env) {
  let out = '', i = a, run = a, m;
  for (;;) {
    INLINE_RE.lastIndex = i;
    m = INLINE_RE.exec(s);
    if (m === null || m.index >= b) break;
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && s.charCodeAt(i + 1) < 128 && ESCAPABLE[s.charCodeAt(i + 1)]) {
        if (i > run) out += s.slice(run, i);
        out += s[i + 1];
        i += 2;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > run) out += s.slice(run, i);
        out += '<code>' + escStr(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          if (i > run) out += s.slice(run, i);
          out += '<strong>' + inlineCat(s, i + 2, j, env) + '</strong>';
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        if (i > run) out += s.slice(run, i);
        out += '<em>' + inlineCat(s, i + 1, j, env) + '</em>';
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let done = false;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const mm = s.indexOf(')', k + 2);
        if (mm !== -1 && mm < b) {
          const target = s.slice(k + 2, mm);
          if (target !== '' && !/\s/.test(target)) {
            if (i > run) out += s.slice(run, i);
            out += '<a href="' + escStr(env.link(target)) + '">' + inlineCat(s, i + 1, k, env) + '</a>';
            i = mm + 1;
            run = i;
            done = true;
          }
        }
      }
      if (!done) i++;
      continue;
    }
    if (i > run) out += s.slice(run, i);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    i++;
    run = i;
  }
  if (b > run) out += s.slice(run, b);
  return out;
}

/** Words of a body: runs of non-whitespace (reference wordsOf, exact for
 *  the full \s set). One whole-body pass: ASCII chars take the `c > 32`
 *  lane; the unicode-space check runs only for c >= 128 (rare). */
function countWords(src) {
  let words = 0, prevWs = true;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c > 32) {
      if (c < 128) { if (prevWs) { words++; prevWs = false; } }
      else if (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) prevWs = true;
      else if (prevWs) { words++; prevWs = false; }
    } else if (c === 32 || (c >= 9 && c <= 13)) prevWs = true;
    else if (prevWs) { words++; prevWs = false; }
  }
  return words;
}

/** Render Markdown: { html, toc, excerpt, words } (reference renderMarkdown).
 *  Lines are index ranges [la, lb) of src — no per-line substrings.
 *  Word count is one whole-body pass up front (countWords). */
function renderMarkdown(src, env, slugMemo) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  let pkA = -1, pkB = -1; // cached peekLine() range, or -1
  let la = 0, lb = 0;     // current line range
  const words = countWords(src);
  const nextLine = () => {
    if (pkA !== -1) { la = pkA; lb = pkB; pkA = -1; return true; }
    if (pos > n) return false;
    if (pos === n) { la = n; lb = n; pos = n + 1; return true; }
    const nl = src.indexOf('\n', pos);
    if (nl === -1) { la = pos; lb = n; pos = n + 1; }
    else { la = pos; lb = nl; pos = nl + 1; }
    return true;
  };
  const peekLine = () => {
    if (pkA !== -1) { la = pkA; lb = pkB; return true; }
    if (pos > n) return false;
    if (pos === n) { la = n; lb = n; return true; }
    const nl = src.indexOf('\n', pos);
    if (nl === -1) { pkA = pos; pkB = n; pos = n + 1; }
    else { pkA = pos; pkB = nl; pos = nl + 1; }
    la = pkA; lb = pkB;
    return true;
  };
  while (true) {
    if (!nextLine()) break;
    if (la === lb) continue;
    const c0 = src.charCodeAt(la);
    if ((c0 === 32 || c0 === 9) && isBlankR(src, la, lb)) continue;
    const lang = c0 === 96 ? fenceLang(src, la, lb) : null;
    if (lang !== null) {
      let fA = -1, fB = -1;
      while (true) {
        if (!nextLine()) break;
        if (fenceClose(src, la, lb)) break;
        if (fA === -1) fA = la;
        fB = lb;
      }
      const cls = lang === '' ? '' : ' class="language-' + escStr(lang) + '"';
      blocks.push('<pre><code' + cls + '>' + (fA === -1 ? '' : escStr(src.slice(fA, fB)) + '\n') + '</code></pre>');
      continue;
    }
    const hd = c0 === 35 ? headingOf(src, la, lb) : null;
    if (hd !== null) {
      const id = uniqueSlug(slugify(src.slice(hd.ta, hd.tb), slugMemo), ids);
      const html = inlineStrR(src, hd.ta, hd.tb, env);
      blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHR(src, la, lb)) { blocks.push('<hr>'); continue; }
    if (c0 === 62) {
      const qa = [], qb = [];
      let ca = la, cb = lb;
      while (true) {
        let a = ca + 1;
        if (a < cb && src.charCodeAt(a) === 32) a++;
        trimR(src, a, cb);
        if (_ta < _tb) { qa.push(_ta); qb.push(_tb); }
        if (!peekLine()) break;
        if (la >= lb || src.charCodeAt(la) !== 62) break;
        nextLine();
        ca = la; cb = lb;
      }
      if (qa.length === 0) {
        blocks.push('<blockquote>\n</blockquote>');
      } else if (qa.length === 1) {
        blocks.push('<blockquote>\n<p>' + inlineStrR(src, qa[0], qb[0], env) + '</p>\n</blockquote>');
      } else {
        const parts = [];
        for (let k = 0; k < qa.length; k++) parts.push(src.slice(qa[k], qb[k]));
        blocks.push('<blockquote>\n<p>' + inlineStr(parts.join('\n'), env) + '</p>\n</blockquote>');
      }
      continue;
    }
    let mA = -1, mB = -1, ordered = false, start = 1;
    if (c0 === 45 && src.charCodeAt(la + 1) === 32) {
      mA = la + 2; mB = lb;
    } else if (c0 === 42 && src.charCodeAt(la + 1) === 32) {
      mA = la + 2; mB = lb;
    } else if (c0 >= 48 && c0 <= 57) {
      let d = 0;
      while (d < 9 && la + d < lb) {
        const c = src.charCodeAt(la + d);
        if (c < 48 || c > 57) break;
        d++;
      }
      if (d >= 1 && src.charCodeAt(la + d) === 46 && src.charCodeAt(la + d + 1) === 32) {
        mA = la + d + 2; mB = lb; ordered = true; start = Number(src.slice(la, la + d));
      }
    }
    if (mA !== -1) {
      const ia = [], ib = [], starts = [0];
      trimR(src, mA, mB);
      ia.push(_ta); ib.push(_tb);
      while (true) {
        if (!peekLine()) break;
        let nmA = -1, nmB = -1;
        if (!ordered) {
          if ((src.charCodeAt(la) === 45 || src.charCodeAt(la) === 42) && src.charCodeAt(la + 1) === 32) { nmA = la + 2; nmB = lb; }
        } else {
          let d = 0;
          while (d < 9 && la + d < lb) {
            const c = src.charCodeAt(la + d);
            if (c < 48 || c > 57) break;
            d++;
          }
          if (d >= 1 && src.charCodeAt(la + d) === 46 && src.charCodeAt(la + d + 1) === 32) { nmA = la + d + 2; nmB = lb; }
        }
        if (nmA !== -1) {
          starts.push(ia.length);
          trimR(src, nmA, nmB);
          ia.push(_ta); ib.push(_tb);
          nextLine();
          continue;
        }
        let sp = 0;
        while (la + sp < lb && src.charCodeAt(la + sp) === 32) sp++;
        if (sp >= 2 && la + sp < lb && !isWsCode(src.charCodeAt(la + sp))) {
          trimR(src, la, lb);
          ia.push(_ta); ib.push(_tb);
          nextLine();
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let html = open + '\n';
      starts.push(ia.length);
      for (let it = 0; it < starts.length - 1; it++) {
        const s0 = starts[it], s1 = starts[it + 1];
        if (s1 - s0 === 1) {
          html += '<li>' + inlineStrR(src, ia[s0], ib[s0], env) + '</li>\n';
        } else {
          const parts = [];
          for (let k = s0; k < s1; k++) parts.push(src.slice(ia[k], ib[k]));
          html += '<li>' + inlineStr(parts.join('\n'), env) + '</li>\n';
        }
      }
      blocks.push(html + '</' + tag + '>');
      continue;
    }
    const pa = [], pb = [];
    trimR(src, la, lb);
    pa.push(_ta); pb.push(_tb);
    while (true) {
      if (!peekLine()) break;
      if (endsParagraph(src, la, lb)) break;
      nextLine();
      trimR(src, la, lb);
      pa.push(_ta); pb.push(_tb);
    }
    let html;
    if (pa.length === 1) {
      html = inlineStrR(src, pa[0], pb[0], env);
    } else {
      const parts = [];
      for (let k = 0; k < pa.length; k++) parts.push(src.slice(pa[k], pb[k]));
      html = inlineStr(parts.join('\n'), env);
    }
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ---------------------------------------------------------------- Templates
const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Parse a template into a node tree (reference parseTemplate). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null && parent.else !== undefined ? parent.else : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// Dependency analysis for include-output caching.
// analyzeDeps(parsed, name, bound) walks template `name` (and its transitive
// includes) and returns { free, caller } or null when unsafe (include cycle).
// `bound` maps names bound at this point to 'caller' (bound by an enclosing
// for in the template that includes this one) or 'local' (bound by a for
// inside this template). A reference to a 'caller' name is a dependency on
// the caller's value; a 'local' name is derived from a for collection that
// is itself recorded as a dependency. `free` holds roots read while unbound.
// Run-constants are site/tags/recent (same objects for the whole run), so a
// template is cacheable only when free ⊆ {site,tags,recent} and its caller
// reads are empty (constant) or a single non-'loop' var (keyed by its value).
// 'loop' is never a key: the loop object is mutated per iteration.
const RUN_CONSTANTS = new Set(['site', 'tags', 'recent']);
function analyzeDeps(parsed, name, bound, seen) {
  if (seen.has(name)) return null;
  const nodes = parsed[name];
  if (nodes === undefined) return { free: new Set(), caller: new Set() };
  seen.add(name);
  const free = new Set(), caller = new Set();
  let ok = true;
  const note = (path, bnd) => {
    const f = path[0];
    const src = bnd.get(f);
    if (src === 'caller') caller.add(f);
    else if (src === undefined) free.add(f);
  };
  const walk = (list, bnd) => {
    for (const n of list) {
      if (!ok) return;
      if (n.kind === 'var' || n.kind === 'raw') {
        note(n.path, bnd);
      } else if (n.kind === 'if') {
        note(n.path, bnd);
        walk(n.then, bnd);
        if (n.else !== null) walk(n.else, bnd);
      } else if (n.kind === 'for') {
        note(n.path, bnd);
        const nb = new Map(bnd);
        nb.set(n.name, 'local');
        nb.set('loop', 'local');
        walk(n.body, nb);
      } else if (n.kind === 'include') {
        const d = analyzeDeps(parsed, n.name, bnd, seen);
        if (d === null) { ok = false; return; }
        for (const x of d.free) free.add(x);
        for (const x of d.caller) caller.add(x);
      }
    }
  };
  walk(nodes, bound);
  seen.delete(name);
  return ok ? { free, caller } : null;
}

/** Cache plan for an include of `name` with `boundArr` (gen's bound stack):
 *  { kind: 'const' } | { kind: 'key', key: varName } | null (do not cache). */
function includePlan(parsed, name, boundArr) {
  const bound = new Map();
  for (const b of boundArr) bound.set(b, 'caller');
  if (boundArr.length > 0) bound.set('loop', 'caller');
  const d = analyzeDeps(parsed, name, bound, new Set());
  if (d === null) return null;
  for (const f of d.free) if (!RUN_CONSTANTS.has(f)) return null;
  if (d.caller.size === 0) return { kind: 'const' };
  if (d.caller.size === 1) {
    const v = [...d.caller][0];
    if (v !== 'loop') return { kind: 'key', key: v };
  }
  return null;
}

/** Include call with output caching (see includePlan). plan: 0 = no cache,
 *  1 = cache per depth (run-constants only), 2 = cache per (key value, depth).
 *  Factored out of the generated code so `new Function` compiles less code. */
function incTpl(T, nm, plan, key, V, L, depth, esc, txt, tru, pr, has, C, inc) {
  if (depth >= 8) return '';
  const f = T[nm];
  if (f === undefined) return '';
  if (plan === 0) return f(V, L, depth + 1, T, esc, txt, tru, pr, has, C, inc);
  let m = C[nm];
  if (m === undefined) m = C[nm] = new Map();
  if (plan === 1) {
    let s = m.get(depth);
    if (s === undefined) { s = f(V, L, depth + 1, T, esc, txt, tru, pr, has, C, inc); m.set(depth, s); }
    return s;
  }
  const k = L[key];
  let d = m.get(k);
  if (d === undefined) {
    const s = f(V, L, depth + 1, T, esc, txt, tru, pr, has, C, inc);
    m.set(k, new Map([[depth, s]]));
    return s;
  }
  let s = d.get(depth);
  if (s === undefined) { s = f(V, L, depth + 1, T, esc, txt, tru, pr, has, C, inc); d.set(depth, s); }
  return s;
}

/** Templates reachable from `roots` via transitive includes (parsed trees).
 *  Only these can ever render, so only these need compiling; the rest are
 *  parsed (for the layout-exists check and the dependency analysis) but
 *  never compiled. */
function reachableTemplates(parsed, roots) {
  const seen = new Set();
  const stack = [];
  for (const r of roots) if (parsed[r] !== undefined) stack.push(r);
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === 'include') {
        if (parsed[n.name] !== undefined && !seen.has(n.name)) stack.push(n.name);
      } else if (n.kind === 'for') walk(n.body);
      else if (n.kind === 'if') {
        walk(n.then);
        if (n.else !== null) walk(n.else);
      }
    }
  };
  while (stack.length > 0) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    walk(parsed[n]);
  }
  return seen;
}

/** Names that may be present in L when template `name` renders, coming from
 *  a caller (for-vars bound at an include site, transitively). L starts
 *  empty for root renders and only for-loops bind names, so a name outside
 *  this set (and outside the template's own bound stack) can never be in L
 *  and codegen may read V directly. 'loop' is included when the template
 *  can be included from inside a for. Fixpoint over the include graph
 *  (cycles possible; sets only grow). */
function callerBoundSets(parsed) {
  const edges = []; // { from, to, bound: Set }
  const walk = (list, bound, from) => {
    for (const n of list) {
      if (n.kind === 'for') {
        const nb = new Set(bound); nb.add(n.name); nb.add('loop');
        walk(n.body, nb, from);
      } else if (n.kind === 'if') {
        walk(n.then, bound, from);
        if (n.else !== null) walk(n.else, bound, from);
      } else if (n.kind === 'include') {
        edges.push({ from, to: n.name, bound: new Set(bound) });
      }
    }
  };
  for (const name of Object.keys(parsed)) walk(parsed[name], new Set(), name);
  const cb = new Map();
  for (const name of Object.keys(parsed)) cb.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const to = cb.get(e.to);
      if (to === undefined) continue; // include of an unparsed template renders ''
      const from = cb.get(e.from);
      for (const x of e.bound) if (!to.has(x)) { to.add(x); changed = true; }
      if (from !== undefined) for (const x of from) if (!to.has(x)) { to.add(x); changed = true; }
    }
  }
  return cb;
}

/** Codegen: compile a node tree to a function (V, L, out, depth, T). */
function compileTemplate(nodes, parsed, callerBound) {
  let uid = 0;
  // Emit a path expression. `bound` is the stack of for-var names enclosing
  // this point (innermost last); 'loop' is bound whenever the stack is non-empty.
  // A name bound locally reads L directly. A name in `callerBound` (bound by
  // a for in some template that includes this one) may be in L, so it keeps
  // the hasOwn check. Any other name can never be in L (L starts empty for
  // root renders; only for-loops bind, and they restore on exit), so it
  // reads V directly — no hasOwn call or ternary per access.
  const pathExpr = (path, bound) => {
    const first = path[0];
    let expr;
    if (first === 'loop') {
      if (bound.length > 0) expr = 'L.loop';
      else if (callerBound.has('loop')) expr = '(has(L,"loop")?L.loop:V.loop)';
      else expr = 'V.loop';
    } else if (bound.includes(first)) {
      expr = 'L.' + first;
    } else if (callerBound.has(first)) {
      expr = '(has(L,' + JSON.stringify(first) + ')?L.' + first + ':V.' + first + ')';
    } else {
      expr = 'V.' + first;
    }
    for (let k = 1; k < path.length; k++) expr = 'pr(' + expr + ',' + JSON.stringify(path[k]) + ')';
    return expr;
  };
  const gen = (list, bound, code) => {
    for (const n of list) {
      if (n.kind === 'text') {
        code.push('s+=' + JSON.stringify(n.text) + ';');
      } else if (n.kind === 'var') {
        code.push('s+=esc(txt(' + pathExpr(n.path, bound) + '));');
      } else if (n.kind === 'raw') {
        code.push('s+=txt(' + pathExpr(n.path, bound) + ');');
      } else if (n.kind === 'if') {
        code.push('if(tru(' + pathExpr(n.path, bound) + ')!==' + n.not + '){');
        gen(n.then, bound, code);
        if (n.else !== null) {
          code.push('}else{');
          gen(n.else, bound, code);
        }
        code.push('}');
      } else if (n.kind === 'for') {
        const u = uid++;
        const xs = '__x' + u, nn = '__n' + u, ii = '__i' + u;
        const ox = '__o' + u, hx = '__h' + u, ol = '__p' + u, hl = '__q' + u, lp = '__l' + u;
        code.push('{const ' + xs + '=' + pathExpr(n.path, bound) + ';');
        code.push('if(Array.isArray(' + xs + ')){const ' + nn + '=' + xs + '.length;');
        code.push('const ' + hx + '=has(L,' + JSON.stringify(n.name) + ');const ' + ox + '=L.' + n.name + ';');
        code.push('const ' + hl + '=has(L,"loop");const ' + ol + '=L.loop;');
        code.push('const ' + lp + '={index:0,first:false,last:false,length:' + nn + '};');
        code.push('for(let ' + ii + '=0;' + ii + '<' + nn + ';' + ii + '++){');
        code.push('L.' + n.name + '=' + xs + '[' + ii + '];L.loop=' + lp + ';');
        code.push(lp + '.index=' + ii + '+1;' + lp + '.first=' + ii + '===0;' + lp + '.last=' + ii + '===' + nn + '-1;');
        gen(n.body, bound.concat([n.name]), code);
        code.push('}');
        code.push('if(' + hx + ')L.' + n.name + '=' + ox + ';else delete L.' + n.name + ';');
        code.push('if(' + hl + ')L.loop=' + ol + ';else delete L.loop;}}');
      } else if (n.kind === 'include') {
        const plan = includePlan(parsed, n.name, bound);
        const nm = JSON.stringify(n.name);
        const pk = plan === null ? '0' : plan.kind === 'const' ? '1' : '2';
        const kk = plan !== null && plan.kind === 'key' ? JSON.stringify(plan.key) : '0';
        code.push('s+=__inc(T,' + nm + ',' + pk + ',' + kk + ',V,L,depth,esc,txt,tru,pr,has,C,__inc);');
      }
    }
  };
  const code = ['let s="";'];
  gen(nodes, [], code);
  code.push('return s;');
  const src = code.join('');
  return new Function('V', 'L', 'depth', 'T', 'esc', 'txt', 'tru', 'pr', 'has', 'C', '__inc', src);
}

/** Fallback interpreter over the node tree (used only if codegen throws). */
function lookupPath(L, V, path) {
  let v;
  if (hasOwn(L, path[0])) v = L[path[0]];
  else v = V[path[0]];
  for (let k = 1; k < path.length; k++) v = pr(v, path[k]);
  return v;
}

function renderNodesFb(nodes, V, L, out, depth, T, C) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(n.text);
    else if (n.kind === 'var') out.push(escStr(textOf(lookupPath(L, V, n.path))));
    else if (n.kind === 'raw') out.push(textOf(lookupPath(L, V, n.path)));
    else if (n.kind === 'if') {
      const branch = truthy(lookupPath(L, V, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodesFb(branch, V, L, out, depth, T, C);
    } else if (n.kind === 'for') {
      const xs = lookupPath(L, V, n.path);
      if (!Array.isArray(xs)) continue;
      const hx = hasOwn(L, n.name), ox = L[n.name];
      const hl = hasOwn(L, 'loop'), ol = L.loop;
      const lp = { index: 0, first: false, last: false, length: xs.length };
      for (let k = 0; k < xs.length; k++) {
        L[n.name] = xs[k];
        L.loop = lp;
        lp.index = k + 1; lp.first = k === 0; lp.last = k === xs.length - 1;
        renderNodesFb(n.body, V, L, out, depth, T, C);
      }
      if (hx) L[n.name] = ox; else delete L[n.name];
      if (hl) L.loop = ol; else delete L.loop;
    } else if (n.kind === 'include') {
      const t = T[n.name];
      if (t !== undefined && depth < INCLUDE_DEPTH) {
        if (typeof t === 'function') out.push(t(V, L, depth + 1, T, escStr, textOf, truthy, pr, hasOwn, C, incTpl));
        else renderNodesFb(t.nodes, V, L, out, depth + 1, T, C);
      }
    }
  }
}

// ---------------------------------------------------------------- Pipeline
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

function resolvePath(dir, rel) {
  if (rel !== '.' && !rel.endsWith('/.') && rel.indexOf('..') === -1 && rel.indexOf('./') === -1
    && rel.indexOf('//') === -1 && rel.charCodeAt(rel.length - 1) !== 47) {
    return dir === '' ? rel : dir + '/' + rel;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

export function run(input) {
  const slugMemo = new Map();
  const report = [];
  const templates = Object.create(null);
  // Parse all templates first: include caching needs every template's nodes
  // before any of them is compiled.
  const parsed = Object.create(null);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed[name] = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Per-run include-output cache (never shared across cases).
  const incCache = Object.create(null);
  const render = (name, V) => {
    const t = templates[name];
    if (t === undefined) return null;
    const L = Object.create(null);
    if (typeof t === 'function') return t(V, L, 0, templates, escStr, textOf, truthy, pr, hasOwn, incCache, incTpl);
    const out = [];
    renderNodesFb(t.nodes, V, L, out, 0, templates, incCache);
    return out.join('');
  };

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    }
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (parsed[layout] === undefined) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // Compile only the templates that can render: the kept sources' layouts
  // plus index/tag/tags, and their transitive includes. The rest are parsed
  // (for the layout check above and the dependency analysis) but never
  // compiled; render() never asks for them.
  const roots = ['index', 'tag', 'tags'];
  for (const s of kept) roots.push(s.layout);
  const reachable = reachableTemplates(parsed, roots);
  const cbSets = callerBoundSets(parsed);
  for (const name of [...reachable].sort(byCodeUnits)) {
    try {
      templates[name] = compileTemplate(parsed[name], parsed, cbSets.get(name) || new Set());
    } catch (e) {
      templates[name] = { nodes: parsed[name] };
    }
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, slugMemo), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (target.startsWith('/') || target.startsWith('#')) return target;
        const ci = target.indexOf(':');
        if (ci > 0) {
          let scheme = true;
          const c0 = target.charCodeAt(0);
          if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) scheme = false;
          else {
            for (let i = 1; i < ci; i++) {
              const c = target.charCodeAt(i);
              if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) {
                scheme = false;
                break;
              }
            }
          }
          if (scheme) return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const tgt = bySource.get(path);
          if (tgt !== undefined) return tgt.url + frag;
          if (staticPaths.has(path)) return base + '/' + path + frag;
        }
        broken.add('broken-link ' + s.path + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags !== undefined ? s.data.tags : [])) {
      const sl = slugify(name, slugMemo);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name, slugMemo);
      return bySlug.get(sl) !== undefined ? bySlug.get(sl) : { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : {
    title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary !== undefined ? s.data.summary : '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => {
    const c = cardOf(s);
    return {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long,
      summary: c.summary, excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: s.slug, content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer !== undefined && s.newer !== null ? s.newer : null),
      older: linkOf(s.older !== undefined && s.older !== null ? s.older : null),
      is_post: s.post,
    };
  };

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const mkV = (vars) => Object.assign(Object.create(null), { site, tags: allTags, recent }, vars);
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, mkV({ page: pageOf(s) }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', mkV({
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k, total: pages, url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    }));
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  const tagOf = (t) => ({
    name: t.name, slug: t.slug, url: t.url, count: t.posts.length,
    posts: t.posts.map((p) => cards.get(p)),
  });
  for (const t of tags) {
    const html = render('tag', mkV({ tag: tagOf(t) }));
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', mkV({}));
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = kept.filter((s) => !s.post).length;
  lines.push('built ' + npages + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}
