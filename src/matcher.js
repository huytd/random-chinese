// Finds English words and short phrases in text that have an HSK translation, using
// part-of-speech tags from src/tagger.js when given. Loaded as a content script (sets
// globalThis.RC_MATCHER) and imported by the tests.
(function (root) {
  'use strict';

  // Accented letters are part of words, so "cafés" is one word and isn't matched as "caf".
  const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g;
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
  const LEVEL_COL = { hsk3: 3, hsk2: 4, jlpt: 3 };
  // Dictionary slots (see scripts/build-dict.mjs); ANY when the part of speech is unknown.
  const SLOT = { V: 0, N: 1, A: 2, F: 3, P: 4, ANY: -1 };
  const ANY_ORDER = [SLOT.P, SLOT.V, SLOT.N, SLOT.A, SLOT.F];

  // Base forms to try for an inflected word when there are no tags: books -> book,
  // studies -> study, loved -> love, running -> run. Exact matches are always tried first.
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

    // Verbs that only take an object, or only go without one (Japanese 始める / 始まる).
    const transitivity = new Map();
    for (const id of dict.transitive || []) transitivity.set(id, 't');
    for (const id of dict.intransitive || []) transitivity.set(id, 'i');

    // Best translation in a list that the learner's level allows, or -1. valence: 't' when
    // the English verb has an object, 'i' when it hasn't, '' to ignore; a verb of the other
    // kind is only used when no better-fitting one is allowed.
    function first(ids, valence = '') {
      let fallback = -1;
      for (const id of ids) {
        const l = dict.words[id][col];
        if (l > 0 && l <= level) {
          // In "only my level" mode, skip words whose best translation is easier than
          // the level, rather than falling back to a worse translation at the level.
          if (settings.onlyLevel && l !== level) return -1;
          const v = transitivity.get(id);
          if (!valence || !v || v === valence) return id;
          if (fallback < 0) fallback = id;
        }
      }
      return fallback;
    }

    function pick(key, slot, valence) {
      if (!Object.hasOwn(dict.index, key)) return -1; // also rules out "constructor" etc.
      const slots = dict.index[key];
      if (slot !== SLOT.ANY) return slots[slot] ? first(slots[slot], valence) : -1;
      for (const s of ANY_ORDER) {
        const id = slots[s] ? first(slots[s]) : -1;
        if (id >= 0) return id;
      }
      return -1;
    }

    // word: as written; slot: its part of speech (SLOT.*); base: its base form from the
    // tagger ("bought" -> "buy"), or null to guess one from the spelling; order: which
    // forms to try, 'word' (word, then base), 'base' (base, then word) or 'plural' (the
    // base only, unless the plural is a word of its own like "glasses").
    function lookup(word, allowLower, slot = SLOT.ANY, base = null, order = 'word', valence = '') {
      const ck = `${word}|${allowLower ? 1 : 0}|${slot}|${base || ''}|${order}|${valence}`;
      if (cache.has(ck)) return cache.get(ck);
      const lower = word.toLowerCase();
      const exact = allowLower && lower !== word ? [word, lower] : [word];
      // Verb inflections carry no meaning in Chinese, so verbs always may use their base
      // form; other words not when it means something else: "news" is not "new".
      const blocked = !allowLower || (slot !== SLOT.V && lexical.has(lower));
      const bases = blocked ? [] : base ? [base] : lemmas(lower.split(' ').pop()).map((b) => lower.replace(/\S+$/, b));
      let forms = [...exact, ...bases];
      if (order === 'base') forms = [...new Set([...bases, ...exact])];
      else if (order === 'plural' && bases.length) forms = bases;
      let id = -1;
      for (const f of forms) if ((id = pick(f, slot, valence)) >= 0) break;
      cache.set(ck, id);
      return id;
    }

    // The grammar the dictionary's language needs (see scripts/build-dict-*.mjs).
    lookup.grammar = dict.grammar;

    // The id of a word, for grammar rules that need a specific one (两 before a measure
    // word).
    let bySimplified = null;
    lookup.word = (simplified) => {
      bySimplified ||= new Map(dict.words.map((w, id) => [w[0], id]));
      return bySimplified.get(simplified) ?? -1;
    };
    lookup.allowed = (id) => id >= 0 && first([id]) === id;
    lookup.hanzi = (id) => dict.words[id][0];
    // The measure word for a noun, whatever the learner's level: "two cats" is 两只 even
    // for a learner who doesn't know 猫 yet.
    lookup.measure = (noun, base) => {
      let c = '';
      for (const key of [base, noun.toLowerCase(), noun]) {
        const ids = key && Object.hasOwn(dict.index, key) && dict.index[key][SLOT.N];
        const withMeasure = ids && ids.find((id) => dict.words[id][6]);
        if (withMeasure !== undefined && withMeasure !== false) {
          c = dict.words[withMeasure][6];
          break;
        }
      }
      c ||= dict.grammar.defaultMeasure;
      return { suffix: c, suffixPinyin: dict.measure[c] || '' };
    };
    return lookup;
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

  // Nouns that are really quantifiers in "a number of", "a lot of".
  const QUANTITY_NOUNS = new Set(['number', 'lot', 'couple', 'variety', 'range', 'majority', 'bunch', 'series', 'total', 'handful', 'plenty', 'deal', 'kind', 'sort', 'type']);

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
      // 怎么/为什么 are pronouns in Chinese; the adverb slot has 如何 and the noun slot 方式.
      let whId = lookup(tokens[i].word, allowLower, SLOT.F);
      if (whId < 0) whId = lookup(tokens[i].word, allowLower, SLOT.A);
      const subjectId = lookup(tokens[k].word, true, SLOT.F);
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

  // Gives each token the tag that covers its first character.
  function attachTags(tokens, tags) {
    let t = 0;
    for (const tok of tokens) {
      while (t < tags.length && tags[t].end <= tok.start) t++;
      if (t < tags.length && tags[t].start <= tok.start) tok.info = tags[t];
    }
  }

  // A single word, or null to leave it in English.
  function wordMatch(tokens, i, text, lookup, allowLower, clauseStart) {
    const tok = tokens[i];
    const info = tok.info;
    if (!info) {
      const id = lookup(tok.word, allowLower);
      return id >= 0 ? { start: tok.start, end: tok.end, parts: [{ id, orig: tok.word }] } : null;
    }
    if (info.skip || info.name) return null;
    const prev = i > 0 ? tokens[i - 1] : null;
    const next = i + 1 < tokens.length && text.slice(tok.end, tokens[i + 1].start) === ' ' ? tokens[i + 1] : null;
    const lower = tok.word.toLowerCase();
    // "gave up" is not 给 + up.
    if (info.slot === SLOT.V && next?.info?.particle) return null;
    // Fixed expressions: "a number of", "get used to".
    if (QUANTITY_NOUNS.has(lower) && /^an?$/i.test(prev?.word || '') && next?.word === 'of') return null;
    if (lower === 'used' && next?.word === 'to') return null;
    // Chinese puts time words before the verb (我今天吃米饭), so a "today" trailing a verb,
    // object or adverb stays English; at the start of a clause, after the subject or in
    // "one day", "in the morning" it reads fine.
    const after = prev?.info;
    if (info.date && !clauseStart && after && !after.subject && [SLOT.V, SLOT.N, SLOT.A].includes(after.slot)) return null;

    // Verbs go by their base form ("works" -> work, not the noun "works" 著作), and plurals
    // by their singular only, as their own dictionary entries list rarer senses (plants -> 工厂).
    const order = info.slot === SLOT.V ? 'base' : info.slot === SLOT.N && info.plural ? 'plural' : 'word';
    // An object after the verb ("started a centre", "began trying") calls for a transitive
    // verb, none ("began to spread", "it starts") for an intransitive one.
    const afterNext = i + 2 < tokens.length ? tokens[i + 2] : null;
    const hasObject = !!next?.info && (next.info.determiner || (!next.info.skip && [SLOT.N, SLOT.F, SLOT.A].includes(next.info.slot)) || next.info.gerund
      || (next.word === 'to' && afterNext?.info?.slot === SLOT.V)); // "began to spread": 広がり始める
    const valence = info.slot === SLOT.V ? (hasObject ? 't' : 'i') : '';
    let id = lookup(tok.word, allowLower, info.slot, info.root, order, valence);
    const grammar = lookup.grammar;
    // they/them/their: 他们 for people, 它们 for animals and things, and left in English
    // when the tagger can't tell what they refer to.
    if (info.human === null) return null;
    if (info.human === false && id >= 0) {
      const it = grammar.thingsPronoun ? lookup.word(grammar.thingsPronoun) : -1;
      if (!lookup.allowed(it)) return null;
      id = it;
    }
    // "Learning Chinese is hard": a gerund the tagger calls a noun may still only have a
    // verb translation (学习), and a verb gerund a noun one ("cooking" 烹饪). Only the -ing
    // form itself: "smoking" must not become the noun "smoke" (烟).
    // Not when it has an object, though: "Building apps" is a verb even when the learner
    // has no word for "build", and must not become the noun 建物.
    if (id < 0 && info.gerund && !hasObject) id = lookup(tok.word, allowLower, SLOT.N, tok.word.toLowerCase());
    else if (id < 0 && tok.word.toLowerCase().endsWith('ing') && info.slot === SLOT.N) id = lookup(tok.word, allowLower, SLOT.V, null, 'base');
    if (id < 0) return null;
    const part = { id, orig: tok.word };

    // "my friend" is 我的朋友 / 私の友達, "people's lives" 人的生活.
    if (info.possessive) Object.assign(part, { suffix: grammar.possessive[0], suffixPinyin: grammar.possessive[1] });
    // "highest" is 最高 / 一番高い and "better" 更好 / もっといい, unless the word already
    // says so (最高, 更好).
    // Only when the translation is the base adjective's: "better" -> 好 needs 更, but
    // "later" has a word of its own (以后).
    const marked = grammar.comparativeMarks && grammar.comparativeMarks.includes(lookup.hanzi(id)[0]);
    const fromBase = () => {
      const own = lookup(tok.word, allowLower, SLOT.A, lower);
      return own < 0 || own === lookup(info.root, true, SLOT.A, info.root);
    };
    if ((info.superlative || info.comparative) && info.adjective && !marked && fromBase()) {
      const [prefix, prefixPinyin] = info.superlative ? grammar.most : grammar.more;
      Object.assign(part, { prefix, prefixPinyin });
    }
    // "three books" is 三本书: a number before a noun takes that noun's measure word.
    // Languages without measure-word data (Japanese counters) leave such numbers English.
    if (info.number) {
      let k = i + 1;
      const joined = (j) => j < tokens.length && text.slice(tokens[j - 1].end, tokens[j].start) === ' ';
      if (joined(k) && tokens[k].info?.slot === SLOT.A) k++;
      const noun = joined(k) && tokens[k].info?.noun && !tokens[k].info.date ? tokens[k] : null;
      if (noun && !grammar.measure) return null;
      if (noun) {
        Object.assign(part, lookup.measure(noun.word, noun.info.root));
        // 两本书, not 二本书
        const [two, twoBefore] = grammar.two || [];
        if (two && lookup.word(two) === id && lookup.word(twoBefore) >= 0) part.id = lookup.word(twoBefore);
      }
    }
    return { start: tok.start, end: tok.end, parts: [part] };
  }

  // Returns [{ start, end, parts }] for non-overlapping matches, longest phrase first.
  // parts lists what replaces text[start, end) in order: { id, orig, prefix?, suffix? }
  // for a Chinese word (orig is the English it stands for; prefix and suffix are grammar the
  // Chinese needs, like 最, 的 or a measure word, each with a ...Pinyin field) or { text }
  // for English kept as is.
  // tags: from RC_TAGGER.tag(text), or omitted to match by spelling alone.
  function findMatches(text, lookup, tags) {
    const tokens = [];
    WORD_RE.lastIndex = 0;
    for (let m; (m = WORD_RE.exec(text)); ) tokens.push({ word: m[0].replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
    if (tags) attachTags(tokens, tags);

    const matches = [];
    for (let i = 0; i < tokens.length; i++) {
      const first = tokens[i];
      // Acronyms (US, IT) are never the English word they spell, except "I".
      if (first.word.length > 1 && first.word === first.word.toUpperCase() && lookup(first.word, false) < 0) continue;
      // Parts of hyphenated compounds: the "time" in full-time.
      if (text[first.start - 1] === '-' || text[first.end] === '-') continue;
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
          const single = wordMatch(tokens, i, text, lookup, allowLower, clauseStart);
          if (single) matches.push(single);
          break;
        }
        const span = tokens.slice(i, i + n);
        // Phrases only join words separated by a single space.
        if (span.some((t, k) => k > 0 && text.slice(span[k - 1].end, t.start) !== ' ')) continue;
        // Inner words must be lowercase so "New York Times" doesn't become "new" + ...
        if (span.some((t, k) => k > 0 && /[A-Z]/.test(t.word))) continue;
        const phrase = span.map((t) => t.word).join(' ');
        // "took place" is "take place": phrases go by their first word's base form.
        const root = span[0].info?.slot === SLOT.V && span[0].info.root !== span[0].word.toLowerCase()
          ? [span[0].info.root, ...span.slice(1).map((t) => t.word)].join(' ')
          : null;
        const id = lookup(phrase, allowLower, tags ? SLOT.P : SLOT.ANY, root);
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

  const api = { lemmas, createLookup, findMatches, LEVEL_COL, SLOT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RC_MATCHER = api;
})(globalThis);
