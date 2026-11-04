// Finds English words and short phrases in text that have an HSK translation.
// Loaded as a content script (sets globalThis.RC_MATCHER) and required by the tests.
(function (root) {
  'use strict';

  const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
  const MAX_PHRASE = 3;
  // Sentence-start capitals ("Today we...") may match lowercase keys; other capitals are
  // likely names ("Bill", "Rose") and only match proper-noun keys like "China".
  const SENTENCE_END = /(^|[.!?:;"“”'‘’()\[\]—–-])\s*$/;

  // Column of the level for each syllabus in a dictionary row.
  const LEVEL_COL = { hsk3: 3, hsk2: 4 };

  // Base forms to try for an inflected word: books -> book, studies -> study,
  // loved -> love, running -> run. Exact matches are always tried first.
  function lemmas(word) {
    const out = [];
    const add = (w) => { if (w.length >= 2 && !out.includes(w)) out.push(w); };
    const n = word.length;
    if (n > 3 && word.endsWith('ies')) add(word.slice(0, -3) + 'y');
    if (n > 3 && /(ss|sh|ch|x|z|o)es$/.test(word)) add(word.slice(0, -2));
    if (n > 3 && word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
    if (n > 4 && word.endsWith('ied')) add(word.slice(0, -3) + 'y');
    if (n > 4 && word.endsWith('ed')) {
      const stem = word.slice(0, -2);
      add(stem + 'e');
      add(stem);
      if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1));
    }
    if (n > 5 && word.endsWith('ing')) {
      const stem = word.slice(0, -3);
      add(stem);
      add(stem + 'e');
      if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1));
    }
    if (n > 3 && word.endsWith("'s")) add(word.slice(0, -2));
    return out;
  }

  // settings: { system: 'hsk3' | 'hsk2', level: 1..7, onlyLevel: boolean }
  function createLookup(dict, settings) {
    const col = LEVEL_COL[settings.system] || LEVEL_COL.hsk3;
    const level = Number(settings.level) || 1;
    const cache = new Map();
    const lexical = new Set(dict.lexical);

    // Best translation the learner's level allows, or -1.
    function pick(key) {
      if (!Object.hasOwn(dict.index, key)) return -1; // also rules out "constructor" etc.
      const ids = dict.index[key];
      for (const id of ids) {
        const l = dict.words[id][col];
        if (l > 0 && l <= level) {
          // In "only my level" mode, skip words whose best translation is easier than
          // the level, rather than falling back to a worse translation at the level.
          return settings.onlyLevel && l !== level ? -1 : id;
        }
      }
      return -1;
    }

    return function lookup(phrase, allowLower) {
      const ck = phrase + (allowLower ? '\u0001' : '');
      if (cache.has(ck)) return cache.get(ck);
      let id = pick(phrase);
      if (id < 0 && allowLower) {
        const lower = phrase.toLowerCase();
        if (lower !== phrase) id = pick(lower);
        // "news" above the learner's level must not fall back to "new".
        if (id < 0 && !lexical.has(lower)) {
          const words = lower.split(' ');
          const last = words.pop();
          for (const base of lemmas(last)) {
            id = pick([...words, base].join(' '));
            if (id >= 0) break;
          }
        }
      }
      cache.set(ck, id);
      return id;
    };
  }

  // Returns [{ start, end, id }] for non-overlapping matches, longest phrase first.
  function findMatches(text, lookup) {
    const tokens = [];
    WORD_RE.lastIndex = 0;
    for (let m; (m = WORD_RE.exec(text)); ) tokens.push({ word: m[0].replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });

    const matches = [];
    for (let i = 0; i < tokens.length; i++) {
      const first = tokens[i];
      // Acronyms (US, IT) are never the English word they spell, except "I".
      if (first.word.length > 1 && first.word === first.word.toUpperCase() && lookup(first.word, false) < 0) continue;
      const capitalized = /^[A-Z]/.test(first.word);
      const allowLower = !capitalized || SENTENCE_END.test(text.slice(0, first.start)) || first.word === 'I';

      for (let n = Math.min(MAX_PHRASE, tokens.length - i); n >= 1; n--) {
        const span = tokens.slice(i, i + n);
        // Phrases only join words separated by a single space.
        if (span.some((t, k) => k > 0 && text.slice(span[k - 1].end, t.start) !== ' ')) continue;
        // Inner words must be lowercase so "New York Times" doesn't become "new" + ...
        if (span.some((t, k) => k > 0 && /[A-Z]/.test(t.word))) continue;
        const phrase = span.map((t) => t.word).join(' ');
        const id = lookup(phrase, allowLower);
        if (id >= 0) {
          matches.push({ start: first.start, end: span[n - 1].end, id });
          i += n - 1;
          break;
        }
      }
    }
    return matches;
  }

  const api = { lemmas, createLookup, findMatches, LEVEL_COL };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RC_MATCHER = api;
})(globalThis);
