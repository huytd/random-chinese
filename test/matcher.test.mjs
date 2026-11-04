import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../vendor/compromise.js');
await import('../src/tagger.js');
await import('../src/dict-zh.js');
await import('../src/matcher.js');
const dict = globalThis.RC_DICTS.zh;
const { lemmas, createLookup, findMatches } = globalThis.RC_MATCHER;
const { tag } = globalThis.RC_TAGGER;

const hsk1 = createLookup(dict, { system: 'hsk3', level: 1, onlyLevel: false });
const hsk6 = createLookup(dict, { system: 'hsk3', level: 6, onlyLevel: false });

// [original text, replacement] for each match; replacements of several words are
// joined with spaces in the order they appear on the page.
const render = (m) => m.parts.map((p) => p.text ?? (p.prefix || '') + dict.words[p.id][0] + (p.suffix || '')).join(' ');
const translate = (text, lookup = hsk1) => findMatches(text, lookup, tag(text)).map((m) => [text.slice(m.start, m.end), render(m)]);

// The whole text with every match replaced.
const rewrite = (text, lookup = hsk6) => {
  let out = '';
  let pos = 0;
  for (const m of findMatches(text, lookup, tag(text))) {
    out += text.slice(pos, m.start) + render(m);
    pos = m.end;
  }
  return out + text.slice(pos);
};

test('dictionary rows are well formed', () => {
  assert.ok(dict.words.length > 10000);
  for (const [simp, trad, pinyin, hsk3, hsk2, meanings, classifier] of dict.words) {
    assert.ok(simp && trad && pinyin && meanings, simp);
    assert.ok(hsk3 > 0 || hsk2 > 0, simp);
    if (classifier) assert.ok(dict.measure[classifier] !== undefined, `${simp} ${classifier}`);
  }
  for (const [key, slots] of Object.entries(dict.index)) {
    assert.ok(slots.length > 0 && slots.length <= 5, key);
    assert.ok(slots.some((ids) => ids && ids.length), key);
    for (const ids of slots) if (ids) assert.ok(ids.every((id) => dict.words[id]), key);
  }
});

test('common words get their usual translation', () => {
  assert.deepEqual(translate('Today I love my friend and we eat rice'), [
    ['Today', '今天'], ['I', '我'], ['love', '爱'], ['my', '我的'], ['friend', '朋友'], ['we', '我们'], ['eat', '吃'], ['rice', '米饭'],
  ]);
});

test('inflected forms match their base word', () => {
  assert.deepEqual(translate('I read books'), [['I', '我'], ['read', '读'], ['books', '书']]);
  assert.deepEqual(translate('She bought it', hsk6).slice(1), [['bought', '买']]);
  assert.deepEqual(translate('She loved him').slice(1, 2), [['loved', '爱']]);
  const second = (text, lookup) => translate(text, lookup)[1];
  assert.deepEqual(second('We walked home'), ['walked', '走']);
  // tired is 累, not a form of tire (轮胎).
  assert.ok(!translate('I am tired', hsk6).some(([, zh]) => zh === '轮胎'));
  assert.deepEqual(second('She studies hard'), ['studies', '学习']);
  assert.deepEqual(second('He goes home'), ['goes', '去']);
  // "news" is a word of its own (新闻, HSK 2), not the plural of "new".
  assert.deepEqual(translate('the news'), []);
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
  assert.deepEqual(translate('He went to China'), [['He', '他'], ['went', '去'], ['China', '中国']]);
});

test('object prototype names are not dictionary keys', () => {
  assert.deepEqual(translate('constructor toString hasOwnProperty'), []);
});

test('acronyms are skipped', () => {
  assert.deepEqual(translate('US IT'), []);
});

test('multi-word phrases win over single words', () => {
  assert.deepEqual(translate('we get up'), [['we', '我们'], ['get up', '起床']]);
  assert.deepEqual(translate('use your cell phone'), [['use', '用'], ['your', '你的'], ['cell phone', '手机']]);
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
  assert.deepEqual(translate('one day', old1), []);
  assert.deepEqual(translate('one day', hsk1), [['day', '天']]);
  assert.deepEqual(translate('train station', old1), [['train station', '火车站']]);
});

