// Builds src/dict.js from complete.json in
// https://github.com/drkameleon/complete-hsk-vocabulary (MIT).
//
//   node scripts/build-dict.mjs                  # fetch complete.json from GitHub
//   node scripts/build-dict.mjs complete.json    # use a local copy
//
// Output: globalThis.RC_DICT = { words, index }
//   words[id] = [simplified, traditional, pinyin, hsk3Level, hsk2Level, meanings]
//               (level 0 = not in that syllabus; HSK 3.0 level 7 covers bands 7-9)
//   index[englishKey] = [id, ...]   best translation first
//   lexical = [englishKey, ...]      inflected-looking keys never reduced to a base form
// Lowercase keys match any casing; keys with capitals (China, TV) must match exactly.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OVERRIDES, EXCLUDE, LEXICAL } from './overrides.mjs';
import '../src/matcher.js';

const SOURCE = 'https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.json';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dict.js');

// Parts of speech that don't translate to a standalone English word:
// particles, modal particles, interjections, onomatopoeia, measure words.
const SKIP_POS = new Set(['u', 'y', 'e', 'o', 'q', 'qv', 'qt', 'mq', 'k']);

// English words too ambiguous or too structural to swap blindly.
const STOP_KEYS = new Set(`
  a an the of to in on at by for with from into onto as and or but if so than then
  not no nor yes be is are was were am been being it its this that these those
  there here do does did done have has had will would shall should can could may might must
  just very too also well still even right left like kind mean fine sort lot one ones way
  get got make made take let set put up down out off over about back through around away
  along across under below above after before since until while again once only
  such same other else more much many some any all each every both either neither
  thing things something anything nothing everything stuff matter case point part
  bit piece lead close present content minute second last next long light
  mine bear bat bark lie lay spring fall fair rest change state mind miss sign
  him her his hers your yours their theirs our ours when where which whose whom
  story head train fire hot ok okay oh ah eh hey hi bye
`.trim().split(/\s+/));

// Segments that explain usage rather than translate.
const SKIP_SEGMENT = /\b(surname|classifier|particle|variant of|abbr|sb|sth|etc|used (in|for|as|after|before|to)|CL|lit|fig|pr|interj|prefix|suffix|radical)\b|\((old|archaic|literary|dialect|Tw|Taiwan|Cantonese|slang|onom|Buddhism|math|chemistry|physics|medicine)[^)]*\)/i;
// Readings that are only a surname, an abbreviation or a cross-reference.
const SKIP_FORM = /^(surname|abbr|variant|old variant|see |used in|used as|comma)/i;

const MAX_MEANINGS = 4;
const MAX_KEY_WORDS = 3;

async function loadSource(file) {
  if (file) return JSON.parse(await readFile(file, 'utf8'));
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`complete.json: HTTP ${res.status}`);
  return res.json();
}

function levelOf(word, prefix) {
  const levels = word.level.filter((l) => l.startsWith(prefix)).map((l) => Number(l.slice(prefix.length)));
  return levels.length ? Math.min(...levels) : 0;
}

// Function words that would only ever be a misleading swap.
const BLOCK_WORDS = new Set(['了', '之', '云', '以', '将', '与', '而', '其', '乃', '则', '者', '所']);
// A candidate whose sense is this much weaker than the key's best one is dropped.
const MAX_SENSE_GAP = 2;

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

function keysOf(meaning) {
  const keys = [];
  for (const [j, raw] of meaning.split(/;|,(?![^(]*\))/).entries()) {
    if (SKIP_SEGMENT.test(raw)) continue;
    const key = cleanSegment(raw);
    if (!/^[A-Za-z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*)*$/.test(key)) continue;
    if ((key.length < 2 && key !== 'I') || key.split(' ').length > MAX_KEY_WORDS) continue;
    if (STOP_KEYS.has(key.toLowerCase())) continue;
    keys.push({ key, j });
  }
  return keys;
}

