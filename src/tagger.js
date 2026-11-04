// Part-of-speech tags for English text, from compromise (vendor/compromise.js, MIT).
// Loaded as a content script after compromise (sets globalThis.RC_TAGGER).
(function (root) {
  'use strict';

  // Dictionary slots, shared with scripts/build-dict.mjs and src/matcher.js.
  const SLOT = { V: 0, N: 1, A: 2, F: 3 };

  // Tags whose words are grammar, not vocabulary.
  const SKIP = ['Determiner', 'Preposition', 'Conjunction', 'Auxiliary', 'Copula', 'Modal', 'Particle', 'Negative', 'Expression'];
  // Names and brands; places (China) are still translated.
  const NAME = ['Person', 'Organization', 'Acronym'];
  const SUBJECT_PRONOUNS = new Set(['i', 'you', 'he', 'she', 'we', 'they']);
  const POSSESSIVE_PRONOUNS = new Set(['my', 'your', 'his', 'her', 'our', 'their']);
  // Pronouns whose Chinese depends on what they refer to: 他们 for people, 它们 otherwise.
  const PLURAL_PRONOUNS = /^(they|them|their)$/i;

  function describe(term) {
    const tags = new Set(term.tags);
    const word = term.text.toLowerCase();
    const has = (list) => list.some((t) => tags.has(t));
    const info = {
      slot: -1, // unknown: any slot
      root: term.root || term.normal || word,
      skip: has(SKIP) && !tags.has('QuestionWord'),
      name: has(NAME) || (tags.has('ProperNoun') && !tags.has('Place') && !tags.has('Demonym')),
      gerund: tags.has('Gerund'),
      plural: tags.has('Plural'),
      possessive: tags.has('Possessive') && (POSSESSIVE_PRONOUNS.has(word) || /['’]s?$/.test(word)),
      subject: tags.has('Pronoun') && SUBJECT_PRONOUNS.has(word),
      noun: tags.has('Noun'),
      date: tags.has('Date'),
      number: tags.has('Cardinal') && tags.has('TextValue'),
      particle: tags.has('Particle'),
      comparative: tags.has('Comparative'),
      superlative: tags.has('Superlative'),
    };
    // 怎么, 什么, 谁 are pronouns in Chinese.
    if (tags.has('Pronoun') || tags.has('QuestionWord') || POSSESSIVE_PRONOUNS.has(word) || tags.has('Value')) info.slot = SLOT.F;
    else if (tags.has('Verb')) info.slot = SLOT.V;
    else if (tags.has('Adjective') || tags.has('Adverb')) info.slot = SLOT.A;
    else if (tags.has('Noun') || tags.has('Date')) info.slot = SLOT.N;
    return info;
  }

  // [{ start, end, ...describe() }] for the words in text, in order.
  function tag(text) {
    const nlp = root.nlp;
    if (!nlp) return null;
    const doc = nlp(text);
    doc.compute('root');
    const out = [];
    const byStart = new Map();
    for (const sentence of doc.json({ offset: true })) {
      for (const term of sentence.terms) {
        if (!term.offset || !term.offset.length) continue; // implied words: don't -> do not
        const info = { start: term.offset.start, end: term.offset.start + term.offset.length, ...describe(term) };
        out.push(info);
        byStart.set(info.start, info);
      }
    }
    // human: true/false when they/them/their refer to people or to things ("cats ... they"),
    // null when the referent isn't in this text.
    try {
      doc.compute('coreference');
      doc.pronouns().forEach((p) => {
        const term = p.json({ offset: true })[0]?.terms?.[0];
        const info = term && byStart.get(term.offset.start);
        if (!info || !PLURAL_PRONOUNS.test(term.text)) return;
        const ref = p.refersTo();
        info.human = ref.found ? ref.has('(#Person|#Actor)') : null;
      });
    } catch {
      // coreference is a bonus; without it plural pronouns stay unresolved (null)
    }
    for (const info of out) if (PLURAL_PRONOUNS.test(text.slice(info.start, info.end)) && info.human === undefined) info.human = null;
    return out;
  }

  root.RC_TAGGER = { tag, SLOT };
})(globalThis);
