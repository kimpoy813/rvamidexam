import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('Render icons decorate static and dynamic actions without replacing labels', async () => {
  const dom = new JSDOM('<body><button id="startBtn">Start examination</button><button class="tab" data-tab="results">Results</button><div id="host"></div></body>');
  const previous = {document:globalThis.document, MutationObserver:globalThis.MutationObserver};
  globalThis.document=dom.window.document; globalThis.MutationObserver=dom.window.MutationObserver;
  try {
    await import('../public/js/render-icons.js');
    const start=dom.window.document.querySelector('#startBtn');
    assert.equal(start.textContent,'Start examination');
    assert.equal(start.querySelector('svg').getAttribute('aria-hidden'),'true');
    assert.equal(dom.window.document.querySelector('[data-tab=results] svg').dataset.icon,'chart');
    dom.window.document.querySelector('#host').innerHTML='<button>Delete exam</button><button>+ Add question</button><button>Next →</button><button class="auth-mode-btn">Sign in</button><button>Create account</button>';
    await new Promise(resolve=>dom.window.setTimeout(resolve,0));
    const buttons=dom.window.document.querySelectorAll('#host button');
    assert.equal(buttons[0].querySelector('svg').dataset.icon,'trash');
    assert.equal(buttons[1].querySelector('svg').dataset.icon,'plus');
    assert.equal(buttons[1].textContent,'Add question');
    assert.equal(buttons[2].querySelector('svg').dataset.icon,'right');
    assert.equal(buttons[2].textContent,'Next');
    assert.equal(buttons[3].querySelector('svg'),null);
    assert.equal(buttons[4].querySelector('svg').dataset.icon,'userPlus');
  } finally { dom.window.close();globalThis.document=previous.document;globalThis.MutationObserver=previous.MutationObserver; }
});
