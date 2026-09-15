// Run: node --test  (from apps/bound-book/)
const test = require('node:test');
const assert = require('node:assert');
const BB = require('./core.js');
const I = require('./integrity.js');
const INV = require('./inventory.js');

function acq(over) {
  return Object.assign({
    dateReceived: '2026-01-05', mfrImporter: 'Acme', model: 'M1', serial: 'SN1',
    type: 'Pistol', caliber: '9mm', sourceName: 'Dist', sourceAddress: '1 Main'
  }, over || {});
}

function entry(over, id, createdAt) {
  return BB.newEntry(acq(over), id || 'e1', createdAt || '2026-01-05T12:00:00Z');
}

function sold(e, over, recordedAt) {
  return BB.applyDisposition(e, Object.assign({
    dispositionType: 'sale_4473', date: '2026-02-02', buyerName: 'Jane',
    buyerAddress: '2 Oak', formSerial: 'F1', eligibilityNote: 'binder A'
  }, over || {}), recordedAt || '2026-02-02T12:00:00Z');
}

// --- on hand ---------------------------------------------------------------

test('onHand returns only open entries', () => {
  const open = entry({}, 'a');
  const gone = sold(entry({ serial: 'SN2' }, 'b'));
  assert.deepEqual(INV.onHand([open, gone]).map((e) => e.id), ['a']);
});

test('aged sorts longest-held first and counts days', () => {
  const older = entry({ dateReceived: '2026-01-01' }, 'a');
  const newer = entry({ dateReceived: '2026-03-01', serial: 'SN2' }, 'b');
  const rows = INV.aged([newer, older], '2026-03-11T00:00:00Z');
  assert.deepEqual(rows.map((r) => r.entry.id), ['a', 'b']);
  assert.equal(rows[0].days, 69);
  assert.equal(rows[1].days, 10);
});

test('aged tolerates a missing or malformed date', () => {
  const rows = INV.aged([entry({ dateReceived: 'whenever' }, 'a')], '2026-03-11T00:00:00Z');
  assert.equal(rows[0].days, null);
});

test('summary counts handguns and groups by type', () => {
  const s = INV.summary([
    entry({ type: 'Pistol' }, 'a'),
    entry({ type: 'Revolver', serial: 'SN2' }, 'b'),
    entry({ type: 'Rifle', serial: 'SN3' }, 'c'),
    sold(entry({ type: 'Pistol', serial: 'SN4' }, 'd'))
  ], '2026-03-11T00:00:00Z');
  assert.equal(s.count, 3, 'disposed entries are not on hand');
  assert.equal(s.handguns, 2);
  assert.deepEqual(s.byType, [
    { label: 'Pistol', count: 1 }, { label: 'Revolver', count: 1 }, { label: 'Rifle', count: 1 }
  ]);
});

test('filterOnHand matches a serial typed without punctuation', () => {
  const e = entry({ serial: 'AB-123-X' }, 'a');
  assert.equal(INV.filterOnHand([e], 'ab123x').length, 1);
  assert.equal(INV.filterOnHand([e], 'AB-123').length, 1);
  assert.equal(INV.filterOnHand([e], 'nope').length, 0);
});

test('filterOnHand matches model and caliber text', () => {
  const e = entry({ model: 'Ranger', caliber: '.308 Win' }, 'a');
  assert.equal(INV.filterOnHand([e], 'ranger').length, 1);
  assert.equal(INV.filterOnHand([e], '.308').length, 1);
});

// --- physical inventory ----------------------------------------------------

test('a count session snapshots the open entries only', () => {
  const s = INV.startCount([entry({}, 'a'), sold(entry({ serial: 'SN2' }, 'b'))], 'c1', '2026-03-11T00:00:00Z');
  assert.equal(s.expected.length, 1);
  assert.equal(s.expected[0].entryId, 'a');
  assert.equal(s.expected[0].serial, 'SN1');
});

test('markFound toggles without duplicating and does not mutate', () => {
  const s0 = INV.startCount([entry({}, 'a')], 'c1', '2026-03-11T00:00:00Z');
  const s1 = INV.markFound(s0, 'a', true);
  const s2 = INV.markFound(s1, 'a', true);
  assert.deepEqual(s0.foundIds, [], 'original session untouched');
  assert.deepEqual(s2.foundIds, ['a']);
  assert.deepEqual(INV.markFound(s2, 'a', false).foundIds, []);
});

test('countStatus reports missing and unexpected as discrepancies', () => {
  let s = INV.startCount([entry({}, 'a'), entry({ serial: 'SN2' }, 'b')], 'c1', '2026-03-11T00:00:00Z');
  let st = INV.countStatus(s);
  assert.equal(st.expected, 2);
  assert.equal(st.found, 0);
  assert.equal(st.missing.length, 2);

  s = INV.markFound(s, 'a', true);
  s = INV.addUnexpected(s, 'GHOST1', 'found in the safe, not in the book');
  st = INV.countStatus(s);
  assert.equal(st.found, 1);
  assert.deepEqual(st.missing.map((m) => m.entryId), ['b']);
  assert.equal(st.unexpected.length, 1);
  assert.equal(st.discrepancies, 2);
  assert.equal(st.complete, false);
});

