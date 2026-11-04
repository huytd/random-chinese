// Hand fixes for the Japanese dictionary, in the same format as overrides-zh.mjs. Words
// are written as in the JLPT list; a する noun's verb is "勉強する".
import { LEXICAL as SHARED_LEXICAL } from './overrides-zh.mjs';

export const OVERRIDES = {
  he: ['彼'],
  how: ['どう'],
  car: ['車', '自動車'],
  people: ['人'],
  day: ['日'],
  today: ['今日'],
  friend: ['友達', '友人'],
  good: ['いい', '良い'],
  happy: ['嬉しい', '楽しい'],
  want: ['欲しい'],
  'watch:v': ['見る'],
  'look:v': ['見る'],
  you: ['あなた'],
  tea: ['お茶', '紅茶'],
  'begin:v': ['始める', '始まる'],
  'start:v': ['始める', '始まる'],
  'spread:v': ['広がる', '広げる'],
  customer: ['客'],
  customers: ['客'],
  restaurant: ['レストラン'],
  usually: ['大抵', '普通'],
  directly: ['直接'],
};

export const EXCLUDE = {
  he: ['自分'],
  my: ['まあ'],
  man: ['まあ'],
  say: ['まあ'],
  love: ['あなた'],
  go: ['等しい'],
  water: ['薄める', 'つける'],
  hot: ['売れる'],
  how: ['なぜ', '方法'],
  what: ['いかに'],
  why: ['これ'],
  customer: ['男', '奴'],
  most: ['最高'],
  later: ['遅い'],
  'show:n': ['様子'],
  usually: ['いつも'],
  directly: ['まっすぐ'],
  grocery: ['店'],
  host: ['大勢'],
  hosts: ['大勢'],
  device: ['案'],
  devices: ['案'],
  modern: ['今'],
  interested: ['示す'],
  'that is': ['つまり'],
  Sri: ['先生'],
  sri: ['先生'],
  money: ['基金'],
};

// English words that never reduce to their base form, whatever the target language.
export const LEXICAL = SHARED_LEXICAL;
