// Swiftforge — a drop-in fast build for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// run(input) returns the exact output tree that makefun-site 1.0.0's build(input) returns, for every input:
// same files, same bytes, same report. The rules are makefun-site's own (its vendored README.md; its code is
// the reference). This module re-implements them with hand-written charCode scanners instead of the
// per-line and per-character regexes of the reference, keeps every cache strictly inside one run(input)
// call, and builds each case from its input alone: no clock, no environment, no randomness, no file reads.

// ---------------------------------------------------------------- text rules (README, "Text")

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The months of `date_long`, 1-12. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The characters a backslash escapes in Markdown inline text. */
const ESCAPABLE = new Uint8Array(128);
for (const c of '\\`*_[]()#+-.!>') ESCAPABLE[c.charCodeAt(0)] = 1;

/** JavaScript-regex `\s` (what \S, /\s/ and .trim see), as a table. */
const WS_TABLE = new Uint8Array(128);
for (const c of [32, 9, 10, 11, 12, 13, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;

/** The characters the HTML escape table replaces: & < > " '. */
const ESC_TRIGGER = new Uint8Array(128);
for (const c of '&<>"\'') ESC_TRIGGER[c.charCodeAt(0)] = 1;

/** The characters inline() handles itself: backslash escapes, code spans, emphasis, links, and the five
 * escape-table characters. (A `]` is only ever read as part of a link's text, never a trigger.) */
const INLINE_TRIGGER = new Uint8Array(128);
for (const c of '\\`*[&<>"\'') INLINE_TRIGGER[c.charCodeAt(0)] = 1;

/** `text` with & < > " ' escaped; the original string when none of them appears. */
function esc(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (ESC_TRIGGER[s.charCodeAt(i)]) break;
    i++;
  }
  if (i === n) return s;
  let out = s.slice(0, i);
  while (i < n) {
    const c = s.charCodeAt(i);
    let j = i + 1;
    while (j < n && !ESC_TRIGGER[s.charCodeAt(j)]) j++;
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    if (j > i + 1) out += s.slice(i + 1, j);
    i = j;
  }
  return out;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and
 * 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left. Iterates code units: astral units are never kept, so they fall in the same runs.
 */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const n = plain.length;
  let out = '';
  let gap = false;
  for (let i = 0; i < n; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  let e = out.length < 64 ? out.length : 64;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  const cut = e === out.length ? out : out.slice(0, e);
  return cut === '' ? 'untitled' : cut;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDateRaw(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- front matter (README, "Front matter")

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    const n = raw.length;
    const last = n - 1;
    if (n < 2 || raw.charCodeAt(last) !== 34) return { error: 'a quoted string is not closed' };
    const bs = raw.indexOf('\\');
    const bq = raw.indexOf('"', 1);
    if (bs === -1 && bq === last) return { value: raw.slice(1, last) };
    let out = '';
    let i = 1;
    while (i < last) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const d = i + 1 < n ? raw.charCodeAt(i + 1) : -1;
        if ((d !== 34 && d !== 92) || i + 1 === last) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw[i + 1];
        i += 2;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
      else {
        out += raw[i];
        i++;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** One known key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const n = raw.length;
      let bad = n !== 10;
      if (!bad) {
        for (let p = 0; p < 10; p++) {
          if (p === 4 || p === 7) {
            if (raw.charCodeAt(p) !== 45) {
              bad = true;
              break;
            }
          } else {
            const c = raw.charCodeAt(p);
            if (c < 48 || c > 57) {
              bad = true;
              break;
            }
          }
        }
      }
      if (bad) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
      const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      const n = raw.length;
      if (n < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(n - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, n - 1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let p = 0; p < t.length; p++) {
          const c = t.charCodeAt(p);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let p = 0; p < raw.length; p++) {
        const c = raw.charCodeAt(p);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return raw === '' ? { error: 'key "layout": not a template name' } : { value: raw };
    }
    case 'slug': {
      // ^[a-z0-9]+(?:-[a-z0-9]+)*$ and at most 64 characters
      const n = raw.length;
      if (n > 64 || n === 0) return { error: 'key "slug": not a slug' };
      let p = 0;
      for (;;) {
        let run = 0;
        while (p < n) {
          const c = raw.charCodeAt(p);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
            p++;
            run++;
          } else break;
        }
        if (run === 0) return { error: 'key "slug": not a slug' };
        if (p === n) break;
        if (raw.charCodeAt(p) !== 45) return { error: 'key "slug": not a slug' };
        p++;
        if (p === n) return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text`
 * has "\n" line ends. Two passes, as the reference scans the whole front matter for its closing "---" before
 * it reads any line.
 */
function parseFrontMatter(text) {
  const len = text.length;
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // The close: the first line after line 0 that is exactly "---".
  let closeIdx = -1;
  let closeEnd = -1;
  {
    let ls = firstNl + 1;
    let idx = 1;
    while (ls <= len) {
      let e = text.indexOf('\n', ls);
      if (e === -1) e = len;
      if (e - ls === 3 && text.charCodeAt(ls) === 45 && text.charCodeAt(ls + 1) === 45 && text.charCodeAt(ls + 2) === 45) {
        closeIdx = idx;
        closeEnd = e === len ? len : e + 1;
        break;
      }
      ls = e + 1;
      idx++;
    }
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = firstNl + 1;
  for (let i = 1; i < closeIdx; i++) {
    let e = text.indexOf('\n', ls);
    if (e === -1) e = len;
    const line = text.slice(ls, e);
    ls = e + 1;
    const n = line.length;
    let p = 0;
    while (p < n) {
      const c = line.charCodeAt(p);
      if (c !== 32 && c !== 9) break;
      p++;
    }
    if (p === n) continue; // blank
    if (n > 0 && line.charCodeAt(0) === 35) continue; // comment
    const ks = p;
    while (p < n) {
      const c = line.charCodeAt(p);
      if ((c >= 97 && c <= 122) || c === 95) p++;
      else break;
    }
    const key = line.slice(ks, p);
    if (key === '' || p >= n || line.charCodeAt(p) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    p++;
    let raw;
    if (p >= n) raw = '';
    else if (line.charCodeAt(p) === 32) raw = line.slice(p + 1);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e2 = raw.length;
    while (e2 > 0) {
      const c = raw.charCodeAt(e2 - 1);
      if (c !== 32 && c !== 9) break;
      e2--;
    }
    if (e2 !== raw.length) raw = raw.slice(0, e2);
    switch (key) {
      case 'title':
      case 'date':
      case 'tags':
      case 'draft':
      case 'layout':
      case 'slug':
      case 'summary':
        break;
      default:
        return { error: `unknown key "${key}"` };
    }
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === len ? '' : text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown (README, "Markdown")

/** Whether `line` holds spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A JavaScript-regex `\s` code (the whitespace \S and /\s tests see). The table covers ASCII; above it
 * only the few non-ASCII \s codes remain (surrogates never match \s). */
function isWsCode(c) {
  if (c < 128) return WS_TABLE[c] === 1;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** A fence-open line: ``` + optional language [A-Za-z0-9_+-]* + spaces/tabs; its language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  const n = line.length;
  let j = 3;
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** A fence-close line: ``` with spaces and tabs only after. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null: 1-6 `#`, at least one space or tab, then non-empty text. */
function headingOf(line) {
  const n = line.length;
  let k = 0;
  while (k < n && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  const c = k < n ? line.charCodeAt(k) : -1;
  if (c !== 32 && c !== 9) return null;
  let j = k + 1;
  while (j < n) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) break;
    j++;
  }
  let e = n;
  while (e > j) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  if (e === j) return null;
  return { depth: k, text: line.slice(j, e) };
}

/** A thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const n = line.length;
  if (n < 3) return false;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(1);
  const c2 = line.charCodeAt(2);
  if (!((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42))) return false;
  for (let k = 3; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item: two or more spaces then a non-whitespace character. */
function isContinued(line) {
  const n = line.length;
  let k = 0;
  while (k < n && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= n) return false;
  return !isWsCode(line.charCodeAt(k));
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  const n = line.length;
  let s = 0;
  while (s < n) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  let e = n;
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return s === 0 && e === n ? line : line.slice(s, e);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. The four are
 * exclusive by first character, so one check dispatches. */
function endsParagraph(line) {
  const n = line.length;
  if (n === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 96) return fenceLang(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** The first index from `from` where `s` holds `**` outside a backslash escape, or -1. */
function findDD(s, from) {
  const n = s.length;
  for (let j = from; j + 1 < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The first `code` from `from` outside a backslash escape, or -1. */
function findUnescapedChar(s, from, code) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c === code) return j;
  }
  return -1;
}

const WS_RE = /\s/;

/**
 * `s` rendered inline: left to right, backslash escapes, code spans, strong, emphasis, links; every other
 * character escaped. `link(target)` is the href of a `[text](target)`.
 */
function inline(s, link) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (INLINE_TRIGGER[c]) {
      if (c === 92) {
        if (i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)]) {
          const d = s.charCodeAt(i + 1);
          out += d === 62 ? '&gt;' : s[i + 1];
          i += 2;
        } else {
          out += '\\';
          i++;
        }
      } else if (c === 96) {
        const j = s.indexOf('`', i + 1);
        if (j > i + 1) {
          out += `<code>${esc(s.slice(i + 1, j))}</code>`;
          i = j + 1;
        } else {
          out += '`';
          i++;
        }
      } else if (c === 42) {
        if (s.charCodeAt(i + 1) === 42) {
          const j = findDD(s, i + 2);
          if (j > i + 2) {
            out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
            i = j + 2;
          } else {
            out += '**';
            i += 2;
          }
        } else {
          const j = findSingleStar(s, i + 1);
          if (j > i + 1) {
            out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
            i = j + 1;
          } else {
            out += '*';
            i++;
          }
        }
      } else if (c === 91) {
        const k = findUnescapedChar(s, i + 1, 93);
        let m = -1;
        if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
        const target = m === -1 ? '' : s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          out += `<a href="${esc(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
          i = m + 1;
        } else {
          out += '[';
          i++;
        }
      } else {
        out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
        i++;
      }
    } else {
      let j = i + 1;
      while (j < n && !INLINE_TRIGGER[s.charCodeAt(j)]) j++;
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

/** The words of a body: its runs of characters other than whitespace, counted without allocating. The
 * whitespace check is spelled out here (not through isWsCode) so the hot loop stays call-free. */
function wordsOf(text) {
  const n = text.length;
  let count = 0;
  let inWord = false;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c === 32 || c === 10 || c === 9 || c === 13) ws = true;
    else if (c === 11 || c === 12) ws = true;
    else if (c < 128) ws = WS_TABLE[c] === 1;
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (inWord) {
      if (ws) inWord = false;
    } else if (!ws) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or ""). A fence's language is [A-Za-z0-9_+-] only, which the escape table never changes.
 */
function renderMarkdown(src, link, slugOf) {
  const lines = src.split('\n');
  const n = lines.length;
  let out = '';
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? 32 : line.charCodeAt(0);
    // The block kinds are exclusive by first character: a blank or tab-started line is only ever blank,
    // a backtick only ever a fence, a `#` only ever a heading, a `>` only ever a quote; `-` and `*` are
    // a break or a bullet, digits an ordered list; anything else is a paragraph.
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let body = '';
        while (i < n && !isFenceClose(lines[i])) {
          body += `${esc(lines[i])}\n`;
          i++;
        }
        i++;
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        out += `<pre><code${cls}>${body}</code></pre>
`
        ;
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugOf(heading.text), ids);
        const html = inline(heading.text, link);
        out += `<h${heading.depth} id="${id}">${html}</h${heading.depth}>
`
        ;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const q = lines[i];
        const stripped = q.charCodeAt(1) === 32 ? q.slice(2) : q.slice(1);
        qlines.push(trimLine(stripped));
        i++;
      }
      let body = '';
      for (const q of qlines) if (q !== '') body = body === '' ? q : `${body}\n${q}`;
      out += body === '' ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body, link)}</p>\n</blockquote>\n`
      ;
      continue;
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out += '<hr>\n'
        ;
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        // A bullet list: `- ` here, and `* ` items too (one marker for both).
        const items = [];
        while (i < n) {
          const li = lines[i];
          const lc = li.charCodeAt(0);
          if ((lc === 45 || lc === 42) && li.charCodeAt(1) === 32) {
            items.push(trimLine(li.slice(2)));
            i++;
          } else if (isContinued(li)) {
            items[items.length - 1] = `${items[items.length - 1]}\n${trimLine(li)}`;
            i++;
          } else break;
        }
        let body = '';
        for (const item of items) body += `<li>${inline(item, link)}</li>\n`;
        out += `<ul>\n${body}</ul>\n`
        ;
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      // An ordered list: 1-9 digits, `. `, and each later line of the same kind.
      let d = 1;
      while (d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        const orderStart = Number(line.slice(0, d));
        const items = [];
        while (i < n) {
          const li = lines[i];
          let e = 0;
          while (e < 9 && li.charCodeAt(e) >= 48 && li.charCodeAt(e) <= 57) e++;
          if (e > 0 && e < 10 && li.charCodeAt(e) === 46 && li.charCodeAt(e + 1) === 32) {
            items.push(trimLine(li.slice(e + 2)));
            i++;
          } else if (isContinued(li)) {
            items[items.length - 1] = `${items[items.length - 1]}\n${trimLine(li)}`;
            i++;
          } else break;
        }
        const open = orderStart !== 1 ? `<ol start="${orderStart}">` : '<ol>';
        let body = '';
        for (const item of items) body += `<li>${inline(item, link)}</li>\n`;
        out += `${open}\n${body}</ol>\n`
        ;
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence, a heading or a break.
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      text += `\n${trimLine(lines[i])}`;
      i++;
    }
    const html = inline(text, link);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`
    ;
  }
  return { html: out, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates (README, "Templates")

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const hop = Object.prototype.hasOwnProperty;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const n = text.length;
  let i = 0;
  if (n === 0) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  const c0 = text.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  i = 1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) {
      i++;
      continue;
    }
    if (c === 46) {
      const d = i + 1 < n ? text.charCodeAt(i + 1) : -1;
      if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95)) {
        throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
      }
      i += 2;
      continue;
    }
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** Whether `s` holds any JavaScript-regex whitespace. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/** Whether `s` is a template name: 1-64 of a-z, 0-9 and `-` (as `{% include "name" %}` reads it). */
function includeNameOk(s) {
  const n = s.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** A tag `for <name> in <path>`: its loop name and path, or null when the tag is not one. */
function parseForTag(tag) {
  // ^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$
  if (!tag.startsWith('for ') || tag.length < 5) return null;
  const c0 = tag.charCodeAt(4);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
  const n = tag.length;
  let p = 5;
  while (p < n) {
    const c = tag.charCodeAt(p);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) p++;
    else break;
  }
  if (p + 4 > n) return null;
  if (tag.charCodeAt(p) !== 32 || tag.charCodeAt(p + 1) !== 105 || tag.charCodeAt(p + 2) !== 110 || tag.charCodeAt(p + 3) !== 32) return null;
  const rest = tag.slice(p + 4);
  if (rest === '' || hasWs(rest)) return null;
  return { name: tag.slice(4, p), rest };
}

/** A tag `if (not )?<path>`: { not, rest }, or null when the tag is not one. */
function parseIfTag(tag) {
  // ^if (not )?(\S+)$
  if (!tag.startsWith('if ') || tag.length < 4) return null;
  let p = 3;
  let not = false;
  if (tag.startsWith('not ', 3)) {
    not = true;
    p = 7;
  }
  const rest = tag.slice(p);
  if (rest === '' || hasWs(rest)) return null;
  return { not, rest };
}

/** A tag `include "<name>"`: the name, or null when the tag is not one. */
function parseIncludeTag(tag) {
  // ^include "([a-z0-9-]+)"$
  const n = tag.length;
  if (n < 11) return null;
  if (tag.charCodeAt(7) !== 32 || tag.charCodeAt(8) !== 34 || tag.charCodeAt(n - 1) !== 34) return null;
  const nm = tag.slice(9, n - 1);
  return includeNameOk(nm) ? nm : null;
}

/** `src`'s tokens: 0 text, 1 var, 2 raw, 3 tag; a standalone tag's line taken with it. */
function tokenize(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') toks.push({ t: 0, s: text });
      text = '';
      toks.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') toks.push({ t: 0, s: text });
    text = '';
    toks.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') toks.push({ t: 0, s: text });
  return toks;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). Node kinds: 0 text, 1 var,
 * 2 raw, 3 if, 4 for, 5 include. */
function parseTemplate(name, src) {
  const root = [];
  // The stack holds the open for/if nodes; each entry carries the body new tokens append to.
  const stack = [{ kind: 0, body: root, node: null }];
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) stack[stack.length - 1].body.push({ t: 0, s: tok.s });
    else if (tok.t === 1 || tok.t === 2) stack[stack.length - 1].body.push({ t: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const f = parseForTag(tag);
      if (f !== null) {
        const loop = { index: 0, first: false, last: false, length: 0 };
        const vars = { [f.name]: undefined, loop };
        const node = { t: 4, name: f.name, path: pathOf(name, f.rest), body: [], vars, loop };
        top.body.push(node);
        stack.push({ kind: 4, body: node.body, node });
      } else {
        const cond = parseIfTag(tag);
        if (cond !== null) {
          const node = { t: 3, not: cond.not, path: pathOf(name, cond.rest), then: [], els: null };
          top.body.push(node);
          stack.push({ kind: 3, body: node.then, node });
        } else if (tag === 'else') {
          if (top.kind !== 3 || top.node.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
          top.node.els = [];
          top.body = top.node.els;
        } else if (tag === 'endfor' || tag === 'endif') {
          const want = tag === 'endfor' ? 4 : 3;
          if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
          stack.pop();
        } else {
          const inc = parseIncludeTag(tag);
          if (inc !== null) top.body.push({ t: 5, name: inc });
          else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
        }
      }
    }
  }
  if (stack.length > 1) {
    const kind = stack[stack.length - 1].kind;
    throw new TemplateError(`template "${name}": a ${kind === 4 ? 'for' : 'if'} is not closed`);
  }
  return root;
}

/** The value at `path` in the scope stack: its first name from the innermost scope holding it, then own properties. */
function lookup(scopes, top, path) {
  const k = path[0];
  for (let s = top; s >= 0; s--) {
    const vars = scopes[s];
    if (hop.call(vars, k)) {
      let v = vars[k];
      for (let p = 1; p < path.length; p++) {
        if (v === null || typeof v !== 'object' || !hop.call(v, path[p])) return undefined;
        v = v[path[p]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined
 * by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in the scope stack `scopes` (innermost at `top`). `tctx` holds the parsed templates. */
function renderNodes(nodes, scopes, top, tctx, depth) {
  let out = '';
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    const t = nd.t;
    if (t === 0) out += nd.s;
    else if (t === 1) out += esc(textOf(lookup(scopes, top, nd.path)));
    else if (t === 2) out += textOf(lookup(scopes, top, nd.path));
    else if (t === 3) {
      const v = truthy(lookup(scopes, top, nd.path));
      const branch = v !== nd.not ? nd.then : nd.els;
      if (branch !== null) out += renderNodes(branch, scopes, top, tctx, depth);
    } else if (t === 4) {
      const xs = lookup(scopes, top, nd.path);
      if (Array.isArray(xs)) {
        const len = xs.length;
        const body = nd.body;
        const vars = nd.vars;
        const loop = nd.loop;
        scopes.push(vars);
        const inner = top + 1;
        const nm = nd.name;
        for (let k = 0; k < len; k++) {
          vars[nm] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          loop.length = len;
          out += renderNodes(body, scopes, inner, tctx, depth);
        }
        scopes.pop();
      }
    } else {
      const tn = tctx.templates.get(nd.name);
      if (tn !== undefined && depth < 8) out += renderNodes(tn, scopes, top, tctx, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build (README, "The build, in order")

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
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

/** A link's resolver for one source: scheme, / and # targets as written, paths resolved to pages and static
 * files, misses reported as broken and kept as written. Results are memoized per source (the resolver is
 * pure within one case). */
function makeLink(srcPath, dir, bySource, staticPaths, base, broken) {
  const cache = new Map();
  return (target) => {
    const hit = cache.get(target);
    if (hit !== undefined) return hit;
    let out;
    // A target with a scheme (https:, mailto: ...), opening on / or opening on # is kept as written.
    const c0 = target.charCodeAt(0);
    let scheme = false;
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      let j = 1;
      const n = target.length;
      while (j < n) {
        const c = target.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) j++;
        else break;
      }
      scheme = j < n && target.charCodeAt(j) === 58;
    }
    if (scheme || c0 === 47 || c0 === 35) {
      out = target;
    } else {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) out = bySource.get(path).url + frag;
      else if (path !== null && staticPaths.has(path)) out = `${base}/${path}${frag}`;
      else {
        broken.add(`broken-link ${srcPath} -> ${target}`);
        out = target;
      }
    }
    cache.set(target, out);
    return out;
  };
}

/** A post's card, as lists show it. */
function cardOf(s, longDateOf) {
  const d = s.data.date;
  const tags = s.tagRefs;
  const tagList = new Array(tags.length);
  for (let i = 0; i < tags.length; i++) tagList[i] = { name: tags[i].name, slug: tags[i].slug, url: tags[i].url };
  return {
    title: s.data.title,
    url: s.url,
    date: d === undefined ? '' : d,
    date_long: d === undefined ? '' : longDateOf(d),
    summary: s.data.summary === undefined ? '' : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: tagList,
  };
}

/** A page's link record as templates read it. */
function linkObj(s, longDateOf) {
  const d = s.data.date;
  return {
    title: s.data.title,
    url: s.url,
    date: d === undefined ? '' : d,
    date_long: d === undefined ? '' : longDateOf(d),
  };
}

/** A page as its layout reads it. */
function pageOf(s, longDateOf) {
  const c = cardOf(s, longDateOf);
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newer === undefined || s.newer === null ? null : linkObj(s.newer, longDateOf),
    older: s.older === undefined || s.older === null ? null : linkObj(s.older, longDateOf),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text, byte for byte what makefun-site 1.0.0's build returns. */
export function run(input) {
  // Per-case memo tables, created here and dead when the call returns: never shared across cases.
  const slugMemo = new Map();
  const slugOf = (t) => {
    let v = slugMemo.get(t);
    if (v === undefined) {
      v = slugifyRaw(t);
      slugMemo.set(t, v);
    }
    return v;
  };
  const dateMemo = new Map();
  const longDateOf = (d) => {
    let v = dateMemo.get(d);
    if (v === undefined) {
      v = longDateRaw(d);
      dateMemo.set(d, v);
    }
    return v;
  };

  // 1. The templates, in code-unit order of their names; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  const tnames = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of tnames) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const tctx = { templates };

  const base = input.site.base_url.replace(/\/+$/, '');

  // 2. The sources, in code-unit order of their paths; a file that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      // Every property a source gains across the pipeline, set once here: one hidden class for all sources,
      // no per-phase transitions.
      sources.push({ path: f.path, text, srcDir: dirOf(f.path), data: null, body: '', post: false, layout: '', slug: '', outDir: '', url: '', html: '', toc: null, excerpt: '', tagRefs: null, card: null, newer: null, older: null });
    } else statics.push(f);
  }

  // 3. Front matter, then the order of refusals: reserved directory, a post with no date, a layout that is
  // no template that parses, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    const post = s.path.startsWith('posts/');
    const own = post ? null : s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout === undefined ? (post ? 'post' : 'page') : data.layout;
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    s.data = data;
    s.body = fm.body;
    s.post = post;
    s.layout = layout;
    kept.push(s);
  }

  // 4. Permalinks: each page's directory, its slug made unique in it, and its url.
  const takenDirs = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : s.srcDir;
    let taken = takenDirs.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED : []);
      takenDirs.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug === undefined ? slugOf(s.data.title) : s.data.slug, taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown: each body rendered, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of kept) {
    const link = makeLink(s.path, s.srcDir, bySource, staticPaths, base, broken);
    const md = renderMarkdown(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. Collections: the posts, newest date first and equal dates by slug; newer and older neighbours.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. Tags: grouped by slug, each named as first met walking the posts, ordered by count then slug.
  const bySlug = new Map();
  for (const p of posts) {
    const refs = [];
    p.tagRefs = refs;
    const names = p.data.tags;
    if (names !== undefined) {
      const seen = new Set();
      for (const name of names) {
        const slug = slugOf(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        let tag = bySlug.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
          bySlug.set(slug, tag);
        }
        tag.posts.push(p);
        refs.push(tag);
      }
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const refs = [];
    const names = s.data.tags;
    if (names !== undefined) {
      const seen = new Set();
      for (const name of names) {
        const slug = slugOf(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        const tag = bySlug.get(slug);
        refs.push(tag === undefined ? { name, slug, url: '', posts: [] } : tag);
      }
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Layouts: every page through its layout, the index pages, the tag pages, the tags page, the statics.
  for (const p of posts) p.card = cardOf(p, longDateOf);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], 0, tctx, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, longDateOf) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every refusal, draft, broken link and unparsed template, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
