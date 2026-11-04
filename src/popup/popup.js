'use strict';

const { loadSettings, saveSettings, MAX_LEVEL } = globalThis.RC_SETTINGS;

// Official cumulative vocabulary sizes, and the words each level adds.
const WORDS = {
  hsk3: [500, 1272, 2245, 3245, 4316, 5456, 11092],
  hsk2: [150, 300, 600, 1200, 2500, 5000],
};

const $ = (id) => document.getElementById(id);
let settings;
let tab = null;
let host = null;

function setRadio(group, value) {
  for (const b of group.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === String(value)));
}

function render() {
  document.body.classList.toggle('off', !settings.enabled);
  $('enabled').checked = settings.enabled;
  setRadio($('system'), settings.system);
  setRadio($('script'), settings.script);

  const levels = $('levels');
  const max = MAX_LEVEL[settings.system];
  levels.classList.toggle('six', max === 6);
  levels.replaceChildren(...Array.from({ length: max }, (_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = i + 1;
    b.textContent = i === 6 ? '7–9' : String(i + 1);
    if (i === 6) b.className = 'wide';
    b.setAttribute('aria-label', `Level ${b.textContent}`);
    return b;
  }));
  setRadio(levels, settings.level);

  const sizes = WORDS[settings.system];
  const n = settings.level - 1;
  const added = sizes[n] - (n ? sizes[n - 1] : 0);
  $('level-hint').textContent = settings.onlyLevel
    ? `Uses the ${added.toLocaleString()} words introduced at this level.`
    : `Uses ${sizes[n].toLocaleString()} words, levels 1–${settings.level === 7 ? '9' : settings.level}.`;
  $('only-level').checked = settings.onlyLevel;

  $('frequency').value = settings.frequency;
  $('frequency-value').textContent = `${settings.frequency}%`;
  $('show-pinyin').checked = settings.showPinyin;

  if (host) $('site-enabled').checked = !settings.disabledSites.includes(host);
}

async function update(patch) {
  Object.assign(settings, patch);
  render();
  await saveSettings(patch);
  setTimeout(refreshStatus, 600);
}

async function refreshStatus() {
  const site = $('site');
  if (!tab) return;
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'rc-status' });
    host = s.host;
    site.classList.remove('unavailable');
    $('site-host').textContent = s.host || 'This page';
    $('site-enabled').checked = !settings.disabledSites.includes(host);
    $('reroll').disabled = !s.running;
    if (!settings.enabled) $('site-status').textContent = 'Paused everywhere';
    else if (settings.disabledSites.includes(host)) $('site-status').textContent = 'Paused on this site';
    else if (!s.english) $('site-status').textContent = 'This page isn’t in English';
    else $('site-status').textContent = `${s.count} word${s.count === 1 ? '' : 's'} in Chinese`;
  } catch {
    site.classList.add('unavailable');
    $('site-host').textContent = 'This page';
    $('site-status').textContent = 'Not available here — reload the tab or open a regular web page.';
  }
}

function bindRadio(group, key, parse = (v) => v) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b) update({ [key]: parse(b.dataset.value) });
  });
}

async function main() {
  settings = await loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  render();

  $('enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));
  $('system').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    // Level 7–9 only exists in HSK 3.0.
    if (b) update({ system: b.dataset.value, level: Math.min(settings.level, MAX_LEVEL[b.dataset.value]) });
  });
  bindRadio($('script'), 'script');
  bindRadio($('levels'), 'level', Number);
  $('only-level').addEventListener('change', (e) => update({ onlyLevel: e.target.checked }));
  $('show-pinyin').addEventListener('change', (e) => update({ showPinyin: e.target.checked }));
  $('frequency').addEventListener('input', (e) => { $('frequency-value').textContent = `${e.target.value}%`; });
  $('frequency').addEventListener('change', (e) => update({ frequency: Number(e.target.value) }));
  $('site-enabled').addEventListener('change', (e) => {
    if (!host) return;
    const others = settings.disabledSites.filter((h) => h !== host);
    update({ disabledSites: e.target.checked ? others : [...others, host] });
  });
  $('reroll').addEventListener('click', async () => {
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'rc-reroll' }).catch(() => {});
    setTimeout(refreshStatus, 600);
  });

  refreshStatus();
}

main();
