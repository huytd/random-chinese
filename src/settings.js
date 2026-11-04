// Settings shared by the content script and the popup (chrome.storage.sync).
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    system: 'hsk3', // 'hsk3' (2021, levels 1-6 + 7-9) or 'hsk2' (levels 1-6)
    level: 1,
    onlyLevel: false, // true: only words introduced at `level`; false: `level` and below
    frequency: 15, // percent of translatable words that get replaced
    script: 'simplified', // or 'traditional'
    showPinyin: false, // pinyin above replaced words
    disabledSites: [], // hostnames
  };

  const MAX_LEVEL = { hsk3: 7, hsk2: 6 };

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return normalize(stored);
  }

  function normalize(s) {
    const out = { ...DEFAULTS, ...s };
    if (!MAX_LEVEL[out.system]) out.system = DEFAULTS.system;
    out.level = Math.min(Math.max(Math.round(Number(out.level)) || 1, 1), MAX_LEVEL[out.system]);
    out.frequency = Math.min(Math.max(Math.round(Number(out.frequency)) || 0, 1), 100);
    if (!Array.isArray(out.disabledSites)) out.disabledSites = [];
    return out;
  }

  function saveSettings(patch) {
    return chrome.storage.sync.set(patch);
  }

  root.RC_SETTINGS = { DEFAULTS, MAX_LEVEL, loadSettings, saveSettings, normalize };
})(globalThis);
