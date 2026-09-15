// smoke.test.js — drives the real page in a real browser.
//
// core/integrity/inventory/packages tests cover the logic; this covers the
// WIRING, which is where a single-file app actually breaks: a renamed element
// id, a handler that never got attached, a screen that throws on first render.
//
// Playwright is not a dependency of this project and never will be — the app
// ships as a double-clickable file with no build step. If Playwright happens to
// be installed (globally or otherwise) this runs; if not, it skips.
//
// Run: node --test          (skips without Playwright)
//      npx playwright install chromium && node --test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try harder below */ }
  // Common global install locations, so a globally installed Playwright works
  // without adding a package.json to this directory.
  const { execSync } = require('node:child_process');
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return require(require('node:path').join(root, 'playwright'));
  } catch (e) {
    return null;
  }
}

const playwright = loadPlaywright();

test('the app boots and every screen works in a real browser', {
  skip: playwright ? false : 'Playwright not installed — skipping the browser smoke test',
  timeout: 180000
}, async () => {
  const { chromium } = playwright;

  const nodePath = require('node:path');
  const os = require('node:os');
  const path = nodePath.join(__dirname, 'index.html');
  const problems = [];
  const steps = [];
  function step(name) { steps.push(name); }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));

  await page.goto('file://' + path);

  // First-run disclaimer
  await page.check('#disclaimer-ack');
  await page.click('#disclaimer-ok');
  step('disclaimer acknowledged');

  // --- acquire, including a bulk shipment -----------------------------------
  await page.fill('[name=dateReceived]', '2026-09-01');
  await page.fill('[name=mfrImporter]', 'Acme Arms');
  await page.fill('[name=model]', 'M1');
  await page.fill('[name=serial]', 'SN-0001');
  await page.fill('[name=type]', 'Pistol');
  await page.fill('[name=caliber]', '9mm');
  await page.fill('[name=sourceName]', 'Distributor LLC');
  await page.fill('[name=sourceAddress]', '1 Main St');
  await page.fill('[name=docLocation]', 'Binder A tab 3');
  await page.click('#bulk-add summary');
  await page.fill('[name=bulkSerials]', 'SN-0002\nSN-0003, SN-0004');
  await page.click('#acquire-form button[type=submit]');
  await page.waitForTimeout(150);

  const ledgerRows = await page.locator('#ledger-table tbody tr').count();
  if (ledgerRows !== 4) problems.push('bulk add: expected 4 ledger rows, got ' + ledgerRows);
  step('bulk acquisition recorded 4 entries from one form fill');

  // --- duplicate serial warns but does not block ----------------------------
  await page.click('nav button[data-view=acquire]');
  await page.fill('[name=dateReceived]', '2026-09-02');
  await page.fill('[name=mfrImporter]', 'Acme Arms');
  await page.fill('[name=model]', 'M1');
  await page.fill('[name=serial]', 'sn0001');
  await page.fill('[name=type]', 'Pistol');
  await page.fill('[name=caliber]', '9mm');
  await page.fill('[name=sourceName]', 'Distributor LLC');
  await page.fill('[name=sourceAddress]', '1 Main St');
  page.once('dialog', (d) => d.dismiss()); // decline the "record anyway?" confirm
  await page.click('#acquire-form button[type=submit]');
  await page.waitForTimeout(150);
  const warnVisible = await page.locator('#acquire-warnings').isVisible();
  const warnText = await page.locator('#acquire-warnings').innerText();
  if (!warnVisible || !/already on the record/.test(warnText)) {
    problems.push('duplicate serial did not warn: ' + warnText);
  }
  step('duplicate serial warned and was declined without being written');

  // --- a future date is refused --------------------------------------------
  await page.fill('[name=dateReceived]', '2030-01-01');
  await page.fill('[name=serial]', 'SN-9999');
  await page.click('#acquire-form button[type=submit]');
  await page.waitForTimeout(100);
  if (!/future/.test(await page.locator('#acquire-errors').innerText())) {
    problems.push('future date received was not refused');
  }
  step('future date received refused');

  // --- theft/loss disposition: no 4473, needs a report reference ------------
  await page.click('nav button[data-view=dispose]');
  await page.selectOption('#dispose-type', 'theft_loss');
  await page.waitForTimeout(100);
  if (await page.locator('#dispose-party').isVisible()) {
    problems.push('theft/loss still asks for a transferee');
  }
  if (await page.locator('#disp-formSerial').count()) {
    problems.push('theft/loss still asks for a 4473 reference');
  }
  await page.fill('#disp-date', '2026-09-10');
  // Submitting without the report reference must not record anything, whether it
  // is the browser's own required-field check or ours that stops it.
  const disposedBefore = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('boundbook.log.v1')).filter((e) => e.type === 'dispose').length);
  await page.click('#dispose-form button[type=submit]');
  await page.waitForTimeout(150);
  const disposedAfter = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('boundbook.log.v1')).filter((e) => e.type === 'dispose').length);
  if (disposedAfter !== disposedBefore) {
    problems.push('theft/loss was recorded without a report reference');
  }
  await page.fill('#disp-reportRef', 'PD#5512 / ATF 3310.11');
  await page.click('#dispose-form button[type=submit]');
  await page.waitForTimeout(150);
  step('theft/loss recorded with a report reference and no invented 4473 data');

  // --- an FFL-to-FFL transfer needs no 4473 --------------------------------
  await page.click('nav button[data-view=dispose]');
  await page.selectOption('#dispose-type', 'ffl_transfer');
  await page.waitForTimeout(100);
  await page.fill('#disp-date', '2026-09-11');
  await page.fill('[name=buyerFfl]', '1-23-45678');
  await page.click('#dispose-form button[type=submit]');
  await page.waitForTimeout(150);
  const disposedCount = await page.locator('#ledger-table .status-disposed').count();
  if (disposedCount !== 2) problems.push('expected 2 disposed entries, got ' + disposedCount);
  step('FFL-to-FFL transfer recorded without a 4473');

  // --- a correction shows struck through, and survives into the printout ----
  await page.click('nav button[data-view=ledger]');
  await page.locator('[data-correct]').first().click();
  await page.selectOption('#correct-field', 'acquisition.model');
  await page.fill('[name=newValue]', 'M1A');
  await page.fill('[name=reason]', 'transcription error');
  await page.click('#correct-form button[type=submit]');
  await page.waitForTimeout(150);
  if (!(await page.locator('#ledger-table .struck').count())) {
    problems.push('correction is not struck through in the ledger');
  }
  await page.click('nav button[data-view=export]');
  await page.waitForTimeout(150);
  // Assert against what actually PRINTS: the header, appendix and certification
  // are print-only, so screen innerText cannot see them.
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(100);
  const printText = await page.locator('#print-ledger').innerText();
  if (!/M1A/.test(printText)) problems.push('printed ledger missing the corrected value');
  if (!/transcription error/.test(printText)) problems.push('printed ledger missing the correction reason');
  if (!/was\s+M1\b/.test(printText)) problems.push('printed ledger does not show the struck-through original');
  if (!/Corrections/.test(printText)) problems.push('printed ledger missing the corrections appendix');
  if (!/Certification/.test(printText)) problems.push('printed ledger missing the certification block');
  if (!/head hash [0-9a-f]{64}/.test(printText)) problems.push('printed ledger missing the head hash');
  if (!/Chain verified/.test(printText)) problems.push('printed ledger missing the chain verification line');
  if (!/Eligibility/.test(printText)) problems.push('printed ledger missing the eligibility column');
  const footer = await page.locator('.print-footer').innerText();
  if (!/head hash/.test(footer)) problems.push('repeating print footer missing');
  await page.emulateMedia({ media: 'screen' });
  step('corrections, appendix, certification, chain line and head hash all reach the printout');

  // --- date range filtering -------------------------------------------------
  await page.fill('#export-from', '2026-09-20');
  await page.waitForTimeout(150);
  if (!/0 of \d+ entries selected/.test(await page.locator('#export-range-note').innerText())) {
    problems.push('date range did not filter: ' + await page.locator('#export-range-note').innerText());
  }
  await page.click('#btn-range-clear');
  await page.waitForTimeout(100);
  step('export date range filters and clears');

  // --- inventory: on hand, aging, alarms ------------------------------------
  await page.click('nav button[data-view=inventory]');
  await page.waitForTimeout(200);
  const tiles = await page.locator('.tile-value').allInnerTexts();
  if (tiles[0] !== '2') problems.push('expected 2 on hand, tiles say ' + JSON.stringify(tiles));
  const onHandRows = await page.locator('#inventory-table tbody tr').count();
  if (onHandRows !== 2) problems.push('expected 2 on-hand rows, got ' + onHandRows);
  step('inventory shows 2 on hand with aging');

  await page.fill('#inventory-search', 'sn0003');
  await page.waitForTimeout(100);
  if (await page.locator('#inventory-table tbody tr').count() !== 1) {
    problems.push('inventory search by unpunctuated serial failed');
  }
  await page.fill('#inventory-search', '');
  await page.waitForTimeout(100);
  step('inventory search matches a serial typed without punctuation');

  // --- physical inventory count --------------------------------------------
  await page.click('#btn-count-start');
  await page.waitForTimeout(150);
  await page.fill('#count-scan', 'sn0003');
  await page.press('#count-scan', 'Enter');
  await page.waitForTimeout(150);
  if (!/1 of 2 found/.test(await page.locator('.count-head').innerText())) {
    problems.push('scanning a serial did not mark it found: ' + await page.locator('.count-head').innerText());
  }
  await page.fill('#count-unexpected', 'GHOST-1');
  await page.fill('#count-unexpected-note', 'found in the safe');
  await page.click('#btn-count-unexpected');
  await page.waitForTimeout(150);
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-count-finish');
  await page.waitForTimeout(250);
  const history = await page.locator('#count-history').innerText();
  if (!/GHOST/.test(await page.locator('#view-inventory').innerText()) && !/2/.test(history)) {
    problems.push('count history did not record the session');
  }
  if (!/1/.test(history)) problems.push('count history empty: ' + history);
  step('physical count recorded, discrepancies and all');

  // --- the count is in the chain, and the chain still verifies --------------
  await page.click('nav button[data-view=integrity]');
  await page.waitForTimeout(200);
  const integrity = await page.locator('#integrity-status').innerText();
  if (!/Chain verified/.test(integrity)) problems.push('chain broken after all that: ' + integrity);
  if (!/Physical inventory/.test(await page.locator('#integrity-log').innerText())) {
    problems.push('inventory count is not in the event log');
  }
  const headHash = await page.locator('#head-hash').innerText();
  if (!/^[0-9a-f]{64}$/.test(headHash)) problems.push('head hash not shown: ' + headHash);
  step('chain verifies; the count is an event in it; head hash is displayed');

  // --- multiple-handgun alarm ----------------------------------------------
  // Two handguns to the same non-licensee, two days apart.
  for (const [serial, date] of [['HG-1', '2026-09-01'], ['HG-2', '2026-09-01']]) {
    await page.click('nav button[data-view=acquire]');
    await page.fill('[name=dateReceived]', date);
    await page.fill('[name=mfrImporter]', 'Acme Arms');
    await page.fill('[name=model]', 'P9');
    await page.fill('[name=serial]', serial);
    await page.fill('[name=type]', 'Pistol');
    await page.fill('[name=caliber]', '9mm');
    await page.fill('[name=sourceName]', 'Distributor LLC');
    await page.fill('[name=sourceAddress]', '1 Main St');
    await page.click('#acquire-form button[type=submit]');
    await page.waitForTimeout(120);
  }
  for (const [label, date] of [['HG-1', '2026-09-08'], ['HG-2', '2026-09-10']]) {
    await page.click('nav button[data-view=dispose]');
    await page.selectOption('#dispose-select', { label: /HG-1/.test(label) ? undefined : undefined }).catch(() => {});
    // pick by visible text
    const options = await page.locator('#dispose-select option').allTextContents();
    const idx = options.findIndex((o) => o.includes(label));
    await page.selectOption('#dispose-select', { index: idx });
    await page.selectOption('#dispose-type', 'sale_4473');
    await page.waitForTimeout(100);
    await page.fill('#disp-date', date);
    await page.fill('[name=buyerName]', 'Jane Buyer');
    await page.fill('[name=buyerAddress]', '9 Elm St');
    await page.fill('#disp-formSerial', 'F-' + label);
    await page.fill('#disp-eligibilityNote', '4473 + NICS proceed, binder A');
    await page.click('#dispose-form button[type=submit]');
    await page.waitForTimeout(150);
  }
  await page.click('nav button[data-view=inventory]');
  await page.waitForTimeout(200);
  const alarms = await page.locator('#inventory-alarms').innerText();
  if (!/2 handguns to Jane Buyer/.test(alarms)) {
    problems.push('multiple-handgun alarm did not fire: ' + alarms);
  }
  step('multiple-handgun sale to one buyer raised an alarm');

  // --- customers: the same buyer under a different spelling ----------------
  // The regression this module exists for, end to end in the browser.
  await page.click('nav button[data-view=acquire]');
  await page.fill('[name=dateReceived]', '2026-09-01');
  await page.fill('[name=mfrImporter]', 'Acme Arms');
  await page.fill('[name=model]', 'P9');
  await page.fill('[name=serial]', 'HG-3');
  await page.fill('[name=type]', 'Pistol');
  await page.fill('[name=caliber]', '9mm');
  await page.fill('[name=sourceName]', 'Distributor LLC');
  await page.fill('[name=sourceAddress]', '1 Main St');
  await page.click('#acquire-form button[type=submit]');
  await page.waitForTimeout(150);

  await page.click('nav button[data-view=dispose]');
  const hg3 = (await page.locator('#dispose-select option').allTextContents())
    .findIndex((o) => o.includes('HG-3'));
  await page.selectOption('#dispose-select', { index: hg3 });
  await page.selectOption('#dispose-type', 'sale_4473');
  await page.waitForTimeout(100);
  await page.fill('#disp-date', '2026-09-11');
  await page.fill('[name=buyerName]', 'Jane A Buyer');      // middle initial added
  await page.fill('[name=buyerAddress]', '9 Elm Street');    // "St" spelled out
  await page.fill('#disp-formSerial', 'F-HG3');
  await page.fill('#disp-eligibilityNote', '4473 + NICS proceed');
  await page.click('#dispose-form button[type=submit]');
  await page.waitForTimeout(200);

  await page.click('nav button[data-view=inventory]');
  await page.waitForTimeout(200);
  const merged = await page.locator('#inventory-alarms').innerText();
  if (!/3 handguns to Jane/.test(merged)) {
    problems.push('alarm did not merge the differently-spelled buyer: ' + merged);
  }
  if (!/different spellings/.test(merged)) {
    problems.push('alarm did not say the spellings differed: ' + merged);
  }
  step('a buyer spelled three ways is caught as one person by the alarm');

  // --- customers screen -----------------------------------------------------
  await page.click('nav button[data-view=customers]');
  await page.waitForTimeout(200);
  const custTiles = await page.locator('#customers-summary .tile-value').allInnerTexts();
  if (!custTiles.length) problems.push('customers summary did not render');
  const custText = await page.locator('#customers-table').innerText();
  if (!/Jane/.test(custText)) problems.push('Jane is not in the customer list: ' + custText);
  if (!/Distributor LLC/.test(custText)) problems.push('the distributor is not a customer');
  if (!/spellings on the record/.test(custText)) {
    problems.push('the customer list does not flag the multiple spellings');
  }
  step('customers screen lists both directions and flags multiple spellings');

  // Jane must be ONE row, not three.
  const janeRows = await page.locator('#customers-table tbody tr', { hasText: 'Jane' }).count();
  if (janeRows !== 1) problems.push('Jane appears as ' + janeRows + ' customers, expected 1');
  step('three spellings collapse to a single customer row');

  await page.locator('[data-customer]').first().click();
  await page.waitForTimeout(150);
  const detail = await page.locator('#customer-detail').innerText();
  if (!/Transferred to them|Acquired from them/.test(detail)) {
    problems.push('customer history did not render: ' + detail);
  }
  step('customer history opens with per-firearm transactions');

  await page.fill('#customers-search', 'nobody-by-this-name');
  await page.waitForTimeout(150);
  if (!/matches that/.test(await page.locator('#customers-table').innerText())) {
    problems.push('customer search did not filter');
  }
  await page.fill('#customers-search', '');
  await page.waitForTimeout(150);
  step('customer search filters and clears');

  // --- autofill -------------------------------------------------------------
  await page.click('nav button[data-view=dispose]');
  await page.waitForTimeout(200);
  const knownOptions = await page.locator('#dispose-known option').allTextContents();
  const janeOption = knownOptions.findIndex((o) => o.includes('Jane'));
  if (janeOption < 1) {
    problems.push('known-customer picker has no Jane: ' + JSON.stringify(knownOptions));
  } else {
    await page.selectOption('#dispose-known', { index: janeOption });
    await page.waitForTimeout(150);
    const filledName = await page.inputValue('[name=buyerName]');
    const filledAddr = await page.inputValue('[name=buyerAddress]');
    if (!/Jane/.test(filledName) || !/Elm/.test(filledAddr)) {
      problems.push('autofill did not populate: ' + filledName + ' / ' + filledAddr);
    }
    const note = await page.locator('#dispose-known-note').innerText();
    if (!/handgun/.test(note)) {
      problems.push('autofill did not warn about prior handgun transfers: ' + note);
    }
  }
  step('autofill fills a known customer and surfaces their handgun history');

  // --- plain backup round-trip through restore -----------------------------
  await page.click('nav button[data-view=integrity]');
  await page.waitForTimeout(150);
  const eventsBefore = await page.locator('#integrity-log tbody tr').count();
  const backup = await page.evaluate(() => {
    const log = JSON.parse(localStorage.getItem('boundbook.log.v1'));
    return JSON.stringify({ app: 'bound-book', version: 1, exportedAt: new Date().toISOString(), log });
  });
  const tmp = nodePath.join(os.tmpdir(), 'bound-book-smoke-backup.json');
  fs.writeFileSync(tmp, backup);
  await page.setInputFiles('#restore-input', tmp);
  await page.waitForTimeout(300);
  const restoreMsg = await page.locator('#restore-msg').innerText();
  if (!/identical/i.test(restoreMsg)) problems.push('identical backup not detected: ' + restoreMsg);
  step('restoring an identical backup is recognised, not blindly applied');

  // An older backup must warn about what would be lost.
  const older = JSON.parse(backup);
  older.log = older.log.slice(0, older.log.length - 2);
  fs.writeFileSync(tmp, JSON.stringify(older));
  let dialogText = '';
  page.once('dialog', (d) => { dialogText = d.message(); d.dismiss(); });
  await page.setInputFiles('#restore-input', tmp);
  await page.waitForTimeout(300);
  if (!/OLDER than the record/.test(dialogText)) {
    problems.push('older backup did not warn about data loss: ' + dialogText);
  }
  const eventsAfter = await page.locator('#integrity-log tbody tr').count();
  if (eventsAfter !== eventsBefore) problems.push('declined restore still changed the record');
  step('older backup warned about dropping events and was declined safely');

  // --- encrypted backup round-trip -----------------------------------------
  const encrypted = await page.evaluate(async () => {
    const log = JSON.parse(localStorage.getItem('boundbook.log.v1'));
    return await window.SecureBackup.encryptBackup(
      window.Integrity.makeBackup(log, new Date().toISOString()), 'a long enough passphrase', new Date().toISOString());
  });
  if (/SN-0001/.test(encrypted)) problems.push('encrypted backup leaked a serial number');
  fs.writeFileSync(tmp, encrypted);
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#restore-input', tmp);
  await page.waitForTimeout(300);
  await page.fill('#pass-form [name=passphrase]', 'a long enough passphrase');
  await page.click('#pass-ok');
  await page.waitForTimeout(600);
  const encMsg = await page.locator('#restore-msg').innerText();
  if (!/identical/i.test(encMsg)) problems.push('encrypted restore failed: ' + encMsg);
  step('encrypted backup decrypts in the browser and verifies');

  await browser.close();

  assert.deepEqual(problems, [], 'browser smoke test found problems');
  assert.ok(steps.length >= 22, 'expected every flow to be exercised, got ' + steps.length);
});