test('how/why go after the subject, as in Chinese', () => {
  assert.equal(rewrite('How I use AI?'), '我 怎么 用 AI?');
  assert.equal(rewrite('How do I use AI?'), '我 怎么 用 AI?');
  assert.equal(rewrite('How can I help you'), '我 怎么 can 帮助 你');
  assert.equal(rewrite('Why are you sad?'), '你 为什么 难过?');
  assert.equal(rewrite('Why did she leave?'), '她 为什么 离开?');
  assert.equal(rewrite('I know why he left'), '我 知道 他 为什么 离开');
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

const hsk3 = createLookup(dict, { system: 'hsk3', level: 3, onlyLevel: false });
const hsk5 = createLookup(dict, { system: 'hsk3', level: 5, onlyLevel: false });

test('verbs and nouns spelled the same get different translations', () => {
  assert.equal(rewrite('Building apps with AI', hsk3), '建立 apps with AI');
  assert.equal(rewrite('The building is tall.', hsk5), 'The 建筑 is 高.');
  // Never the 房子 "house" that CC-CEDICT also glosses as "building".
  assert.ok(!rewrite('We are building a house.', hsk3).includes('房子 a'));
  assert.equal(rewrite('Rain is falling and it will rain', hsk3), '雨 is falling and it will 下雨');
  assert.equal(rewrite('I drink water. Have a drink.', hsk5), '我 喝 水. Have a 饮料.');
  assert.equal(rewrite('The children play a show.', hsk3), 'The 孩子 玩儿 a 节目.');
});

test('a word with no translation at the learner level stays English', () => {
  // "water the plants" has no HSK verb; 植物 is level 4, and 工厂 (a factory plant) is wrong.
  assert.equal(rewrite('Water the plants.', hsk3), 'Water the plants.');
  assert.equal(rewrite('Water the plants.', hsk5), 'Water the 植物.');
});

test('irregular forms go by their base form', () => {
  assert.equal(rewrite('The children bought it.', hsk3), 'The 孩子 买 it.');
});

test('numbers before a noun get its measure word', () => {
  assert.equal(rewrite('She has two cats and three big dogs.', hsk3), '她 has 两只 猫 and 三只 大 狗.');
  assert.equal(rewrite('I read three books.', hsk3), '我 读 三本 书.');
});

test('possessive pronouns take 的', () => {
  assert.equal(rewrite('my friend and the students and their teacher', hsk3), '我的 朋友 and the 学生 and 他们的 老师');
  assert.equal(rewrite("It improves people's lives.", hsk3), 'It improves 人的 lives.');
});

test('time words are only swapped where Chinese would put them', () => {
  assert.equal(rewrite('Today I eat rice.', hsk3), '今天 我 吃 米饭.');
  assert.equal(rewrite('I eat rice today.', hsk3), '我 吃 米饭 today.');
});

test('phrasal verbs are not split', () => {
  // "gave up" is not 给 + up; 放弃 is HSK 5.
  assert.equal(rewrite('He gave up.', hsk3), '他 gave up.');
  assert.equal(rewrite('He gave up.', hsk5), '他 放弃.');
  assert.equal(rewrite('The event took place.', hsk3), 'The 事件 发生.');
});

test('names and parts of compounds are left alone', () => {
  assert.equal(rewrite('Bill and Apple went to China', hsk3), 'Bill and Apple 去 to 中国');
  assert.equal(rewrite('a full-time job', hsk3), 'a full-time 工作');
});

test('the measure word comes from the noun even above the learner level', () => {
  // 猫 is HSK 3.0 level 2.
  assert.equal(rewrite('two cats', hsk1), '两只 cats');
});

test('comparatives and superlatives take 更 and 最', () => {
  const hsk4 = createLookup(dict, { system: 'hsk3', level: 4, onlyLevel: false });
  assert.equal(rewrite('the highest mountain', hsk4), 'the 最高 山');
  assert.equal(rewrite('She is the best student, and he is taller.', hsk4), '她 is the 最好 学生, and 他 is 更高.');
});

test('quantifier nouns and fixed expressions stay English', () => {
  assert.equal(rewrite('He has a lot of money.', hsk3), '他 has a lot of 钱.');
  assert.equal(rewrite('We got used to it.', hsk3), '我们 got used to it.');
});

test('they/them/their follow what they refer to', () => {
  const hsk2 = createLookup(dict, { system: 'hsk3', level: 2, onlyLevel: false });
  assert.equal(rewrite('When cats walk, they use their toes.', hsk2), 'When 猫 走, 它们 用 它们的 toes.');
  assert.equal(rewrite('The players said they won.', hsk2), 'The players 说 他们 won.');
  // No referent in the text: left in English rather than guessed.
  assert.equal(rewrite('They said so.', hsk2), 'They 说 so.');
});

test('accented words and classifier glosses do not produce fragments', () => {
  const hsk2 = createLookup(dict, { system: 'hsk3', level: 2, onlyLevel: false });
  assert.ok(!rewrite('We met in cafés.', hsk6).includes('酒店'));
  assert.ok(!rewrite('She ate a cake.', hsk2).includes('块'));
});

test('comparatives with a word of their own get no 更', () => {
  const hsk4 = createLookup(dict, { system: 'hsk3', level: 4, onlyLevel: false });
  assert.equal(rewrite('Years later, she was happier.', hsk4), '年 以后, 她 was 更快乐.');
});
