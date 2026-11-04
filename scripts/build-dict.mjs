// Builds src/dict.js from two MIT-licensed sources:
//   complete-hsk-vocabulary (https://github.com/drkameleon/complete-hsk-vocabulary):
//     HSK words, levels, pinyin, CC-CEDICT meanings and Chinese parts of speech
//   ECDICT (https://github.com/skywind3000/ECDICT):
//     an English -> Chinese dictionary whose translations are grouped by English part
//     of speech and ordered by how common each sense is
//
//   node scripts/build-dict.mjs                              # download both sources
//   node scripts/build-dict.mjs complete.json ecdict.csv     # use local copies
//
// An English word maps to an HSK word when ECDICT lists it as a translation for that
// part of speech, optionally confirmed by the HSK word's own CC-CEDICT glosses. Words
// only CC-CEDICT links are kept when the gloss is their main sense and doesn't
// contradict ECDICT. This keeps "show" (verb) from becoming 打开, which CC-CEDICT
// glosses as "to show (a ticket)".
//
// Output: globalThis.RC_DICT = { words, index, lexical, measure }
//   words[id] = [simplified, traditional, pinyin, hsk3Level, hsk2Level, meanings, classifier]
//               (level 0 = not in that syllabus; HSK 3.0 level 7 covers bands 7-9)
//   index[key] = [verbs, nouns, modifiers, function words, phrase]: id lists, best first
//               (0 = none; trailing zeros dropped). Phrases use the last slot only.
//   lexical = keys never reduced to their base form (glasses is not glass)
//   measure = { classifier: pinyin }
// Lowercase keys match any casing; keys with capitals (China, TV) must match exactly.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as fixes from './overrides.mjs';

// NO_OVERRIDES=1 shows what the sources alone produce, for reviewing overrides.mjs.
const { OVERRIDES, EXCLUDE, LEXICAL } = process.env.NO_OVERRIDES ? { OVERRIDES: {}, EXCLUDE: {}, LEXICAL: [] } : fixes;

const HSK_SOURCE = 'https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.json';
const ECDICT_SOURCE = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dict.js');

// Index slots, shared with src/matcher.js.
const V = 0, N = 1, A = 2, F = 3, P = 4;
const SLOTS = 5;

// Parts of speech that don't translate to a standalone English word:
// particles, modal particles, interjections, onomatopoeia, measure words.
const SKIP_POS = new Set(['u', 'y', 'e', 'o', 'q', 'qv', 'qt', 'mq', 'k']);
// Chinese (ICTCLAS) part of speech -> slots it can fill.
const ZH_SLOTS = {
  n: [N], nr: [N], ns: [N], nt: [N], nz: [N], s: [N], f: [N], t: [N], g: [N], vn: [N, V], an: [N, A],
  v: [V], a: [A], ad: [A], b: [A], z: [A], d: [A], r: [F], m: [F], c: [F], p: [F],
};
// ECDICT part of speech -> slot.
const EC_SLOTS = { n: N, v: V, vt: V, vi: V, a: A, adj: A, ad: A, adv: A, pron: F, num: F };

// English words too ambiguous to swap even with a part-of-speech tag.
const STOP_KEYS = new Set(`
  a an the of to in on at by for with from into onto as and or but if so than then
  not no nor yes be is are was were am been being it its it's this that these those
  there here do does did done have has had will would shall should can could may might must
  just very too also well still even right left like kind mean fine sort lot one ones way
  get got make made take let set put up down out off over about back through around away
  along across under below above after before since until while again once only
  such same other else more much many some any all each every both either neither
  thing things something anything nothing everything stuff matter case point part
  bit piece lead present content second last next long light
  mine bear bat bark lie lay spring fall fair rest state mind miss sign fire
  hers yours theirs ours when where which whose whom ok okay oh ah eh hey hi bye
`.trim().split(/\s+/));

// Function words that would only ever be a misleading swap.
const BLOCK_WORDS = new Set(['了', '之', '云', '以', '将', '与', '而', '其', '乃', '则', '者', '所']);

