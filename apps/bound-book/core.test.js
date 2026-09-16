// Run: node --test  (from apps/bound-book/)
const test = require('node:test');
const assert = require('node:assert');
const BB = require('./core.js');

const goodAcq = {
  dateReceived: '2026-07-24',
  mfrImporter: 'Acme Arms',
  model: 'M1',
  serial: 'SN123',
  type: 'Pistol',
  caliber: '9mm',
  sourceName: 'Distributor LLC',
  sourceAddress: '1 Main St'
};

test('validateAcquisition passes with all required fields', () => {
  assert.deepEqual(BB.validateAcquisition(goodAcq), { ok: true, errors: [] });
});

test('validateAcquisition flags each missing required field', () => {
  const res = BB.validateAcquisition({});
  assert.equal(res.ok, false);
  // 6 required scalar fields + 1 party error
  assert.equal(res.errors.length, 7);
});

test('source is valid via FFL number alone (no name/address)', () => {
  const acq = Object.assign({}, goodAcq, { sourceName: '', sourceAddress: '', sourceFfl: '1-23-45' });
  assert.equal(BB.validateAcquisition(acq).ok, true);
});

test('source with only a name (no address, no FFL) is invalid', () => {
  const acq = Object.assign({}, goodAcq, { sourceName: 'Bob', sourceAddress: '', sourceFfl: '' });
  const res = BB.validateAcquisition(acq);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /Source requires/.test(e)));
});

test('validateDisposition requires buyer, form serial, eligibility', () => {
  const res = BB.validateDisposition({});
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 4);
});

test('applyDisposition sets status and does not mutate the original', () => {
  const e = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z');
  const disposed = BB.applyDisposition(e, {
    date: '2026-07-25', buyerName: 'Jane', buyerAddress: '2 Oak',
    formSerial: 'F900', eligibilityNote: '4473 on file, box 3'
  });
  assert.equal(disposed.status, 'disposed');
  assert.equal(e.status, 'open', 'original entry unchanged');
  assert.equal(disposed.disposition.buyerName, 'Jane');
});

test('addCorrection is append-only and currentValue reflects latest', () => {
  const e = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z');
  assert.equal(BB.currentValue(e, 'acquisition.serial'), 'SN123');

  const c1 = BB.addCorrection(e, 'acquisition.serial', 'SN999', 'typo', '2026-07-24T01:00:00Z');
  // original object still shows original stored value
  assert.equal(e.acquisition.serial, 'SN123');
  assert.equal(c1.acquisition.serial, 'SN123', 'stored value never overwritten');
  assert.equal(BB.currentValue(c1, 'acquisition.serial'), 'SN999');
  assert.equal(c1.corrections.length, 1);
  assert.equal(c1.corrections[0].oldValue, 'SN123');

  const c2 = BB.addCorrection(c1, 'acquisition.serial', 'SN000', 'again', '2026-07-24T02:00:00Z');
  assert.equal(BB.currentValue(c2, 'acquisition.serial'), 'SN000');
  assert.equal(c2.corrections.length, 2);
  assert.equal(c2.corrections[1].oldValue, 'SN999', 'correction chains from prior current value');
});

test('csvEscape quotes commas, quotes, and newlines', () => {
  assert.equal(BB.csvEscape('plain'), 'plain');
  assert.equal(BB.csvEscape('a,b'), '"a,b"');
  assert.equal(BB.csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(BB.csvEscape('line1\nline2'), '"line1\nline2"');
});

test('toCSV emits header plus one row per entry with a party rendered', () => {
  const e1 = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z');
  const e2 = BB.applyDisposition(
    BB.newEntry(Object.assign({}, goodAcq, { serial: 'SN2' }), 'id2', '2026-07-24T00:00:00Z'),
    { date: '2026-07-25', buyerName: 'Jane', buyerAddress: '2 Oak', formSerial: 'F900', eligibilityNote: 'box 3' }
  );
  const csv = BB.toCSV([e1, e2]);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('Entry ID,Status,'));
  assert.ok(lines[1].includes('Distributor LLC, 1 Main St'));
  assert.ok(lines[2].includes('Jane, 2 Oak'));
});

