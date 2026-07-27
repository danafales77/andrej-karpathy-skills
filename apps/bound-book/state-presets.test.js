// Run: node --test  (from apps/bound-book/)
const test = require('node:test');
const assert = require('node:assert');
const SP = require('./state-presets.js');

test('STATES covers 50 states + DC', () => {
  assert.equal(SP.STATES.length, 51);
  assert.ok(SP.STATES.every((s) => s.code && s.name));
});

test('fieldId is deterministic and key-safe', () => {
  assert.equal(SP.fieldId('CA', 'DROS number'), 'st_ca_dros_number');
  assert.equal(SP.fieldId('CA', 'DROS number'), SP.fieldId('CA', 'DROS number'));
  assert.match(SP.fieldId('CA', 'DROS number'), /^[a-z0-9_]+$/);
});

test('applyState adds the preset fields for a seeded state', () => {
  const fields = SP.applyState([], 'CA');
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, 'DROS number');
  assert.equal(fields[0].side, 'disposition');
  assert.equal(fields[0].required, true);
  assert.equal(fields[0].source, 'state');
});

test('Florida preset: FDLE approval number is required, on disposition', () => {
  const fields = SP.applyState([], 'FL');
  assert.equal(fields.length, 3);
  const fdle = fields.find((f) => f.label === 'FDLE approval number');
  assert.ok(fdle, 'FDLE approval number present');
  assert.equal(fdle.side, 'disposition');
  assert.equal(fdle.required, true);
  assert.ok(fields.every((f) => f.side === 'disposition'), 'all FL fields are disposition-side');
  assert.ok(fields.some((f) => /waiting period cleared/i.test(f.label)));
  assert.ok(fields.some((f) => /exemption/i.test(f.label)));
});

test('applyState preserves manual fields', () => {
  const manual = { id: 'abc', label: 'My note', side: 'acquisition', required: false, source: 'manual' };
  const fields = SP.applyState([manual], 'CA');
  assert.equal(fields.length, 2);
  assert.ok(fields.some((f) => f.id === 'abc'));
  assert.ok(fields.some((f) => f.label === 'DROS number'));
});

test('applyState replaces prior state fields when switching states', () => {
  const withCA = SP.applyState([], 'CA');
  const switched = SP.applyState(withCA, 'TX'); // TX has no preset
  assert.equal(switched.filter((f) => f.source === 'state').length, 0);
});

test('applyState clears state fields for a state with no preset / empty selection', () => {
  const withCA = SP.applyState([], 'CA');
  assert.equal(SP.applyState(withCA, '').length, 0);
});

test('applyState is idempotent for the same state', () => {
  const once = SP.applyState([], 'CA');
  const twice = SP.applyState(once, 'CA');
  assert.deepEqual(once, twice);
});