test('a fully matched count is complete', () => {
  let s = INV.startCount([entry({}, 'a')], 'c1', '2026-03-11T00:00:00Z');
  s = INV.markFound(s, 'a', true);
  const st = INV.countStatus(s);
  assert.equal(st.complete, true);
  assert.equal(st.discrepancies, 0);
});

test('findExpectedBySerial matches punctuation-insensitively, refuses ambiguity', () => {
  const s = INV.startCount([
    entry({ serial: 'AB-12' }, 'a'), entry({ serial: 'ab12' }, 'b'), entry({ serial: 'ZZ9' }, 'c')
  ], 'c1', '2026-03-11T00:00:00Z');
  assert.equal(INV.findExpectedBySerial(s, 'zz-9').entryId, 'c');
  assert.equal(INV.findExpectedBySerial(s, 'AB12'), null, 'two candidates is not a match');
  assert.equal(INV.findExpectedBySerial(s, ''), null);
});

test('removeUnexpected drops the right row', () => {
  let s = INV.startCount([], 'c1', '2026-03-11T00:00:00Z');
  s = INV.addUnexpected(s, 'A', '');
  s = INV.addUnexpected(s, 'B', '');
  assert.deepEqual(INV.removeUnexpected(s, 0).unexpected.map((u) => u.serial), ['B']);
});

test('a completed count commits to the chain and reads back', () => {
  let s = INV.startCount([entry({}, 'a'), entry({ serial: 'SN2' }, 'b')], 'c1', '2026-03-11T00:00:00Z');
  s = INV.markFound(s, 'a', true);
  s.note = 'annual count';
  const payload = INV.countEventPayload(s, '2026-03-11T18:00:00Z');
  assert.equal(payload.expectedCount, 2);
  assert.equal(payload.foundCount, 1);
  assert.equal(payload.missing[0].entryId, 'b');

  const log = I.appendEvent([], 'inventory', payload, '2026-03-11T18:00:00Z');
  assert.equal(I.verifyChain(log).ok, true);
  assert.equal(INV.countsFromLog(log).length, 1);
  assert.equal(INV.countsFromLog(log)[0].payload.note, 'annual count');
});

test('an inventory event does not appear in the A&D projection', () => {
  let log = I.appendEvent([], 'acquire', Object.assign(acq(), { entryId: 'a' }), '2026-01-05T12:00:00Z');
  log = I.appendEvent(log, 'inventory', { sessionId: 'c1', expectedCount: 1, foundCount: 1, missing: [], unexpected: [] }, '2026-03-11T18:00:00Z');
  const entries = I.project(log);
  assert.equal(entries.length, 1, 'the ledger still holds exactly one firearm');
  assert.equal(entries[0].id, 'a');
});

// --- alarms ----------------------------------------------------------------

test('two handguns to one buyer inside the window raise an alarm', () => {
  const a = sold(entry({ type: 'Pistol' }, 'a'), { date: '2026-02-02' });
  const b = sold(entry({ type: 'Revolver', serial: 'SN2' }, 'b'), { date: '2026-02-04' });
  const hits = INV.multipleHandgunSales([a, b]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 2);
  assert.equal(hits[0].firstDate, '2026-02-02');
  assert.equal(hits[0].lastDate, '2026-02-04');
});

test('the same two handguns outside the window do not', () => {
  const a = sold(entry({ type: 'Pistol' }, 'a'), { date: '2026-02-02' });
  const b = sold(entry({ type: 'Pistol', serial: 'SN2' }, 'b'), { date: '2026-03-02' });
  assert.deepEqual(INV.multipleHandgunSales([a, b]), []);
});

test('long guns and different buyers never raise it', () => {
  const rifles = [
    sold(entry({ type: 'Rifle' }, 'a'), { date: '2026-02-02' }),
    sold(entry({ type: 'Shotgun', serial: 'SN2' }, 'b'), { date: '2026-02-03' })
  ];
  assert.deepEqual(INV.multipleHandgunSales(rifles), []);

  const others = [
    sold(entry({ type: 'Pistol' }, 'a'), { date: '2026-02-02', buyerName: 'Jane' }),
    sold(entry({ type: 'Pistol', serial: 'SN2' }, 'b'), { date: '2026-02-03', buyerName: 'Bob', buyerAddress: '9 Elm' })
  ];
  assert.deepEqual(INV.multipleHandgunSales(others), []);
});

