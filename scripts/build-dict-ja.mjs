// Builds src/dict-ja.js from three sources:
//   open-anki-jlpt-decks (https://github.com/jamsinclair/open-anki-jlpt-decks, MIT;
//     word lists from tanos.co.uk): JLPT N5-N1 words with readings
//   JMdict (https://www.edrdg.org/jmdict/j_jmdict.html, CC BY-SA 4.0, via
//     https://github.com/scriptin/jmdict-simplified): parts of speech and English glosses
//   EJDict-hand (https://github.com/kujirahand/EJDict, public domain): an English ->
//     Japanese dictionary listing senses in order of use, main translations in 『』
//
//   node scripts/build-dict-ja.mjs                                   # download all three
//   node scripts/build-dict-ja.mjs <jlpt dir> <jmdict.json> <ejdict dir>   # local copies
//
// See dict-common.mjs for the output format and how the sources are combined; EJDict
// plays the English-first role and JMdict the words' own glosses. Here words[id] =
// [word, word, kana reading, level, 0, meanings, ''], level 1 = N5 ... 5 = N1. Nouns
// that take する (勉強) also get a verb row (勉強する) used for English verbs.

import { readFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import * as fixes from './overrides-ja.mjs';
import {
  V, N, A, F, P, STOP_KEYS, loadText, glossKeys, parseCsvLine, mergeCandidates, applyOverrides, pack, lexicalKeys, guessRoot, writeDict,
} from './dict-common.mjs';

const OVERRIDES = process.env.NO_OVERRIDES ? { OVERRIDES: {}, EXCLUDE: {}, LEXICAL: [] } : fixes;

const JLPT_SOURCE = 'https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src';
const JMDICT_RELEASES = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';
const EJDICT_SOURCE = 'https://raw.githubusercontent.com/kujirahand/EJDict/master/src';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dict-ja.js');

// JLPT level -> 1 (N5, easiest) ... 5 (N1).
const LEVELS = { 5: 1, 4: 2, 3: 3, 2: 4, 1: 5 };

// Grammar the matcher adds for Japanese.
const GRAMMAR = {
  possessive: ['の', 'の'], // 私の友達
  more: ['もっと', 'もっと'],
  most: ['一番', 'いちばん'],
  thingsPronoun: null, // それら isn't a JLPT word: they/them for things stay English
  measure: false, // counters (三冊, 三匹) depend on the noun; numbers before nouns stay English
  comparativeMarks: '',
};

// JMdict notes that clarify rather than narrow: "cold (e.g. weather)".
const BENIGN = /^\((coll|formal|informal|polite|honorific|humble|intransitive|transitive|written|spoken|of a person|of people|e\.g\.|esp\.|usu\.|usually|as in|in|of)\b/i;

// JMdict part of speech -> slot. "vs" marks a noun that becomes a verb with する.
function slotOf(tag) {
  if (/^(v1|v5|vk|vz|vs-i|vs-s|v1-s|vr|vn)/.test(tag)) return V;
  if (/^adj-(i|ix|na|no|t|f)$/.test(tag) || /^adv/.test(tag)) return A;
  if (/^n(-adv|-t)?$/.test(tag)) return N;
  if (tag === 'pn' || tag === 'num') return F;
  return undefined;
}

async function loadJlpt(dir) {
  const rows = [];
  for (const n of [5, 4, 3, 2, 1]) {
    const text = await loadText(dir && path.join(dir, `n${n}.csv`), `${JLPT_SOURCE}/n${n}.csv`);
    const lines = text.split('\n');
    const header = parseCsvLine(lines[0]);
    const col = Object.fromEntries(header.map((h, i) => [h, i]));
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const r = parseCsvLine(line);
      rows.push({ level: LEVELS[n], expression: r[col.expression], reading: r[col.reading], meaning: r[col.meaning] });
    }
  }
  return rows;
}

async function loadJmdict(file) {
  if (file) return JSON.parse(await readFile(file, 'utf8'));
  const release = await (await fetch(JMDICT_RELEASES)).json();
  const asset = release.assets.find((a) => /^jmdict-eng-\d.*\.json\.tgz$/.test(a.name));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-jmdict-'));
  const tgz = path.join(dir, asset.name);
  execFileSync('curl', ['-sSL', '-o', tgz, asset.browser_download_url]);
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  const json = execFileSync('sh', ['-c', `ls ${JSON.stringify(dir)}/*.json`]).toString().trim();
  return JSON.parse(await readFile(json, 'utf8'));
}

async function loadEjdict(dir) {
  const lines = [];
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    lines.push(...(await loadText(dir && path.join(dir, `${c}.txt`), `${EJDICT_SOURCE}/${c}.txt`)).split('\n'));
  }
  return lines;
}

