import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../vendor/compromise.js');
await import('../src/tagger.js');
await import('../src/dict-ja.js');
await import('../src/matcher.js');
const dict = globalThis.RC_DICTS.ja;
const { createLookup, findMatches } = globalThis.RC_MATCHER;
const { tag } = globalThis.RC_TAGGER;

// JLPT N5 = level 1 ... N1 = level 5.
const n5 = createLookup(dict, { system: 'jlpt', level: 1, onlyLevel: false });
const n3 = createLookup(dict, { system: 'jlpt', level: 3, onlyLevel: false });

const render = (m) => m.parts.map((p) => p.text ?? (p.prefix || '') + dict.words[p.id][0] + (p.suffix || '')).join(' ');
const rewrite = (text, lookup = n5) => {
  let out = '';
  let pos = 0;
  for (const m of findMatches(text, lookup, tag(text))) {
    out += text.slice(pos, m.start) + render(m);
    pos = m.end;
  }
  return out + text.slice(pos);
};

test('dictionary rows are well formed', () => {
  assert.equal(dict.lang, 'ja');
  assert.ok(dict.words.length > 8000);
  for (const [word, , reading, level, , meanings] of dict.words) {
    assert.ok(word && reading && meanings, word);
    assert.ok(level >= 1 && level <= 5, word);
  }
});

test('common words get their usual translation', () => {
  assert.equal(rewrite('Today I eat rice and drink water.'), '今日 私 食べる rice and 飲む 水.');
  assert.equal(rewrite('I read a book at school.'), '私 読む a 本 at 学校.');
});

test('する nouns become verbs for English verbs', () => {
  assert.equal(rewrite('I study every day.'), '私 勉強する 毎日.');
  assert.equal(rewrite('My study is quiet.', n3).split(' ')[1], '勉強');
});

test('verbs and nouns spelled the same get different translations', () => {
  assert.equal(rewrite('The building is tall.'), 'The 建物 is 高い.');
  assert.equal(rewrite('Building apps with AI'), '作る apps with AI');
});

test('possessives take の and question words keep Japanese order', () => {
  assert.equal(rewrite('my friend'), '私の 友達');
  assert.equal(rewrite('How do I use AI?'), '私 どう 使う AI?');
});

test('comparatives and superlatives take もっと and 一番', () => {
  assert.equal(rewrite('the highest mountain and a better plan'), 'the 一番高い 山 and a もっといい plan');
});

test('numbers before nouns stay English without counter data', () => {
  assert.equal(rewrite('three cats'), 'three 猫');
});

test('they for things stays English (no JLPT word for それら)', () => {
  assert.equal(rewrite('When cats walk, they use their toes.'), 'When 猫 歩く, they 使う their toes.');
});

test('a word above the learner level stays English', () => {
  // 我々 is N3.
  assert.equal(rewrite('We eat.'), 'We 食べる.');
  assert.equal(rewrite('We eat.', n3), '我々 食べる.');
});

test('verbs with an object are transitive, without one intransitive', () => {
  const n2 = createLookup(dict, { system: 'jlpt', level: 4, onlyLevel: false });
  assert.equal(rewrite('Open the door. The door opened.', n2), '開ける the door. The door 開く.');
  assert.equal(rewrite('She started a business.', n2).split(' ')[1], '始める');
  assert.equal(rewrite('The show started at nine.', n2).split(' ')[2], '始まる');
  assert.equal(rewrite('He spread the map.', n2).split(' ')[1], '広げる');
});

test('comparatives with a word of their own get no もっと', () => {
  const n2 = createLookup(dict, { system: 'jlpt', level: 4, onlyLevel: false });
  assert.ok(!rewrite('Years later, she was happier.', n2).includes('遅い'));
});
