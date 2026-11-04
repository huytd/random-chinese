import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/dict.js');
await import('../src/matcher.js');
const dict = globalThis.RC_DICT;
const { lemmas, createLookup, findMatches } = globalThis.RC_MATCHER;

const hsk1 = createLookup(dict, { system: 'hsk3', level: 1, onlyLevel: false });
const hsk6 = createLookup(dict, { system: 'hsk3', level: 6, onlyLevel: false });

// [original text, replacement] for each match; replacements of several words are
// joined with spaces in the order they appear on the page.
const render = (m) => m.parts.map((p) => p.text ?? dict.words[p.id][0]).join(' ');
const translate = (text, lookup = hsk1) => findMatches(text, lookup).map((m) => [text.slice(m.start, m.end), render(m)]);

// The whole text with every match replaced.
const rewrite = (text, lookup = hsk6) => {
  let out = '';
  let pos = 0;
  for (const m of findMatches(text, lookup)) {
    out += text.slice(pos, m.start) + render(m);
    pos = m.end;
  }
  return out + text.slice(pos);
};

test('dictionary rows are well formed', () => {
  assert.ok(dict.words.length > 10000);
  for (const [simp, trad, pinyin, hsk3, hsk2, meanings] of dict.words) {
    assert.ok(simp && trad && pinyin && meanings, simp);
    assert.ok(hsk3 > 0 || hsk2 > 0, simp);
  }
  for (const [key, ids] of Object.entries(dict.index)) {
    assert.ok(ids.length > 0 && ids.every((id) => dict.words[id]), key);
  }
});

test('common words get their usual translation', () => {
  assert.deepEqual(translate('I love my friend and we eat rice today'), [
    ['I', '我'], ['love', '爱'], ['my', '我'], ['friend', '朋友'], ['we', '我们'], ['eat', '吃'], ['rice', '米饭'], ['today', '今天'],
  ]);
});

test('inflected forms match their base word', () => {
  assert.deepEqual(translate('books'), [['books', '书']]);
  assert.deepEqual(translate('loved'), [['loved', '爱']]);
  assert.deepEqual(translate('walked'), [['walked', '走']]);
  // tired is 累, not a form of tire (轮胎).
  assert.ok(!translate('tired', hsk6).some(([, zh]) => zh === '轮胎'));
  assert.deepEqual(translate('studies'), [['studies', '学习']]);
  assert.deepEqual(translate('goes'), [['goes', '去']]);
  // "news" is a word of its own (新闻, HSK 2), not the plural of "new".
  assert.deepEqual(translate('news'), []);
});

test('lemmas never shrink a word below two letters', () => {
  assert.deepEqual(lemmas('is'), []);
  assert.ok(!lemmas('us').includes('u'));
  assert.ok(lemmas('boxes').includes('box'));
  assert.ok(lemmas('stopped').includes('stop'));
});

test('ambiguous function words are left alone', () => {
  assert.deepEqual(translate('the table is on the left and it can see that'), [['table', '桌子'], ['see', '看见']]);
});

test('capitalized words mid-sentence are treated as names', () => {
  assert.deepEqual(translate('I met Rose and Bill'), [['I', '我']]);
  assert.deepEqual(translate('Today. Love wins'), [['Today', '今天'], ['Love', '爱']]);
  assert.deepEqual(translate('He went to China'), [['He', '他'], ['China', '中国']]);
});

test('object prototype names are not dictionary keys', () => {
  assert.deepEqual(translate('constructor toString hasOwnProperty'), []);
});

test('acronyms are skipped', () => {
  assert.deepEqual(translate('US IT'), []);
});

test('multi-word phrases win over single words', () => {
  assert.deepEqual(translate('we get up'), [['we', '我们'], ['get up', '起床']]);
  assert.deepEqual(translate('use your cell phone'), [['use', '用'], ['cell phone', '手机']]);
});

test('level limits which words are used', () => {
  // 经济 economy is HSK 3.0 level 3
  assert.deepEqual(translate('economy', hsk1), []);
  assert.deepEqual(translate('economy', hsk6), [['economy', '经济']]);
  const only3 = createLookup(dict, { system: 'hsk3', level: 3, onlyLevel: true });
  assert.deepEqual(translate('economy and water', only3), [['economy', '经济']]);
});

test('HSK 2.0 levels are separate from HSK 3.0', () => {
  const old1 = createLookup(dict, { system: 'hsk2', level: 1, onlyLevel: false });
  // 天 is HSK 3.0 level 1 but not an HSK 2.0 word; 火车站 is only in HSK 2.0.
  assert.deepEqual(translate('day', old1), [['day', '日']]);
  assert.deepEqual(translate('day', hsk1), [['day', '天']]);
  assert.deepEqual(translate('train station', old1), [['train station', '火车站']]);
});

test('how/why go after the subject, as in Chinese', () => {
  assert.equal(rewrite('How I use AI?'), '我 怎么 用 AI?');
  assert.equal(rewrite('How do I use AI?'), '我 怎么 用 AI?');
  assert.equal(rewrite('How can I help you'), '我 怎么 can 帮助 你');
  assert.equal(rewrite('Why are you sad?'), '你 为什么 难过?');
  assert.equal(rewrite('Why did she leave?'), '她 为什么 离开?');
  assert.equal(rewrite('I know why he left'), '我 知道 他 为什么 left');
});

test('how/why stay put where Chinese puts them first too', () => {
  assert.equal(rewrite('How to cook rice'), '怎么 to 煮 米饭');
  assert.equal(rewrite('why not'), '为什么 not');
});

test('how/why are left in English when the order can not be fixed', () => {
  // "How are you" is 你好吗, and "how big" is 多大, not 怎么.
  assert.equal(rewrite('How are you'), 'How are 你');
  assert.equal(rewrite('how big'), 'how 大');
  // A noun-phrase subject can't be moved reliably.
  assert.equal(rewrite('How does the system work').startsWith('How does'), true);
});

test('set phrases beat the word-order rules', () => {
  assert.deepEqual(translate('how much'), [['how much', '多少']]);
});

test('what/who are only used as a question subject', () => {
  assert.equal(rewrite('Who wants tea?'), '谁 要 茶?');
  // Object questions and relative pronouns stay in English.
  assert.equal(rewrite('What do you want?'), 'What do 你 要?');
  assert.equal(rewrite('the man who lives here').includes('谁'), false);
});
