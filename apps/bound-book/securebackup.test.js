// Run: node --test  (from apps/bound-book/)
// Needs WebCrypto on globalThis — Node 18+.
const test = require('node:test');
const assert = require('node:assert');
const I = require('./integrity.js');
const SB = require('./securebackup.js');

const acq = {
  entryId: 'e1', dateReceived: '2026-07-24', mfrImporter: 'Acme', model: 'M1',
  serial: 'SN123', type: 'Pistol', caliber: '9mm', sourceName: 'Dist', sourceAddress: '1 Main'
};

function buildLog() {
  let log = I.appendEvent([], 'acquire', acq, '2026-07-24T00:00:00Z');
  log = I.appendEvent(log, 'acquire', Object.assign({}, acq, { entryId: 'e2', serial: 'SN2' }), '2026-07-24T01:00:00Z');
  return log;
}

const PASS = 'correct horse battery staple';

test('an encrypted backup round-trips', async () => {
  const log = buildLog();
  const text = await SB.encryptBackup(I.makeBackup(log, '2026-07-27T00:00:00Z'), PASS, '2026-07-27T00:00:00Z');
  const res = await SB.decryptBackup(text, PASS);
  assert.equal(res.ok, true);
  assert.equal(res.log.length, 2);
  assert.deepEqual(I.verifyChain(res.log), { ok: true, count: 2 });
});

test('the ciphertext does not leak the record', async () => {
  const text = await SB.encryptBackup(I.makeBackup(buildLog(), 'x'), PASS, 'x');
  assert.equal(text.includes('SN123'), false);
  assert.equal(text.includes('Acme'), false);
  assert.equal(text.includes('1 Main'), false);
});

test('the wrong passphrase is refused, not silently wrong', async () => {
  const text = await SB.encryptBackup(I.makeBackup(buildLog(), 'x'), PASS, 'x');
  const res = await SB.decryptBackup(text, 'not the passphrase');
  assert.equal(res.ok, false);
  assert.match(res.error, /wrong passphrase|altered/i);
});

test('an altered ciphertext fails authentication', async () => {
  const text = await SB.encryptBackup(I.makeBackup(buildLog(), 'x'), PASS, 'x');
  const data = JSON.parse(text);
  const bytes = Buffer.from(data.ciphertext, 'base64');
  bytes[5] ^= 0xff;
  data.ciphertext = bytes.toString('base64');
  const res = await SB.decryptBackup(JSON.stringify(data), PASS);
  assert.equal(res.ok, false);
});

test('a backup that decrypts but fails the chain check is still refused', async () => {
  const log = buildLog();
  log[0].payload.serial = 'TAMPERED'; // break the chain before encrypting
  const text = await SB.encryptBackup(I.makeBackup(log, 'x'), PASS, 'x');
  const res = await SB.decryptBackup(text, PASS);
  assert.equal(res.ok, false);
  assert.match(res.error, /integrity check/i);
});

test('isEncryptedBackup tells the two file kinds apart', () => {
  const plain = JSON.stringify(I.makeBackup(buildLog(), 'x'));
  assert.equal(SB.isEncryptedBackup(plain), false);
  assert.equal(SB.isEncryptedBackup('not json at all'), false);
});

test('encrypted and plain backups are distinguishable after a round-trip', async () => {
  const text = await SB.encryptBackup(I.makeBackup(buildLog(), 'x'), PASS, 'x');
  assert.equal(SB.isEncryptedBackup(text), true);
  // ...and the plain parser refuses the encrypted file rather than half-reading it
  assert.equal(I.parseBackup(text).ok, false);
});

test('decryptBackup rejects a file that is not one of ours', async () => {
  const res = await SB.decryptBackup(JSON.stringify({ app: 'something-else', encrypted: true, ciphertext: 'x' }), PASS);
  assert.equal(res.ok, false);
  assert.match(res.error, /does not look like/i);
});

test('an unknown encryption format is refused rather than guessed at', async () => {
  const res = await SB.decryptBackup(
    JSON.stringify({ app: 'bound-book', encrypted: true, format: 'rot13', ciphertext: 'x', salt: 'x', iv: 'x' }), PASS);
  assert.equal(res.ok, false);
  assert.match(res.error, /Unsupported encryption format/);
});

test('the iterations count travels with the file', async () => {
  const text = await SB.encryptBackup(I.makeBackup(buildLog(), 'x'), PASS, 'x');
  assert.equal(JSON.parse(text).iterations, SB.ITERATIONS);
});

test('a short passphrase is flagged before it is used', () => {
  assert.equal(SB.passphraseProblems(PASS).length, 0);
  assert.equal(SB.passphraseProblems('short').length, 1);
  assert.equal(SB.passphraseProblems('').length, 1);
});