// CC-CEDICT segments that explain usage rather than translate.
const SKIP_SEGMENT = /\b(surname|classifier|particle|variant of|abbr|sb|sth|etc|used (in|for|as|after|before|to)|CL|lit|fig|pr|interj|prefix|suffix|radical)\b|\((old|archaic|literary|dialect|Tw|Taiwan|Cantonese|slang|onom|Buddhism|math|chemistry|physics|medicine)[^)]*\)/i;
// Readings that are only a surname, an abbreviation or a cross-reference.
const SKIP_FORM = /^(surname|abbr|variant|old variant|see |used in|used as|comma)/i;
// Parenthetical notes that don't narrow a sense; anything else ("to show (a ticket)")
// marks a narrow usage.
const BENIGN_NOTE = /^\((coll|formal|informal|polite|honorific|humble|intransitive|transitive|written|spoken|of a person|of people)\b/i;

const MAX_MEANINGS = 4;
const MAX_KEY_WORDS = 3;
const MAX_EC_ONLY_POS = 3; // ECDICT translations further down need CC-CEDICT agreement
const MAX_SCORE = 7;
const FREQ_LIMIT = 50000; // ECDICT headwords outside the most common 50k are ignored

async function loadText(file, url) {
  if (file) return readFile(file, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function levelOf(word, prefix) {
  const levels = word.level.filter((l) => l.startsWith(prefix)).map((l) => Number(l.slice(prefix.length)));
  return levels.length ? Math.min(...levels) : 0;
}

const segmentCount = (form) => form.meanings.reduce((n, m) => n + m.split(';').length, 0);

// The reading with the most senses, skipping surname/abbreviation readings and preferring
// lowercase pinyin: 看 kàn "to see" over kān "to look after", 读 dú "to read" over dòu "comma".
function primaryForm(word) {
  const usable = word.forms.filter((f) => f.meanings.length && !SKIP_FORM.test(f.meanings[0]) && !f.meanings.every((m) => /^\([^)]*\)$/.test(m)));
  const proper = (f) => (/^[A-Z]/.test(f.transcriptions.pinyin) ? 1 : 0);
  return usable.sort((a, b) => proper(a) - proper(b) || segmentCount(b) - segmentCount(a))[0] || null;
}

function cleanSegment(seg) {
  let s = seg.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/[!?.…]+$/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^to (be )?/i, '').replace(/^(a|an|the) /i, '').trim();
  return s;
}

// English keys in one CC-CEDICT meaning, with the slots each can fill.
function cedictKeys(meaning, zhSlots, single) {
  const keys = [];
  // "classifier for pieces of cloth, cake, soap" lists what 块 counts, not what it means.
  if (/classifier|measure word/i.test(meaning)) return keys;
  for (const [j, raw] of meaning.split(/;|,(?![^(]*\))/).entries()) {
    if (SKIP_SEGMENT.test(raw)) continue;
    const notes = raw.match(/\([^)]*\)/g) || [];
    // "(bound form)" single characters (市 city, 子 son) aren't words on their own.
    if (single && notes.some((n) => /bound form/i.test(n))) continue;
    const key = cleanSegment(raw);
    if (!/^[A-Za-z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*)*$/.test(key)) continue;
    if ((key.length < 2 && key !== 'I') || key.split(' ').length > MAX_KEY_WORDS) continue;
    if (STOP_KEYS.has(key.toLowerCase())) continue;
    // CC-CEDICT glosses verbs as "to ..."; other glosses take the word's non-verb slots.
    const slots = /^\s*(\([^)]*\)\s*)?to /i.test(raw) ? [V] : zhSlots.filter((s) => s !== V);
    if (!slots.length) continue;
    keys.push({ key, j, slots, narrow: notes.some((n) => !BENIGN_NOTE.test(n)) });
  }
  return keys;
}

