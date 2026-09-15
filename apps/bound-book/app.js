// app.js — DOM wiring + localStorage persistence. Pure logic lives in core.js,
// inventory.js, packages.js, integrity.js and securebackup.js.
(function () {
  'use strict';
  var BB = window.BoundBook;
  var INT = window.Integrity;
  var PK = window.Packages;
  var INV = window.Inventory;
  var SB = window.SecureBackup;
  var CUST = window.Customers;
  var LOG_KEY = 'boundbook.log.v1';
  var PROFILE_KEY = 'boundbook.profile.v1';
  var DISCLAIMER_KEY = 'boundbook.disclaimer.v1';
  var BACKUP_KEY = 'boundbook.lastbackup.v1';
  var PACKAGES_KEY = 'boundbook.packages.v1';
  var COUNT_KEY = 'boundbook.count.v1';

  // --- persistence -----------------------------------------------------------
  // Every write goes through persist(). A browser can refuse a write (quota,
  // private mode, blocked site data) and the old code would have carried on with
  // an in-memory record that no longer matched the disk. Now a failed write is
  // loud, and the caller does not adopt the change.

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) || fallback);
    } catch (e) {
      return fallback;
    }
  }

  function persist(key, text) {
    try {
      localStorage.setItem(key, text);
      // Read it back: a write that silently did nothing is the failure mode that
      // loses records quietly.
      if (localStorage.getItem(key) !== text) throw new Error('the browser did not keep the value');
      return true;
    } catch (e) {
      raiseStorageAlarm(e);
      return false;
    }
  }

  function raiseStorageAlarm(err) {
    var el = document.getElementById('storage-alarm');
    el.innerHTML = '<strong>&#10007; This device would not save the record.</strong> ' +
      esc(err && err.message ? err.message : String(err)) +
      '. Nothing you have entered since this appeared has been written to disk. ' +
      'Use <em>Integrity &rarr; Download full backup</em> now — the copy in this ' +
      'window is still complete — then restore it somewhere that can save.' +
      ' <button type="button" class="link-btn" id="storage-alarm-backup">Download backup now</button>';
    el.classList.remove('hidden');
    var btn = document.getElementById('storage-alarm-backup');
    if (btn) btn.addEventListener('click', downloadPlainBackup);
  }

  var log = readJson(LOG_KEY, []);
  var entries = INT.project(log);
  var packages = readJson(PACKAGES_KEY, []);
  var lastBackup = readJson(BACKUP_KEY, null);
  var countSession = readJson(COUNT_KEY, null);

  function loadProfile() { return readJson(PROFILE_KEY, {}); }
  function saveProfile(p) { return persist(PROFILE_KEY, JSON.stringify(p)); }
  function savePackages() { return persist(PACKAGES_KEY, JSON.stringify(packages)); }
  function saveLastBackup(marker) {
    lastBackup = marker;
    return persist(BACKUP_KEY, JSON.stringify(marker));
  }
  function saveCountSession() {
    if (countSession === null) {
      try { localStorage.removeItem(COUNT_KEY); } catch (e) { /* removing can't lose a record */ }
      return true;
    }
    return persist(COUNT_KEY, JSON.stringify(countSession));
  }

  // Record an action as a new chained event. The in-memory log only advances if
  // the write succeeded, so what is on screen is always what is on disk.
  // Returns true when the event was recorded.
  function commit(type, payload) {
    var next = INT.appendEvent(log, type, payload, nowIso());
    if (!persist(LOG_KEY, JSON.stringify(next))) return false;
    log = next;
    entries = INT.project(log);
    return true;
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'e' + Date.now() + Math.floor(Math.random() * 1e6);
  }
  function nowIso() { return new Date().toISOString(); }
  // Carrier scan times may arrive without fractional seconds, so the trailing
  // Z has to go too; for a toISOString() value the first replace already ate it.
  function shortDate(iso) { return String(iso || '').replace('T', ' ').replace(/\..*/, '').replace(/Z$/, ''); }
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
  function plural(n) { return n === 1 ? '' : 's'; }
  function alertLine(cls, text) { return '<div class="' + cls + '">' + text + '</div>'; }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- navigation ---
  function show(view) {
    document.querySelectorAll('.view').forEach(function (s) { s.classList.add('hidden'); });
    document.getElementById('view-' + view).classList.remove('hidden');
    document.querySelectorAll('nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    if (view === 'dispose') renderDisposeOptions();
    if (view === 'inventory') renderInventory();
    if (view === 'customers') renderCustomers();
    if (view === 'acquire') renderKnownParties('acquire');
    if (view === 'packages') renderPackages();
    if (view === 'ledger') renderLedger();
    if (view === 'export') renderPrintLedger();
    if (view === 'integrity') renderIntegrity();
  }
  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () { show(b.dataset.view); });
  });

  // --- field suggestions (free text stays free; this only steadies spelling) ---
  (function initSuggestions() {
    function fill(id, values) {
      document.getElementById(id).innerHTML = values.map(function (v) {
        return '<option value="' + esc(v) + '"></option>';
      }).join('');
    }
    fill('mfr-options', BB.MFR_SUGGESTIONS);
    fill('type-options', BB.TYPE_SUGGESTIONS);
    fill('caliber-options', BB.CALIBER_SUGGESTIONS);
  })();

  // --- acquire ---------------------------------------------------------------

  // Serials pasted for a bulk add: one per line or comma separated, de-duped.
  function parseBulkSerials(text) {
    var seen = {};
    return String(text || '').split(/[\n,;]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) {
        if (!s) return false;
        var k = BB.normalizeSerial(s);
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
  }

  function submitAcquisition(keepForm) {
    var form = document.getElementById('acquire-form');
    var errEl = document.getElementById('acquire-errors');
    var warnEl = document.getElementById('acquire-warnings');
    var data = formData(form);
    var serials = [data.serial].concat(parseBulkSerials(data.bulkSerials));
    delete data.bulkSerials;

    // Validate every serial before writing any of them: a half-committed
    // shipment is worse than a rejected one.
    var errors = [];
    var warnings = [];
    var known = entries.slice();
    serials.forEach(function (serial, i) {
      var candidate = Object.assign({}, data, { serial: serial });
      var res = BB.validateAcquisition(candidate, { now: nowIso() });
      res.errors.forEach(function (msg) {
        errors.push(serials.length > 1 ? 'Serial ' + serial + ': ' + msg : msg);
      });
      if (serials.length > 1 && serials.indexOf(serial) !== i) {
        errors.push('Serial ' + serial + ' is listed twice.');
      }
      BB.acquisitionWarnings(candidate, known).forEach(function (w) { warnings.push(w); });
    });

    showErrors(errEl, errors);
    warnEl.innerHTML = warnings.length
      ? '<strong>Check before saving:</strong><ul>' +
        warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>'
      : '';
    warnEl.classList.toggle('hidden', !warnings.length);
    if (errors.length) return;
    if (warnings.length && !window.confirm(warnings.join('\n\n') + '\n\nRecord ' +
      (serials.length > 1 ? 'these acquisitions' : 'this acquisition') + ' anyway?')) return;

    var recorded = 0;
    for (var i = 0; i < serials.length; i++) {
      var payload = Object.assign({}, data, { serial: serials[i], entryId: newId() });
      if (!commit('acquire', payload)) break;
      // Only the first entry can be the package that was delivered.
      if (recorded === 0 && pendingPackageId) linkPackage(pendingPackageId, payload.entryId);
      recorded++;
    }
    if (!recorded) return;

    clearPendingPackage();
    showErrors(errEl, []);
    warnEl.innerHTML = '';
    warnEl.classList.add('hidden');

    if (keepForm) {
      // Keep the shipment's details, clear what changes per firearm.
      form.serial.value = '';
      form.bulkSerials.value = '';
      form.serial.focus();
      errEl.innerHTML = '<div class="chain-ok">&#10003; Recorded ' + recorded +
        ' entr' + (recorded === 1 ? 'y' : 'ies') + '. The rest of the form is still filled in.</div>';
      return;
    }
    form.reset();
    show('ledger');
  }

  document.getElementById('acquire-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    submitAcquisition(false);
  });
  document.getElementById('btn-acquire-again').addEventListener('click', function () {
    var form = document.getElementById('acquire-form');
    if (!form.reportValidity()) return;
    submitAcquisition(true);
  });

  // --- dispose ---------------------------------------------------------------

  function openEntries() { return entries.filter(function (e) { return e.status === 'open'; }); }

  function entryLabel(e) {
    return BB.currentValue(e, 'acquisition.mfrImporter') + ' ' +
      BB.currentValue(e, 'acquisition.model') + ' — SN ' +
      BB.currentValue(e, 'acquisition.serial');
  }

  function renderDisposeOptions() {
    var sel = document.getElementById('dispose-select');
    var open = openEntries();
    sel.innerHTML = open.length
      ? open.map(function (e) {
          return '<option value="' + esc(e.id) + '">' + esc(entryLabel(e)) + '</option>';
        }).join('')
      : '<option value="">No open firearms</option>';

    renderKnownParties('dispose');
    var types = document.getElementById('dispose-type');
    if (!types.options.length) {
      types.innerHTML = BB.DISP_TYPES.map(function (t) {
        return '<option value="' + esc(t.key) + '">' + esc(t.label) + '</option>';
      }).join('');
    }
    renderDisposeFields();
  }

  function disposeInput(f) {
    var id = 'disp-' + f.key;
    var label = esc(f.label) + (f.required ? '' : ' <span class="opt">optional</span>');
    var control;
    if (f.key === 'date' || f.key === 'nicsDate') {
      control = '<input type="date" name="' + esc(f.key) + '" id="' + id + '"' + (f.required ? ' required' : '') + ' />';
    } else if (f.key === 'note' || f.key === 'eligibilityNote') {
      control = '<textarea name="' + esc(f.key) + '" id="' + id + '" rows="2"' +
        (f.required ? ' required' : '') + ' placeholder="' +
        (f.key === 'eligibilityNote' ? 'e.g. 4473 + NICS proceed on file, binder A' : '') + '"></textarea>';
    } else {
      control = '<input name="' + esc(f.key) + '" id="' + id + '"' + (f.required ? ' required' : '') + ' />';
    }
    return '<label class="span2">' + label + control + '</label>';
  }

  function renderDisposeFields() {
    var typeKey = document.getElementById('dispose-type').value || BB.DEFAULT_DISP_TYPE;
    var t = BB.dispType(typeKey);
    document.getElementById('dispose-type-hint').textContent = t.hint;
    document.getElementById('dispose-party').classList.toggle('hidden', t.party !== 'required');
    document.getElementById('dispose-fields').innerHTML =
      BB.dispositionFields(typeKey).map(disposeInput).join('');
  }
  document.getElementById('dispose-type').addEventListener('change', renderDisposeFields);

  document.getElementById('dispose-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var id = document.getElementById('dispose-select').value;
    var errEl = document.getElementById('dispose-errors');
    if (!id) { showErrors(errEl, ['Select an open firearm first.']); return; }
    var entry = entries.filter(function (e) { return e.id === id; })[0];
    var data = formData(this);
    data.dispositionType = document.getElementById('dispose-type').value || BB.DEFAULT_DISP_TYPE;
    var res = BB.validateDisposition(data, entry, { now: nowIso() });
    showErrors(errEl, res.errors);
    if (!res.ok) return;
    data.entryId = id;
    if (!commit('dispose', data)) return;
    this.reset();
    renderDisposeFields();
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

  // Show current value; every correction is shown beneath it, original struck
  // through, so the line-out is visible wherever the field is.
  function fieldCell(e, path) {
    var cur = esc(BB.currentValue(e, path));
    return cur + BB.correctionsFor(e, path).map(function (c) {
      return '<span class="corr">was <span class="struck">' + esc(c.oldValue) + '</span> — ' +
        esc(c.reason) + (c.at ? ' (' + esc(String(c.at).slice(0, 10)) + ')' : '') + '</span>';
    }).join('');
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
    if (hay.indexOf(q) !== -1) return true;
    var qs = BB.normalizeSerial(q);
    return qs.length > 0 &&
      BB.normalizeSerial(BB.currentValue(e, 'acquisition.serial')).indexOf(qs) !== -1;
  }

  function dispositionCell(e) {
    if (!e.disposition) return '—';
    var t = BB.dispType(e.disposition.dispositionType);
    var out = '<span class="disp-type">' + esc(t.label) + '</span><br>' +
      fieldCell(e, 'disposition.date') + '<br>' + esc(BB.party(e, 'buyer'));
    var ref = BB.currentValue(e, 'disposition.formSerial');
    if (ref) out += '<br>4473: ' + esc(ref);
    var report = BB.currentValue(e, 'disposition.reportRef');
    if (report) out += '<br>Report: ' + esc(report);
    return out;
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
      '<th>Source</th><th>Status</th><th>Disposition</th>';
    var body = rows.map(function (e) {
      var cells = LEDGER_COLS.map(function (c) { return '<td>' + fieldCell(e, c[1]) + '</td>'; }).join('');
      var source = '<td>' + esc(BB.party(e, 'source')) + '</td>';
      var status = '<td class="status-' + e.status + '">' + e.status + '</td>';
      var disp = '<td>' + dispositionCell(e) + '</td>';
      var action = '<td class="no-print"><button type="button" class="link-btn" data-correct="' + esc(e.id) + '">Correct</button></td>';
      return '<tr>' + cells + source + status + disp + action + '</tr>';
    }).join('');
    el.innerHTML = '<table><thead>' + head + '<th class="no-print"></th></tr></thead><tbody>' + body + '</tbody></table>';
    el.querySelectorAll('[data-correct]').forEach(function (b) {
      b.addEventListener('click', function () { openCorrection(b.dataset.correct); });
    });
  }
  document.getElementById('ledger-search').addEventListener('input', renderLedger);

  // --- corrections (append-only) ---
  var correctingId = null;
  function correctableFields(entry) {
    var paths = BB.ACQ_FIELDS.concat(BB.ACQ_OPTIONAL_FIELDS).map(function (f) {
      return 'acquisition.' + f.key;
    }).concat(['acquisition.sourceName', 'acquisition.sourceAddress', 'acquisition.sourceFfl']);

    if (entry.disposition) {
      var typeKey = entry.disposition.dispositionType;
      if (BB.dispType(typeKey).party === 'required') {
        paths = paths.concat(['disposition.buyerName', 'disposition.buyerAddress', 'disposition.buyerFfl']);
      }
      paths = paths.concat(BB.dispositionFields(typeKey).map(function (f) {
        return 'disposition.' + f.key;
      }));
    }
    return paths.map(function (p) { return { path: p, label: BB.fieldLabel(p) }; });
  }

  function openCorrection(id) {
    correctingId = id;
    var entry = entries.find(function (e) { return e.id === id; });
    var sel = document.getElementById('correct-field');
    sel.innerHTML = correctableFields(entry).map(function (f) {
      var now = BB.currentValue(entry, f.path);
      return '<option value="' + esc(f.path) + '">' + esc(f.label) + ' (now: ' +
        esc(now === undefined || now === '' ? '—' : now) + ')</option>';
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
    if (!commit('correct', { entryId: correctingId, field: data.field, newValue: data.newValue, reason: data.reason })) return;
    document.getElementById('correct-modal').classList.add('hidden');
    renderLedger();
  });

  // --- inventory on hand -----------------------------------------------------

  function renderInventory() {
    var now = nowIso();
    var profile = loadProfile();
    var s = INV.summary(entries, now);

    document.getElementById('inventory-summary').innerHTML = [
      tile(s.count, 'on hand'),
      tile(s.handguns, 'handgun' + plural(s.handguns)),
      tile(s.oldestDays === null ? '—' : s.oldestDays, 'days, longest held'),
      tile(s.medianDays === null ? '—' : s.medianDays, 'days, typical')
    ].join('') +
      '<div class="tile-note">' +
        s.byType.map(function (t) { return esc(t.label) + ': ' + t.count; }).join(' · ') +
      '</div>';

    renderAlarms(INV.alarms(entries, now, profile));
    renderInventoryTable();
    renderCountPanel();
    renderCountHistory();
  }

  function tile(value, label) {
    return '<div class="tile"><span class="tile-value">' + esc(value) + '</span>' +
      '<span class="tile-label">' + esc(label) + '</span></div>';
  }

  function renderAlarms(a) {
    var out = [];

    a.multipleHandgun.forEach(function (g) {
      out.push(alertLine('chain-bad', '&#10007; <strong>' + g.count + ' handguns to ' + esc(g.buyer) +
        '</strong> between ' + esc(g.firstDate) + ' and ' + esc(g.lastDate) + ' (' +
        esc(g.entries.map(function (e) { return BB.currentValue(e, 'acquisition.serial'); }).join(', ')) +
        '). Multiple handgun sales to one non-licensee inside a short window require a ' +
        'separate report to ATF — check whether this one does.' +
        (g.spellingsMerged
          ? ' <em>These were written under different spellings — ' +
            esc(g.spellings.join(' / ')) + ' — so the record does not obviously show them ' +
            'as one buyer.</em>'
          : '')));
    });

    if (a.lateEntries.length) {
      var worst = a.lateEntries.slice(0, 3).map(function (h) {
        return esc(BB.currentValue(h.entry, 'acquisition.serial')) + ' (' + h.kind + ', ' +
          h.lagBusinessDays + ' business days)';
      }).join(', ');
      out.push(alertLine('backup-warn', '&#9888; ' + a.lateEntries.length + ' entr' +
        (a.lateEntries.length === 1 ? 'y' : 'ies') + ' reached the book later than your policy ' +
        'allows: ' + worst + (a.lateEntries.length > 3 ? ', …' : '') +
        '. You cannot change when they were written, but you can find this before an inspector does.'));
    }

    if (a.longOpen.length) {
      out.push(alertLine('backup-warn', '&#9888; ' + a.longOpen.length + ' firearm' +
        plural(a.longOpen.length) + ' open longer than ' + a.settings.openAgeAlertDays +
        ' days — the oldest for ' + a.longOpen[0].days + '. Usually a consignment that went ' +
        'quiet or a transfer nobody wrote down.'));
    }

    if (!out.length) {
      out.push(alertLine('chain-ok', entries.length
        ? '&#10003; Nothing flagged against your current thresholds.'
        : '&#10003; No entries yet.'));
    }
    out.push('<p class="hint">Thresholds are yours to set in <em>Licensee &rarr; Alarm ' +
      'thresholds</em>. They approximate rules with conditions this app does not model, so ' +
      'confirm the real ones for your situation.</p>');
    document.getElementById('inventory-alarms').innerHTML = out.join('');
  }

  function renderInventoryTable() {
    var q = document.getElementById('inventory-search').value.trim();
    var now = nowIso();
    var rows = INV.filterOnHand(entries, q);
    var ageById = {};
    INV.aged(entries, now).forEach(function (r) { ageById[r.entry.id] = r.days; });

    var el = document.getElementById('inventory-table');
    if (!rows.length) {
      el.innerHTML = '<p class="empty">' + (q ? 'Nothing on hand matches that.' : 'Nothing on hand.') + '</p>';
      return;
    }
    rows = rows.slice().sort(function (a, b) { return (ageById[b.id] || 0) - (ageById[a.id] || 0); });
    var body = rows.map(function (e) {
      var days = ageById[e.id];
      return '<tr>' +
        '<td>' + esc(BB.currentValue(e, 'acquisition.serial')) + '</td>' +
        '<td>' + esc(BB.currentValue(e, 'acquisition.mfrImporter')) + ' ' +
                 esc(BB.currentValue(e, 'acquisition.model')) + '</td>' +
        '<td>' + esc(BB.currentValue(e, 'acquisition.type')) + '</td>' +
        '<td>' + esc(BB.currentValue(e, 'acquisition.caliber')) + '</td>' +
        '<td>' + esc(BB.currentValue(e, 'acquisition.dateReceived')) + '</td>' +
        '<td>' + (days === null || days === undefined ? '—' : days) + '</td>' +
        '<td>' + esc(BB.party(e, 'source')) + '</td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr><th>Serial</th><th>Firearm</th><th>Type</th>' +
      '<th>Caliber</th><th>Received</th><th>Days held</th><th>Source</th></tr></thead><tbody>' +
      body + '</tbody></table>';
  }
  document.getElementById('inventory-search').addEventListener('input', renderInventoryTable);

  // --- physical inventory ----------------------------------------------------

  function renderCountPanel() {
    var el = document.getElementById('count-panel');
    if (!countSession) {
      var n = INV.onHand(entries).length;
      el.innerHTML = '<p class="hint">' + n + ' firearm' + plural(n) + ' to account for.</p>' +
        '<div class="actions no-print"><button type="button" id="btn-count-start"' +
        (n ? '' : ' disabled') + '>Start a count</button></div>';
      var start = document.getElementById('btn-count-start');
      if (start) start.addEventListener('click', startCount);
      return;
    }

    var st = INV.countStatus(countSession);
    var found = {};
    countSession.foundIds.forEach(function (id) { found[id] = true; });

    var rows = countSession.expected.map(function (x) {
      return '<tr class="' + (found[x.entryId] ? 'row-found' : '') + '">' +
        '<td class="no-print"><input type="checkbox" data-found="' + esc(x.entryId) + '"' +
          (found[x.entryId] ? ' checked' : '') + ' /></td>' +
        '<td>' + esc(x.serial) + '</td>' +
        '<td>' + esc(x.mfrImporter) + ' ' + esc(x.model) + '</td>' +
        '<td>' + esc(x.type) + '</td>' +
        '<td>' + (found[x.entryId] ? 'found' : '<strong>not found</strong>') + '</td>' +
        '</tr>';
    }).join('');

    var unexpected = countSession.unexpected.map(function (u, i) {
      return '<li>' + esc(u.serial) + (u.note ? ' — ' + esc(u.note) : '') +
        ' <button type="button" class="link-btn no-print" data-drop-unexpected="' + i + '">remove</button></li>';
    }).join('');

    el.innerHTML =
      '<div class="count-head">' +
        '<strong>' + st.found + ' of ' + st.expected + ' found</strong>' +
        (st.missing.length ? ' · <span class="bad">' + st.missing.length + ' not found</span>' : '') +
        (st.unexpected.length ? ' · <span class="bad">' + st.unexpected.length + ' not in the book</span>' : '') +
        ' · started ' + esc(shortDate(countSession.startedAt)) +
      '</div>' +
      '<div class="count-scan no-print">' +
        '<label>Scan or type a serial<input id="count-scan" placeholder="marks it found" /></label>' +
        '<div id="count-scan-msg"></div>' +
      '</div>' +
      '<table><thead><tr><th class="no-print"></th><th>Serial</th><th>Firearm</th>' +
        '<th>Type</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<h3>Found but not in the book</h3>' +
      (unexpected ? '<ul class="unexpected">' + unexpected + '</ul>'
                  : '<p class="hint">Nothing recorded.</p>') +
      '<div class="count-scan no-print">' +
        '<label>Add one<input id="count-unexpected" placeholder="serial number" /></label>' +
        '<label>Note<input id="count-unexpected-note" placeholder="where you found it" /></label>' +
        '<button type="button" id="btn-count-unexpected" class="secondary">Record it</button>' +
      '</div>' +
      '<label class="span2">Note for the record<textarea id="count-note" rows="2">' +
        esc(countSession.note || '') + '</textarea></label>' +
      '<div class="actions no-print">' +
        '<button type="button" id="btn-count-finish">Finish and record this count</button>' +
        '<button type="button" id="btn-count-abandon" class="secondary">Abandon</button>' +
      '</div>';

    el.querySelectorAll('[data-found]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        countSession = INV.markFound(countSession, cb.dataset.found, cb.checked);
        if (saveCountSession()) renderCountPanel();
      });
    });
    el.querySelectorAll('[data-drop-unexpected]').forEach(function (b) {
      b.addEventListener('click', function () {
        countSession = INV.removeUnexpected(countSession, parseInt(b.dataset.dropUnexpected, 10));
        if (saveCountSession()) renderCountPanel();
      });
    });
    document.getElementById('count-scan').addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      scanSerial(this.value);
      this.value = '';
    });
    document.getElementById('count-note').addEventListener('input', function () {
      countSession.note = this.value;
      saveCountSession();
    });
    document.getElementById('btn-count-unexpected').addEventListener('click', addUnexpectedFromForm);
    document.getElementById('btn-count-finish').addEventListener('click', finishCount);
    document.getElementById('btn-count-abandon').addEventListener('click', abandonCount);
  }

  function startCount() {
    countSession = INV.startCount(entries, newId(), nowIso());
    if (saveCountSession()) renderCountPanel();
  }

  function scanSerial(value) {
    var msg = document.getElementById('count-scan-msg');
    var hit = INV.findExpectedBySerial(countSession, value);
    if (!hit) {
      msg.innerHTML = alertLine('backup-warn', '&#9888; ' + esc(value) +
        ' is not on the list of what you should have. If it is really on your shelf, ' +
        'record it below as found-but-not-in-the-book.');
      return;
    }
    countSession = INV.markFound(countSession, hit.entryId, true);
    if (!saveCountSession()) return;
    renderCountPanel();
    document.getElementById('count-scan-msg').innerHTML =
      alertLine('chain-ok', '&#10003; ' + esc(hit.serial) + ' — ' + esc(hit.mfrImporter) + ' ' +
        esc(hit.model) + ' found.');
    document.getElementById('count-scan').focus();
  }

  function addUnexpectedFromForm() {
    var serial = document.getElementById('count-unexpected').value.trim();
    if (!serial) return;
    var note = document.getElementById('count-unexpected-note').value.trim();
    countSession = INV.addUnexpected(countSession, serial, note);
    if (saveCountSession()) renderCountPanel();
  }

  function finishCount() {
    var st = INV.countStatus(countSession);
    var warn = st.discrepancies
      ? 'This count has ' + st.discrepancies + ' discrepanc' + (st.discrepancies === 1 ? 'y' : 'ies') +
        ' (' + st.missing.length + ' not found, ' + st.unexpected.length + ' not in the book). ' +
        'They will be recorded exactly as they stand.\n\n'
      : '';
    if (!window.confirm(warn + 'Record this count in the permanent log? It cannot be edited afterwards.')) return;
    if (!commit('inventory', INV.countEventPayload(countSession, nowIso()))) return;
    countSession = null;
    saveCountSession();
    renderInventory();
  }

  function abandonCount() {
    if (!window.confirm('Abandon this count? Nothing is written to the record.')) return;
    countSession = null;
    saveCountSession();
    renderCountPanel();
  }

  function renderCountHistory() {
    var counts = INV.countsFromLog(log);
    var el = document.getElementById('count-history');
    if (!counts.length) {
      el.innerHTML = '<p class="hint">No count has been recorded yet.</p>';
      return;
    }
    el.innerHTML = '<table><thead><tr><th>Counted</th><th>Expected</th><th>Found</th>' +
      '<th>Discrepancies</th><th>Note</th></tr></thead><tbody>' +
      counts.map(function (c) {
        var d = (c.payload.missing || []).length + (c.payload.unexpected || []).length;
        return '<tr class="' + (d ? 'row-warn' : '') + '">' +
          '<td>' + esc(shortDate(c.payload.completedAt || c.timestamp)) + '</td>' +
          '<td>' + esc(c.payload.expectedCount) + '</td>' +
          '<td>' + esc(c.payload.foundCount) + '</td>' +
          '<td>' + (d || '—') + '</td>' +
          '<td>' + esc(c.payload.note || '') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
  }

  // --- customers --------------------------------------------------------------
  // A projection of the record, recomputed on demand. Nothing is stored here,
  // so there is no customer list to fall out of step with the bound book.

  function customerList() { return CUST.customers(entries); }

  var openCustomerKey = null;

  function renderCustomers() {
    var list = customerList();
    var people = list.filter(function (c) { return c.kind === 'person'; });
    var licensees = list.filter(function (c) { return c.kind === 'licensee'; });
    var repeat = list.filter(function (c) { return c.transactions.length > 1; });

    document.getElementById('customers-summary').innerHTML = [
      tile(list.length, 'customers'),
      tile(people.length, 'individual' + plural(people.length)),
      tile(licensees.length, 'licensee' + plural(licensees.length)),
      tile(repeat.length, 'dealt with twice or more')
    ].join('');

    renderDuplicateReview(list);
    renderCustomersTable(list);
    renderCustomerDetail(list);
  }

  function renderDuplicateReview(list) {
    var dupes = CUST.duplicateCandidates(list);
    var el = document.getElementById('customers-dupes');
    if (!dupes.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = alertLine('backup-warn', '&#9888; ' + dupes.length + ' pair' + plural(dupes.length) +
      ' that might be the same customer. These are <strong>not</strong> merged automatically — ' +
      'the record says what it says, and only a logged correction changes it.') +
      '<table><thead><tr><th>One</th><th>The other</th><th>Why it is ambiguous</th>' +
      '<th class="no-print"></th></tr></thead><tbody>' +
      dupes.map(function (d, i) {
        return '<tr>' +
          '<td>' + esc(d.a.displayName) + '<span class="pkg-note">' + esc(d.a.displayAddress) + '</span></td>' +
          '<td>' + esc(d.b.displayName) + '<span class="pkg-note">' + esc(d.b.displayAddress) + '</span></td>' +
          '<td>' + esc(d.reason) + '</td>' +
          '<td class="no-print"><button type="button" class="link-btn" data-standardize="' + i + '">Standardize&hellip;</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table>';

    el.querySelectorAll('[data-standardize]').forEach(function (b) {
      b.addEventListener('click', function () {
        standardizeCustomer(dupes[parseInt(b.dataset.standardize, 10)]);
      });
    });
  }

  // Standardizing does not rewrite anything. It proposes the corrections that
  // would bring one customer's entries onto a single spelling, and writes them
  // through the ordinary append-only correction path — so the old spelling stays
  // on the record, struck through, with a reason, exactly like any other fix.
  function standardizeCustomer(pair) {
    var choice = window.prompt(
      'Standardize both of these onto one spelling.\n\n' +
      '1 = ' + pair.a.displayName + ', ' + pair.a.displayAddress + '\n' +
      '2 = ' + pair.b.displayName + ', ' + pair.b.displayAddress + '\n\n' +
      'This does not erase anything: each change is recorded as a correction, ' +
      'with the original kept and struck through.\n\n' +
      'Type 1 or 2, or cancel:', '1');
    if (choice !== '1' && choice !== '2') return;
    var keep = choice === '1' ? pair.a : pair.b;
    var fix = choice === '1' ? pair.b : pair.a;

    var corrections = CUST.standardizeCorrections(fix, keep.displayName, keep.displayAddress);
    if (!corrections.length) {
      window.alert('Nothing to change — those entries already read that way.');
      return;
    }
    if (!window.confirm('Record ' + corrections.length + ' correction' + plural(corrections.length) +
      ' so those entries read "' + keep.displayName + ', ' + keep.displayAddress + '"?')) return;

    var reason = 'Standardized customer spelling';
    for (var i = 0; i < corrections.length; i++) {
      var c = corrections[i];
      if (!commit('correct', {
        entryId: c.entryId, field: c.field, newValue: c.newValue, reason: reason
      })) return;
    }
    renderCustomers();
  }

  function renderCustomersTable(list) {
    var rows = CUST.search(list, document.getElementById('customers-search').value.trim());
    var el = document.getElementById('customers-table');
    if (!rows.length) {
      el.innerHTML = '<p class="empty">' + (list.length ? 'Nobody matches that.'
        : 'No customers yet — they appear as soon as you log an entry.') + '</p>';
      return;
    }
    el.innerHTML = '<table><thead><tr><th>Who</th><th>Kind</th><th>Acquired from</th>' +
      '<th>Sold to</th><th>Handguns</th><th>Last dealt</th><th class="no-print"></th></tr></thead><tbody>' +
      rows.map(function (c) {
        return '<tr>' +
          '<td>' + esc(c.displayName) +
            '<span class="pkg-note">' + esc(c.displayAddress || (c.ffl ? 'FFL# ' + c.ffl : '')) + '</span>' +
            (c.spellings > 1 ? '<span class="pkg-note">' + c.spellings +
              ' spellings on the record</span>' : '') + '</td>' +
          '<td>' + (c.kind === 'licensee' ? 'Licensee' : 'Individual') + '</td>' +
          '<td>' + c.acquiredCount + '</td>' +
          '<td>' + c.disposedCount + '</td>' +
          '<td>' + (c.handgunsBought || '—') + '</td>' +
          '<td>' + esc(c.lastDealt || '—') + '</td>' +
          '<td class="no-print"><button type="button" class="link-btn" data-customer="' +
            esc(c.key) + '">History</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table>';

    el.querySelectorAll('[data-customer]').forEach(function (b) {
      b.addEventListener('click', function () {
        openCustomerKey = openCustomerKey === b.dataset.customer ? null : b.dataset.customer;
        renderCustomerDetail(customerList());
      });
    });
  }

  function renderCustomerDetail(list) {
    var el = document.getElementById('customer-detail');
    var c = openCustomerKey ? CUST.find(list, openCustomerKey) : null;
    if (!c) { el.innerHTML = ''; return; }

    var spellings = '';
    if (c.spellings > 1) {
      spellings = '<p class="hint">Recorded under ' + c.names.length + ' name spelling' +
        plural(c.names.length) + ' and ' + c.addresses.length + ' address spelling' +
        plural(c.addresses.length) + ': ' +
        esc(c.names.concat(c.addresses).join(' · ')) + '</p>';
    }

    el.innerHTML = '<div class="customer-card"><h3>' + esc(c.displayName) + '</h3>' +
      '<p class="hint">' + esc(c.displayAddress) + (c.ffl ? ' · FFL# ' + esc(c.ffl) : '') +
      ' · first dealt ' + esc(c.firstDealt || '—') + '</p>' +
      spellings +
      '<table><thead><tr><th>Date</th><th>Direction</th><th>Firearm</th><th>Serial</th>' +
      '<th>Type</th></tr></thead><tbody>' +
      c.transactions.map(function (t) {
        return '<tr><td>' + esc(t.date || '—') + '</td>' +
          '<td>' + (t.direction === 'acquired' ? 'Acquired from them' : 'Transferred to them') + '</td>' +
          '<td>' + esc(t.firearm) + '</td>' +
          '<td>' + esc(t.serial) + '</td>' +
          '<td>' + esc(t.type) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="actions no-print"><button type="button" class="secondary" id="btn-close-customer">Close</button></div></div>';

    document.getElementById('btn-close-customer').addEventListener('click', function () {
      openCustomerKey = null;
      renderCustomerDetail(list);
    });
  }

  document.getElementById('customers-search').addEventListener('input', function () {
    renderCustomersTable(customerList());
  });

  // --- autofill ---------------------------------------------------------------
  // The real fix for the alarm that spelling variation used to defeat: stop the
  // second spelling being created at all.

  function renderKnownParties(which) {
    var sel = document.getElementById(which + '-known');
    if (!sel) return;
    var list = customerList();
    sel.innerHTML = '<option value="">Type it fresh below</option>' +
      list.map(function (c) {
        var label = c.displayName + (c.displayAddress ? ' — ' + c.displayAddress : '') +
          (c.ffl ? ' (FFL# ' + c.ffl + ')' : '');
        return '<option value="' + esc(c.key) + '">' + esc(label) + '</option>';
      }).join('');
    sel.value = '';
  }

  function wireAutofill(which, nameField, addressField, fflField) {
    var sel = document.getElementById(which + '-known');
    if (!sel) return;
    sel.addEventListener('change', function () {
      var note = document.getElementById(which + '-known-note');
      if (!sel.value) {
        if (note) { note.innerHTML = ''; note.classList.add('hidden'); }
        return;
      }
      var c = CUST.find(customerList(), sel.value);
      if (!c) return;
      var form = document.getElementById(which + '-form');
      form[nameField].value = c.displayName;
      form[addressField].value = c.displayAddress;
      form[fflField].value = c.ffl || '';
      if (note) {
        var hg = c.handgunsBought;
        note.innerHTML = 'Dealt with ' + c.transactions.length + ' time' + plural(c.transactions.length) +
          ' before, most recently ' + esc(c.lastDealt || 'an unknown date') + '.' +
          (hg ? ' <strong>' + hg + ' handgun' + plural(hg) + '</strong> already transferred to them.' : '');
        note.classList.remove('hidden');
      }
    });
  }

  wireAutofill('acquire', 'sourceName', 'sourceAddress', 'sourceFfl');
  wireAutofill('dispose', 'buyerName', 'buyerAddress', 'buyerFfl');

  // --- export ----------------------------------------------------------------

  var discontinuanceMode = false;

  // An entry is in range if either end of its life falls inside it: a firearm
  // acquired before the window and sold inside it belongs on that report.
  function inRange(e, from, to) {
    if (!from && !to) return true;
    var dates = [BB.currentValue(e, 'acquisition.dateReceived')];
    if (e.disposition) dates.push(BB.currentValue(e, 'disposition.date'));
    return dates.some(function (d) {
      if (!BB.isValidDate(d)) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  function exportSelection() {
    var from = document.getElementById('export-from').value;
    var to = document.getElementById('export-to').value;
    var openOnly = document.getElementById('export-open-only').checked;
    var rows = entries.filter(function (e) {
      if (openOnly && e.status !== 'open') return false;
      return inRange(e, from, to);
    });
    return { rows: rows, from: from, to: to, openOnly: openOnly };
  }

  function rangeLabel(sel) {
    var parts = [];
    if (sel.from || sel.to) {
      parts.push('Entries dated ' + (sel.from || 'the beginning') + ' to ' + (sel.to || 'today'));
    } else {
      parts.push('Complete record');
    }
    if (sel.openOnly) parts.push('open entries only');
    return parts.join(' · ');
  }

  function printHeader(sel) {
    var p = loadProfile();
    var chain = INT.verifyChain(log);
    return '<div class="ledger-header">' +
      (discontinuanceMode ? '<div class="cover-flag">Records surrendered on discontinuance of license</div>' : '') +
      '<h2>Acquisition &amp; Disposition Record</h2>' +
      '<div class="meta">' + esc(p.name || '') +
        (p.ffl ? ' · FFL# ' + esc(p.ffl) : '') +
        (p.address ? ' · ' + esc(p.address) : '') + '</div>' +
      '<div class="meta">' + esc(rangeLabel(sel)) + ' · ' + sel.rows.length + ' of ' +
        entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') +
        ' · printed ' + esc(shortDate(nowIso())) + '</div>' +
      '<div class="meta chain-line">' +
        (chain.ok
          ? 'Chain verified: ' + chain.count + ' events, no gaps, nothing altered.'
          : 'INTEGRITY CHECK FAILED: ' + esc(chain.reason)) +
        ' · head hash ' + esc(INT.headHash(log)) +
      '</div></div>';
  }

  function correctionsAppendix(rows) {
    var withCorrections = rows.filter(function (e) { return e.corrections.length; });
    if (!withCorrections.length) return '';
    var body = withCorrections.map(function (e) {
      return BB.correctionLines(e).map(function (line, i) {
        return '<tr>' +
          (i === 0 ? '<td rowspan="' + e.corrections.length + '">' +
            esc(BB.currentValue(e, 'acquisition.serial')) + '</td>' : '') +
          '<td>' + esc(line) + '</td></tr>';
      }).join('');
    }).join('');
    return '<div class="appendix"><h3>Corrections</h3>' +
      '<p class="hint">Every change made after an entry was recorded. The original value is ' +
      'never removed — it appears struck through in the ledger above and in full here.</p>' +
      '<table><thead><tr><th>Serial</th><th>Correction</th></tr></thead><tbody>' +
      body + '</tbody></table></div>';
  }

  function certificationBlock() {
    var p = loadProfile();
    return '<div class="certification"><h3>Certification</h3>' +
      '<p>I certify that the foregoing is a true and complete copy of the Acquisition and ' +
      'Disposition record maintained under FFL ' + esc(p.ffl || '________') + '.</p>' +
      '<div class="sign-row"><span>Signature: ______________________________</span>' +
      '<span>Printed: ' + esc(p.certifier || p.name || '______________________________') + '</span>' +
      '<span>Date: ______________</span></div></div>';
  }

  function countHistoryForPrint() {
    var counts = INV.countsFromLog(log);
    if (!counts.length) return '';
    return '<div class="appendix"><h3>Physical inventory counts</h3><table><thead><tr>' +
      '<th>Counted</th><th>Expected</th><th>Found</th><th>Not found</th><th>Not in the book</th>' +
      '<th>Note</th></tr></thead><tbody>' +
      counts.map(function (c) {
        return '<tr><td>' + esc(shortDate(c.payload.completedAt || c.timestamp)) + '</td>' +
          '<td>' + esc(c.payload.expectedCount) + '</td>' +
          '<td>' + esc(c.payload.foundCount) + '</td>' +
          '<td>' + ((c.payload.missing || []).map(function (m) { return esc(m.serial); }).join(', ') || '—') + '</td>' +
          '<td>' + ((c.payload.unexpected || []).map(function (u) { return esc(u.serial); }).join(', ') || '—') + '</td>' +
          '<td>' + esc(c.payload.note || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function printFooter() {
    var p = loadProfile();
    // position:fixed repeats this on every printed page in current browsers, so
    // each sheet carries the identity of the record it came from.
    return '<div class="print-footer print-only">' + esc(p.name || '') +
      (p.ffl ? ' · FFL# ' + esc(p.ffl) : '') +
      ' · head hash ' + esc(INT.headHash(log).slice(0, 16)) + '…' +
      ' · printed ' + esc(shortDate(nowIso())) + '</div>';
  }

  function renderPrintLedger() {
    var sel = exportSelection();
    var el = document.getElementById('print-ledger');
    document.getElementById('export-range-note').textContent =
      sel.rows.length + ' of ' + entries.length + ' entries selected.';

    if (!sel.rows.length) {
      el.innerHTML = printHeader(sel) + '<p class="empty">Nothing in this selection.</p>';
      return;
    }
    var head = '<tr><th>Received</th><th>Mfr/Importer</th><th>Model</th><th>Serial</th>' +
      '<th>Type</th><th>Caliber</th><th>Source</th><th>Disposition</th><th>Transferee</th>' +
      '<th>Reference</th><th>Eligibility</th></tr>';
    var body = sel.rows.map(function (e) {
      var d = e.disposition;
      return '<tr>' +
        '<td>' + fieldCell(e, 'acquisition.dateReceived') + '</td>' +
        '<td>' + fieldCell(e, 'acquisition.mfrImporter') + '</td>' +
        '<td>' + fieldCell(e, 'acquisition.model') + '</td>' +
        '<td>' + fieldCell(e, 'acquisition.serial') + '</td>' +
        '<td>' + fieldCell(e, 'acquisition.type') + '</td>' +
        '<td>' + fieldCell(e, 'acquisition.caliber') + '</td>' +
        '<td>' + esc(BB.party(e, 'source')) + '</td>' +
        '<td>' + (d ? esc(BB.dispType(d.dispositionType).label) + '<br>' +
                      fieldCell(e, 'disposition.date') : '—') + '</td>' +
        '<td>' + (d ? esc(BB.party(e, 'buyer')) : '') + '</td>' +
        '<td>' + (d ? fieldCell(e, 'disposition.formSerial') +
                      (BB.currentValue(e, 'disposition.reportRef')
                        ? '<br>' + fieldCell(e, 'disposition.reportRef') : '') : '') + '</td>' +
        '<td>' + (d ? fieldCell(e, 'disposition.eligibilityNote') : '') + '</td>' +
        '</tr>';
    }).join('');

    el.innerHTML = printHeader(sel) +
      '<table class="print-ledger-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
      correctionsAppendix(sel.rows) +
      (discontinuanceMode ? countHistoryForPrint() : '') +
      certificationBlock() +
      printFooter();
  }

  ['export-from', 'export-to', 'export-open-only'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', renderPrintLedger);
  });
  document.getElementById('btn-range-clear').addEventListener('click', function () {
    document.getElementById('export-from').value = '';
    document.getElementById('export-to').value = '';
    document.getElementById('export-open-only').checked = false;
    discontinuanceMode = false;
    renderPrintLedger();
  });

  document.getElementById('btn-print').addEventListener('click', function () { window.print(); });
  document.getElementById('btn-csv').addEventListener('click', function () {
    var sel = exportSelection();
    download('bound-book-backup.csv', BB.toCSV(sel.rows), 'text/csv');
  });

  // Everything an inspector or a successor needs, in one go: the full printable
  // record with corrections and counts, the machine-readable log, and the CSV.
  document.getElementById('btn-discontinuance').addEventListener('click', function () {
    if (!window.confirm('Build the discontinuance bundle?\n\n' +
      'This downloads the complete record as JSON and CSV, then opens the full ' +
      'printable copy — corrections, count history and a certification block — ' +
      'for print or Save as PDF.')) return;
    document.getElementById('export-from').value = '';
    document.getElementById('export-to').value = '';
    document.getElementById('export-open-only').checked = false;
    discontinuanceMode = true;
    downloadPlainBackup();
    download('bound-book-record.csv', BB.toCSV(entries), 'text/csv');
    renderPrintLedger();
    window.print();
  });

  // --- integrity view --------------------------------------------------------

  function eventSummary(e) {
    if (e.type === 'acquire') return 'Acquired ' + esc(e.payload.mfrImporter) + ' ' + esc(e.payload.model) + ' — SN ' + esc(e.payload.serial);
    if (e.type === 'dispose') return esc(BB.dispTypeLabel(e.payload.dispositionType)) +
      (e.payload.formSerial ? ' (4473 ' + esc(e.payload.formSerial) + ')' : '') +
      (e.payload.reportRef ? ' (report ' + esc(e.payload.reportRef) + ')' : '');
    if (e.type === 'correct') return 'Corrected ' + esc(BB.fieldLabel(e.payload.field)) + ' → ' + esc(e.payload.newValue) + ' (' + esc(e.payload.reason) + ')';
    if (e.type === 'inventory') return 'Physical inventory: ' + esc(e.payload.foundCount) + ' of ' +
      esc(e.payload.expectedCount) + ' found' +
      ((e.payload.unexpected || []).length ? ', ' + e.payload.unexpected.length + ' not in the book' : '');
    return esc(e.type);
  }

  function backupBanner() {
    var s = INT.backupStatus(log, lastBackup);
    // Priority 1: unsaved changes are the most urgent — data would be lost.
    if (!s.upToDate) {
      var noun = s.pending === 1 ? 'change has' : 'changes have';
      var lead = s.neverBackedUp
        ? 'No backup yet — '
        : (esc(s.pending) + ' ' + noun + ' been recorded since your last backup' + (s.lastBackupAt ? ' (' + esc(shortDate(s.lastBackupAt)) + ')' : '') + '. ');
      return '<div class="backup-warn">&#9888; ' + lead + 'Download a backup so this record survives loss of this device.</div>';
    }
    // Priority 2: fully backed up, but the calendar cadence is due (policy).
    var interval = parseInt(loadProfile().backupIntervalDays, 10) || 0;
    var due = INT.backupOverdue(lastBackup, nowIso(), interval);
    if (due.overdue) {
      return '<div class="backup-warn">&#9888; Your last backup is ' + esc(due.ageDays) + ' days old (policy: every ' + esc(interval) + ' days). Download a fresh copy and store it offsite.</div>';
    }
    var when = s.lastBackupAt ? ' (last backup ' + esc(shortDate(s.lastBackupAt)) + ')' : '';
    return '<div class="backup-ok">&#10003; All changes backed up' + when + '.</div>';
  }

  function renderAnchorPanel() {
    var el = document.getElementById('anchor-panel');
    if (!log.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<h3>Head hash</h3>' +
      '<p class="mono hash-value" id="head-hash">' + esc(INT.headHash(log)) + '</p>' +
      '<p class="hint">This one string stands for every byte of your history: two copies of ' +
      'this record that agree on it agree on everything. The chain proves nobody edited the ' +
      'past <em>in place</em> — it cannot prove nobody rebuilt the whole history from ' +
      'scratch, because whoever holds the file can recompute every hash in it. Writing this ' +
      'value down somewhere outside the file closes that gap: print it with your ledger, ' +
      'file it with each backup, mail it to yourself. A rebuilt chain will not match the ' +
      'copy you anchored.</p>' +
      '<div class="actions no-print"><button type="button" class="secondary" id="btn-copy-hash">Copy head hash</button></div>';
    document.getElementById('btn-copy-hash').addEventListener('click', function () {
      var text = INT.headHash(log);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { this.textContent = 'Copied'; }.bind(this));
      } else {
        window.prompt('Copy the head hash:', text);
      }
    });
  }

  function renderIntegrity() {
    var res = INT.verifyChain(log);
    var statusEl = document.getElementById('integrity-status');
    if (!log.length) {
      statusEl.innerHTML = '<div class="chain-ok">No entries yet — nothing to verify.</div>';
      document.getElementById('integrity-log').innerHTML = '';
      document.getElementById('anchor-panel').innerHTML = '';
      return;
    }
    statusEl.innerHTML = (res.ok
      ? '<div class="chain-ok">&#10003; Chain verified — ' + res.count + ' entr' + (res.count === 1 ? 'y' : 'ies') + ', no gaps, nothing altered.</div>'
      : '<div class="chain-bad">&#10007; Integrity check FAILED. ' + esc(res.reason) + '</div>')
      + backupBanner();

    renderAnchorPanel();

    var rows = log.map(function (e) {
      var broken = !res.ok && e.seq >= res.brokenAt;
      return '<tr class="' + (broken ? 'row-bad' : '') + '">' +
        '<td>' + e.seq + '</td>' +
        '<td>' + esc((e.timestamp || '').replace('T', ' ').replace(/\..*/, '')) + '</td>' +
        '<td>' + eventSummary(e) + '</td>' +
        '<td class="mono">' + esc(String(e.hash).slice(0, 12)) + '…</td>' +
        '</tr>';
    }).join('');
    document.getElementById('integrity-log').innerHTML =
      '<table><thead><tr><th>#</th><th>When</th><th>Action</th><th>Hash</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  // --- backup / restore (continuity of the legal record) ---------------------

  function markBackedUp(at) {
    saveLastBackup({ seq: INT.headSeq(log), at: at });
  }

  function downloadPlainBackup() {
    var at = nowIso();
    download('bound-book-backup.json', JSON.stringify(INT.makeBackup(log, at), null, 2), 'application/json');
    markBackedUp(at);
    if (!document.getElementById('view-integrity').classList.contains('hidden')) renderIntegrity();
  }

  document.getElementById('btn-backup').addEventListener('click', downloadPlainBackup);

  document.getElementById('btn-backup-encrypted').addEventListener('click', function () {
    askPassphrase({
      title: 'Encrypt this backup',
      hint: 'The file is useless without this passphrase — and so is your record, if this ' +
        'is your only copy and you forget it. Write it down somewhere separate from the backup.',
      confirm: true
    }).then(function (pass) {
      if (pass === null) return;
      var at = nowIso();
      return SB.encryptBackup(INT.makeBackup(log, at), pass, at).then(function (text) {
        download('bound-book-backup.encrypted.json', text, 'application/json');
        markBackedUp(at);
        renderIntegrity();
      });
    }).catch(function (err) {
      document.getElementById('restore-msg').innerHTML =
        '<div class="chain-bad">' + esc(err.message || String(err)) + '</div>';
    });
  });

  // Restoring is the only action in this app that can destroy recorded history,
  // so it compares the two chains first and says exactly what would be lost.
  function confirmRestore(cmp) {
    if (cmp.relation === 'identical') {
      return { proceed: false, message: '<div class="chain-ok">This backup is identical to the ' +
        'record already on this device (' + cmp.currentCount + ' events). Nothing to restore.</div>' };
    }
    if (cmp.relation === 'incoming_ahead') {
      if (!cmp.currentCount) return { proceed: true };
      return {
        proceed: window.confirm('This backup continues the record on this device: ' +
          cmp.currentCount + ' events here, ' + cmp.incomingCount + ' in the backup, and the ' +
          'shared history matches. Nothing recorded here would be lost. Restore?')
      };
    }
    if (cmp.relation === 'incoming_behind') {
      return {
        proceed: window.confirm('STOP. This backup is OLDER than the record on this device.\n\n' +
          'This device has ' + cmp.currentCount + ' events; the backup has ' + cmp.incomingCount +
          '. Restoring would permanently drop the ' + cmp.lostCount + ' most recent event' +
          (cmp.lostCount === 1 ? '' : 's') + ' from your record.\n\n' +
          'Download a backup of THIS device first if you have not.\n\nRestore anyway?')
      };
    }
    return {
      proceed: window.confirm('STOP. This backup is not a copy of the record on this device.\n\n' +
        'The two histories agree up to event ' + (cmp.divergedAt - 1) + ' and disagree from ' +
        'event ' + cmp.divergedAt + ' on. One of them is not this record. Restoring would ' +
        'replace ' + cmp.lostCount + ' recorded event' + (cmp.lostCount === 1 ? '' : 's') +
        ' with a different history.\n\nThis is almost certainly the wrong file. Restore anyway?')
    };
  }

  function applyRestore(incoming, msgEl) {
    var cmp = INT.compareChains(log, incoming);
    var decision = confirmRestore(cmp);
    if (decision.message) { msgEl.innerHTML = decision.message; return; }
    if (!decision.proceed) {
      msgEl.innerHTML = '<div class="chain-ok">Restore cancelled. Nothing was changed.</div>';
      return;
    }
    if (!persist(LOG_KEY, JSON.stringify(incoming))) return;
    log = incoming;
    entries = INT.project(log);
    // The restored data matches a backup file that exists on disk, so it is
    // current as of this restore.
    markBackedUp(nowIso());
    msgEl.innerHTML = '<div class="chain-ok">Restored ' + incoming.length +
      ' events. Chain verified. Head hash now ' + esc(INT.headHash(log).slice(0, 16)) + '…</div>';
    renderIntegrity();
  }

  var restoreInput = document.getElementById('restore-input');
  restoreInput.addEventListener('change', function () {
    var file = this.files && this.files[0];
    var msg = document.getElementById('restore-msg');
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      restoreInput.value = '';
      if (SB.isEncryptedBackup(text)) {
        askPassphrase({
          title: 'Encrypted backup',
          hint: 'Enter the passphrase this backup was encrypted with.'
        }).then(function (pass) {
          if (pass === null) return;
          return SB.decryptBackup(text, pass).then(function (res) {
            if (!res.ok) {
              msg.innerHTML = '<div class="chain-bad">' + esc(res.error) + '</div>';
              return;
            }
            applyRestore(res.log, msg);
          });
        }).catch(function (err) {
          msg.innerHTML = '<div class="chain-bad">' + esc(err.message || String(err)) + '</div>';
        });
        return;
      }
      var res = INT.parseBackup(text);
      if (!res.ok) {
        msg.innerHTML = '<div class="chain-bad">' + esc(res.error) + '</div>';
        return;
      }
      applyRestore(res.log, msg);
    };
    reader.readAsText(file);
  });

  // --- passphrase prompt -----------------------------------------------------
  // Resolves to the passphrase, or null if the user cancelled.

  function askPassphrase(opts) {
    return new Promise(function (resolve) {
      var modal = document.getElementById('pass-modal');
      var form = document.getElementById('pass-form');
      var errEl = document.getElementById('pass-errors');
      document.getElementById('pass-title').textContent = opts.title;
      document.getElementById('pass-hint').textContent = opts.hint;
      document.getElementById('pass-confirm-wrap').classList.toggle('hidden', !opts.confirm);
      form.reset();
      showErrors(errEl, []);
      modal.classList.remove('hidden');
      form.passphrase.focus();

      function close(value) {
        modal.classList.add('hidden');
        form.removeEventListener('submit', onSubmit);
        cancel.removeEventListener('click', onCancel);
        form.reset();
        resolve(value);
      }
      function onSubmit(ev) {
        ev.preventDefault();
        var pass = form.passphrase.value;
        var errors = [];
        if (opts.confirm) {
          errors = SB.passphraseProblems(pass);
          if (pass !== form.confirm.value) errors.push('The two passphrases do not match.');
        } else if (!pass) {
          errors.push('Enter the passphrase.');
        }
        showErrors(errEl, errors);
        if (errors.length) return;
        close(pass);
      }
      function onCancel() { close(null); }
      var cancel = document.getElementById('pass-cancel');
      form.addEventListener('submit', onSubmit);
      cancel.addEventListener('click', onCancel);
    });
  }

  // --- packages (inbound tracking; NOT part of the chained A&D record) ---
  // Carrier data is third-party logistics information, not a regulated field,
  // so it lives in its own store and rows here can be edited or removed freely.
  // The single path into the legal record is "Log as acquisition", which writes
  // an ordinary acquire event through commit().

  var pendingPackageId = null;

  function findPackage(id) {
    return packages.filter(function (p) { return p.id === id; })[0];
  }
  function pkgRank(p) {
    if (PK.needsLogging(p)) return 0;
    if (PK.isActive(p)) return 1;
    return 2;
  }

  function renderPackages() {
    var rec = PK.reconcile(packages, entries, nowIso());
    renderPackageAlerts(rec);
    renderPackageTable(rec);
  }

  function renderPackageAlerts(rec) {
    var out = [];
    if (rec.lateToLog.length) {
      out.push(alertLine('chain-bad', '&#10007; ' + rec.lateToLog.length + ' delivered package' +
        plural(rec.lateToLog.length) + ' not yet in the bound book. An acquisition is due by the close ' +
        'of the next business day after you receive the firearm.'));
    }
    var waiting = rec.toLog.length - rec.lateToLog.length;
    if (waiting > 0) {
      out.push(alertLine('backup-warn', '&#9888; ' + waiting + ' delivered package' + plural(waiting) +
        ' waiting to be logged as ' + (waiting === 1 ? 'an acquisition' : 'acquisitions') + '.'));
    }
    if (rec.stalled.length) {
      out.push(alertLine('backup-warn', '&#9888; ' + rec.stalled.length + ' package' + plural(rec.stalled.length) +
        ' stopped scanning ' + PK.DEFAULT_STALL_DAYS + '+ days ago. Nothing would have emailed you about this.'));
    }
    if (rec.overdue.length) {
      out.push(alertLine('backup-warn', '&#9888; ' + rec.overdue.length + ' package' + plural(rec.overdue.length) +
        ' past the date you expected ' + (rec.overdue.length === 1 ? 'it' : 'them') + '.'));
    }
    if (rec.orphanLinks.length) {
      out.push(alertLine('backup-warn', '&#9888; ' + rec.orphanLinks.length + ' package' + plural(rec.orphanLinks.length) +
        ' point at a ledger entry that no longer exists — likely a restore from an older backup.'));
    }
    if (!out.length) {
      out.push(alertLine('chain-ok', packages.length
        ? '&#10003; ' + rec.active.length + ' inbound, nothing needs attention.'
        : '&#10003; No packages tracked yet.'));
    }
    document.getElementById('packages-alerts').innerHTML = out.join('');
  }

  function renderPackageTable(rec) {
    var el = document.getElementById('packages-table');
    if (!packages.length) {
      el.innerHTML = '<p class="empty">Nothing tracked yet. Add what you are expecting above, ' +
        'or run the poller to pull in what your carrier accounts already know about.</p>';
      return;
    }
    var now = nowIso();
    // Last flag wins, so the most serious one is applied last.
    var flagged = {};
    rec.overdue.forEach(function (p) { flagged[p.id] = 'Past its expected date'; });
    rec.stalled.forEach(function (p) {
      flagged[p.id] = 'No scan in ' + PK.daysBetween(p.lastScan.at, now) + ' days';
    });
    rec.lateToLog.forEach(function (p) { flagged[p.id] = 'Not logged as an acquisition'; });

    var ranked = packages.slice().sort(function (a, b) {
      return pkgRank(a) - pkgRank(b) ||
        String(a.description).localeCompare(String(b.description));
    });

    var head = '<tr><th>Status</th><th>What</th><th>Carrier / tracking</th>' +
      '<th>Last scan</th><th>Expected</th><th class="no-print"></th></tr>';
    var body = ranked.map(function (p) {
      var status = '<td><span class="pkg-status pkg-' + esc(p.status) + '">' +
        esc(PK.STATUS_LABELS[p.status] || p.status) + '</span></td>';

      var what = '<td>' + esc(p.description);
      if (p.source === 'portal') {
        what += '<span class="pkg-note">found on the ' + esc(PK.carrierLabel(p.carrier)) + ' portal</span>';
      }
      if (p.linkedEntryId) what += '<span class="pkg-note">logged as an acquisition</span>';
      if (flagged[p.id]) what += '<span class="pkg-flag">' + esc(flagged[p.id]) + '</span>';
      what += '</td>';

      var tn = '<td>' + esc(PK.carrierLabel(p.carrier)) + (p.trackingNumber
        ? '<span class="pkg-note mono">' + esc(p.trackingNumber) + '</span>'
        : '<span class="pkg-note">no tracking number yet</span>') + '</td>';

      var scan = '<td>' + (p.lastScan
        ? esc(p.lastScan.description) + '<span class="pkg-note">' + esc(shortDate(p.lastScan.at)) +
          (p.lastScan.location ? ' · ' + esc(p.lastScan.location) : '') + '</span>'
        : '—') + '</td>';

      var exp = '<td>' + esc(p.expectedBy || '—') + '</td>';

      var actions = '<td class="no-print">';
      if (PK.needsLogging(p)) {
        actions += '<button type="button" class="link-btn" data-log="' + esc(p.id) + '">Log as acquisition</button><br>';
      }
      actions += '<button type="button" class="link-btn" data-drop="' + esc(p.id) + '">Remove</button></td>';

      return '<tr class="' + (flagged[p.id] ? 'row-warn' : '') + '">' +
        status + what + tn + scan + exp + actions + '</tr>';
    }).join('');

    el.innerHTML = '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
    el.querySelectorAll('[data-log]').forEach(function (b) {
      b.addEventListener('click', function () { startAcquisitionFrom(b.dataset.log); });
    });
    el.querySelectorAll('[data-drop]').forEach(function (b) {
      b.addEventListener('click', function () { dropPackage(b.dataset.drop); });
    });
  }

  document.getElementById('package-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var data = formData(this);
    var res = PK.validatePackage(data);
    showErrors(document.getElementById('package-errors'), res.errors);
    if (!res.ok) return;
    var before = packages;
    packages = packages.concat([PK.newPackage(data, newId(), nowIso())]);
    if (!savePackages()) { packages = before; return; }
    this.reset();
    renderPackages();
  });

  // Removing a package touches nothing regulated — this list is not the record.
  function dropPackage(id) {
    var p = findPackage(id);
    if (!p) return;
    if (!window.confirm('Remove "' + p.description + '" from the package list? ' +
      'This does not touch the A&D record.')) return;
    var before = packages;
    packages = packages.filter(function (x) { return x.id !== id; });
    if (!savePackages()) { packages = before; return; }
    renderPackages();
  }

  // --- the handoff into the legal record ---

  function deliveryDate(p) {
    var at = (p.lastScan && p.lastScan.at) || '';
    return /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : '';
  }

  function startAcquisitionFrom(id) {
    var p = findPackage(id);
    if (!p) return;
    pendingPackageId = id;
    var banner = document.getElementById('acquire-from-package');
    banner.innerHTML = 'Logging the acquisition for <strong>' + esc(p.description) + '</strong>' +
      (p.trackingNumber ? ' (' + esc(PK.carrierLabel(p.carrier)) + ' ' + esc(p.trackingNumber) + ')' : '') +
      '. The carrier cannot tell you what was in the box, so the firearm details are yours to enter. ' +
      '<button type="button" class="link-btn" id="cancel-from-package">Cancel</button>';
    banner.classList.remove('hidden');
    document.getElementById('cancel-from-package').addEventListener('click', clearPendingPackage);
    // The delivery scan date is real carrier data, so it is worth prefilling.
    // Nothing else on the form can be known from tracking.
    var d = deliveryDate(p);
    if (d) document.getElementById('acquire-form').dateReceived.value = d;
    show('acquire');
  }

  function clearPendingPackage() {
    pendingPackageId = null;
    var banner = document.getElementById('acquire-from-package');
    banner.innerHTML = '';
    banner.classList.add('hidden');
  }

  function linkPackage(id, entryId) {
    var before = packages;
    packages = packages.map(function (p) {
      return p.id === id ? PK.linkToEntry(p, entryId, nowIso()) : p;
    });
    if (!savePackages()) packages = before;
  }

  // --- poller round-trip (same shape as backup/restore: a file, not a server) ---

  document.getElementById('btn-tracking-list').addEventListener('click', function () {
    download('tracking-list.json', JSON.stringify({
      app: 'bound-book-tracking-list',
      version: 1,
      exportedAt: nowIso(),
      packages: PK.trackingList(packages)
    }, null, 2), 'application/json');
  });

  var snapshotInput = document.getElementById('snapshot-input');
  snapshotInput.addEventListener('change', function () {
    var file = this.files && this.files[0];
    var msg = document.getElementById('snapshot-msg');
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data = null;
      try { data = JSON.parse(String(reader.result)); } catch (e) { /* reported below */ }
      if (!data || data.app !== 'bound-book-tracker' || !Array.isArray(data.packages)) {
        msg.innerHTML = '<div class="chain-bad">That is not a poller snapshot. Expected ' +
          'package-snapshot.json, written by tracker/poll.js.</div>';
        snapshotInput.value = '';
        return;
      }
      var before = packages;
      var res = PK.mergeSnapshot(packages, data, nowIso(), newId);
      packages = res.packages;
      snapshotInput.value = '';
      if (!savePackages()) { packages = before; return; }
      msg.innerHTML = '<div class="chain-ok">Imported ' + data.packages.length + ' package' +
        plural(data.packages.length) + ': ' + res.updated + ' updated, ' + res.added + ' newly discovered.</div>';
      renderPackages();
    };
    reader.readAsText(file);
  });

  // --- profile ---
  var PROFILE_FIELDS = ['name', 'ffl', 'address', 'certifier', 'backupIntervalDays']
    .concat(Object.keys(INV.DEFAULTS));

  (function initProfile() {
    var form = document.getElementById('profile-form');
    var p = loadProfile();
    PROFILE_FIELDS.forEach(function (k) { if (form[k]) form[k].value = p[k] || ''; });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!saveProfile(formData(this))) return;
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
      persist(DISCLAIMER_KEY, '1');
      modal.classList.add('hidden');
    });
  })();

  show('acquire');
})();
