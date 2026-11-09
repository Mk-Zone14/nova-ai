const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  HISTORY_KEY, HISTORY_TTL_DAYS, HISTORY_TTL_MS, HISTORY_MAX, normalizeHistory, addHistoryEntry, removeHistoryEntry
} = require('../report-model');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const REPORT = { opportunityName: 'Atlas Labs intern', overallMatchScore: 62, evidence: ['I built a dashboard'] };
const entry = (over = {}) => ({ id: NOW, title: 'Atlas Labs intern', score: 62, verdict: 'Needs verification', timestamp: '9/11/2026, 5:30:00 pm', savedAt: NOW, expiresAt: NOW + HISTORY_TTL_MS, report: REPORT, ...over });
const stored = (entries) => JSON.stringify(entries);
const legacy = (over = {}) => { const { savedAt, expiresAt, ...rest } = entry(over); return rest; }; // pre-expiry schema

test('policy constants: 30 days, at most 10 entries, existing storage key', () => {
  assert.equal(HISTORY_TTL_DAYS, 30);
  assert.equal(HISTORY_TTL_MS, 30 * DAY);
  assert.equal(HISTORY_MAX, 10);
  assert.equal(HISTORY_KEY, 'ocopilot-history');
});

// ---- expiry calculation ----------------------------------------------------------------------------------------------

test('a new entry is stamped with its save time and an expiry exactly 30 days later', () => {
  const [added] = addHistoryEntry([], { id: 7, title: 't', report: REPORT }, NOW);
  assert.equal(added.savedAt, NOW);
  assert.equal(added.expiresAt, NOW + 30 * DAY);
  assert.deepEqual(added.report, REPORT);
});

test('entries expire at the boundary: still kept one millisecond before expiry, gone at and after it', () => {
  const e = entry({ id: NOW - 29 * DAY, savedAt: NOW - 29 * DAY, expiresAt: NOW - 29 * DAY + HISTORY_TTL_MS });
  assert.equal(normalizeHistory(stored([e]), e.expiresAt - 1).entries.length, 1);
  assert.equal(normalizeHistory(stored([e]), e.expiresAt).entries.length, 0);
  assert.equal(normalizeHistory(stored([e]), e.expiresAt + 1).entries.length, 0);
});

test('re-saving the same id replaces the entry and restarts its term; other entries keep theirs', () => {
  const other = entry({ id: 1, savedAt: NOW - 3 * DAY, expiresAt: NOW - 3 * DAY + HISTORY_TTL_MS });
  const out = addHistoryEntry([other, entry({ id: 2 })], { id: 2, title: 'again', report: REPORT }, NOW + DAY);
  assert.deepEqual(out.map((item) => item.id), [2, 1]);
  assert.equal(out[0].expiresAt, NOW + DAY + HISTORY_TTL_MS);
  assert.equal(out[1].expiresAt, other.expiresAt);
});

