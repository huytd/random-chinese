// Shared by build-dict-zh.mjs and build-dict-ja.mjs: turning glosses into English keys,
// merging an English-first dictionary with the target words' own glosses, and packing
// the result for src/matcher.js.
//
// Every dictionary file sets globalThis.RC_DICTS[lang] = { lang, speech, grammar, words,
// index, lexical, measure }:
//   words[id] = [word, alternate script, reading, level, level in a second syllabus,
//                meanings, measure word]   (level 0 = not in that syllabus)
//   index[key] = [verbs, nouns, modifiers, function words, phrase]: id lists, best first
//                (0 = none; trailing zeros dropped). Phrases use the last slot only.
//   lexical = keys never reduced to their base form (glasses is not glass)
// Lowercase keys match any casing; keys with capitals (China, TV) must match exactly.

import { readFile, writeFile } from 'node:fs/promises';
import '../src/matcher.js';

// Index slots, shared with src/matcher.js.
export const V = 0, N = 1, A = 2, F = 3, P = 4;
export const SLOTS = 5;
export const SLOT_NAMES = { v: V, n: N, a: A, f: F };

// English words too ambiguous to swap even with a part-of-speech tag.
export const STOP_KEYS = new Set(`
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

// Gloss segments that explain usage rather than translate.
const SKIP_SEGMENT = /\b(surname|classifier|particle|variant of|abbr|sb|sth|etc|used (in|for|as|after|before|to)|CL|lit|fig|pr|interj|prefix|suffix|radical)\b|\((old|archaic|literary|dialect|Tw|Taiwan|Cantonese|slang|onom|Buddhism|math|chemistry|physics|medicine)[^)]*\)/i;
// Parenthetical notes that don't narrow a sense; anything else ("to show (a ticket)")
// marks a narrow usage.
export const BENIGN_NOTE = /^\((coll|formal|informal|polite|honorific|humble|intransitive|transitive|written|spoken|of a person|of people)\b/i;

export const MAX_KEY_WORDS = 3;
const MAX_FIRST_ONLY_POS = 3; // English-first translations further down need the word's own agreement
const MAX_SCORE = 7;

export async function loadText(file, url) {
  if (file) return readFile(file, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export function cleanSegment(seg) {
  let s = seg.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/[!?.…]+$/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^to (be )?/i, '').replace(/^(a|an|the) /i, '').trim();
  return s;
}

// English keys in one gloss ("to see; to look at"), with the slots each can fill.
// slotsFor(raw) gives the slots for a segment; single: the word is one character;
// benign: the notes that don't narrow a sense.
export function glossKeys(meaning, slotsFor, { single = false, benign = BENIGN_NOTE } = {}) {
  const keys = [];
  // "classifier for pieces of cloth, cake, soap" lists what 块 counts, not what it means.
  if (/classifier|measure word|counter for/i.test(meaning)) return keys;
  for (const [j, raw] of meaning.split(/;|,(?![^(]*\))/).entries()) {
    if (SKIP_SEGMENT.test(raw)) continue;
    const notes = raw.match(/\([^)]*\)/g) || [];
    // "(bound form)" single characters (市 city, 子 son) aren't words on their own.
    if (single && notes.some((n) => /bound form/i.test(n))) continue;
    const key = cleanSegment(raw);
    if (!/^[A-Za-z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*)*$/.test(key)) continue;
    if ((key.length < 2 && key !== 'I') || key.split(' ').length > MAX_KEY_WORDS) continue;
    if (STOP_KEYS.has(key.toLowerCase())) continue;
    const slots = slotsFor(raw);
    if (!slots.length) continue;
    keys.push({ key, j, slots, narrow: notes.some((n) => !benign.test(n)) });
  }
  return keys;
}

// Minimal CSV line parser (no line breaks inside fields).
export function parseCsvLine(line) {
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

// Combines both directions into scored candidate lists per key.
//   first: key -> [slot] -> { terms: [string], hits: Map(id -> position) }
//     an English-first dictionary (ECDICT, EJDict): translations in order of use
//   own: key -> Map(id -> { slots, sense, narrow })
//     the target words' own glosses (CC-CEDICT, JMdict)
// An English-first translation counts when the word's own glosses agree or it is near
// the top; a word only its own glosses link counts when that gloss is its main sense and
// the English-first side doesn't contradict it. strong marks main senses on either side;
// only strong candidates serve as fallbacks for learners below the best word's level, so
// "plant" falls back from 植物 to nothing rather than to 工厂.
// agrees(term, row): whether an English-first term partly agrees with a word's row.
// strongPos: positions up to this count as a main sense of the English word.
const substring = (t, [w]) => t.includes(w) || w.includes(t);
export function mergeCandidates(first, own, words, { noLoneNouns = false, agrees = substring, strongPos = 1 } = {}) {
  const index = {};
  for (const key of new Set([...first.keys(), ...own.keys()])) {
    const phrase = key.includes(' ');
    const firstSlots = first.get(key) || [];
    const ownHits = own.get(key) || new Map();
    const lists = Array.from({ length: SLOTS }, () => new Map()); // slot -> id -> {score, strong}
    const put = (slot, id, score, strong) => {
      const s = phrase ? P : slot;
      const prev = lists[s].get(id);
      if (!prev || score < prev.score) lists[s].set(id, { score, strong: strong || prev?.strong || false });
    };

    for (let slot = 0; slot < SLOTS; slot++) {
      const e = firstSlots[slot];
      if (!e) continue;
      for (const [id, pos] of e.hits) {
        const o = ownHits.get(id);
        const confirmed = o && (phrase || o.slots.includes(slot) || slot === P);
        // Phrase entries are loose ("run to" -> 达到), so phrases need agreement.
        if (!confirmed && (phrase || pos > MAX_FIRST_ONLY_POS)) continue;
        put(slot, id, pos + (confirmed ? 0 : 1.5), pos <= strongPos || o?.sense === 0);
      }
    }
    for (const [id, o] of ownHits) {
      if (o.sense > 1 || o.narrow) continue;
      for (const slot of phrase ? [P] : o.slots) {
        if (lists[slot].has(id)) continue;
        const e = firstSlots[slot];
        const w = words[id][0];
        // The English-first side knows this sense: only accept words it agrees with in
        // part (冷 for "cold", next to its 寒冷), and optionally never a lone-character noun.
        if (e) {
          if (noLoneNouns && slot === N && w.length === 1) continue;
          if (!e.terms.some((t) => t && agrees(t, words[id]))) continue;
        }
        put(slot, id, 3 + o.sense + (e ? 0 : 1), o.sense === 0);
      }
    }
    index[key] = lists.map((m) => [...m].filter(([, c]) => c.score <= MAX_SCORE).map(([id, c]) => ({ id, ...c })));
  }
  return index;
}

// Hand-picked translations win. "show:n" applies to one part of speech; a bare key goes
// into every slot the word is a candidate for, or the slots slotsOf(id) allows.
export function applyOverrides(index, { OVERRIDES = {}, EXCLUDE = {} }, idOf, slotsOf) {
  for (const [spec, list] of Object.entries(OVERRIDES)) {
    const [key, pos] = spec.split(':');
    const lists = index[key] || (index[key] = Array.from({ length: SLOTS }, () => []));
    list.forEach((s, n) => {
      const id = idOf(spec, s, pos);
      let slots = pos ? [SLOT_NAMES[pos]] : key.includes(' ') ? [P] : lists.map((l, i) => (l.some((c) => c.id === id) ? i : -1)).filter((i) => i >= 0);
      if (!slots.length) slots = slotsOf(id);
      for (const slot of slots) {
        lists[slot] = lists[slot].filter((c) => c.id !== id);
        lists[slot].push({ id, score: -10 + n, strong: true });
      }
    });
  }
  for (const [spec, list] of Object.entries(EXCLUDE)) {
    const [key, pos] = spec.split(':');
    const drop = list.map((s) => idOf(spec, s, pos));
    if (index[key]) index[key] = index[key].map((l, slot) => (pos && SLOT_NAMES[pos] !== slot ? l : l.filter((c) => !drop.includes(c.id))));
  }
}

// Sorts each slot, keeps the best candidate at every level of every syllabus (so any
// setting finds its best match by taking the first eligible id), and packs.
// levelCols: word columns holding levels; tiebreak(id): lower wins among equal scores;
// kindOf(id): candidates of different kinds are kept side by side at a level (a
// transitive and an intransitive verb, 始める and 始まる).
export function pack(index, words, { levelCols, maxLevel, tiebreak, kindOf = () => '' }) {
  const packed = {};
  for (const key of Object.keys(index).sort()) {
    const slots = index[key].map((list) => {
      const sorted = list
        .sort((a, b) => a.score - b.score || tiebreak(a.id) - tiebreak(b.id))
        .filter((c, n) => n === 0 || c.strong);
      const keep = new Set();
      for (const col of levelCols) {
        for (let lvl = 1; lvl <= maxLevel; lvl++) {
          const seen = new Set();
          for (const c of sorted) {
            if (words[c.id][col] !== lvl || seen.has(kindOf(c.id))) continue;
            seen.add(kindOf(c.id));
            keep.add(c.id);
          }
        }
      }
      const ids = sorted.filter((c) => keep.has(c.id)).map((c) => c.id);
      return ids.length ? ids : 0;
    });
    while (slots.length && slots[slots.length - 1] === 0) slots.pop();
    if (slots.length) packed[key] = slots;
  }
  return packed;
}

// Participles whose translation shares nothing with their base form's: tired (累) is not
// tire (轮胎), interested (感兴趣) is not interest (利息). Plurals go by their singular
// unless the overrides list them (glasses is not glass).
// rootOf(key): the English base form, or undefined.
export function lexicalKeys(packed, words, curated, rootOf) {
  // Curated keys count even without a translation of their own: "later" must not fall
  // back to "late" (遅い) in a dictionary that has nothing for "later".
  return [...new Set([...curated, ...Object.keys(packed).filter((key) => {
    if (!/(ed|ing)$/.test(key)) return false;
    const base = rootOf(key);
    if (!base || !packed[base]) return false;
    return packed[key].some((ids, slot) => {
      const other = packed[base][slot];
      if (!ids || !other) return false;
      const [a, b] = [words[ids[0]][0], words[other[0]][0]];
      return ![...a].some((ch) => b.includes(ch));
    });
  })])];
}

// A base form guessed from spelling, for builds whose English source has no inflections.
export const guessRoot = (packed) => (key) => globalThis.RC_MATCHER.lemmas(key).find((b) => packed[b]);

export async function writeDict(out, lang, data, credit) {
  const json = JSON.stringify(data);
  const body = `// Generated by scripts/build-dict-${lang}.mjs from ${credit}. Do not edit.\n` +
    `(globalThis.RC_DICTS ||= {}).${lang} = JSON.parse(${JSON.stringify(json)});\n`;
  await writeFile(out, body);
  return body.length;
}