test('party renders FFL form when no name/address', () => {
  const acq = Object.assign({}, goodAcq, { sourceName: '', sourceAddress: '', sourceFfl: '1-23-45' });
  const e = BB.newEntry(acq, 'id1', '2026-07-24T00:00:00Z');
  assert.equal(BB.party(e, 'source'), 'FFL# 1-23-45');
});

// --- disposition types -----------------------------------------------------

test('a 4473 sale still demands the 4473 facts', () => {
  const res = BB.validateDisposition({ dispositionType: 'sale_4473', date: '2026-07-25' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /4473 \/ transfer reference is required/.test(e)));
  assert.ok(res.errors.some((e) => /Eligibility documentation is required/.test(e)));
});

test('an FFL-to-FFL transfer needs no 4473 and no eligibility note', () => {
  const res = BB.validateDisposition({
    dispositionType: 'ffl_transfer', date: '2026-07-25', buyerFfl: '1-23-45'
  });
  assert.deepEqual(res, { ok: true, errors: [] });
});

test('a theft/loss needs a report reference and no transferee at all', () => {
  const missing = BB.validateDisposition({ dispositionType: 'theft_loss', date: '2026-07-25' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /report reference is required/i.test(e)));
  assert.ok(!missing.errors.some((e) => /transferee/i.test(e)), 'a stolen firearm has no buyer');

  const ok = BB.validateDisposition({ dispositionType: 'theft_loss', date: '2026-07-25', reportRef: 'PD#55/ATF' });
  assert.deepEqual(ok, { ok: true, errors: [] });
});

test('destruction and personal collection need a note, not a buyer', () => {
  assert.equal(BB.validateDisposition({ dispositionType: 'destruction', date: '2026-07-25' }).ok, false);
  assert.equal(BB.validateDisposition({
    dispositionType: 'destruction', date: '2026-07-25', note: 'cut up, photos in binder B'
  }).ok, true);
  assert.equal(BB.validateDisposition({
    dispositionType: 'personal_collection', date: '2026-07-25', note: 'moved to my collection'
  }).ok, true);
});

test('an unknown disposition type falls back to the 4473 rules', () => {
  const res = BB.validateDisposition({ dispositionType: 'nonsense-or-legacy', date: '2026-07-25' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /4473/.test(e)));
  assert.equal(BB.dispType('nonsense-or-legacy').key, 'sale_4473');
});

test('dispositionFields marks required vs optional per type', () => {
  const theft = BB.dispositionFields('theft_loss');
  assert.deepEqual(theft.filter((f) => f.required).map((f) => f.key), ['date', 'reportRef']);
  assert.ok(theft.some((f) => f.key === 'note' && !f.required));
  assert.ok(!BB.dispositionFields('theft_loss').some((f) => f.key === 'formSerial'));
});

test('a party-less disposition renders its type where the buyer would go', () => {
  const e = BB.applyDisposition(BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z'), {
    dispositionType: 'theft_loss', date: '2026-07-25', reportRef: 'PD#55'
  });
  assert.match(BB.party(e, 'buyer'), /Theft or loss/);
});

test('a legacy dispose payload projects as a 4473 sale', () => {
  const e = BB.applyDisposition(BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z'), {
    date: '2026-07-25', buyerName: 'Jane', buyerAddress: '2 Oak', formSerial: 'F900', eligibilityNote: 'box 3'
  });
  assert.equal(e.disposition.dispositionType, 'sale_4473');
  assert.equal(BB.party(e, 'buyer'), 'Jane, 2 Oak');
});

// --- validation ------------------------------------------------------------

