# Random Red Ink

Learn Chinese or Japanese while you browse. On English pages, this Chrome extension swaps a random share of words for their translation at your level: HSK for Chinese, JLPT for Japanese. Click a swapped word to see its reading and meanings and hear how it's pronounced.

> Today I want to 告诉 you about 我的 朋友. We like to 吃 rice and 喝 茶 in the morning.
>
> Today I want to 話す you about 私の 友達. We like to 食べる rice and 飲む お茶 in the 朝.

With the extension on:

<img width="1653" height="1258" alt="image" src="https://github.com/user-attachments/assets/f1a9b1a7-b846-48c5-9bdd-babc50e02f80" />

With the extension off:

<img width="1653" height="1258" alt="image" src="https://github.com/user-attachments/assets/577445c5-e56f-4fd2-b858-5a8d1e69a548" />

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the extension and open any English page.

## Settings (toolbar popup)

| Setting | What it does |
|---|---|
| On/off | Turns the extension on or off everywhere. The site switch pauses it for the current site only. |
| Learn | 中文 Chinese or 日本語 Japanese. |
| HSK 3.0 / HSK 2.0 | Chinese only: which syllabus to use. HSK 3.0 (2021) has levels 1–6 plus 7–9; HSK 2.0 has levels 1–6. |
| Level | HSK 1–9 or JLPT N5–N1. Uses words up to and including this level. With **Only words new at this level**, it uses only the words that level introduces. |
| Replace | The percentage of translatable words that get replaced (1–100%, default 15%). |
| 简体 / 繁體 | Chinese only: simplified or traditional characters. |
| Show pinyin / furigana above words | Shows pinyin over Chinese words, or kana over the kanji of Japanese words (食(た)べる). |
| Shuffle | Picks a new random set of words on the current page. |

Settings sync through your Chrome profile and apply right away to open tabs.

## Word card

Clicking a replaced word (it won't follow the link if the word sits inside one) opens a card with:

- the word, plus the other script when it differs (书 / 書)
- its reading (pinyin with tone marks, or kana) and a 🔊 button that reads it aloud with Chrome's Chinese or Japanese voice (`chrome.tts`, falling back to the Web Speech API)
- the HSK or JLPT level and up to three meanings
- a note when the extension added grammar (的/の for possession, a measure word, 最/一番 for "most")
- the original English word, with a **Show English** button that puts it back

Press Esc or click anywhere else to close the card.

## How it works

- **Part of speech** – each paragraph goes through [compromise](https://github.com/spencermountain/compromise) (MIT, `vendor/compromise.js`), an English tagger that runs in the page. It tells the verb in "**Building** apps" from the noun in "the **building**", and it gives each word's base form, so irregular forms like bought, children and went work too. It also flags names and brands (Bill, Apple), phrasal verbs ("gave **up**"), possessives, comparatives and dates, and works out what "they" refers to.
- **Dictionaries** – each language combines an English-first dictionary, which lists an English word's translations by part of speech and most common sense first, with the target words' own glosses:
  - Chinese, `src/dict-zh.js` from `scripts/build-dict-zh.mjs`: [ECDICT](https://github.com/skywind3000/ECDICT) (water: *n.* 水; *v.* 浇水) and [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) (11,368 HSK words with levels, pinyin, CC-CEDICT meanings and measure words)
  - Japanese, `src/dict-ja.js` from `scripts/build-dict-ja.mjs`: [EJDict-hand](https://github.com/kujirahand/EJDict) (eat: 『食べる』), [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) for parts of speech and glosses, and the JLPT N5–N1 lists from [open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks) (about 8,000 words with readings). Nouns that take する (勉強) also get a verb form (勉強する) for English verbs.

  An English word maps to a word in the list when the English-first dictionary gives it for that part of speech, ideally confirmed by the word's own gloss. CC-CEDICT can add a word only if this English word is the Chinese word's main meaning and ECDICT doesn't contradict it. If the best translation is above your level, the matcher falls back only to close synonyms (冷 for "cold" instead of 寒冷). Otherwise it leaves the word in English: "plant" never becomes 工厂 (a factory). `scripts/overrides.mjs` holds the remaining hand fixes, per part of speech if needed (`show:n` → 节目).
- **Grammar** – the Chinese has to read correctly wherever Chinese words meet:
  - question words keep Chinese order: "How do I use AI?" → 我 怎么 用 AI?
  - numbers get the noun's measure word: three books → 三本 书, two cats → 两只 猫
  - possessives get 的/の: my friend → 我的 朋友 / 私の 友達, people's → 人的
  - comparatives and superlatives get 更/最 or もっと/一番: cheaper → 更便宜, highest → 最高 / 一番高い
  - they/them/their follow what they refer to: 他们 for people, 它们 for animals and things ("when cats walk, they…" → 它们). They stay English when the referent isn't in the paragraph, and for things in Japanese, which has no JLPT word for それら
  - Japanese has no counter data, so numbers before nouns stay English there (three 猫, not 三 猫)
  - time words are swapped only where Chinese would put them: "Today I eat rice" → 今天 …, but "I eat rice today" keeps *today*
  - parts of phrasal verbs, hyphenated compounds (full-time), names and grammar words (the, can, like, …) stay English
- **Page** – `src/content.js` asks the background worker to inject the dictionary for the chosen language (only that one, as each is over a megabyte), then walks the page's text nodes in idle-time slices and tags each paragraph once. It skips inputs, editors, code, buttons and `translate="no"` content, and stops at 400 replacements per page. A MutationObserver handles content that loads later. Pages whose `<html lang>` is set to something other than English are left alone.

## Development

```sh
npm test                 # unit tests for the matcher and dictionary (node:test, no dependencies)
npm run build:dict       # regenerate both dictionaries (downloads the sources, about 80 MB)
npm run build:zh         # Chinese only: complete.json and the 66 MB ecdict.csv
npm run build:ja         # Japanese only: JLPT lists, JMdict (12 MB) and EJDict
node scripts/build-dict-zh.mjs complete.json ecdict.csv            # ...or from local copies
node scripts/build-dict-ja.mjs jlpt-dir jmdict-eng.json ejdict-dir
NO_OVERRIDES=1 npm run build:zh                        # see the output without overrides-zh.mjs
npm run icons            # regenerate icons/ (needs Python + Pillow and Noto Sans CJK)
npm run pack             # zip for the Chrome Web Store
```

After editing files, click the reload button on the extension in `chrome://extensions` and refresh the tab.

## Known limitations

- The tagger tells parts of speech apart, but not senses within one part of speech: "restrictions were lifted" still gets 提高 (raise) instead of 解除 (remove). Add a fix to `scripts/overrides-zh.mjs` or `scripts/overrides-ja.mjs` and rebuild.
- The tagger sometimes gets a part of speech wrong, especially in lists: in "read books, watch a movie, and walk to school" it takes *walk* for a noun (散歩, "a stroll").
- English word order is kept outside the rules above, so the result is English with Chinese words in it, not Chinese sentences.
- Pronunciation needs a Chinese voice. Chrome on Windows, macOS and ChromeOS includes one; on Linux you may need to install one (for example through speech-dispatcher).

## Data licenses

- complete-hsk-vocabulary, ECDICT, open-anki-jlpt-decks and compromise: MIT
- EJDict-hand: public domain (CC0)
- JMdict: © the Electronic Dictionary Research and Development Group, used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). `src/dict-ja.js` contains JMdict glosses and parts of speech and is shared under the same license.
- The JLPT lists are based on Jonathan Waller's lists at [tanos.co.uk](http://www.tanos.co.uk/jlpt/) (CC BY).
