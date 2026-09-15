// Run: node --test  (from apps/bound-book/)
const test = require('node:test');
const assert = require('node:assert');
const BB = require('./core.js');
const INV = require('./inventory.js');
const C = require('./customers.js');

function entry(over, id) {
  return BB.newEntry(Object.assign({
    dateReceived: '2026-01-05', mfrImporter: 'Acme', model: 'P9', serial: id || 'SN1',
    type: 'Pistol', caliber: '9mm', sourceName: 'Dist LLC', sourceAddress: '1 Main St',
    sourceFfl: '9-88-77777'
  }, over || {}), id || 'e1', '2026-01-05T12:00:00Z');
}

function soldTo(e, name, address, over) {
  return BB.applyDisposition(e, Object.assign({
    dispositionType: 'sale_4473', date: '2026-02-02', buyerName: name, buyerAddress: address,
    formSerial: 'F1', eligibilityNote: 'binder A'
  }, over || {}), '2026-02-02T12:00:00Z');
}

function party(name, address, ffl) {
  return { name: name || '', address: address || '', ffl: ffl || '' };
}

// --- address normalization -------------------------------------------------

test('street suffixes normalize to one spelling', () => {
  assert.equal(C.addressCore('9 Elm St'), '9 ELM ST');
  assert.equal(C.addressCore('9 Elm Street'), '9 ELM ST');
  assert.equal(C.addressCore('9 Elm St.'), '9 ELM ST');
  assert.equal(C.addressCore('9  elm   street'), '9 ELM ST');
  assert.equal(C.addressCore('100 Oak Avenue'), C.addressCore('100 Oak Ave'));
  assert.equal(C.addressCore('5 Pine Boulevard'), '5 PINE BLVD');
});

test('directionals normalize', () => {
  assert.equal(C.addressCore('9 North Elm St'), '9 N ELM ST');
  assert.equal(C.addressCore('9 N Elm St'), '9 N ELM ST');
});

test('unit designators normalize, including the bare hash', () => {
  assert.equal(C.addressCore('9 Elm St Apt 2'), '9 ELM ST APT 2');
  assert.equal(C.addressCore('9 Elm St #2'), '9 ELM ST APT 2');
  assert.equal(C.addressCore('9 Elm St Unit 2'), '9 ELM ST APT 2');
  assert.equal(C.addressCore('9 Elm St Suite 2'), '9 ELM ST STE 2');
  // ...but a different unit is a different doorway
  assert.notEqual(C.addressCore('9 Elm St Apt 2'), C.addressCore('9 Elm St Apt 5'));
});

test('the town is split off the doorway', () => {
  const p = C.addressParts('9 Elm St, Springfield IL 62704');
  assert.equal(p.core, '9 ELM ST');
  assert.equal(p.locality, 'SPRINGFIELD IL 62704');
  // so adding the town later still matches the doorway
  assert.equal(C.addressCore('9 Elm St'), p.core);
});

test('an address with no street suffix still peels off its town', () => {
  const p = C.addressParts('9 Elm Springfield IL 62704');
  assert.equal(p.core, '9 ELM');
  assert.match(p.locality, /IL 62704/);
});

test('localityKey reduces a town to something comparable', () => {
  assert.equal(C.localityKey('9 Elm St, Springfield IL 62704'), '62704');
  assert.equal(C.localityKey('9 Elm St, Springfield IL'), 'IL');
  assert.equal(C.localityKey('9 Elm St'), '');
});

test('localities conflict only when both are stated and disagree', () => {
  assert.equal(C.localityConflict('9 Elm St', '9 Elm St, Springfield IL 62704'), false,
    'a missing town is not a disagreement');
  assert.equal(C.localityConflict('9 Elm St, Springfield IL 62704', '9 Elm St, Boston MA 02101'), true);
  assert.equal(C.localityConflict('9 Elm St, Springfield IL', '9 Elm St, Boston MA'), true);
  assert.equal(C.localityConflict('9 Elm St, Springfield IL 62704', '9 Elm St, Springfield IL 62704'), false);
});

// --- name normalization ----------------------------------------------------

