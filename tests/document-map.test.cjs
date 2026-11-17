/* Run with node --test tests/*.test.cjs. No npm dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/reader.js'), 'utf8');

function boot({ desktop = true, reduced = false } = {}) {
  const summary = {
    addEventListener(name, fn) { this[name] = fn; },
    getBoundingClientRect: () => ({ height: 44 }),
  };
  const map = {};
  const animations = [];
  const disclosure = {
    open: false, dataset: {},
    querySelector: () => summary,
    addEventListener() {},
    getBoundingClientRect() { return { height: this.open ? 240 : 46 }; },
    animate(keyframes, options) {
      let finish;
      const animation = {
        keyframes, options, cancelled: false,
        finished: new Promise((resolve) => { finish = resolve; }),
        cancel() { this.cancelled = true; },
        finish() { finish(); },
      };
      animations.push(animation);
      return animation;
    },
  };
  const media = {};
  const document = {
    documentElement: {},
    querySelector(selector) {
      if (selector === '[data-document-map]') return map;
      if (selector === '[data-document-map-disclosure]') return disclosure;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = {
    blogReader: { values: {} },
    matchMedia(query) {
      return media[query] ||= {
        matches: query.includes('reduced-motion') ? reduced : desktop,
        addEventListener(name, fn) { this[name] = fn; },
      };
    },
    addEventListener() {},
  };
  vm.runInNewContext(source, { document, window, requestAnimationFrame: () => 1 });
  return {
    disclosure, map, animations, media,
    click() {
      let prevented = false;
      summary.click({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    },
  };
}

test('desktop outline starts expanded; narrow screens start with the icon', () => {
  const desktop = boot();
  assert.equal(desktop.disclosure.open, true);
  assert.equal(desktop.disclosure.dataset.collapsed, 'false');
  assert.equal(desktop.map.inert, false);
  const mobile = boot({ desktop: false });
  assert.equal(mobile.disclosure.open, false);
  assert.equal(mobile.disclosure.dataset.collapsed, 'true');
  assert.equal(mobile.map.inert, true);
});

test('collapse keeps contents rendered until the shrink animation finishes', async () => {
  const state = boot();
  state.click();
  assert.equal(state.disclosure.open, true);
  assert.equal(state.disclosure.dataset.collapsed, 'true');
  assert.equal(state.map.inert, true);
  const animation = state.animations[0];
  assert.equal(animation.keyframes[0].height, '240px');
  assert.equal(animation.keyframes[1].height, '46px');
  animation.finish();
  await Promise.resolve();
  assert.equal(state.disclosure.open, false);
  assert.equal(animation.cancelled, true);
});

test('expansion animates back to the full outline height', async () => {
  const state = boot({ desktop: false });
  state.click();
  assert.equal(state.disclosure.open, true);
  assert.equal(state.map.inert, false);
  assert.equal(state.disclosure.dataset.collapsed, 'false');
  assert.equal(state.animations[0].keyframes[0].height, '46px');
  assert.equal(state.animations[0].keyframes[1].height, '240px');
  state.animations[0].finish();
  await Promise.resolve();
  assert.equal(state.disclosure.open, true);
});

test('rapidly reversing a collapse cannot finish in the stale closed state', async () => {
  const state = boot();
  state.click();
  state.click();
  assert.equal(state.animations[0].cancelled, true);
  state.animations[0].finish();
  await Promise.resolve();
  assert.equal(state.disclosure.open, true);
  state.animations[1].finish();
  await Promise.resolve();
  assert.equal(state.disclosure.open, true);
  assert.equal(state.disclosure.dataset.collapsed, 'false');
});

test('reduced motion and breakpoint changes update immediately', () => {
  const state = boot({ reduced: true });
  state.click();
  assert.equal(state.disclosure.open, false);
  assert.equal(state.animations.length, 0);
  state.click();
  assert.equal(state.disclosure.open, true);
  const media = state.media['(min-width: 1024px)'];
  media.matches = false;
  media.change();
  assert.equal(state.disclosure.open, false);
  assert.equal(state.map.inert, true);
});
