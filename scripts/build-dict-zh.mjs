// Builds src/dict-zh.js from two MIT-licensed sources:
//   complete-hsk-vocabulary (https://github.com/drkameleon/complete-hsk-vocabulary):
//     HSK words, levels, pinyin, CC-CEDICT meanings and Chinese parts of speech
//   ECDICT (https://github.com/skywind3000/ECDICT):
//     an English -> Chinese dictionary whose translations are grouped by English part
//     of speech and ordered by how common each sense is
//
//   node scripts/build-dict-zh.mjs                              # download both sources
//   node scripts/build-dict-zh.mjs complete.json ecdict.csv     # use local copies
//
// See dict-common.mjs for the output format and how the two sources are combined.
// Here words[id] = [simplified, traditional, pinyin, hsk3Level, hsk2Level, meanings,
// classifier]; HSK 3.0 level 7 covers bands 7-9.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as fixes from './overrides-zh.mjs';
import {
  V, N, A, F, P, STOP_KEYS, loadText, glossKeys, parseCsvLine, mergeCandidates, applyOverrides, pack, lexicalKeys, writeDict,
} from './dict-common.mjs';

// NO_OVERRIDES=1 shows what the sources alone produce, for reviewing overrides-zh.mjs.
const OVERRIDES = process.env.NO_OVERRIDES ? { OVERRIDES: {}, EXCLUDE: {}, LEXICAL: [] } : fixes;

const HSK_SOURCE = 'https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.json';
const ECDICT_SOURCE = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dict-zh.js');

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

// Function words that would only ever be a misleading swap.
const BLOCK_WORDS = new Set(['了', '之', '云', '以', '将', '与', '而', '其', '乃', '则', '者', '所']);
// Readings that are only a surname, an abbreviation or a cross-reference.
const SKIP_FORM = /^(surname|abbr|variant|old variant|see |used in|used as|comma)/i;

const MAX_MEANINGS = 4;
const FREQ_LIMIT = 50000; // ECDICT headwords outside the most common 50k are ignored

// Grammar the matcher adds for Chinese.
const GRAMMAR = {
  possessive: ['的', 'de'],
  more: ['更', 'gèng'],
  most: ['最', 'zuì'],
  thingsPronoun: '它们', // they/them for animals and things
  measure: true, // numbers take the noun's measure word: 三本书
  defaultMeasure: '个',
  two: ['二', '两'], // 两 before a measure word
  comparativeMarks: '最更较', // words that already say "most"/"more"
};

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

    // CC-CEDICT glosses verbs as "to ..."; other glosses take the word's non-verb slots.
    const slotsFor = (raw) => (/^\s*(\([^)]*\)\s*)?to /i.test(raw) ? [V] : zhSlotsOf[id].filter((s) => s !== V));
    meanings.forEach((meaning, i) => {
      for (const { key, j, slots, narrow } of glossKeys(meaning, slotsFor, { single: w.simplified.length === 1 })) {
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

  const index = mergeCandidates(ec, cedict, words, { noLoneNouns: true });
  const idOf = (key, s) => {
    const id = bySimplified.get(s);
    if (id === undefined) throw new Error(`overrides-zh.mjs "${key}": ${s} is not an HSK word`);
    return id;
  };
  applyOverrides(index, OVERRIDES, idOf, (id) => zhSlotsOf[id]);
  const packed = pack(index, words, { levelCols: [3, 4], maxLevel: 7, tiebreak: (id) => freqOf.get(words[id][0]) });
  const lexical = lexicalKeys(packed, words, OVERRIDES.LEXICAL || [], (key) => roots.get(key));

  // Classifiers outside the HSK list have no pinyin here; those nouns fall back to 个.
  for (const w of words) if (w[6] && !measure[w[6]]) w[6] = '';
  const used = new Set(words.map((w) => w[6]).filter(Boolean));
  const measureUsed = Object.fromEntries(Object.entries(measure).filter(([c]) => used.has(c) || c === '个'));
  const size = await writeDict(OUT, 'zh', { lang: 'zh', speech: 'zh-CN', grammar: GRAMMAR, words, index: packed, lexical, measure: measureUsed },
    'complete-hsk-vocabulary and ECDICT (both MIT)');
  console.log(`${words.length} words, ${Object.keys(packed).length} English keys, ${(size / 1024).toFixed(0)} KB -> ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