test('the store is capped at 10 entries, newest first', () => {
  let entries = [];
  for (let index = 1; index <= 13; index += 1) entries = addHistoryEntry(entries, { id: index, title: `e${index}`, report: REPORT }, NOW + index);
  assert.equal(entries.length, HISTORY_MAX);
  assert.deepEqual(entries.map((item) => item.id), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  const loaded = normalizeHistory(stored(Array.from({ length: 14 }, (_, index) => entry({ id: NOW - index }))), NOW);
  assert.equal(loaded.entries.length, HISTORY_MAX);
});

// ---- cleanup ---------------------------------------------------------------------------------------------------------

test('expired entries are removed and the rest are kept in order; storage is flagged for rewrite', () => {
  const fresh = entry({ id: NOW - DAY, savedAt: NOW - DAY, expiresAt: NOW - DAY + HISTORY_TTL_MS });
  const old = entry({ id: NOW - 31 * DAY, savedAt: NOW - 31 * DAY, expiresAt: NOW - 31 * DAY + HISTORY_TTL_MS });
  const current = entry();
  const result = normalizeHistory(stored([current, old, fresh]), NOW);
  assert.deepEqual(result.entries.map((item) => item.id), [current.id, fresh.id]);
  assert.equal(result.changed, true);
});

test('clean storage is stable: nothing changes, nothing needs rewriting, and the report content is untouched', () => {
  const entries = [entry(), entry({ id: NOW - 5 })];
  const first = normalizeHistory(stored(entries), NOW);
  assert.equal(first.changed, false);
  assert.deepEqual(first.entries, entries);
  assert.equal(normalizeHistory(stored(first.entries), NOW).changed, false);
  assert.deepEqual(first.entries[0].report, REPORT);
});

test('what would be displayed, restored or exported contains no expired entry (single gateway, serialises cleanly)', () => {
  const mixed = [entry({ id: 1, expiresAt: NOW - 1 }), entry({ id: 2 }), entry({ id: 3, expiresAt: NOW + 5 * DAY })];
  const visible = JSON.parse(JSON.stringify(normalizeHistory(stored(mixed), NOW).entries));
  assert.deepEqual(visible.map((item) => item.id), [2, 3]);
  assert.ok(visible.every((item) => item.expiresAt > NOW));
});

test('an expiry that would outlive the policy is clamped; a shorter one is respected; a bad one is recomputed', () => {
  const limit = NOW + HISTORY_TTL_MS;
  assert.equal(normalizeHistory(stored([entry({ expiresAt: NOW + 3650 * DAY })]), NOW).entries[0].expiresAt, limit);
  assert.equal(normalizeHistory(stored([entry({ expiresAt: NOW + DAY })]), NOW).entries[0].expiresAt, NOW + DAY);
  for (const bad of ['soon', null, NaN, {}, [], true]) assert.equal(normalizeHistory(stored([entry({ expiresAt: bad })]), NOW).entries[0].expiresAt, limit, String(bad));
});

test('a save time in the future (clock changed, or tampered) cannot buy extra retention', () => {
  const future = NOW + 400 * DAY;
  const out = normalizeHistory(stored([entry({ id: 42, savedAt: future, expiresAt: future + HISTORY_TTL_MS })]), NOW).entries[0];
  assert.equal(out.savedAt, NOW);
  assert.ok(out.expiresAt <= NOW + HISTORY_TTL_MS);
});

// ---- legacy migration ------------------------------------------------------------------------------------------------

test('legacy entries (no savedAt/expiresAt) are migrated, not dropped: the save time is recovered from the id', () => {
  const recent = legacy({ id: NOW - 5 * DAY });
  const result = normalizeHistory(stored([recent]), NOW);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].savedAt, NOW - 5 * DAY);
  assert.equal(result.entries[0].expiresAt, NOW - 5 * DAY + HISTORY_TTL_MS);
  assert.deepEqual(result.entries[0].report, REPORT);
  assert.equal(result.entries[0].title, recent.title);
  assert.equal(result.changed, true, 'storage is rewritten in the new schema');
  assert.equal(normalizeHistory(stored(result.entries), NOW).changed, false, 'and is stable afterwards');
});

test('legacy entries already older than the retention period are removed on first load (the policy applies retroactively)', () => {
  const result = normalizeHistory(stored([legacy({ id: NOW - 31 * DAY }), legacy({ id: NOW - 2 * DAY })]), NOW);
  assert.deepEqual(result.entries.map((item) => item.id), [NOW - 2 * DAY]);
});

test('legacy entries whose id is not a plausible timestamp are kept and given a full term from the migration time', () => {
  for (const id of [5, 1_000_000, 'abc-1', NOW + 10 * DAY]) {
    const out = normalizeHistory(stored([legacy({ id })]), NOW).entries;
    assert.equal(out.length, 1, String(id));
    assert.equal(out[0].savedAt, NOW);
    assert.equal(out[0].expiresAt, NOW + HISTORY_TTL_MS);
    assert.equal(out[0].id, id, 'the id is preserved so existing references keep working');
  }
});

test('legacy and new entries can coexist in one store', () => {
  const out = normalizeHistory(stored([entry(), legacy({ id: NOW - DAY })]), NOW).entries;
  assert.deepEqual(out.map((item) => [item.id, typeof item.expiresAt]), [[NOW, 'number'], [NOW - DAY, 'number']]);
});

// ---- malformed storage -----------------------------------------------------------------------------------------------

test('absent storage is empty and needs no rewrite', () => {
  assert.deepEqual(normalizeHistory(null, NOW), { entries: [], changed: false });
  assert.deepEqual(normalizeHistory(undefined, NOW), { entries: [], changed: false });
});

test('unreadable or wrongly shaped storage yields no entries and is flagged for removal (no data retained that cannot be shown)', () => {
  for (const raw of ['not json', '{"a":1}', '"text"', 'null', '123', 'true', '{', '', '[', '{"id":1,"report":{}}']) {
    const result = normalizeHistory(raw, NOW);
    assert.deepEqual(result.entries, [], raw);
    assert.equal(result.changed, true, raw);
  }
});

test('malformed entries are dropped one by one; valid neighbours survive', () => {
  const good = entry({ id: 100 });
  const junk = [null, 7, 'x', [], {}, { id: 1 }, { id: 2, report: null }, { id: 3, report: 'text' }, { id: 4, report: [] }, { report: REPORT }, { id: {}, report: REPORT }, { id: '', report: REPORT }, { id: NaN, report: REPORT }];
  const result = normalizeHistory(stored([...junk, good]), NOW);
  assert.deepEqual(result.entries.map((item) => item.id), [100]);
  assert.equal(result.changed, true);
});

