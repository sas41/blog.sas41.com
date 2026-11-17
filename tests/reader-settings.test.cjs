/* Run with node --test tests/reader-settings.test.cjs. No npm dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/reader-settings.js'), 'utf8');

function boot(saved, blocked = false) {
  const properties = new Map();
  const events = [];
  let stored;
  const document = { documentElement: { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value) } } };
  const window = { dispatchEvent: (event) => events.push(event) };
  const localStorage = {
    getItem() { if (blocked) throw new Error('Storage disabled'); return saved; },
    setItem(key, value) { if (blocked) throw new Error('Storage disabled'); stored = { key, value }; },
  };
  const CustomEvent = function(type, options) { this.type = type; this.detail = options.detail; };
  vm.runInNewContext(source, { window, document, localStorage, CustomEvent });
  return { api: window.blogReader, document, properties, events, stored: () => stored };
}

test('default font and theme match the requested reading experience', () => {
  const { api, document, properties } = boot(null);
  assert.equal(api.values.font, 'source-sans-3');
  assert.equal(api.values.size, 18);
  assert.equal(api.values.theme, 'dark');
  assert.equal(api.values.width, 700);
  assert.equal(api.values.dateFormat, 'browser');
  assert.equal(document.documentElement.dataset.readerFont, 'source-sans-3');
  assert.equal(properties.get('--reader-width'), '700px');
});

test('date format is allowlisted, persisted, restored, and reset', () => {
  const state = boot(null);
  state.api.set({ dateFormat: 'iso' });
  assert.equal(state.api.values.dateFormat, 'iso');
  assert.equal(state.document.documentElement.dataset.dateFormat, 'iso');
  const restored = boot(state.stored().value);
  assert.equal(restored.api.values.dateFormat, 'iso');
  restored.api.set(restored.api.defaults);
  assert.equal(restored.api.values.dateFormat, 'browser');
  assert.equal(boot(JSON.stringify({ dateFormat: 'invalid' })).api.values.dateFormat, 'browser');
  assert.equal(boot(JSON.stringify({ font: 'inter' })).api.values.dateFormat, 'browser');
  const blocked = boot(null, true);
  assert.doesNotThrow(() => blocked.api.set({ dateFormat: 'iso' }));
  assert.equal(blocked.api.values.dateFormat, 'iso');
});

test('saved preferences are restored before the page is painted', () => {
  const { api, document, properties } = boot(JSON.stringify({ font: 'inter', size: 22, theme: 'light', width: 900 }));
  assert.equal(api.values.font, 'inter');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(properties.get('--reader-font-size'), '22px');
  assert.equal(properties.get('--reader-width'), '900px');
});

test('only allowlisted fonts and bounded numeric values reach CSS', () => {
  const { api, properties } = boot(JSON.stringify({ font: '__proto__', size: 1000, theme: 'url(evil)', width: -100 }));
  assert.equal(api.values.font, 'source-sans-3');
  assert.equal(api.values.size, 28);
  assert.equal(api.values.width, 520);
  assert.equal(api.values.theme, 'dark');
  api.set({ size: NaN, width: '1200px; color:red', font: 'missing' });
  assert.equal(properties.get('--reader-font-size'), '18px');
  assert.equal(properties.get('--reader-width'), '700px');
});

test('changes persist, notify the UI, and reset without exposing mutable state', () => {
  const state = boot(null);
  state.api.set({ font: 'atkinson', theme: 'light' });
  assert.equal(JSON.parse(state.stored().value).font, 'atkinson');
  assert.equal(state.events[0].type, 'reader-settings-change');
  const copy = state.api.values;
  copy.width = 9999;
  assert.equal(state.api.values.width, 700);
  state.api.set(state.api.defaults);
  assert.equal(state.api.values.theme, 'dark');
  assert.equal(Object.keys(state.api.fonts).length, 14);
});

test('blocked storage and malformed stored JSON never prevent reading', () => {
  for (const saved of ['{broken', 'null', '[]', '"string"']) {
    assert.equal(boot(saved).api.values.font, 'source-sans-3');
  }
  const state = boot(null, true);
  assert.doesNotThrow(() => state.api.set({ size: 20 }));
  assert.equal(state.api.values.size, 20);
});
