/* Run with node --test tests/*.test.cjs. No npm dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/post-filter.js'), 'utf8');

function boot(query = '', entries = [
  { title: 'Building a blog', summary: 'A small static site', tags: ['Software', 'systems'] },
  { title: 'Reading notes', summary: 'Books and thoughts', tags: ['writing', 'long tag'] },
  { title: 'Older notes', summary: 'Untagged', tags: [] },
]) {
  function element(extra = {}) {
    return { hidden: true, value: '', events: {}, addEventListener(name, fn) { this.events[name] = fn; },
      focus() { this.focused = true; }, ...extra };
  }
  const search = element(), tags = element(), clear = element(), status = element(), empty = element();
  const fields = { '[data-filter-search]': search, '[data-filter-tags]': tags,
    '[data-filter-clear]': clear, '[data-filter-status]': status };
  const form = element({ querySelector: (key) => fields[key] });
  const cards = entries.map((entry) => element({
    dataset: { postTags: JSON.stringify(entry.tags) },
    querySelector: (key) => ({ textContent: key === 'h3' ? entry.title : entry.summary }),
  }));
  const section = element({ querySelector: (key) => key === '[data-filter-form]' ? form : empty,
    querySelectorAll: () => cards });
  const location = { href: `https://blog.example/${query}` };
  const history = { replaceState(_state, _title, url) { location.href = url.href; } };
  const events = {};
  vm.runInNewContext(source, { URL, location, history,
    document: { querySelector: () => section },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
  });
  return { search, tags, clear, status, empty, form, cards, section, location, events };
}

test('all posts visible initially; controls progressively enhanced', () => {
  const state = boot();
  assert.equal(state.form.hidden, false);
  assert.deepEqual(state.cards.map((card) => card.hidden), [false, false, false]);
  assert.equal(state.status.textContent, '3 of 3 posts');
  assert.equal(state.clear.disabled, true);
  assert.equal(state.empty.hidden, true);
});

test('tag filters are exact, comma-separated, case-insensitive AND matches', () => {
  const state = boot('?tags=software%2C%20SYSTEMS');
  assert.deepEqual(state.cards.map((card) => card.hidden), [false, true, true]);
  state.tags.value = 'software, writing';
  state.tags.events.input();
  assert.ok(state.cards.every((card) => card.hidden));
  assert.equal(state.empty.hidden, false);
  state.tags.value = 'soft';
  state.tags.events.input();
  assert.equal(state.empty.hidden, false);
  state.tags.value = 'long tag, ,';
  state.tags.events.input();
  assert.deepEqual(state.cards.map((card) => card.hidden), [true, false, true]);
});

test('text search covers titles, summaries, and tags, combined with filters', () => {
  const state = boot('?q=STATIC%20software&tags=systems');
  assert.deepEqual(state.cards.map((card) => card.hidden), [false, true, true]);
  state.search.value = 'thoughts';
  state.tags.value = '';
  state.search.events.input();
  assert.deepEqual(state.cards.map((card) => card.hidden), [true, false, true]);
  assert.equal(new URL(state.location.href).searchParams.get('q'), 'thoughts');
  assert.equal(new URL(state.location.href).searchParams.has('tags'), false);
});

test('clear and browser navigation restore results while preserving unrelated URL state', () => {
  const state = boot('?tags=writing&other=keep#writing');
  state.clear.events.click();
  assert.ok(state.cards.every((card) => !card.hidden));
  assert.equal(state.search.focused, true);
  assert.equal(state.location.href, 'https://blog.example/?other=keep#writing');
  state.location.href = 'https://blog.example/?tags=systems';
  state.events.popstate();
  assert.equal(state.tags.value, 'systems');
  assert.deepEqual(state.cards.map((card) => card.hidden), [false, true, true]);
});

test('tag clicks filter, but modified clicks retain static archive behavior', () => {
  const state = boot();
  let prevented = false;
  const event = { target: { closest: () => ({ dataset: { tagFilterLink: 'writing' } }) },
    button: 0, preventDefault() { prevented = true; } };
  state.section.events.click({ ...event, ctrlKey: true });
  assert.equal(prevented, false);
  state.section.events.click(event);
  assert.equal(prevented, true);
  assert.equal(state.tags.value, 'writing');
  assert.deepEqual(state.cards.map((card) => card.hidden), [true, false, true]);
});

test('empty blog remains usable and submitting search never navigates away', () => {
  const state = boot('', []);
  let prevented = false;
  state.form.events.submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(state.status.textContent, '0 of 0 posts');
  assert.equal(state.empty.hidden, true);
});