test('a malformed or impossible date received is rejected', () => {
  assert.equal(BB.validateAcquisition(Object.assign({}, goodAcq, { dateReceived: '24/07/2026' })).ok, false);
  assert.equal(BB.validateAcquisition(Object.assign({}, goodAcq, { dateReceived: '2026-02-30' })).ok, false);
});

test('a future date received is rejected only when a clock is supplied', () => {
  const future = Object.assign({}, goodAcq, { dateReceived: '2027-01-01' });
  assert.equal(BB.validateAcquisition(future).ok, true, 'pure by default');
  const res = BB.validateAcquisition(future, { now: '2026-07-24T00:00:00Z' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /future/.test(e)));
});

test('a disposition before its acquisition is rejected', () => {
  const entry = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z'); // received 2026-07-24
  const res = BB.validateDisposition({
    dispositionType: 'ffl_transfer', date: '2026-07-01', buyerFfl: '1-23-45'
  }, entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /before the date received/.test(e)));
});

test('the date check follows a corrected date received', () => {
  let entry = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z');
  entry = BB.addCorrection(entry, 'acquisition.dateReceived', '2026-06-01', 'typo', '2026-07-24T01:00:00Z');
  const res = BB.validateDisposition({
    dispositionType: 'ffl_transfer', date: '2026-06-15', buyerFfl: '1-23-45'
  }, entry);
  assert.equal(res.ok, true, 'now legal against the corrected acquisition date');
});

test('normalizeSerial ignores case and punctuation', () => {
  assert.equal(BB.normalizeSerial('ab-123 x'), 'AB123X');
  assert.equal(BB.normalizeSerial(null), '');
});

test('acquisitionWarnings flags a duplicate serial without blocking it', () => {
  const existing = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z'); // SN123, Acme
  const same = BB.acquisitionWarnings(Object.assign({}, goodAcq, { serial: 'sn-123' }), [existing]);
  assert.equal(same.length, 1);
  assert.match(same[0], /same manufacturer/);

  const other = BB.acquisitionWarnings(
    Object.assign({}, goodAcq, { serial: 'SN123', mfrImporter: 'Other Co' }), [existing]);
  assert.match(other[0], /genuine serial collision/);

  assert.deepEqual(BB.acquisitionWarnings(Object.assign({}, goodAcq, { serial: 'SN999' }), [existing]), []);
  // ...and a warning is never an error
  assert.equal(BB.validateAcquisition(Object.assign({}, goodAcq, { serial: 'sn-123' })).ok, true);
});

test('isHandgun recognises handguns and leaves frames alone', () => {
  assert.equal(BB.isHandgun('Pistol'), true);
  assert.equal(BB.isHandgun('revolver'), true);
  assert.equal(BB.isHandgun('Rifle'), false);
  assert.equal(BB.isHandgun('Frame'), false, 'deliberately conservative');
});

// --- corrections reach the exports -----------------------------------------

test('correctionLines describe every correction in reader-facing language', () => {
  let e = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z');
  e = BB.addCorrection(e, 'acquisition.serial', 'SN999', 'transcription error', '2026-07-25T00:00:00Z');
  e = BB.addCorrection(e, 'acquisition.model', 'M2', 'wrong model', '2026-07-26T00:00:00Z');
  const lines = BB.correctionLines(e);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Serial number: "SN123" → "SN999" \(transcription error\) on 2026-07-25/);
  assert.match(lines[1], /^Model: "M1" → "M2"/);
});

test('correctionsFor returns the whole history for a field, not just the last', () => {
  let e = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z');
  e = BB.addCorrection(e, 'acquisition.serial', 'SN999', 'first', '2026-07-25T00:00:00Z');
  e = BB.addCorrection(e, 'acquisition.serial', 'SN000', 'second', '2026-07-26T00:00:00Z');
  const hist = BB.correctionsFor(e, 'acquisition.serial');
  assert.deepEqual(hist.map((c) => c.oldValue), ['SN123', 'SN999']);
  assert.deepEqual(BB.correctionsFor(e, 'acquisition.model'), []);
});

