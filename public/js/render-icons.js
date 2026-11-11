// Decorative, local outline icons; button text remains the accessible name.
import { addIcon } from '../neon-icons.js';

const byId = {
  startBtn:'right', submitBtn:'check', submitTopBtn:'check', newExamBtn:'plus', newCode:'key',
  codeCopy:'copy', logoutBtn:'logout', loadCurrent:'refresh', loadSampleText:'help',
  previewBank:'eye', addBankSection:'plus', importBank:'save', showRegister:'userPlus', showLogin:'left'
};
const tabs = { live:'eye', results:'chart', questions:'book', setup:'settings' };
const words = [
  [/^(create\s+(a\s+)?(teacher\s+)?account)/i,'userPlus'],
  [/^(review\s*&?\s*submit)/i,'check'],
  [/^(save|apply|update)/i,'save'], [/^(delete|remove)/i,'trash'], [/^(add|new|create)/i,'plus'],
  [/^(edit|change)/i,'edit'], [/^(refresh|reload)/i,'refresh'], [/^(reset|clear)/i,'reset'],
  [/^(download|export)/i,'download'], [/^(copy)/i,'copy'], [/^(release|show|preview|view)/i,'eye'],
  [/^(hide)/i,'eyeOff'], [/^(reopen|unlock)/i,'unlock'], [/^(lock)/i,'lock'],
  [/^(next|continue|start)/i,'right'], [/^(previous|back)/i,'left'], [/^(submit|sign in)/i,'send'],
  [/^(check score)/i,'chart'], [/^(sign out)/i,'logout'], [/^(invalidate)/i,'ban'], [/^(extend)/i,'clock']
];
function stripDuplicateGlyphs(button) {
  for (const child of button.childNodes) {
    if (child.nodeType !== 3) continue;
    const cleaned = child.nodeValue.replace(/^\s*[+↻←]\s*/, '').replace(/\s*→\s*$/, '');
    if (cleaned !== child.nodeValue) child.nodeValue = cleaned;
  }
}
function decorate(root) {
  const nodes = [];
  if (root.nodeType === 1 && root.matches('button')) nodes.push(root);
  if (root.querySelectorAll) nodes.push(...root.querySelectorAll('button'));
  for (const button of nodes) {
    if (button.classList.contains('auth-mode-btn')) continue;
    if (button.querySelector('svg') || !button.textContent.trim()) continue;
    const label = button.textContent.trim().replace(/^[+↻←]\s*/, '').replace(/\s*→$/, '');
    const name = byId[button.id] || tabs[button.dataset.tab] || words.find(([pattern]) => pattern.test(label))?.[1];
    if (name) {
      stripDuplicateGlyphs(button);
      addIcon(button, name);
    }
  }
}
decorate(document);
new MutationObserver(records => {
  for (const record of records) { for (const node of record.addedNodes) decorate(node); if (record.target.nodeType === 1 && record.target.matches('button')) decorate(record.target); }
}).observe(document.body, { childList:true, subtree:true });
