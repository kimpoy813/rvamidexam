import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { addIcon } from '../public/neon-icons.js';

test('action icons are decorative, local, and preserve accessible text', () => {
  const dom=new JSDOM('<button>Delete exam</button>'); const previous=globalThis.document;
  try {
    globalThis.document=dom.window.document;const button=document.querySelector('button');
    addIcon(button,'trash');const svg=button.querySelector('svg');
    assert.equal(button.textContent,'Delete exam');assert.equal(svg.getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('focusable'),'false');assert.equal(svg.dataset.icon,'trash');assert.ok(svg.querySelectorAll('path').length);
    addIcon(button,'copy');assert.equal(button.querySelectorAll('svg').length,1);assert.equal(button.querySelector('svg').dataset.icon,'copy');assert.equal(button.textContent,'Delete exam');
  } finally {dom.window.close();if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
