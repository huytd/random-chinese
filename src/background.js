// Speaks words for the content script with chrome.tts, which has Chinese voices
// even on pages that block or override the Web Speech API.
const pickVoice = (voices) =>
  voices.find((v) => /^zh[-_]CN/i.test(v.lang || '')) || voices.find((v) => (v.lang || '').startsWith('zh'));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'rc-speak' || typeof msg.text !== 'string') return;
  chrome.tts.getVoices((voices) => {
    const voice = pickVoice(voices);
    if (!voice) return sendResponse({ ok: false });
    chrome.tts.speak(msg.text, { voiceName: voice.voiceName, lang: voice.lang || 'zh-CN', rate: 0.8 });
    sendResponse({ ok: true });
  });
  return true;
});