// One EJDict sense ("…を『食べる』;〈食事〉をする") -> its likely English part of speech
// and its Japanese terms: [{ text, main }], main = marked 『』 as the key translation.
function ejSense(sense) {
  const hint = /〈[UC]〉/.test(sense) ? N : /…[をにでがとへ]|〈[^〉]*〉[をにでがと]|[をに]『/.test(sense) ? V : null;
  const clean = sense
    .replace(/《[^》]*》/g, '')
    .replace(/〈[^〉]*〉/g, '')
    .replace(/[(（][^)）]*[)）]/g, ',')
    .replace(/\[[^\]]*\]/g, ',');
  const terms = [];
  for (let t of clean.split(/[,;、，；]/)) {
    const main = t.includes('『');
    t = t.replace(/[『』]/g, '').replace(/^[…\s]*[をにでがとへの]?/, '').trim();
    if (t) terms.push({ text: t, main });
  }
  return { hint, terms };
}

async function main() {
  const [jlptDir, jmFile, ejDir] = process.argv.slice(2);
  const [jlpt, jm, ejLines] = await Promise.all([loadJlpt(jlptDir), loadJmdict(jmFile), loadEjdict(ejDir)]);

  // ---- JMdict lookup by written form ----
  const byText = new Map();
  for (const e of jm.words) {
    for (const k of [...e.kanji, ...e.kana]) {
      if (!byText.has(k.text)) byText.set(k.text, []);
      byText.get(k.text).push(e);
    }
  }
  const isCommon = (e) => e.kanji.some((k) => k.common) || e.kana.some((k) => k.common);
  const kanaOnly = (e) => !e.kanji.length || e.sense.some((s) => s.misc.includes('uk')); // usually written in kana
  // The entry for a JLPT word. Kana words are ambiguous (どう: 銅 copper, 胴 torso, the
  // adverb どう), so prefer entries normally written in kana, then common ones.
  const entryFor = (expr, reading) => {
    const list = (byText.get(expr) || []).filter((e) => e.kana.some((k) => k.text === reading));
    if (!list.length) return (byText.get(expr) || []).find(isCommon);
    if (!/\p{Script=Han}/u.test(expr)) return list.find((e) => kanaOnly(e) && isCommon(e)) || list.find(kanaOnly) || list.find(isCommon) || list[0];
    return list.find((e) => e.kanji.some((k) => k.text === expr) && isCommon(e)) || list.find((e) => e.kanji.some((k) => k.text === expr)) || list[0];
  };

  // ---- JLPT words ----
  const words = [];
  const byExpr = new Map();
  const slotsOf = []; // word id -> slots its part of speech allows
  const suruOf = new Map(); // noun id -> id of its する verb row
  const transitive = [];
  const intransitive = [];
  // A verb's transitivity from JMdict's vt/vi tags on its verb senses: 始める (vt) takes
  // an object, 始まる (vi) doesn't. Verbs tagged both ways stay neutral.
  const valenceOf = (id, senses) => {
    const tags = new Set(senses.flatMap((s) => s.partOfSpeech));
    if (tags.has('vt') && !tags.has('vi')) transitive.push(id);
    else if (tags.has('vi') && !tags.has('vt')) intransitive.push(id);
  };
  const common = [];
  const own = new Map(); // key -> Map(id -> {slots, sense, narrow})
  const addOwn = (key, id, slots, sense, narrow) => {
    if (!own.has(key)) own.set(key, new Map());
    const m = own.get(key);
    const prev = m.get(id);
    if (!prev || sense < prev.sense) m.set(id, { slots, sense, narrow });
  };

  // Spellings EJDict may use for a JLPT word. A kana spelling shared by several JLPT
  // words (かみ: 紙, 髪, 神) is ambiguous and dropped.
  const aliases = new Map();
  const addAlias = (text, id) => {
    const prev = aliases.get(text);
    aliases.set(text, prev === undefined || prev === id ? id : -1);
  };

  // Easiest level first, so a word listed twice (今日 きょう N5, こんにち N3) keeps its N5 row.
  jlpt.sort((a, b) => a.level - b.level);
  for (const row of jlpt) {
    const expr = row.expression.split(/[;；]/)[0].trim();
    if (!expr || /[～〜~…（(]/.test(expr) || byExpr.has(expr)) continue;
    // "べんきょう (する)" marks a する noun; kana words may leave the reading blank.
    const suruListed = /\(する\)/.test(row.reading);
    const reading = row.reading.split(/[;；]/)[0].replace(/\s*\(する\)\s*$/, '').trim() || expr;
    const entry = entryFor(expr, reading);
    const senses = entry ? entry.sense.slice(0, 4) : [];
    const slots = new Set();
    let suru = suruListed;
    for (const s of senses.slice(0, 3)) {
      for (const tag of s.partOfSpeech) {
        if (tag === 'vs') suru = true;
        const slot = slotOf(tag);
        if (slot !== undefined) slots.add(slot);
      }
    }
    if (!entry) slots.add(/^to /i.test(row.meaning) ? V : N);
    if (!slots.size) continue; // particles, counters, interjections, prefixes
    const verbSenses = senses.slice(0, 3).filter((s) => s.partOfSpeech.some((t) => slotOf(t) === V));
    const meanings = senses.length
      ? senses.slice(0, 3).map((s) => s.gloss.slice(0, 3).map((g) => g.text).join('; ')).join(' | ')
      : row.meaning;
    const id = words.length;
    words.push([expr, expr, reading, row.level, 0, meanings, '']);
    if (verbSenses.length) valenceOf(id, verbSenses);
    byExpr.set(expr, id);
    // Kana spellings only for words usually written in kana: おや is also "oh my!", not 親.
    if (entry) for (const k of [...entry.kanji, ...(kanaOnly(entry) ? entry.kana : [])]) if (k.text !== expr) addAlias(k.text, id);
    slotsOf.push([...slots]);
    common.push(entry && (entry.kanji.some((k) => k.common) || entry.kana.some((k) => k.common)) ? 0 : 1);
    if (suru) {
      const sid = words.length;
      const verbSenses = senses.filter((s) => s.partOfSpeech.includes('vs'));
      words.push([`${expr}する`, `${expr}する`, `${reading}する`, row.level, 0,
        verbSenses.length ? verbSenses.slice(0, 3).map((s) => `to ${s.gloss[0].text}`).join(' | ') : `to ${row.meaning}`, '']);
      slotsOf.push([V]);
      common.push(common[id]);
      suruOf.set(id, sid);
      if (verbSenses.length) valenceOf(sid, verbSenses);
    }

    // The word's own glosses. Verbs gloss as "to ...", like CC-CEDICT; for a する noun the
    // same gloss also names its verb: 勉強 "study" -> 勉強する for the verb.
    senses.forEach((s, i) => {
      const senseSlots = [...new Set(s.partOfSpeech.map(slotOf).filter((x) => x !== undefined))];
      if (!senseSlots.length) return;
      const takesSuru = s.partOfSpeech.includes('vs') && suruOf.has(id);
      const gloss = s.gloss.map((g) => g.text).join('; ');
      for (const { key, j, slots: ks, narrow } of glossKeys(gloss, () => senseSlots, { benign: BENIGN })) {
        const sense = Math.min(i, 3) * 2 + Math.min(j, 3);
        addOwn(key, id, ks, sense, narrow);
        if (takesSuru) addOwn(key, suruOf.get(id), [V], sense, narrow);
      }
    });
  }

  // ---- EJDict ----
  const first = new Map(); // key -> [slot] -> { terms, hits: Map(id -> position) }
  const wordId = (text) => {
    const id = byExpr.get(text) ?? aliases.get(text);
    return id === undefined || id < 0 ? undefined : id;
  };
  const matchTerm = (text) => {
    // [id, slot or null] for each way the term names a JLPT word.
    const out = [];
    if (text === 'する') return out; // what's left of 水を…にする: never a translation by itself
    const id = wordId(text);
    if (id !== undefined) out.push([id, null]);
    // A particle left on the term: 彼は -> 彼, 私の -> 私.
    if (id === undefined && /[はがをの]$/.test(text)) {
      const base = wordId(text.slice(0, -1));
      if (base !== undefined) out.push([base, null]);
    }
    if (text.endsWith('する')) {
      const base = wordId(text.slice(0, -2));
      if (base !== undefined && suruOf.has(base)) out.push([suruOf.get(base), V]);
    }
    if (/[なにく]$/.test(text)) {
      // 静かな / 静かに -> 静か, 速く -> 速い
      const stem = text.endsWith('く') ? `${text.slice(0, -1)}い` : text.slice(0, -1);
      const base = wordId(stem);
      if (base !== undefined && slotsOf[base].includes(A)) out.push([base, A]);
    }
    return out;
  };
  for (const line of ejLines) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const defs = line.slice(tab + 1);
    for (const head of line.slice(0, tab).split(',')) {
      const key = head.trim();
      if (!/^[A-Za-z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*){0,2}$/.test(key) || STOP_KEYS.has(key.toLowerCase())) continue;
      const phrase = key.includes(' ');
      const perSlot = first.get(key) || [];
      // Position counts the EJDict senses of that part of speech, which come in order of
      // use (all of "work"'s noun senses come before its verb ones, so 働く is still the
      // first verb). A 『』 main translation moves up half a step ("plan": 『計画』 first,
      // its 『地図』 sense later).
      const senses = []; // slot -> senses with hits so far
      for (const sense of defs.split(' / ')) {
        const { hint, terms } = ejSense(sense);
        const hitSlots = new Set();
        for (const { text, main } of terms) {
          for (const [id, forced] of matchTerm(text)) {
            const wordSlots = slotsOf[id];
            let slots = forced !== null ? [forced] : hint !== null && wordSlots.includes(hint) ? [hint] : wordSlots;
            if (phrase) slots = [P];
            for (const slot of slots) {
              perSlot[slot] ||= { terms: [], hits: new Map() };
              const rank = senses[slot] || 0;
              const pos = main ? Math.max(0, rank - 0.5) : rank;
              hitSlots.add(slot);
              const prev = perSlot[slot].hits.get(id);
              if (prev === undefined || pos < prev) perSlot[slot].hits.set(id, pos);
            }
          }
          // Every term counts for the partial-agreement check, matched or not.
          const slot = phrase ? P : hint ?? null;
          for (const s of slot === null ? [V, N, A, F] : [slot]) {
            perSlot[s] ||= { terms: [], hits: new Map() };
            perSlot[s].terms.push(text);
          }
        }
        // A sense counts for the slots it matched, and for its likely part of speech even
        // when nothing in it is a JLPT word ("we": 私たちは, 人は ... come before あなたは).
        for (const slot of terms.length ? [...hitSlots, ...(hint === null ? [V, N, A, F] : [hint])] : hitSlots) hitSlots.add(slot);
        for (const slot of hitSlots) senses[slot] = (senses[slot] || 0) + 1;
      }
      if (perSlot.some((e) => e && e.hits.size)) first.set(key, perSlot);
    }
  }

  // Kana spellings defeat substring checks (友だち vs 友達, われわれ vs 我々), so agreement
  // here also means sharing a kanji or starting with the word's reading.
  const agrees = (term, [w, , reading]) =>
    term.includes(w) || w.includes(term) || term.startsWith(reading) || [...w].some((c) => /\p{Script=Han}/u.test(c) && term.includes(c));
  // Positions are whole EJDict senses, so only the first (or a 『』 term in the second)
  // is a main sense.
  const index = mergeCandidates(first, own, words, { agrees, strongPos: 0.5 });
  // "勉強する" names a する noun's verb row.
  const idOf = (spec, s) => {
    const id = s.endsWith('する') && !byExpr.has(s) ? suruOf.get(byExpr.get(s.slice(0, -2))) : byExpr.get(s);
    if (id === undefined) throw new Error(`overrides-ja.mjs "${spec}": ${s} is not a JLPT word`);
    return id;
  };
  applyOverrides(index, OVERRIDES, idOf, (id) => slotsOf[id]);
  const valence = new Map([...transitive.map((id) => [id, 't']), ...intransitive.map((id) => [id, 'i'])]);
  const packed = pack(index, words, {
    levelCols: [3],
    maxLevel: 5,
    tiebreak: (id) => words[id][3] * 10 + common[id] * 5 + words[id][0].length / 10,
    kindOf: (id) => valence.get(id) || '',
  });
  const lexical = lexicalKeys(packed, words, OVERRIDES.LEXICAL || [], guessRoot(packed));

  const size = await writeDict(OUT, 'ja', { lang: 'ja', speech: 'ja-JP', grammar: GRAMMAR, words, index: packed, lexical, measure: {}, transitive, intransitive },
    'open-anki-jlpt-decks (MIT), JMdict (CC BY-SA 4.0, EDRDG) and EJDict-hand (public domain)');
  console.log(`${words.length} words, ${Object.keys(packed).length} English keys, ${(size / 1024).toFixed(0)} KB -> ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