test('fields are coerced safely: a bad title, score or verdict cannot break rendering', () => {
  const [out] = normalizeHistory(stored([entry({ title: { a: 1 }, score: 'high', verdict: 5, timestamp: null })]), NOW).entries;
  assert.equal(out.title, 'Analysis');
  assert.equal(out.score, null);
  assert.equal(out.verdict, '');
  assert.equal(out.timestamp, '');
  const [long] = normalizeHistory(stored([entry({ title: 'x'.repeat(5000) })]), NOW).entries;
  assert.equal(long.title.length, 200);
});

test('duplicate ids keep the first (newest) copy only', () => {
  const out = normalizeHistory(stored([entry({ id: 9, title: 'new' }), entry({ id: 9, title: 'old' })]), NOW).entries;
  assert.deepEqual(out.map((item) => item.title), ['new']);
});

test('normalising never mutates its input', () => {
  const raw = stored([legacy({ id: NOW - DAY })]);
  const parsed = JSON.parse(raw);
  const before = JSON.stringify(parsed);
  normalizeHistory(parsed, NOW); // a non-string input is treated as unreadable, not modified
  assert.equal(JSON.stringify(parsed), before);
});

// ---- deletion --------------------------------------------------------------------------------------------------------

test('deleting one entry removes only that entry, matches numeric and string ids, and does not mutate', () => {
  const entries = [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 'three' })];
  const snapshot = JSON.stringify(entries);
  assert.deepEqual(removeHistoryEntry(entries, 2).map((item) => item.id), [1, 'three']);
  assert.deepEqual(removeHistoryEntry(entries, '2').map((item) => item.id), [1, 'three'], 'ids from data attributes are strings');
  assert.deepEqual(removeHistoryEntry(entries, 'three').map((item) => item.id), [1, 2]);
  assert.deepEqual(removeHistoryEntry(entries, 99).map((item) => item.id), [1, 2, 'three'], 'unknown id is a no-op');
  assert.deepEqual(removeHistoryEntry([], 1), []);
  assert.equal(JSON.stringify(entries), snapshot);
});

// ---- wiring (static): one reader, one notice ------------------------------------------------------------------------

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('wiring: the history store has one reader, every consumer goes through it, and the key is not hard-coded elsewhere', () => {
  const client = read('client.js');
  assert.equal([...client.matchAll(/storage\.get\(HISTORY_KEY\)/g)].length, 1, 'exactly one place may read the store');
  assert.doesNotMatch(client, /ocopilot-history/, 'use HISTORY_KEY');
  const consumers = ['function renderHistory', 'function saveHistory', 'function updateHistory'].map((name) => {
    const start = client.indexOf(name);
    return client.slice(start, client.indexOf('\nfunction ', start + 10) === -1 ? undefined : client.indexOf('\nfunction ', start + 10));
  });
  for (const body of consumers) assert.match(body, /historyEntries\(\)/, 'must read through historyEntries()');
  assert.match(client, /function historyEntries\(\) \{\s*const \{ entries, changed \} = normalizeHistory\(storage\.get\(HISTORY_KEY\), Date\.now\(\)\);/);
  assert.match(client, /\[data-history-remove\]/, 'individual deletion is wired');
  assert.match(client, /'#clearHistory'/, 'clear-all is wired');
  assert.match(client, /storage\.remove\(HISTORY_KEY\)/);
  assert.match(client, /if \(index === -1\) return;/, 'a deleted entry is never resurrected by a late update');
});

test('wiring: the retention notice is visible, states the real period, and does not overclaim security', () => {
  const html = read('index.html');
  const days = `${HISTORY_TTL_DAYS} days`;
  assert.match(html, new RegExp(`id="privacyNote"[^>]*>[^<]*${days}`), 'privacy note states the period');
  assert.match(html, new RegExp(`id="historyNotice"[^>]*>[^<]*${days}`), 'history panel states the period');
  assert.match(html, /not encrypted/i);
  assert.doesNotMatch(html, /(?<!not )(?<!un)encrypted|\bsecurely stored|\bsecure storage/i, 'storage must not be described as encrypted or secure');
  assert.match(html, /id="historyNotice"/);
  assert.match(html, /id="clearHistory"/);
});

test('wiring: the history panel sits outside #report and #workspace so it is reachable before any analysis', () => {
  const html = read('index.html');
  const cardAt = html.indexOf('class="history-card"');
  assert.ok(cardAt > 0);
  for (const id of ['report', 'workspace']) {
    const start = html.indexOf(`id="${id}"`);
    const open = html.lastIndexOf('<section', start);
    let depth = 0;
    let end = -1;
    for (const tag of html.slice(open).matchAll(/<(\/?)section\b/g)) {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) { end = open + tag.index; break; }
    }
    assert.ok(end > open, `${id} section is balanced`);
    assert.ok(cardAt > end, `history card must not be inside #${id}`);
  }
  assert.equal([...html.matchAll(/id="historyList"/g)].length, 1, 'one history list only');
});
