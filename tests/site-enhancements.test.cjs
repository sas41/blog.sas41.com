/* Run with node --test tests/*.test.cjs. No npm dependencies. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/site.js'), 'utf8');

test('publication and edit dates across article and listing templates share the format preference', () => {
  for (const template of ['layouts/_default/single.html', 'layouts/index.html', 'layouts/_default/taxonomy.html', 'layouts/_default/list.html']) {
    const markup = fs.readFileSync(path.join(__dirname, '..', template), 'utf8');
    const times = markup.match(/<time\b[^>]*>/g);
    assert.ok(times?.length, `${template} renders dates`);
    for (const time of times) {
      assert.match(time, /data-local-time="date"/, template);
      assert.match(time, /datetime="{{ .*\.Format "2006-01-02T15:04:05Z07:00" }}/, template);
    }
  }
});

test('Last Edited is a working archive link without JavaScript, with no extra browse link', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../layouts/_default/single.html'), 'utf8');
  assert.match(markup, /<a class="history-toggle" href="\/history\/.*?\/" data-history-toggle>Last Edited/);
  assert.doesNotMatch(markup, /<button[^>]*data-history-toggle/);
  assert.doesNotMatch(markup, /history-fallback|Browse all revisions without the slider/);
});

function boot({ times = [], locale = 'en-US', timeZone = 'UTC', dateFormat = 'browser' } = {}) {
  const events = {};
  const embeds = [{ hidden: true }];
  const document = {
    documentElement: { dataset: { dateFormat } },
    addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    querySelectorAll: (selector) => selector === 'time[data-local-time]' ? times : embeds,
    querySelector: () => null,
  };
  const intl = {
    DateTimeFormat: function(languages, options) {
      assert.deepEqual(languages, [locale], 'use the reader’s preferred browser languages');
      return new Intl.DateTimeFormat(languages, { ...options, timeZone });
    },
  };
  const window = { addEventListener(name, fn) { (events[name] ||= []).push(fn); } };
  vm.runInNewContext(source, { document, window, Intl: intl, navigator: { languages: [locale] } });
  return { events, embeds, document };
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

for (const [locale, timeZone] of [['en-US', 'America/New_York'], ['de-DE', 'Asia/Kolkata'], ['sv-SE', 'Europe/Sofia']]) {
  test(`history timestamps include seconds in ${locale} and ${timeZone}`, () => {
    const time = { dateTime: '2026-11-17T23:45:37Z', textContent: 'UTC fallback' };
    boot({ times: [time], locale, timeZone });
    const expected = new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short', timeZone,
    }).format(new Date(time.dateTime));
    assert.equal(time.textContent, expected);
    assert.ok(time.textContent.includes(':37'));
    assert.equal(time.dateTime, '2026-11-17T23:45:37Z', 'retain the original machine-readable instant');
  });
}

test('Last Edited uses the browser locale for its date and full hover timestamp', () => {
  const time = { dateTime: '2026-11-17T23:45:37Z', dataset: { localTime: 'date' } };
  boot({ times: [time], locale: 'en-GB', timeZone: 'Europe/Berlin' });
  assert.equal(time.textContent, '18/11/2026');
  assert.match(time.title, /18\/11\/2026/);
  assert.match(time.title, /0:45:37/);
  assert.doesNotMatch(time.title, /\b(?:AM|PM)\b/);
  assert.equal(time.dateTime, '2026-11-17T23:45:37Z');
});

test('ISO-style browser locales retain ISO dates and 24-hour time', () => {
  const time = { dateTime: '2026-11-17T23:45:37Z', dataset: { localTime: 'date' } };
  boot({ times: [time], locale: 'sv-SE', timeZone: 'Europe/Sofia' });
  assert.equal(time.textContent, '2026-11-18');
  assert.match(time.title, /1:45:37/);
  assert.doesNotMatch(time.title, /\b(?:AM|PM)\b/);
});

test('12-hour browser locales keep their native clock instead of a forced override', () => {
  const time = { dateTime: '2026-11-17T23:45:37Z', dataset: { localTime: 'date' } };
  boot({ times: [time], locale: 'en-US', timeZone: 'Europe/Sofia' });
  assert.equal(time.textContent, '11/18/2026');
  assert.match(time.title, /1:45:37 AM/);
});

test('malformed timestamps do not prevent other page enhancements', () => {
  const time = { dateTime: 'not-a-date' };
  const state = boot({ times: [time] });
  assert.equal(time.textContent, 'not-a-date');
  assert.equal(state.embeds[0].hidden, false);
});

test('ISO preference uses local dates, 24-hour time, and offsets and updates without a reload', () => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'Europe/Sofia';
  try {
    const time = { dateTime: '2026-11-17T23:45:37Z', dataset: { localTime: 'date' } };
    const revision = { dateTime: '2026-11-17T23:45:37Z' };
    const summer = { dateTime: '2026-07-17T23:45:37Z' };
    const state = boot({ times: [time, revision, summer], dateFormat: 'iso' });
    assert.equal(time.textContent, '2026-11-18');
    assert.equal(time.title, '2026-11-18 01:45:37 UTC+02:00');
    assert.equal(revision.textContent, time.title);
    assert.equal(summer.textContent, '2026-07-18 02:45:37 UTC+03:00');
    state.document.documentElement.dataset.dateFormat = 'browser';
    for (const listener of state.events['reader-settings-change']) listener();
    assert.equal(time.textContent, '11/17/2026');
    assert.match(time.title, /11:45:37 PM/);
    state.document.documentElement.dataset.dateFormat = 'iso';
    for (const listener of state.events['reader-settings-change']) listener();
    assert.equal(time.textContent, '2026-11-18');
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

test('revision slider status and accessible value retain hours, minutes, and seconds', async () => {
  const element = (extra = {}) => ({
    events: {}, attributes: {},
    addEventListener(name, fn) { this.events[name] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; },
    ...extra,
  });
  const slider = element({ max: '1', focus() {} });
  const status = element();
  const toggle = element();
  const historyLink = element({
    className: 'history-toggle', innerHTML: 'Last Edited <time>11/17/2026</time>',
    replaceWith(button) {
      assert.equal(typeof button.events.click, 'function', 'attach the slider handler before replacing the link');
      this.replacement = button;
    },
  });
  const children = {
    'input[type=range]': slider,
    '[data-revision-status]': status,
    '[data-history-error]': element(),
    '[data-history-close]': element(),
    '[data-history-latest]': element(),
  };
  const panel = element({ hidden: true, dataset: { historyManifest: '/history/test.json' }, querySelector: (s) => children[s] });
  const nodes = {
    '[data-history-manifest]': panel, '[data-history-toggle]': historyLink,
    '[data-article-content]': { innerHTML: 'Current article' }, '[data-old-revision]': element(),
  };
  const dates = ['2026-11-17T12:34:56Z', '2026-11-17T23:45:37Z'];
  const events = {};
  const documentElement = { dataset: { dateFormat: 'browser' } };
  vm.runInNewContext(source, {
    document: {
      documentElement, addEventListener() {}, querySelectorAll: () => [], querySelector: (s) => nodes[s] || null,
      createElement(tag) { assert.equal(tag, 'button'); return toggle; },
    },
    window: {
      matchMedia: () => ({ matches: true }),
      addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    },
    URL, location: { origin: 'https://example.test' },
    fetch: async () => ({
      ok: true, headers: { get: () => 'application/json' },
      json: async () => ({ version: 1, revisions: dates.map((date, index) => ({ date, fragment: `/history/${index}.html` })) }),
    }),
  });
  assert.equal(historyLink.replacement, toggle, 'enhance the fallback link into the inline slider button');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.innerHTML, historyLink.innerHTML, 'preserve the localized date and tooltip');
  assert.equal(toggle.attributes['aria-controls'], 'revision-panel');
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  await toggle.events.click({ preventDefault() {} });
  const expected = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(new Date(dates[1]));
  assert.equal(status.textContent, `Revision 2 of 2 · ${expected} · Latest`);
  assert.equal(slider.attributes['aria-valuetext'], status.textContent);
  documentElement.dataset.dateFormat = 'iso';
  for (const listener of events['reader-settings-change']) listener();
  assert.match(status.textContent, /^Revision 2 of 2 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:37 UTC[+-]\d{2}:\d{2} · Latest$/);
  assert.equal(slider.attributes['aria-valuetext'], status.textContent);
  documentElement.dataset.dateFormat = 'browser';
  for (const listener of events['reader-settings-change']) listener();
  assert.equal(status.textContent, `Revision 2 of 2 · ${expected} · Latest`);
});