test('names match through case, punctuation and spacing', () => {
  assert.equal(C.namesCompatible('Jane Buyer', 'JANE  BUYER'), true);
  assert.equal(C.namesCompatible('Jane Buyer', "jane buyer"), true);
  assert.equal(C.nameKey('Jane Buyer'), 'JANE BUYER');
});

test('an added middle initial is compatible; a different one is not', () => {
  assert.equal(C.namesCompatible('Jane Buyer', 'Jane A Buyer'), true);
  assert.equal(C.namesCompatible('Jane A Buyer', 'Jane Alice Buyer'), true);
  assert.equal(C.namesCompatible('Jane A Buyer', 'Jane B Buyer'), false);
  assert.equal(C.namesCompatible('Jane Buyer', 'John Buyer'), false);
  assert.equal(C.namesCompatible('Jane Buyer', 'Jane Seller'), false);
});

test('last-name-first is the same person', () => {
  assert.equal(C.namesCompatible('Buyer, Jane', 'Jane Buyer'), true);
  assert.equal(C.nameKey('Buyer, Jane'), C.nameKey('Jane Buyer'));
});

// --- identity --------------------------------------------------------------

test('an FFL number identifies a licensee outright', () => {
  const a = party('Acme Guns', '1 Trade Way', '1-23-45678');
  const b = party('ACME GUNS INC', '99 Different Rd', '1-23-45678');
  assert.equal(C.identityKey(a), C.identityKey(b), 'same FFL is the same licensee');
  assert.equal(C.probablySame(a, b), true);
  assert.equal(C.isLicensee(a), true);
});

test('different FFLs are never the same licensee, however alike the names', () => {
  const a = party('Acme Guns', '1 Trade Way', '1-23-45678');
  const b = party('Acme Guns', '1 Trade Way', '9-99-99999');
  assert.equal(C.probablySame(a, b), false);
});

test('the identity key carries the town, so one street in two towns is two people', () => {
  const a = party('Jane Buyer', '9 Elm St, Springfield IL 62704');
  const b = party('Jane Buyer', '9 Elm St, Boston MA 02101');
  assert.notEqual(C.identityKey(a), C.identityKey(b));
  assert.equal(C.probablySame(a, b), false);
});

test('probablySame bridges the spellings that used to split a customer', () => {
  const base = party('Jane Buyer', '9 Elm St');
  assert.equal(C.probablySame(base, party('Jane Buyer', '9 Elm Street')), true);
  assert.equal(C.probablySame(base, party('Jane Buyer', '9 Elm St.')), true);
  assert.equal(C.probablySame(base, party('Jane A Buyer', '9 Elm St')), true);
  assert.equal(C.probablySame(base, party('Jane Buyer', '9 Elm St, Springfield IL 62704')), true);
});

test('probablySame will not merge on a name alone', () => {
  assert.equal(C.probablySame(party('Jane Buyer', '9 Elm St'), party('Jane Buyer', '11 Elm St')), false,
    'a different doorway is a different customer, because two people can share a name');
  assert.equal(C.probablySame(party('Jane Buyer', ''), party('Jane Buyer', '')), false,
    'no address is not enough to identify anyone');
});

test('a party with nothing in it has no identity', () => {
  assert.equal(C.identityKey(party('', '', '')), '');
  assert.equal(C.identityKey(null), '');
});

// --- projection ------------------------------------------------------------

test('customers are projected from both directions of the record', () => {
  const list = C.customers([soldTo(entry({}, 'a'), 'Jane Buyer', '9 Elm St')]);
  const names = list.map((c) => c.displayName).sort();
  assert.deepEqual(names, ['Dist LLC', 'Jane Buyer']);
  const jane = list.filter((c) => c.displayName === 'Jane Buyer')[0];
  assert.equal(jane.disposedCount, 1);
  assert.equal(jane.acquiredCount, 0);
  const dist = list.filter((c) => c.displayName === 'Dist LLC')[0];
  assert.equal(dist.acquiredCount, 1, 'the distributor is a customer too');
});