test('an FFL-to-FFL handgun transfer is not a multiple-handgun sale', () => {
  const a = sold(entry({ type: 'Pistol' }, 'a'),
    { dispositionType: 'ffl_transfer', date: '2026-02-02', buyerName: '', buyerAddress: '', buyerFfl: '1-23-45' });
  const b = sold(entry({ type: 'Pistol', serial: 'SN2' }, 'b'),
    { dispositionType: 'ffl_transfer', date: '2026-02-03', buyerName: '', buyerAddress: '', buyerFfl: '1-23-45' });
  assert.deepEqual(INV.multipleHandgunSales([a, b]), []);
});

test('the handgun threshold and window are configurable', () => {
  const sales = [
    sold(entry({ type: 'Pistol' }, 'a'), { date: '2026-02-02' }),
    sold(entry({ type: 'Pistol', serial: 'SN2' }, 'b'), { date: '2026-02-03' })
  ];
  assert.equal(INV.multipleHandgunSales(sales, { handgunThreshold: 3 }).length, 0);
  assert.equal(INV.multipleHandgunSales(sales, { handgunWindowBusinessDays: 1 }).length, 0);
});

test('a cluster is reported once, not once per sale in it', () => {
  const sales = ['2026-02-02', '2026-02-03', '2026-02-04'].map((d, i) =>
    sold(entry({ type: 'Pistol', serial: 'SN' + i }, 'e' + i), { date: d }));
  const hits = INV.multipleHandgunSales(sales);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 3);
});

test('lateEntries measures the gap between the event and the book', () => {
  // received Monday 2026-01-05, written up Thursday 2026-01-08 -> 3 business days
  const late = entry({ dateReceived: '2026-01-05' }, 'a', '2026-01-08T09:00:00Z');
  const hits = INV.lateEntries([late]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'acquisition');
  assert.equal(hits[0].lagBusinessDays, 3);
  assert.equal(hits[0].limit, 1);
});

test('an entry inside the limit is not flagged', () => {
  const ok = entry({ dateReceived: '2026-01-05' }, 'a', '2026-01-06T09:00:00Z');
  assert.deepEqual(INV.lateEntries([ok]), []);
});

test('a weekend delivery written up Monday is not late', () => {
  // Saturday 2026-01-03 -> Monday 2026-01-05 is 1 business day
  const e = entry({ dateReceived: '2026-01-03' }, 'a', '2026-01-05T09:00:00Z');
  assert.deepEqual(INV.lateEntries([e]), []);
});

test('a late disposition is flagged from its recording timestamp', () => {
  const e = sold(entry({}, 'a', '2026-01-05T12:00:00Z'), { date: '2026-02-02' }, '2026-02-20T12:00:00Z');
  const hits = INV.lateEntries([e]).filter((h) => h.kind === 'disposition');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lagBusinessDays, 14);
  assert.equal(hits[0].limit, 7);
});

test('a disposition recorded before types existed has no recordedAt and is skipped', () => {
  const legacy = BB.applyDisposition(entry({}, 'a'), { date: '2026-02-02', formSerial: 'F1', eligibilityNote: 'x' });
  assert.deepEqual(INV.lateEntries([legacy]).filter((h) => h.kind === 'disposition'), []);
});

test('longOpen flags a firearm held past the threshold', () => {
  const old = entry({ dateReceived: '2024-01-01' }, 'a');
  const fresh = entry({ dateReceived: '2026-03-01', serial: 'SN2' }, 'b');
  const hits = INV.longOpen([old, fresh], '2026-03-11T00:00:00Z');
  assert.deepEqual(hits.map((h) => h.entry.id), ['a']);
  assert.equal(INV.longOpen([old, fresh], '2026-03-11T00:00:00Z', { openAgeAlertDays: 10000 }).length, 0);
});

test('settings fall back to defaults for blank or nonsense values', () => {
  assert.deepEqual(INV.settings({}), INV.DEFAULTS);
  assert.deepEqual(INV.settings({ handgunThreshold: '' }), INV.DEFAULTS);
  assert.deepEqual(INV.settings({ handgunThreshold: 'abc' }), INV.DEFAULTS);
  assert.equal(INV.settings({ handgunThreshold: '3' }).handgunThreshold, 3);
  assert.equal(INV.settings({ openAgeAlertDays: 0 }).openAgeAlertDays, 0);
});

test('alarms bundles every check in one pass', () => {
  const a = sold(entry({ type: 'Pistol' }, 'a'), { date: '2026-02-02' });
  const b = sold(entry({ type: 'Pistol', serial: 'SN2' }, 'b'), { date: '2026-02-03' });
  const res = INV.alarms([a, b], '2026-03-11T00:00:00Z');
  assert.equal(res.multipleHandgun.length, 1);
  assert.ok(Array.isArray(res.lateEntries));
  assert.ok(Array.isArray(res.longOpen));
  assert.equal(res.settings.handgunThreshold, 2);
});