test('the CSV carries the correction history, not just the corrected value', () => {
  let e = BB.newEntry(goodAcq, 'id1', '2026-07-24T00:00:00Z');
  e = BB.addCorrection(e, 'acquisition.serial', 'SN999', 'transcription error', '2026-07-25T00:00:00Z');
  const csv = BB.toCSV([e]);
  assert.ok(csv.split('\r\n')[0].includes('Corrections'));
  assert.ok(csv.includes('SN999'), 'the effective value');
  assert.ok(csv.includes('SN123'), 'and the value it replaced');
  assert.ok(csv.includes('transcription error'), 'and why');
});

test('the CSV carries the disposition type and paperwork columns', () => {
  const e = BB.applyDisposition(BB.newEntry(Object.assign({}, goodAcq, { docLocation: 'Binder A' }), 'id1', 'x'), {
    dispositionType: 'theft_loss', date: '2026-07-25', reportRef: 'PD#55', docLocation: 'Binder C'
  });
  const csv = BB.toCSV([e]);
  assert.ok(csv.includes('Theft or loss'));
  assert.ok(csv.includes('PD#55'));
  assert.ok(csv.includes('Binder A'));
  assert.ok(csv.includes('Binder C'));
});

test('fieldLabel renders correction paths for humans', () => {
  assert.equal(BB.fieldLabel('acquisition.serial'), 'Serial number');
  assert.equal(BB.fieldLabel('acquisition.sourceName'), 'Source name');
  assert.equal(BB.fieldLabel('disposition.formSerial'), 'Disposition — 4473 / transfer reference');
  assert.equal(BB.fieldLabel('disposition.buyerFfl'), 'Buyer FFL');
});

// --- record mode: whose claim is it, anyway? -------------------------------

test('the default record mode is the cautious one', () => {
  // Nothing configured must never mean "this licensee holds a variance".
  assert.equal(BB.recordMode({}).mode.key, 'companion');
  assert.equal(BB.recordMode(undefined).mode.key, 'companion');
  assert.equal(BB.recordMode({ recordMode: '' }).mode.key, 'companion');
  assert.equal(BB.recordMode({ recordMode: 'something-else' }).mode.key, 'companion');
  assert.equal(BB.recordMode({}).mode.systemOfRecord, 'print');
});

test('electronic mode needs both an explicit choice and a named variance', () => {
  const chosen = BB.recordMode({ recordMode: 'electronic' });
  assert.equal(chosen.mode.key, 'companion', 'a claim you cannot name is not a claim');
  assert.equal(chosen.downgraded, true);
  assert.match(chosen.reason, /no variance reference/i);

  const complete = BB.recordMode({ recordMode: 'electronic', varianceRef: 'VAR-2026-0142' });
  assert.equal(complete.mode.key, 'electronic');
  assert.equal(complete.downgraded, false);
  assert.equal(complete.reason, '');
  assert.equal(complete.mode.systemOfRecord, 'log');
});

test('a blank variance reference does not count as one', () => {
  assert.equal(BB.recordMode({ recordMode: 'electronic', varianceRef: '   ' }).downgraded, true);
});

test('each mode carries the statement its printout should make', () => {
  const companion = BB.recordMode({}).mode;
  assert.match(companion.printStatement, /printed ledger is the official/i);
  const electronic = BB.recordMode({ recordMode: 'electronic', varianceRef: 'X' }).mode;
  assert.match(electronic.printStatement, /electronic log is the record/i);
  // and the two never say the same thing
  assert.notEqual(companion.printStatement, electronic.printStatement);
});

test('only the electronic mode claims to require a variance', () => {
  assert.equal(BB.RECORD_MODES.filter((m) => m.requiresVariance).map((m) => m.key).join(), 'electronic');
});