test('one buyer spelled four ways is one customer', () => {
  const list = C.customers([
    soldTo(entry({ serial: 'S1' }, 'a'), 'Jane Buyer', '9 Elm St'),
    soldTo(entry({ serial: 'S2' }, 'b'), 'Jane Buyer', '9 Elm Street'),
    soldTo(entry({ serial: 'S3' }, 'c'), 'Jane A Buyer', '9 Elm St.'),
    soldTo(entry({ serial: 'S4' }, 'd'), 'Jane Buyer', '9 Elm St, Springfield IL 62704')
  ]);
  const people = list.filter((c) => c.kind === 'person');
  assert.equal(people.length, 1, 'four spellings, one person');
  assert.equal(people[0].disposedCount, 4);
  assert.equal(people[0].spellings > 1, true, 'and it remembers that they were spelled differently');
  assert.equal(people[0].handgunsBought, 4);
  // the fullest spelling is the one shown
  assert.match(people[0].displayAddress, /Springfield/);
});

test('transactions are chronological and carry the firearm', () => {
  const list = C.customers([
    soldTo(entry({ serial: 'S2' }, 'b'), 'Jane Buyer', '9 Elm St', { date: '2026-03-01' }),
    soldTo(entry({ serial: 'S1' }, 'a'), 'Jane Buyer', '9 Elm St', { date: '2026-01-01' })
  ]);
  const jane = list.filter((c) => c.kind === 'person')[0];
  assert.deepEqual(jane.transactions.map((t) => t.date), ['2026-01-01', '2026-03-01']);
  assert.equal(jane.firstDealt, '2026-01-01');
  assert.equal(jane.lastDealt, '2026-03-01');
  assert.equal(jane.transactions[0].serial, 'S1');
});

test('a corrected name re-groups the customer, because identity reads current values', () => {
  let e = soldTo(entry({}, 'a'), 'Jane Buyr', '9 Elm St');
  e = BB.addCorrection(e, 'disposition.buyerName', 'Jane Buyer', 'typo', '2026-02-03T00:00:00Z');
  const jane = C.customers([e]).filter((c) => c.kind === 'person')[0];
  assert.equal(jane.displayName, 'Jane Buyer');
});

test('search finds a customer by name, address, FFL or serial', () => {
  const list = C.customers([soldTo(entry({ serial: 'AB-123' }, 'a'), 'Jane Buyer', '9 Elm St')]);
  assert.equal(C.search(list, 'jane').length, 1);
  assert.equal(C.search(list, 'elm').length, 1);
  // Both parties to a transaction match its serial — the distributor it came
  // from and the person it went to. That is the useful answer to "who touched
  // this firearm", so it is not a bug.
  assert.equal(C.search(list, 'ab123').length, 2, 'serial, punctuation-insensitively');
  assert.equal(C.search(list, 'nobody').length, 0);
  assert.equal(C.search(list, '').length, list.length);
});

test('find returns a customer by key', () => {
  const list = C.customers([soldTo(entry({}, 'a'), 'Jane Buyer', '9 Elm St')]);
  assert.equal(C.find(list, list[0].key).key, list[0].key);
  assert.equal(C.find(list, 'nope'), null);
});

// --- duplicates ------------------------------------------------------------

test('same name at a different address is offered for review, not merged', () => {
  const list = C.customers([
    soldTo(entry({ serial: 'S1' }, 'a'), 'Jane Buyer', '9 Elm St'),
    soldTo(entry({ serial: 'S2' }, 'b'), 'Jane Buyer', '44 Oak Ave')
  ]);
  assert.equal(list.filter((c) => c.kind === 'person').length, 2, 'kept apart');
  const dupes = C.duplicateCandidates(list);
  assert.equal(dupes.length, 1);
  assert.match(dupes[0].reason, /moved, or two people/);
});

test('two names at one address are offered for review', () => {
  const list = C.customers([
    soldTo(entry({ serial: 'S1' }, 'a'), 'Jane Buyer', '9 Elm St'),
    soldTo(entry({ serial: 'S2' }, 'b'), 'John Buyer', '9 Elm St')
  ]);
  const dupes = C.duplicateCandidates(list);
  assert.equal(dupes.length, 1);
  assert.match(dupes[0].reason, /household, or a typo/);
});

test('unrelated customers are not offered as duplicates', () => {
  const list = C.customers([
    soldTo(entry({ serial: 'S1' }, 'a'), 'Jane Buyer', '9 Elm St'),
    soldTo(entry({ serial: 'S2' }, 'b'), 'Bob Other', '44 Oak Ave')
  ]);
  assert.deepEqual(C.duplicateCandidates(list), []);
});

