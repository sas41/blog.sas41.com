/* Run with node --test tests/*.test.cjs. No npm dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/site.js'), 'utf8');

function boot(withComments = false) {
  const events = {};
  const embeds = [{ hidden: true }];
  const button = { hidden: true, events: {}, addEventListener(name, fn) { this.events[name] = fn; } };
  const comments = { querySelector: () => button };
  const document = {
    addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    querySelectorAll: () => embeds,
    querySelector: (selector) => withComments && selector === '[data-comments-host]' ? comments : null,
  };
  vm.runInNewContext(source, { document });
  return { events, embeds, button };
}

test('embed buttons are enhanced without making external requests', () => {
  const state = boot();
  assert.equal(state.embeds[0].hidden, false);
  assert.equal(state.events.click.length, 1);
});

test('newly inserted historical embeds are enhanced after revision changes', () => {
  const state = boot();
  state.embeds.push({ hidden: true });
  for (const listener of state.events['article-revision-change']) listener();
  assert.ok(state.embeds.every((button) => !button.hidden));
});

test('comments load button is revealed only after its handler is attached', () => {
  const state = boot(true);
  assert.equal(state.button.hidden, false);
  assert.equal(typeof state.button.events.click, 'function');
});
