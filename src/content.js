// Replaces a random share of English words on the page with their HSK Chinese
// translation; clicking one opens a card with pinyin, audio and meanings.
(() => {
  'use strict';
  if (globalThis.__randomChineseLoaded) return;
  globalThis.__randomChineseLoaded = true;

  const { createLookup, findMatches, LEVEL_COL } = globalThis.RC_MATCHER;
  const { loadSettings } = globalThis.RC_SETTINGS;
  const dict = globalThis.RC_DICT;

  const MAX_REPLACEMENTS = 400; // per page, keeps long pages readable and fast
  const CHUNK_MS = 12; // work per idle slice
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'button',
    'code', 'pre', 'kbd', 'samp', 'var', 'svg', 'math', 'canvas', 'iframe', 'title', 'head',
    '[contenteditable]:not([contenteditable="false"])', '[translate="no"]', '.notranslate',
    '.rc-word', '.rc-group', '#random-chinese-popover',
  ].join(',');

  let settings = null;
  let lookup = null;
  let scanned = new WeakSet(); // text nodes already considered
  let count = 0;
  let running = false;
  let run = 0; // bumped on every (re)start so stale work stops
  let observer = null;
  const queue = [];
  let flushTimer = 0;

  // ---- Scanning --------------------------------------------------------------

  function siteDisabled(s) {
    return s.disabledSites.includes(location.hostname);
  }

  function pageLooksEnglish() {
    const lang = (document.documentElement.lang || '').toLowerCase();
    return !lang || lang.startsWith('en');
  }

  function shouldRun(s) {
    return s.enabled && !siteDisabled(s) && pageLooksEnglish();
  }

  function skippedElement(el) {
    return !el || el.closest(SKIP_SELECTOR) !== null || el.isContentEditable;
  }

  function collectText(root, out) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (!scanned.has(root) && !skippedElement(root.parentElement)) out.push(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || skippedElement(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return node.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return scanned.has(node) || !/[A-Za-z]{2}|\bI\b/.test(node.nodeValue) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n; (n = walker.nextNode()); ) out.push(n);
  }

  function makeWord(id, original) {
    const [simp, trad, pinyin] = dict.words[id];
    const hanzi = settings.script === 'traditional' ? trad : simp;
    const span = document.createElement('span');
    span.className = 'rc-word';
    span.lang = settings.script === 'traditional' ? 'zh-Hant' : 'zh-Hans';
    span.dataset.rcId = id;
    span.dataset.rcOrig = original;
    if (settings.showPinyin) {
      const ruby = document.createElement('ruby');
      const rt = document.createElement('rt');
      rt.textContent = pinyin;
      ruby.append(hanzi, rt);
      span.append(ruby);
    } else {
      span.textContent = hanzi;
    }
    return span;
  }

  // A single word, or a group of words reordered for Chinese grammar ("How I" -> "我 怎么"),
  // which is restored to English as a whole.
  function makeMatch(m, original) {
    if (m.parts.length === 1) return makeWord(m.parts[0].id, original);
    const group = document.createElement('span');
    group.className = 'rc-group';
    group.dataset.rcOrig = original;
    m.parts.forEach((p, n) => {
      if (n) group.append(' ');
      group.append(p.text ?? makeWord(p.id, p.orig));
    });
    return group;
  }

  function processTextNode(node) {
    scanned.add(node);
    if (!node.parentNode || count >= MAX_REPLACEMENTS) return;
    const text = node.nodeValue;
    const matches = findMatches(text, lookup).filter(() => Math.random() * 100 < settings.frequency);
    if (!matches.length) return;

    const frag = document.createDocumentFragment();
    const piece = (s) => {
      const t = document.createTextNode(s);
      scanned.add(t);
      frag.append(t);
    };
    let pos = 0;
    for (const m of matches) {
      if (count >= MAX_REPLACEMENTS) break;
      if (m.start > pos) piece(text.slice(pos, m.start));
      frag.append(makeMatch(m, text.slice(m.start, m.end)));
      pos = m.end;
      count++;
    }
    if (pos < text.length) piece(text.slice(pos));
    node.parentNode.replaceChild(frag, node);
  }

  function enqueue(node) {
    queue.push(node);
    if (!flushTimer) flushTimer = setTimeout(flush, 150);
  }

  function flush() {
    flushTimer = 0;
    if (!running) return;
    const nodes = [];
    for (const root of queue.splice(0)) if (root.isConnected) collectText(root, nodes);
    processInSlices(nodes);
  }

  function processInSlices(nodes) {
    const mine = run;
    let i = 0;
    const step = () => {
      if (!running || run !== mine) return;
      const until = performance.now() + CHUNK_MS;
      while (i < nodes.length && performance.now() < until) processTextNode(nodes[i++]);
      if (i < nodes.length && count < MAX_REPLACEMENTS) idle(step);
    };
    step();
  }

  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16));

  function start() {
    running = true;
    run++;
    lookup = createLookup(dict, settings);
    enqueue(document.body);
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') {
          scanned.delete(r.target);
          enqueue(r.target);
        } else {
          for (const n of r.addedNodes) {
            const ours = n.nodeType === Node.ELEMENT_NODE && (n.classList.contains('rc-word') || n.classList.contains('rc-group'));
            if (!ours && !scanned.has(n)) enqueue(n);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stop() {
    running = false;
    observer?.disconnect();
    observer = null;
    queue.length = 0;
    closePopover();
    for (const el of document.querySelectorAll('.rc-group, .rc-word')) if (el.isConnected) restoreWord(el);
    count = 0;
    scanned = new WeakSet();
  }

  function restoreWord(el) {
    const target = el.closest('.rc-group') || el;
    const t = document.createTextNode(target.dataset.rcOrig);
    scanned.add(t);
    target.replaceWith(t);
  }

  let applying = 0;
  async function apply() {
    const mine = ++applying;
    const next = await loadSettings();
    if (mine !== applying) return; // a newer change superseded this one
    stop();
    settings = next;
    if (shouldRun(settings) && document.body) start();
  }

  // ---- Popover ---------------------------------------------------------------

  let pop = null; // { host, card, word }

  const POPOVER_CSS = `
    :host { all: initial; }
    .card {
      --bg: #ffffff; --fg: #1f1f1f; --muted: #6b6b6b; --line: #e7e2dc; --accent: #c8402a; --chip: #fbeae6;
      position: fixed; z-index: 2147483647; width: 280px; box-sizing: border-box;
      padding: 14px 16px 12px; border-radius: 12px; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      .card { --bg: #23211f; --fg: #f2efea; --muted: #a8a29b; --line: #3a3633; --accent: #ff7a5c; --chip: #3b2620; }
    }
    .row { display: flex; align-items: center; gap: 10px; }
    .hanzi { font: 600 34px/1.1 "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; letter-spacing: .02em; }
    .alt { color: var(--muted); font-size: 16px; }
    .pinyin { margin-top: 2px; font-size: 18px; color: var(--accent); font-weight: 500; }
    .speak {
      margin-left: auto; width: 34px; height: 34px; flex: none; border-radius: 50%; border: 1px solid var(--line);
      background: transparent; color: var(--fg); cursor: pointer; display: grid; place-items: center; padding: 0;
    }
    .speak:hover { background: var(--chip); color: var(--accent); border-color: transparent; }
    .speak svg { width: 18px; height: 18px; }
    .badge { display: inline-block; margin-top: 8px; padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--accent); font-size: 12px; font-weight: 600; }
    ol { margin: 8px 0 0; padding-left: 20px; }
    li { margin: 2px 0; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
    .foot b { color: var(--fg); font-weight: 600; }
    .show-en { margin-left: auto; border: none; background: none; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; padding: 2px 0; }
    .show-en:hover { text-decoration: underline; }
  `;

  const SPEAKER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function showPopover(word) {
    closePopover();
    const id = Number(word.dataset.rcId);
    const [simp, trad, pinyin, hsk3, hsk2, meanings] = dict.words[id];
    const traditional = settings.script === 'traditional';
    const hanzi = traditional ? trad : simp;
    const other = traditional ? simp : trad;
    const level = dict.words[id][LEVEL_COL[settings.system]];

    const host = el('div');
    host.id = 'random-chinese-popover';
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = POPOVER_CSS;
    const card = el('div', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', `${hanzi} ${pinyin}`);

    const top = el('div', 'row');
    const h = el('span', 'hanzi', hanzi);
    h.lang = traditional ? 'zh-Hant' : 'zh-Hans';
    top.append(h);
    if (other !== hanzi) top.append(el('span', 'alt', other));
    const speak = el('button', 'speak');
    speak.type = 'button';
    speak.title = 'Listen';
    speak.setAttribute('aria-label', 'Listen to pronunciation');
    speak.innerHTML = SPEAKER_SVG;
    speak.addEventListener('click', () => say(simp));
    top.append(speak);

    const list = el('ol');
    for (const m of meanings.split(' | ')) list.append(el('li', null, m));

    const foot = el('div', 'foot');
    const orig = el('span');
    orig.append('English: ', el('b', null, word.dataset.rcOrig));
    const showEn = el('button', 'show-en', 'Show English');
    showEn.type = 'button';
    showEn.addEventListener('click', () => {
      closePopover();
      restoreWord(word);
      count--;
    });
    foot.append(orig, showEn);

    const label = settings.system === 'hsk2' ? `HSK 2.0 · Level ${level}` : `HSK 3.0 · Level ${level === 7 ? '7–9' : level}`;
    card.append(top, el('div', 'pinyin', pinyin), el('span', 'badge', label), list, foot);
    root.append(style, card);
    document.documentElement.append(host);
    pop = { host, card, word };
    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
  }

  function position() {
    if (!pop) return;
    if (!pop.word.isConnected) return closePopover();
    const r = pop.word.getBoundingClientRect();
    const c = pop.card.getBoundingClientRect();
    const margin = 8;
    let top = r.bottom + margin;
    if (top + c.height > innerHeight - margin && r.top - margin - c.height > margin) top = r.top - margin - c.height;
    const left = Math.min(Math.max(r.left + r.width / 2 - c.width / 2, margin), innerWidth - c.width - margin);
    pop.card.style.top = `${Math.round(top)}px`;
    pop.card.style.left = `${Math.round(left)}px`;
  }

  function closePopover() {
    if (!pop) return;
    pop.word.classList.remove('rc-active');
    pop.host.remove();
    pop = null;
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
  }

  function say(text) {
    try {
      chrome.runtime.sendMessage({ type: 'rc-speak', text })
        .then((res) => { if (!res?.ok) speakInPage(text); })
        .catch(() => speakInPage(text));
    } catch {
      speakInPage(text); // the extension was reloaded since this page loaded
    }
  }

  // Fallback when the extension's TTS is unavailable.
  function speakInPage(text) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.8;
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => /^zh[-_]CN/i.test(v.lang)) || voices.find((v) => v.lang.startsWith('zh')) || null;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  window.addEventListener('click', (e) => {
    if (pop && e.composedPath().includes(pop.host)) return;
    const word = e.target instanceof Element ? e.target.closest('.rc-word') : null;
    if (!word) return closePopover();
    // Words inside links shouldn't navigate.
    e.preventDefault();
    e.stopPropagation();
    if (pop?.word === word) return closePopover();
    showPopover(word);
    word.classList.add('rc-active');
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  }, true);

  // ---- Wiring ----------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') apply();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'rc-status') {
      sendResponse({ host: location.hostname, count, running, english: pageLooksEnglish() });
    } else if (msg?.type === 'rc-reroll') {
      apply().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  apply();
})();