test('standardizing produces one correction per field that actually differs', () => {
  const list = C.customers([
    soldTo(entry({ serial: 'S1' }, 'a'), 'Jane Buyer', '9 Elm Street'),
    soldTo(entry({ serial: 'S2' }, 'b'), 'Jane A Buyer', '9 Elm St')
  ]);
  const jane = list.filter((c) => c.kind === 'person')[0];
  const fixes = C.standardizeCorrections(jane, 'Jane Buyer', '9 Elm St');
  // entry a needs its address corrected, entry b needs its name corrected
  assert.equal(fixes.length, 2);
  assert.ok(fixes.some((f) => f.entryId === 'a' && f.field === 'disposition.buyerAddress'));
  assert.ok(fixes.some((f) => f.entryId === 'b' && f.field === 'disposition.buyerName'));
  // nothing is written for values that already match
  assert.equal(C.standardizeCorrections(jane, 'Jane Buyer', '9 Elm Street')
    .filter((f) => f.entryId === 'a' && f.field === 'disposition.buyerAddress').length, 0);
});

// --- the regression this module exists to fix -------------------------------

test('REGRESSION: the handgun alarm survives ordinary typing variation', () => {
  const variants = [
    ['Jane Buyer', '9 Elm Street'],
    ['Jane Buyer', '9 Elm St.'],
    ['Jane A Buyer', '9 Elm St'],
    ['Jane Buyer', '9 Elm St #2'],
    ['Jane Buyer', '9 Elm St, Springfield IL 62704']
  ];
  const base = ['Jane Buyer', '9 Elm St'];
  const baseApt = ['Jane Buyer', '9 Elm St Apt 2'];

  variants.forEach(([name, address], i) => {
    const first = address.indexOf('#') !== -1 ? baseApt : base;
    const sales = [
      soldTo(entry({ serial: 'H' + i + 'a' }, 'e' + i + 'a'), first[0], first[1], { date: '2026-02-02' }),
      soldTo(entry({ serial: 'H' + i + 'b' }, 'e' + i + 'b'), name, address, { date: '2026-02-04' })
    ];
    const hits = INV.multipleHandgunSales(sales);
    assert.equal(hits.length, 1, 'alarm missed "' + name + ' / ' + address + '"');
    assert.equal(hits[0].count, 2);
    assert.equal(hits[0].spellingsMerged, true, 'and it says the spellings differed');
    assert.ok(hits[0].spellings.length >= 2);
  });
});

test('the alarm still stays silent for people who are genuinely different', () => {
  const quiet = [
    [['Jane A Buyer', '9 Elm St'], ['Jane B Buyer', '9 Elm St']],
    [['Jane Buyer', '9 Elm St'], ['John Buyer', '9 Elm St']],
    [['Jane Buyer', '9 Elm St, Springfield IL 62704'], ['Jane Buyer', '9 Elm St, Boston MA 02101']],
    [['Jane Buyer', '9 Elm St'], ['Jane Buyer', '11 Elm St']],
    [['Jane Buyer', '9 Elm St Apt 2'], ['Jane Buyer', '9 Elm St Apt 5']]
  ];
  quiet.forEach(([a, b], i) => {
    const sales = [
      soldTo(entry({ serial: 'Q' + i + 'a' }, 'q' + i + 'a'), a[0], a[1], { date: '2026-02-02' }),
      soldTo(entry({ serial: 'Q' + i + 'b' }, 'q' + i + 'b'), b[0], b[1], { date: '2026-02-04' })
    ];
    assert.deepEqual(INV.multipleHandgunSales(sales), [],
      'false positive on ' + JSON.stringify([a, b]));
  });
});

test('an exact-match cluster does not claim spellings were merged', () => {
  const sales = [
    soldTo(entry({ serial: 'X1' }, 'x1'), 'Jane Buyer', '9 Elm St', { date: '2026-02-02' }),
    soldTo(entry({ serial: 'X2' }, 'x2'), 'Jane Buyer', '9 Elm St', { date: '2026-02-04' })
  ];
  const hits = INV.multipleHandgunSales(sales);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].spellingsMerged, false);
  assert.equal(hits[0].spellings.length, 1, 'one spelling, so nothing to point out');
});
