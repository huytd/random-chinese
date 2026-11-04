// Finds English words and short phrases in text that have an HSK translation.
// Loaded as a content script (sets globalThis.RC_MATCHER) and required by the tests.
(function (root) {
  'use strict';

  const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
  const MAX_PHRASE = 3;
  // Sentence-start capitals ("Today we...") may match lowercase keys; other capitals are
  // likely names ("Bill", "Rose") and only match proper-noun keys like "China".
  const CLAUSE_BREAK = new Set('.!?:;"“”\'‘’()[]—–-');

  // True when only whitespace or clause punctuation precedes text[pos].
  function atClauseStart(text, pos) {
    let p = pos - 1;
    while (p >= 0 && /\s/.test(text[p])) p--;
    return p < 0 || CLAUSE_BREAK.has(text[p]);
  }

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

  // Chinese leaves question words where the answer would go and keeps the subject first,
  // while English moves them to the front: "How do I use AI" is 我怎么用AI, so it becomes
  // "我 怎么 use AI" rather than "怎么 do 我 use AI".
  const ADVERB_WH = new Set(['how', 'why']);
  const NOUN_WH = new Set(['what', 'who', 'which', 'whom', 'whose']);
  const SUBJECTS = new Set(['i', 'you', 'he', 'she', 'we', 'they']);
  const DO = new Set(['do', 'does', 'did']);
  const BE = new Set(['am', 'is', 'are', 'was', 'were']);
  const MODALS = new Set(['can', 'could', 'should', 'would', 'will', 'may', 'might', 'must', 'shall']);
  const SKIP = 'skip';

  // Returns null when no rule applies, SKIP to leave tokens[i] in English, or a match
  // that replaces several tokens at once in Chinese order.
  function questionWord(tokens, i, text, lookup, allowLower, clauseStart) {
    const wh = tokens[i].word.toLowerCase();
    const adverb = ADVERB_WH.has(wh);
    if (!adverb && !NOUN_WH.has(wh)) return null;
    // The lowercase word at k, if it directly follows the previous one.
    const at = (k) => (k < tokens.length && text.slice(tokens[k - 1].end, tokens[k].start) === ' ' ? tokens[k].word.toLowerCase() : null);
    const next = at(i + 1);

    if (!adverb) {
      // Mid-sentence these are mostly relative pronouns ("the book which ..."), and before
      // a verb or subject the Chinese word belongs at the end ("What do you want" is
      // 你要什么). Only a question word acting as the subject stays put: "Who wants tea".
      if (!clauseStart) return SKIP;
      return next && (DO.has(next) || BE.has(next) || MODALS.has(next) || SUBJECTS.has(next)) ? SKIP : null;
    }

    // how/why [do | be | modal] subject  ->  subject how/why [modal]
    let k = i + 1;
    let modal = null;
    let word = next;
    if (word && DO.has(word)) word = at(++k); // no Chinese counterpart, dropped
    else if (word && MODALS.has(word)) { modal = tokens[k].word; word = at(++k); }
    else if (word && BE.has(word)) {
      if (wh === 'how') return SKIP; // "How are you" is 你好吗, not 你怎么
      word = at(++k); // "why are you sad" -> 你为什么难过
    }
    if (word && SUBJECTS.has(word)) {
      const whId = lookup(tokens[i].word, allowLower);
      const subjectId = lookup(tokens[k].word, true);
      if (whId < 0 || subjectId < 0) return null;
      const parts = [{ id: subjectId, orig: tokens[k].word }, { id: whId, orig: tokens[i].word }];
      if (modal) parts.push({ text: modal });
      return { start: tokens[i].start, end: tokens[k].end, parts };
    }
    if (k > i + 1) return SKIP; // an inverted question whose subject we can't move
    // "how to cook", "why not" read the same in Chinese order. Before anything else the
    // word is a degree ("how big" is 多大) or the subject is a noun phrase we can't move.
    return next === 'to' || next === 'not' || next === null ? null : SKIP;
  }

  // Returns [{ start, end, parts }] for non-overlapping matches, longest phrase first.
  // parts lists what replaces text[start, end) in order: { id, orig } for a Chinese word
  // (orig is the English it stands for) or { text } for English kept as is.
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
      const clauseStart = atClauseStart(text, first.start);
      const allowLower = !capitalized || clauseStart || first.word === 'I';

      for (let n = Math.min(MAX_PHRASE, tokens.length - i); n >= 1; n--) {
        // Set phrases ("how much") come first, then word-order rules, then single words.
        if (n === 1) {
          const rule = questionWord(tokens, i, text, lookup, allowLower, clauseStart);
          if (rule === SKIP) break;
          if (rule) {
            matches.push(rule);
            i = tokens.findIndex((t) => t.end === rule.end);
            break;
          }
        }
        const span = tokens.slice(i, i + n);
        // Phrases only join words separated by a single space.
        if (span.some((t, k) => k > 0 && text.slice(span[k - 1].end, t.start) !== ' ')) continue;
        // Inner words must be lowercase so "New York Times" doesn't become "new" + ...
        if (span.some((t, k) => k > 0 && /[A-Z]/.test(t.word))) continue;
        const phrase = span.map((t) => t.word).join(' ');
        const id = lookup(phrase, allowLower);
        if (id >= 0) {
          const end = span[n - 1].end;
          matches.push({ start: first.start, end, parts: [{ id, orig: text.slice(first.start, end) }] });
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