// Minimal CSV line parser (ECDICT has no line breaks inside fields).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Chinese terms in one ECDICT translation line, cleaned up: "寒冷的" -> 寒冷, "很快地" -> 快.
function ecTerms(text, slot) {
  const terms = [];
  for (let t of text.split(/[,，;；、]/)) {
    t = t.replace(/（[^）]*）|\([^)]*\)|\[[^\]]*\]|〈[^〉]*〉|<[^>]*>/g, '').trim();
    if (!t || /[A-Za-z0-9…~～=]|\.\.|某|过去式|分词|复数|比较级|最高级|第三人称/.test(t) || /^[使被]/.test(t)) {
      terms.push(null); // keeps positions honest
      continue;
    }
    const variants = [t];
    // Adjectives and possessives drop 的 (寒冷的 -> 寒冷, 我的 -> 我), adverbs 很…地 (很快地 -> 快).
    if (slot === A || slot === F) variants.push(t.replace(/[的地]$/, ''));
    if (slot === A && t.endsWith('地')) variants.push(t.replace(/^很/, '').replace(/地$/, ''));
    terms.push([...new Set(variants)].filter(Boolean));
  }
  return terms;
}

async function main() {
  const [hskFile, ecFile] = process.argv.slice(2);
  const source = JSON.parse(await loadText(hskFile, HSK_SOURCE));

  // ---- HSK words and their CC-CEDICT keys ----
  const words = [];
  const bySimplified = new Map();
  const zhSlotsOf = [];
  const measure = {};
  const cedict = new Map(); // key -> Map(id -> {slots, sense, narrow})

  for (const w of source) {
    const hsk3 = levelOf(w, 'new-');
    const hsk2 = levelOf(w, 'old-');
    if (!hsk3 && !hsk2) continue;
    if (w.simplified.length === 1) {
      // A measure word's pinyin: the reading glossed as a classifier, else the first lowercase one.
      const f = w.forms.find((x) => x.meanings.some((m) => /classifier/i.test(m))) || w.forms.find((x) => !/^[A-Z]/.test(x.transcriptions.pinyin)) || w.forms[0];
      if (!measure[w.simplified] || w.forms.length && f.meanings.some((m) => /classifier/i.test(m))) measure[w.simplified] = f.transcriptions.pinyin;
    }
    if (BLOCK_WORDS.has(w.simplified) || (w.pos.length && w.pos.every((p) => SKIP_POS.has(p)))) continue;
    const form = primaryForm(w);
    if (!form) continue;
    const meanings = form.meanings.slice(0, MAX_MEANINGS);
    const id = words.length;
    const classifier = (form.classifiers || w.forms.flatMap((f) => f.classifiers || []))[0] || '';
    words.push([w.simplified, form.traditional || w.simplified, form.transcriptions.pinyin, hsk3, hsk2, meanings.slice(0, 3).join(' | '), classifier]);
    bySimplified.set(w.simplified, id);
    const zhSlots = [...new Set(w.pos.flatMap((p) => ZH_SLOTS[p] || []))];
    zhSlotsOf.push(zhSlots.length ? zhSlots : [N, A]);

    meanings.forEach((meaning, i) => {
      for (const { key, j, slots, narrow } of cedictKeys(meaning, zhSlotsOf[id], w.simplified.length === 1)) {
        if (!cedict.has(key)) cedict.set(key, new Map());
        const m = cedict.get(key);
        if (m.has(id)) continue;
        m.set(id, { slots, sense: Math.min(i, 3) * 2 + Math.min(j, 3), narrow });
      }
    });
  }
  const freqOf = new Map(source.map((w) => [w.simplified, Number.isFinite(w.frequency) ? w.frequency : 99999]));

  // ---- ECDICT ----
  const ec = new Map(); // key -> [slot] -> { terms: [string], hits: Map(id -> position) }
  const roots = new Map(); // inflected key -> base form, from ECDICT's exchange field
  const lines = (await loadText(ecFile, ECDICT_SOURCE)).split('\n');
  const header = parseCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  const common = new Set();
  for (let li = 1; li < lines.length; li++) {
    if (!lines[li]) continue;
    const r = parseCsvLine(lines[li]);
    const word = r[col.word];
    if (!/^[A-Za-z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*){0,2}$/.test(word)) continue;
    const frq = Number(r[col.frq]) || 0;
    const bnc = Number(r[col.bnc]) || 0;
    const isCommon = (frq > 0 && frq <= FREQ_LIMIT) || (bnc > 0 && bnc <= FREQ_LIMIT) || r[col.tag] || Number(r[col.collins]) > 0 || r[col.oxford] === '1';
    if (!word.includes(' ')) {
      if (!isCommon) continue;
      common.add(word.toLowerCase());
    }
    rows.push([word, r[col.translation], r[col.exchange]]);
  }
  for (const [word, translation, exchange] of rows) {
    const phrase = word.includes(' ');
    if (phrase && !word.split(' ').every((x) => common.has(x.toLowerCase()))) continue;
    const key = word;
    if (STOP_KEYS.has(key.toLowerCase())) continue;
    const base = /(?:^|\/)0:([^/]+)/.exec(exchange || '');
    if (base && base[1] !== word) roots.set(key, base[1]);
    const perSlot = [];
    for (const line of translation.split('\\n')) {
      if (line.startsWith('[')) continue; // domain senses: [计] [医] [网络] ...
      const m = /^([a-z]+)\.\s*(.*)$/.exec(line);
      const slot = m ? EC_SLOTS[m[1]] : phrase ? P : undefined;
      if (slot === undefined) continue;
      const s = phrase ? P : slot;
      perSlot[s] ||= { terms: [], hits: new Map() };
      const entry = perSlot[s];
      for (const variants of ecTerms(m ? m[2] : line, slot)) {
        const pos = entry.terms.length;
        entry.terms.push(variants ? variants[0] : '');
        if (!variants) continue;
        for (const v of variants) {
          const id = bySimplified.get(v);
          if (id !== undefined && !entry.hits.has(id)) entry.hits.set(id, pos);
        }
      }
    }
    if (perSlot.some(Boolean)) ec.set(key, perSlot);
  }

  // ---- Merge ----
  const index = {};
  const keys = new Set([...ec.keys(), ...cedict.keys()]);
  for (const key of keys) {
    const phrase = key.includes(' ');
    const ecSlots = ec.get(key) || [];
    const ceHits = cedict.get(key) || new Map();
    const lists = Array.from({ length: SLOTS }, () => new Map()); // slot -> id -> {score, strong}
    // strong: a main sense of the English word (ECDICT's top two) or of the Chinese word
    // (its first CC-CEDICT gloss). Only strong candidates serve as fallbacks for learners
    // below the best word's level: "plant" may fall back from 植物 to nothing, not 工厂.
    const put = (slot, id, score, strong) => {
      const s = phrase ? P : slot;
      const prev = lists[s].get(id);
      if (!prev || score < prev.score) lists[s].set(id, { score, strong: strong || prev?.strong || false });
    };

    for (let slot = 0; slot < SLOTS; slot++) {
      const e = ecSlots[slot];
      if (!e) continue;
      for (const [id, pos] of e.hits) {
        const ce = ceHits.get(id);
        const confirmed = ce && (phrase || ce.slots.includes(slot) || slot === P);
        // ECDICT phrase entries are loose ("run to" -> 达到), so phrases need agreement.
        if (!confirmed && (phrase || pos > MAX_EC_ONLY_POS)) continue;
        put(slot, id, pos + (confirmed ? 0 : 1.5), pos <= 1 || ce?.sense === 0);
      }
    }
    for (const [id, ce] of ceHits) {
      if (ce.sense > 1 || ce.narrow) continue;
      for (const slot of phrase ? [P] : ce.slots) {
        if (lists[slot].has(id)) continue;
        const e = ecSlots[slot];
        const zh = words[id][0];
        // ECDICT knows this sense: only accept words it agrees with in part
        // (冷 for "cold", next to its 寒冷), and never a lone character noun.
        if (e) {
          if (slot === N && zh.length === 1) continue;
          if (!e.terms.some((t) => t && (t.includes(zh) || zh.includes(t)))) continue;
        }
        put(slot, id, 3 + ce.sense + (e ? 0 : 1), ce.sense === 0);
      }
    }

    index[key] = lists.map((m) => [...m].filter(([, c]) => c.score <= MAX_SCORE).map(([id, c]) => ({ id, ...c })));
  }

  const idOf = (key, s) => {
    const id = bySimplified.get(s);
    if (id === undefined) throw new Error(`overrides.mjs "${key}": ${s} is not an HSK word`);
    return id;
  };
  // Hand-picked translations win. "show:n" applies to one part of speech; a bare key goes
  // into every slot the word is a candidate for, or the slots its Chinese POS allows.
  const SLOT_NAMES = { v: V, n: N, a: A, f: F };
  for (const [spec, list] of Object.entries(OVERRIDES)) {
    const [key, pos] = spec.split(':');
    const lists = index[key] || (index[key] = Array.from({ length: SLOTS }, () => []));
    list.forEach((s, n) => {
      const id = idOf(spec, s);
      let slots = pos ? [SLOT_NAMES[pos]] : key.includes(' ') ? [P] : lists.map((l, i) => (l.some((c) => c.id === id) ? i : -1)).filter((i) => i >= 0);
      if (!slots.length) slots = zhSlotsOf[id];
      for (const slot of slots) {
        lists[slot] = lists[slot].filter((c) => c.id !== id);
        lists[slot].push({ id, score: -10 + n, strong: true });
      }
    });
  }
  for (const [spec, list] of Object.entries(EXCLUDE)) {
    const [key, pos] = spec.split(':');
    const drop = list.map((s) => idOf(spec, s));
    if (index[key]) index[key] = index[key].map((l, slot) => (pos && SLOT_NAMES[pos] !== slot ? l : l.filter((c) => !drop.includes(c.id))));
  }

  // Sort, keep the best candidate at every level of both syllabuses (so any setting finds
  // its best match by taking the first eligible id), and pack.
  const packed = {};
  for (const key of Object.keys(index).sort()) {
    const slots = index[key].map((list) => {
      const sorted = list
        .sort((a, b) => a.score - b.score || freqOf.get(words[a.id][0]) - freqOf.get(words[b.id][0]))
        .filter((c, n) => n === 0 || c.strong);
      const keep = new Set();
      for (const col of [3, 4]) {
        for (let lvl = 1; lvl <= 7; lvl++) {
          const c = sorted.find((x) => words[x.id][col] === lvl);
          if (c) keep.add(c.id);
        }
      }
      const ids = sorted.filter((c) => keep.has(c.id)).map((c) => c.id);
      return ids.length ? ids : 0;
    });
    while (slots.length && slots[slots.length - 1] === 0) slots.pop();
    if (slots.length) packed[key] = slots;
  }

  // Participles whose translation shares nothing with their base form's: tired (累) is not
  // tire (轮胎), interested (感兴趣) is not interest (利息). Plurals go by their singular
  // unless overrides.mjs lists them (glasses is not glass).
  const lexical = Object.keys(packed).filter((key) => {
    if (LEXICAL.includes(key)) return true;
    if (!/(ed|ing)$/.test(key)) return false;
    const base = roots.get(key);
    if (!base || !packed[base]) return false;
    return packed[key].some((ids, slot) => {
      const other = packed[base][slot];
      if (!ids || !other) return false;
      const [a, b] = [words[ids[0]][0], words[other[0]][0]];
      return ![...a].some((ch) => b.includes(ch));
    });
  });

  // Classifiers outside the HSK list have no pinyin here; those nouns fall back to 个.
  for (const w of words) if (w[6] && !measure[w[6]]) w[6] = '';
  const used = new Set(words.map((w) => w[6]).filter(Boolean));
  const measureUsed = Object.fromEntries(Object.entries(measure).filter(([c]) => used.has(c) || c === '个'));
  const json = JSON.stringify({ words, index: packed, lexical, measure: measureUsed });
  const body = `// Generated by scripts/build-dict.mjs from complete-hsk-vocabulary and ECDICT (both MIT). Do not edit.\n` +
    `globalThis.RC_DICT = JSON.parse(${JSON.stringify(json)});\n`;
  await writeFile(OUT, body);
  console.log(`${words.length} words, ${Object.keys(packed).length} English keys, ${(body.length / 1024).toFixed(0)} KB -> ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
