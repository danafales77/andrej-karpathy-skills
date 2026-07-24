// app.js — DOM wiring + localStorage persistence. Pure logic lives in core.js.
(function () {
  'use strict';
  var BB = window.BoundBook;
  var STORE_KEY = 'boundbook.entries.v1';
  var PROFILE_KEY = 'boundbook.profile.v1';
  var DISCLAIMER_KEY = 'boundbook.disclaimer.v1';

  // --- persistence ---
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function save(entries) { localStorage.setItem(STORE_KEY, JSON.stringify(entries)); }
  function loadProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveProfile(p) { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }

  var entries = load();

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'e' + Date.now() + Math.floor(Math.random() * 1e6);
  }
  function nowIso() { return new Date().toISOString(); }
  function formData(form) {
    var o = {};
    new FormData(form).forEach(function (v, k) { o[k] = String(v).trim(); });
    return o;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function showErrors(el, errors) {
    el.innerHTML = errors.length
      ? '<ul>' + errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>'
      : '';
  }

  // --- navigation ---
  function show(view) {
    document.querySelectorAll('.view').forEach(function (s) { s.classList.add('hidden'); });
    document.getElementById('view-' + view).classList.remove('hidden');
    document.querySelectorAll('nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    if (view === 'dispose') renderDisposeOptions();
    if (view === 'ledger') renderLedger();
    if (view === 'export') renderPrintLedger();
  }
  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () { show(b.dataset.view); });
  });

  // --- acquire ---
  document.getElementById('acquire-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var data = formData(this);
    var res = BB.validateAcquisition(data);
    showErrors(document.getElementById('acquire-errors'), res.errors);
    if (!res.ok) return;
    entries.push(BB.newEntry(data, newId(), nowIso()));
    save(entries);
    this.reset();
    showErrors(document.getElementById('acquire-errors'), []);
    show('ledger');
  });

  // --- dispose ---
  function openEntries() { return entries.filter(function (e) { return e.status === 'open'; }); }

  function renderDisposeOptions() {
    var sel = document.getElementById('dispose-select');
    var open = openEntries();
    if (!open.length) {
      sel.innerHTML = '<option value="">No open firearms</option>';
      return;
    }
    sel.innerHTML = open.map(function (e) {
      var label = BB.currentValue(e, 'acquisition.mfrImporter') + ' ' +
        BB.currentValue(e, 'acquisition.model') + ' — SN ' +
        BB.currentValue(e, 'acquisition.serial');
      return '<option value="' + esc(e.id) + '">' + esc(label) + '</option>';
    }).join('');
  }

  document.getElementById('dispose-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var id = document.getElementById('dispose-select').value;
    var errEl = document.getElementById('dispose-errors');
    if (!id) { showErrors(errEl, ['Select an open firearm first.']); return; }
    var data = formData(this);
    var res = BB.validateDisposition(data);
    showErrors(errEl, res.errors);
    if (!res.ok) return;
    var idx = entries.findIndex(function (e) { return e.id === id; });
    entries[idx] = BB.applyDisposition(entries[idx], data);
    save(entries);
    this.reset();
    show('ledger');
  });

  // --- ledger ---
  var LEDGER_COLS = [
    ['Received', 'acquisition.dateReceived'],
    ['Mfr/Importer', 'acquisition.mfrImporter'],
    ['Model', 'acquisition.model'],
    ['Serial', 'acquisition.serial'],
    ['Type', 'acquisition.type'],
    ['Caliber', 'acquisition.caliber']
  ];

  function fieldCell(e, path) {
    // Show current value; if corrected, show the original struck out beneath.
    var corr = null;
    e.corrections.forEach(function (c) { if (c.field === path) corr = c; });
    var cur = esc(BB.currentValue(e, path));
    if (!corr) return cur;
    var orig = esc(corr.oldValue);
    return cur + '<span class="corr">was <span class="struck">' + orig + '</span> — ' + esc(corr.reason) + '</span>';
  }

  function matches(e, q) {
    if (!q) return true;
    q = q.toLowerCase();
    var hay = [
      BB.currentValue(e, 'acquisition.serial'),
      BB.currentValue(e, 'acquisition.model'),
      BB.currentValue(e, 'acquisition.mfrImporter'),
      BB.party(e, 'source'),
      e.disposition ? BB.party(e, 'buyer') : ''
    ].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function renderLedger() {
    var q = document.getElementById('ledger-search').value.trim();
    var rows = entries.filter(function (e) { return matches(e, q); });
    var el = document.getElementById('ledger-table');
    if (!rows.length) {
      el.innerHTML = '<p class="empty">No entries yet. Start with an acquisition.</p>';
      return;
    }
    var head = '<tr>' + LEDGER_COLS.map(function (c) { return '<th>' + c[0] + '</th>'; }).join('') +
      '<th>Source</th><th>Status</th><th>Disposition</th></tr>';
    var body = rows.map(function (e) {
      var cells = LEDGER_COLS.map(function (c) { return '<td>' + fieldCell(e, c[1]) + '</td>'; }).join('');
      var source = '<td>' + esc(BB.party(e, 'source')) + '</td>';
      var status = '<td class="status-' + e.status + '">' + e.status + '</td>';
      var disp = '<td>';
      if (e.disposition) {
        disp += esc(BB.currentValue(e, 'disposition.date')) + '<br>' +
          esc(BB.party(e, 'buyer')) + '<br>' +
          '4473: ' + esc(BB.currentValue(e, 'disposition.formSerial'));
      } else {
        disp += '—';
      }
      disp += '</td>';
      var action = '<td class="no-print"><button type="button" class="link-btn" data-correct="' + esc(e.id) + '">Correct</button></td>';
      return '<tr>' + cells + source + status + disp + action + '</tr>';
    }).join('');
    el.innerHTML = '<table><thead>' + head + '<th class="no-print"></th></thead><tbody>' + body + '</tbody></table>';
    el.querySelectorAll('[data-correct]').forEach(function (b) {
      b.addEventListener('click', function () { openCorrection(b.dataset.correct); });
    });
  }
  document.getElementById('ledger-search').addEventListener('input', renderLedger);

  // --- corrections (append-only) ---
  var correctingId = null;
  function correctableFields(entry) {
    var fields = BB.ACQ_FIELDS.map(function (f) {
      return { path: 'acquisition.' + f.key, label: f.label };
    });
    if (entry.disposition) {
      BB.DISP_FIELDS.forEach(function (f) {
        fields.push({ path: 'disposition.' + f.key, label: 'Disposition — ' + f.label });
      });
    }
    return fields;
  }
  function openCorrection(id) {
    correctingId = id;
    var entry = entries.find(function (e) { return e.id === id; });
    var sel = document.getElementById('correct-field');
    sel.innerHTML = correctableFields(entry).map(function (f) {
      return '<option value="' + esc(f.path) + '">' + esc(f.label) + ' (now: ' +
        esc(BB.currentValue(entry, f.path)) + ')</option>';
    }).join('');
    showErrors(document.getElementById('correct-errors'), []);
    document.getElementById('correct-form').reset();
    document.getElementById('correct-target').textContent =
      'SN ' + BB.currentValue(entry, 'acquisition.serial') + ' — the original stays on record, struck through.';
    document.getElementById('correct-modal').classList.remove('hidden');
  }
  document.getElementById('correct-cancel').addEventListener('click', function () {
    document.getElementById('correct-modal').classList.add('hidden');
  });
  document.getElementById('correct-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var data = formData(this);
    if (!data.newValue || !data.reason) {
      showErrors(document.getElementById('correct-errors'), ['Corrected value and reason are both required.']);
      return;
    }
    var idx = entries.findIndex(function (e) { return e.id === correctingId; });
    entries[idx] = BB.addCorrection(entries[idx], data.field, data.newValue, data.reason, nowIso());
    save(entries);
    document.getElementById('correct-modal').classList.add('hidden');
    renderLedger();
  });

  // --- export ---
  function renderPrintLedger() {
    var p = loadProfile();
    var header = '<div class="ledger-header"><h2>Acquisition &amp; Disposition Record</h2>' +
      '<div class="meta">' + esc(p.name || '') +
      (p.ffl ? ' · FFL# ' + esc(p.ffl) : '') +
      (p.address ? ' · ' + esc(p.address) : '') + '</div></div>';
    var el = document.getElementById('print-ledger');
    if (!entries.length) { el.innerHTML = header + '<p class="empty">No entries yet.</p>'; return; }
    var head = '<tr><th>Received</th><th>Mfr/Importer</th><th>Model</th><th>Serial</th>' +
      '<th>Type</th><th>Caliber</th><th>Source</th><th>Disp. date</th><th>Buyer</th><th>4473</th></tr>';
    var body = entries.map(function (e) {
      return '<tr>' +
        td(BB.currentValue(e, 'acquisition.dateReceived')) +
        td(BB.currentValue(e, 'acquisition.mfrImporter')) +
        td(BB.currentValue(e, 'acquisition.model')) +
        td(BB.currentValue(e, 'acquisition.serial')) +
        td(BB.currentValue(e, 'acquisition.type')) +
        td(BB.currentValue(e, 'acquisition.caliber')) +
        td(BB.party(e, 'source')) +
        td(e.disposition ? BB.currentValue(e, 'disposition.date') : '') +
        td(e.disposition ? BB.party(e, 'buyer') : '') +
        td(e.disposition ? BB.currentValue(e, 'disposition.formSerial') : '') +
        '</tr>';
    }).join('');
    el.innerHTML = header + '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }
  function td(v) { return '<td>' + esc(v) + '</td>'; }

  document.getElementById('btn-print').addEventListener('click', function () { window.print(); });
  document.getElementById('btn-csv').addEventListener('click', function () {
    var blob = new Blob([BB.toCSV(entries)], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'bound-book-backup.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- profile ---
  (function initProfile() {
    var form = document.getElementById('profile-form');
    var p = loadProfile();
    ['name', 'ffl', 'address'].forEach(function (k) { if (form[k]) form[k].value = p[k] || ''; });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveProfile(formData(this));
      document.getElementById('profile-saved').textContent = 'Saved.';
      setTimeout(function () { document.getElementById('profile-saved').textContent = ''; }, 1500);
    });
  })();

  // --- disclaimer ---
  (function initDisclaimer() {
    if (localStorage.getItem(DISCLAIMER_KEY)) return;
    var modal = document.getElementById('disclaimer');
    modal.classList.remove('hidden');
    var ack = document.getElementById('disclaimer-ack');
    var ok = document.getElementById('disclaimer-ok');
    ack.addEventListener('change', function () { ok.disabled = !ack.checked; });
    ok.addEventListener('click', function () {
      localStorage.setItem(DISCLAIMER_KEY, '1');
      modal.classList.add('hidden');
    });
  })();

  show('acquire');
})();