async function main() {
  const source = await loadSource(process.argv[2]);
  const words = [];
  const candidates = new Map(); // key -> [{id, rank}]
  const bySimplified = new Map();

  for (const w of source) {
    const hsk3 = levelOf(w, 'new-');
    const hsk2 = levelOf(w, 'old-');
    if (!hsk3 && !hsk2) continue;
    if (BLOCK_WORDS.has(w.simplified) || (w.pos.length && w.pos.every((p) => SKIP_POS.has(p)))) continue;
    const form = primaryForm(w);
    if (!form) continue;
    const meanings = form.meanings.slice(0, MAX_MEANINGS);
    const id = words.length;
    words.push([w.simplified, form.traditional || w.simplified, form.transcriptions.pinyin, hsk3, hsk2, meanings.slice(0, 3).join(' | ')]);
    bySimplified.set(w.simplified, id);

    const seen = new Set();
    meanings.forEach((meaning, i) => {
      for (const { key, j } of keysOf(meaning)) {
        if (seen.has(key)) continue;
        seen.add(key);
        // Earlier senses beat later ones; ties go to the more frequent word.
        const sense = Math.min(i, 3) * 2 + Math.min(j, 3);
        const freq = Number.isFinite(w.frequency) ? w.frequency : 99999;
        if (!candidates.has(key)) candidates.set(key, []);
        candidates.get(key).push({ id, sense, rank: sense * 1e5 + freq });
      }
    });
  }

  const idOf = (key, s) => {
    const id = bySimplified.get(s);
    if (id === undefined) throw new Error(`overrides.mjs "${key}": ${s} is not an HSK word`);
    return id;
  };
  // Hand-picked translations for common words win over the heuristic.
  for (const [key, list] of Object.entries(OVERRIDES)) {
    const picks = list.map((s) => idOf(key, s));
    const natural = candidates.get(key) || [];
    const rest = natural.filter((c) => !picks.includes(c.id));
    const sense = (id) => natural.find((c) => c.id === id)?.sense ?? 0;
    candidates.set(key, [...picks.map((id, n) => ({ id, sense: sense(id), override: true, rank: n - 1e6 })), ...rest]);
  }
  for (const [key, list] of Object.entries(EXCLUDE)) {
    const drop = list.map((s) => idOf(key, s));
    candidates.set(key, (candidates.get(key) || []).filter((c) => !drop.includes(c.id)));
  }

  const index = {};
  for (const key of [...candidates.keys()].sort()) {
    const all = candidates.get(key);
    if (!all.length) continue;
    const bestSense = Math.min(...all.map((c) => c.sense));
    const sorted = all.filter((c) => c.override || c.sense - bestSense <= MAX_SENSE_GAP).sort((a, b) => a.rank - b.rank);
    // Keep the best candidate at every level of both syllabuses, so any setting finds
    // its best match by taking the first eligible id.
    const keep = new Set();
    for (const col of [3, 4]) {
      for (let lvl = 1; lvl <= 7; lvl++) {
        const c = sorted.find((x) => words[x.id][col] === lvl);
        if (c) keep.add(c.id);
      }
    }
    index[key] = sorted.filter((c) => keep.has(c.id)).map((c) => c.id);
  }

  // Words that look inflected but mean something else than their base form, so the
  // matcher must not fall back to it: tired (累) is not tire (轮胎).
  const lexical = Object.keys(index).filter((key) => {
    if (LEXICAL.includes(key)) return true;
    const base = globalThis.RC_MATCHER.lemmas(key).find((b) => index[b]);
    if (!base || key.includes(' ')) return false;
    const [a, b] = [words[index[key][0]][0], words[index[base][0]][0]];
    return ![...a].some((ch) => b.includes(ch));
  });

  const json = JSON.stringify({ words, index, lexical });
  const body = `// Generated by scripts/build-dict.mjs from complete-hsk-vocabulary (MIT). Do not edit.\n` +
    `globalThis.RC_DICT = JSON.parse(${JSON.stringify(json)});\n`;
  await writeFile(OUT, body);
  console.log(`${words.length} words, ${Object.keys(index).length} English keys, ${(body.length / 1024).toFixed(0)} KB -> ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
