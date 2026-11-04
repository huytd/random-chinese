# Random Chinese

A Chrome extension for learning Chinese while you browse. On English pages it swaps a random share of words for their Chinese translation at your HSK level. Click a swapped word to see its pinyin and meanings and hear how it's pronounced.

> Today I want to 告诉 you about my 朋友. We like to 吃 rice and 喝 茶 in the morning.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the extension and open any English page.

## Settings (toolbar popup)

| Setting | What it does |
|---|---|
| On/off | Turns the extension on or off everywhere. The site switch pauses it for the current site only. |
| HSK 3.0 / HSK 2.0 | Which syllabus to use. HSK 3.0 (2021) has levels 1–6 plus 7–9; HSK 2.0 has levels 1–6. |
| Level | Uses words up to and including this level. With **Only words new at this level**, it uses only the words that level introduces. |
| Replace | The percentage of translatable words that get replaced (1–100%, default 15%). |
| 简体 / 繁體 | Simplified or traditional characters. |
| Show pinyin above words | Shows pinyin as ruby text over each replaced word. |
| Shuffle | Picks a new random set of words on the current page. |

Settings sync through your Chrome profile and apply right away to open tabs.

## Word card

Clicking a replaced word (it won't follow the link if the word sits inside one) opens a card with:

- the characters, plus the other script when it differs (书 / 書)
- pinyin with tone marks and a 🔊 button that reads the word aloud (it uses Chrome's `chrome.tts` Chinese voice, falling back to the Web Speech API)
- the HSK level and up to three meanings
- the original English word, with a **Show English** button that puts it back

Press Esc or click anywhere else to close the card.

## How it works

- **Dictionary** – `src/dict.js` is generated from [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) (MIT). It holds 11,368 HSK words with pinyin and meanings, plus an English → Chinese index of about 14,000 keys. `scripts/build-dict.mjs` turns CC-CEDICT-style glosses into keys: it splits on `;`, drops notes like "surname", "classifier" and "(old)", strips "to"/"a"/"the", and ranks the candidates by sense order and then by word frequency. `scripts/overrides.mjs` fixes the common words the heuristic gets wrong (tell → 告诉, not 吩咐) and removes misleading senses (news → 风).
- **Matching** – `src/matcher.js` tokenizes text and tries three-, two- and one-word phrases ("cell phone" → 手机). Inflected words fall back to their base form (books → 书, walked → 走), except words that mean something different from their base form (tired is not tire, news is not new). Function words that are too ambiguous to swap (the, can, like, will, …) are never replaced. Capitalized words in the middle of a sentence are treated as names, and acronyms like US and IT are skipped.
- **Page** – `src/content.js` walks the page's text nodes in idle-time slices. It skips inputs, editors, code, buttons and `translate="no"` content, and stops at 400 replacements per page. A MutationObserver handles content that loads later. Pages whose `<html lang>` is set to something other than English are left alone.

## Development

```sh
npm test                 # unit tests for the matcher and dictionary (node:test, no dependencies)
npm run build:dict       # regenerate src/dict.js from the upstream complete.json
node scripts/build-dict.mjs path/to/complete.json   # ...or from a local copy
npm run icons            # regenerate icons/ (needs Python + Pillow and Noto Sans CJK)
npm run pack             # zip for the Chrome Web Store
```

After editing files, click the reload button on the extension in `chrome://extensions` and refresh the tab.

## Known limitations

- Replacements go word by word and ignore context, so an ambiguous word can occasionally get the wrong sense. Add a fix to `scripts/overrides.mjs` and rebuild.
- English word order is kept, so the result is English with Chinese words in it, not Chinese grammar.
- Pronunciation needs a Chinese voice. Chrome on Windows, macOS and ChromeOS includes one; on Linux you may need to install one (for example through speech-dispatcher).
