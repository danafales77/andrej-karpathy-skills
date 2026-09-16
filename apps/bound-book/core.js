// core.js — pure, storage-agnostic logic for the Bound Book budget tier.
// Runs in the browser (attached to window.BoundBook) and under Node (require) for tests.
// No Date/random defaults inside pure functions: callers pass ids and timestamps
// so behavior is deterministic and testable.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoundBook = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ATF-required fields per firearm (27 CFR Part 478). Labels are used by the UI
  // and the ledger export headers.
  var ACQ_FIELDS = [
    { key: 'dateReceived', label: 'Date received' },
    { key: 'mfrImporter', label: 'Manufacturer / Importer' },
    { key: 'model', label: 'Model' },
    { key: 'serial', label: 'Serial number' },
    { key: 'type', label: 'Type' },
    { key: 'caliber', label: 'Caliber / Gauge' }
  ];

  // Not required by ATF, but this is where the licensee records which binder or
  // folder the acquisition paperwork actually lives in. Optional everywhere.
  var ACQ_OPTIONAL_FIELDS = [
    { key: 'docLocation', label: 'Paperwork location' }
  ];

  // Every disposition field this app knows, with the label used by the forms,
  // the correction picker and the exports.
  var DISP_FIELD_LABELS = {
    date: 'Date of disposition',
    formSerial: '4473 / transfer reference',
    eligibilityNote: 'Eligibility documentation',
    nicsRef: 'NICS transaction reference',
    nicsDate: 'NICS check date',
    docLocation: 'Paperwork location',
    reportRef: 'ATF / police report reference',
    note: 'Note'
  };

  // A firearm can leave inventory in more than one way, and which facts apply
  // depends on which way. An FFL-to-FFL transfer has no 4473; a theft has no
  // transferee at all. A single required-field list for all of them forced users
  // to type fictional data into a regulated record, so each type carries its own
  // requirements.
  //
  // `party` — 'required': a transferee name+address or FFL must be recorded.
  //           'none':     there is no transferee (theft, destruction, own collection).
  // `requires` — disposition field keys that must be filled for this type.
  // `hint` — shown under the type picker; a nudge, not legal advice.
  var DISP_TYPES = [
    {
      key: 'sale_4473',
      label: 'Sale / transfer to a non-licensee (4473)',
      party: 'required',
      requires: ['date', 'formSerial', 'eligibilityNote'],
      hint: 'The usual over-the-counter transfer: a completed 4473 and a background check.'
    },
    {
      key: 'ffl_transfer',
      label: 'Transfer to a licensee (FFL-to-FFL)',
      party: 'required',
      requires: ['date'],
      hint: 'No 4473 is executed by you. Record the receiving licensee — an FFL number is enough.'
    },
    {
      key: 'return_to_owner',
      label: 'Returned to the person it came from (repair / consignment)',
      party: 'required',
      requires: ['date'],
      hint: 'Returned to the same person who left it with you.'
    },
    {
      key: 'theft_loss',
      label: 'Theft or loss',
      party: 'none',
      requires: ['date', 'reportRef'],
      hint: 'A stolen or lost firearm still has to close its line in the book. Reporting it to ATF and to local law enforcement is a separate, time-limited obligation — verify the current deadline and form.'
    },
    {
      key: 'destruction',
      label: 'Destroyed / scrapped',
      party: 'none',
      requires: ['date', 'note'],
      hint: 'Describe how it was destroyed and what evidence you kept.'
    },
    {
      key: 'personal_collection',
      label: 'Transferred to personal collection',
      party: 'none',
      requires: ['date', 'note'],
      hint: 'Moving a firearm out of the business and into your own collection has its own conditions — confirm them before relying on this entry.'
    }
  ];

  var DEFAULT_DISP_TYPE = 'sale_4473';

  function dispType(key) {
    for (var i = 0; i < DISP_TYPES.length; i++) {
      if (DISP_TYPES[i].key === key) return DISP_TYPES[i];
    }
    // Entries recorded before disposition types existed were all 4473 sales.
    return DISP_TYPES[0];
  }

  function dispTypeLabel(key) {
    return dispType(key).label;
  }

  // The disposition fields worth showing for a type: the required ones first,
  // then the optional extras that still apply.
  var DISP_EXTRA_FIELDS = {
    sale_4473: ['nicsRef', 'nicsDate', 'docLocation', 'note'],
    ffl_transfer: ['formSerial', 'docLocation', 'note'],
    return_to_owner: ['docLocation', 'note'],
    theft_loss: ['docLocation', 'note'],
    destruction: ['docLocation'],
    personal_collection: ['docLocation']
  };

  function dispositionFields(typeKey) {
    var t = dispType(typeKey);
    var extra = DISP_EXTRA_FIELDS[t.key] || [];
    return t.requires.concat(extra).map(function (k) {
      return { key: k, label: DISP_FIELD_LABELS[k], required: t.requires.indexOf(k) !== -1 };
    });
  }

  // --- record mode -----------------------------------------------------------
  // WHAT IS THE LEGAL RECORD: the paper you print, or the log in this app?
  //
  // This used to be hardcoded. The app asserted "ATF variance on file" as a
  // statement of fact, which was true for exactly one licensee — the one it was
  // built for. Shipped to anyone else, the product would tell them they may run
  // a paperless system of record when they may have no approval to do so. A
  // claim about someone's regulatory standing is theirs to make, not the
  // software's to assume.
  //
  // So it is configured, and the DEFAULT IS THE CAUTIOUS ONE. Running in
  // companion mode when you hold a variance costs you some printing. Running in
  // electronic mode when you do not is a compliance problem, so nothing but an
  // explicit, deliberate setting can turn it on.
  var RECORD_MODES = [
    {
      key: 'companion',
      label: 'Companion — the printed ledger is my official record',
      short: 'Companion record',
      // Option A in the PRD.
      systemOfRecord: 'print',
      summary: 'This app helps you keep the record. The printed or PDF ledger is ' +
        'the official one: print it, keep it, and the paper is what you produce on demand.',
      printStatement: 'This printed ledger is the official Acquisition and Disposition record.',
      requiresVariance: false
    },
    {
      key: 'electronic',
      label: 'Electronic — this app is my system of record (ATF variance on file)',
      short: 'Electronic system of record',
      // Option B in the PRD.
      systemOfRecord: 'log',
      summary: 'The hash-chained log in this app is your legal record. Print and CSV ' +
        'are the human-readable surrender copy. This requires ATF approval — a variance ' +
        'granted to you, not to this software.',
      printStatement: 'This is a printed copy of an electronic Acquisition and Disposition ' +
        'record maintained under an approved variance. The electronic log is the record.',
      requiresVariance: true
    }
  ];

  var DEFAULT_RECORD_MODE = 'companion';

  function isBlank(v) {
    return v === undefined || v === null || String(v).trim() === '';
  }

  // The mode actually in force, given the licensee profile.
  //
  // Electronic mode requires BOTH an explicit choice and a recorded variance
  // reference. That second condition is a deliberate forcing function: if you
  // cannot name the approval, you should not be relying on it, and the app
  // should not be printing that you do. Falling back is silent to the caller but
  // never silent to the user — `downgraded` says it happened and why.
  function recordMode(profile) {
    profile = profile || {};
    var wanted = profile.recordMode === 'electronic' ? 'electronic' : DEFAULT_RECORD_MODE;
    if (wanted === 'electronic' && isBlank(profile.varianceRef)) {
      return {
        mode: modeByKey(DEFAULT_RECORD_MODE),
        downgraded: true,
        reason: 'Electronic system of record is selected, but no variance reference ' +
          'is recorded. Until one is entered, this record is treated as a companion ' +
          'to your printed ledger and the printout says so.'
      };
    }
    return { mode: modeByKey(wanted), downgraded: false, reason: '' };
  }

  function modeByKey(key) {
    for (var i = 0; i < RECORD_MODES.length; i++) {
      if (RECORD_MODES[i].key === key) return RECORD_MODES[i];
    }
    return RECORD_MODES[0];
  }

  // --- type vocabulary -------------------------------------------------------
  // ATF's own "type" field is free text, and real records contain everything from
  // "pistol" to "receiver". These lists drive datalist suggestions rather than a
  // closed dropdown: consistent spelling makes the ledger legible and makes the
  // handgun-count alarm work, without blocking the entry a real shipment needs.
  var TYPE_SUGGESTIONS = [
    'Pistol', 'Revolver', 'Rifle', 'Shotgun', 'Receiver', 'Frame',
    'Short-barreled rifle', 'Short-barreled shotgun', 'Any other weapon'
  ];

  var CALIBER_SUGGESTIONS = [
    '.22 LR', '.223 Rem', '5.56 NATO', '.243 Win', '6.5 Creedmoor', '.270 Win',
    '.30-06', '.308 Win', '7.62x39mm', '.300 Win Mag', '.338 Lapua',
    '9mm', '.380 ACP', '.38 Spl', '.357 Mag', '.40 S&W', '.44 Mag', '.45 ACP',
    '10mm', '12 ga', '16 ga', '20 ga', '28 ga', '.410 bore', 'Multi'
  ];

  // A convenience list of commonly logged manufacturers, NOT ATF's official
  // manufacturer/importer abbreviation list. It only saves typing and keeps
  // spelling consistent; the field stays free text.
  var MFR_SUGGESTIONS = [
    'Beretta', 'Browning', 'Bushmaster', 'Colt', 'CZ', 'Daniel Defense',
    'FN', 'Glock', 'Heckler & Koch', 'Henry', 'Kimber', 'Marlin', 'Mossberg',
    'Remington', 'Ruger', 'Savage', 'SIG Sauer', 'Smith & Wesson',
    'Springfield Armory', 'Taurus', 'Walther', 'Winchester'
  ];

  function normalizeType(t) {
    return String(t == null ? '' : t).trim().toLowerCase();
  }

  // Used by the multiple-handgun alarm. Frames and receivers are deliberately
  // NOT counted here: whether a given frame counts toward a multiple-handgun
  // report is a legal question this app does not try to answer.
  function isHandgun(t) {
    return /pistol|revolver|handgun/.test(normalizeType(t));
  }

  // --- validation ------------------------------------------------------------

  // A source/buyer is valid if we have (name AND address) OR an FFL number.
  function partyValid(name, address, ffl) {
    return (!isBlank(name) && !isBlank(address)) || !isBlank(ffl);
  }

  // Serials are compared with punctuation and case ignored, because "AB-123" and
  // "ab123" are the same firearm to everyone except a string comparison. The
  // value the licensee typed is what gets stored and printed — this is only ever
  // used for matching and search.
  function normalizeSerial(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function isValidDate(v) {
    if (!ISO_DATE.test(String(v || ''))) return false;
    var d = new Date(String(v) + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === String(v);
  }

  // Compares two YYYY-MM-DD strings. Lexicographic order is chronological order
  // for ISO dates, so no Date objects and no timezone surprises.
  function dateBefore(a, b) {
    return String(a) < String(b);
  }

  function dayOf(iso) {
    return String(iso || '').slice(0, 10);
  }

  // `opts.now` (an ISO timestamp) enables the "not in the future" check. Omit it
  // and the check is skipped, which keeps the function pure for callers that
  // have no clock.
  function validateAcquisition(a, opts) {
    a = a || {};
    opts = opts || {};
    var errors = [];
    ACQ_FIELDS.forEach(function (f) {
      if (isBlank(a[f.key])) errors.push(f.label + ' is required.');
    });
    if (!isBlank(a.dateReceived) && !isValidDate(a.dateReceived)) {
      errors.push('Date received must be a real date (YYYY-MM-DD).');
    } else if (opts.now && !isBlank(a.dateReceived) && dateBefore(dayOf(opts.now), a.dateReceived)) {
      errors.push('Date received is in the future — an acquisition is logged after the firearm arrives.');
    }
    if (!partyValid(a.sourceName, a.sourceAddress, a.sourceFfl)) {
      errors.push('Source requires either name + address, or an FFL number.');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // Things worth a second look but not worth blocking. Duplicate serials are
  // legitimately possible across manufacturers, so this warns and lets the
  // licensee confirm rather than refusing a real firearm.
  function acquisitionWarnings(a, entries) {
    a = a || {};
    var out = [];
    var serial = normalizeSerial(a.serial);
    if (!serial) return out;
    (entries || []).forEach(function (e) {
      if (normalizeSerial(currentValue(e, 'acquisition.serial')) !== serial) return;
      var sameMfr = normalizeType(currentValue(e, 'acquisition.mfrImporter')) === normalizeType(a.mfrImporter);
      var where = e.status === 'open' ? 'still open in inventory' : 'already disposed';
      out.push('Serial ' + currentValue(e, 'acquisition.serial') + ' is already on the record (' +
        currentValue(e, 'acquisition.mfrImporter') + ' ' + currentValue(e, 'acquisition.model') +
        ', ' + where + ')' +
        (sameMfr ? ' — same manufacturer, so this looks like a duplicate entry.'
                 : ' — different manufacturer, so this may be a genuine serial collision.'));
    });
    return out;
  }

  // `entry` (optional) enables the date-ordering check against the acquisition.
  // `opts.now` (optional) enables the "not in the future" check.
  function validateDisposition(d, entry, opts) {
    d = d || {};
    opts = opts || {};
    var t = dispType(d.dispositionType);
    var errors = [];

    t.requires.forEach(function (key) {
      if (isBlank(d[key])) errors.push((DISP_FIELD_LABELS[key] || key) + ' is required.');
    });

    if (!isBlank(d.date) && !isValidDate(d.date)) {
      errors.push('Date of disposition must be a real date (YYYY-MM-DD).');
    } else if (!isBlank(d.date)) {
      if (opts.now && dateBefore(dayOf(opts.now), d.date)) {
        errors.push('Date of disposition is in the future.');
      }
      if (entry) {
        var received = currentValue(entry, 'acquisition.dateReceived');
        if (isValidDate(received) && dateBefore(d.date, received)) {
          errors.push('Date of disposition (' + d.date + ') is before the date received (' + received + ').');
        }
      }
    }

    if (!isBlank(d.nicsDate) && !isValidDate(d.nicsDate)) {
      errors.push('NICS check date must be a real date (YYYY-MM-DD).');
    }

    if (t.party === 'required' && !partyValid(d.buyerName, d.buyerAddress, d.buyerFfl)) {
      errors.push('Buyer/transferee requires either name + address, or an FFL number.');
    }

    return { ok: errors.length === 0, errors: errors };
  }

  // --- entry model -----------------------------------------------------------

  // Build a new open entry. Caller supplies id and createdAt (ISO string).
  function newEntry(acq, id, createdAt) {
    return {
      id: id,
      createdAt: createdAt,
      status: 'open',
      acquisition: {
        dateReceived: acq.dateReceived,
        mfrImporter: acq.mfrImporter,
        model: acq.model,
        serial: acq.serial,
        type: acq.type,
        caliber: acq.caliber,
        sourceName: acq.sourceName || '',
        sourceAddress: acq.sourceAddress || '',
        sourceFfl: acq.sourceFfl || '',
        docLocation: acq.docLocation || ''
      },
      disposition: null,
      corrections: []
    };
  }

  // Record a disposition against an open entry. Returns a new entry object.
  // `recordedAt` is when the disposition reached the book (the event timestamp),
  // as opposed to `date`, which is when the firearm actually left. The gap
  // between the two is what the late-entry audit measures.
  function applyDisposition(entry, disp, recordedAt) {
    var next = clone(entry);
    next.disposition = {
      // Events recorded before types existed carry no dispositionType; they were
      // all 4473 sales, which is what dispType() falls back to.
      dispositionType: dispType(disp.dispositionType).key,
      date: disp.date,
      buyerName: disp.buyerName || '',
      buyerAddress: disp.buyerAddress || '',
      buyerFfl: disp.buyerFfl || '',
      formSerial: disp.formSerial || '',
      eligibilityNote: disp.eligibilityNote || '',
      nicsRef: disp.nicsRef || '',
      nicsDate: disp.nicsDate || '',
      docLocation: disp.docLocation || '',
      reportRef: disp.reportRef || '',
      note: disp.note || '',
      recordedAt: recordedAt || null
    };
    next.status = 'disposed';
    return next;
  }

  // Append-only correction. Original field values are never mutated in place;
  // the "line-out, don't erase" convention is preserved by keeping the history.
  // `path` is a dotted path, e.g. 'acquisition.serial'.
  function addCorrection(entry, path, newValue, reason, at) {
    var next = clone(entry);
    next.corrections = next.corrections.concat([{
      field: path,
      oldValue: currentValue(entry, path),
      newValue: newValue,
      reason: reason,
      at: at
    }]);
    return next;
  }

  // Effective value of a field = latest correction for that path, else the
  // original stored value.
  function currentValue(entry, path) {
    var latest;
    for (var i = 0; i < entry.corrections.length; i++) {
      if (entry.corrections[i].field === path) latest = entry.corrections[i];
    }
    if (latest) return latest.newValue;
    return getPath(entry, path);
  }

  // Every correction for a path, oldest first. The printed record needs the whole
  // history, not just the most recent value.
  function correctionsFor(entry, path) {
    return (entry.corrections || []).filter(function (c) { return c.field === path; });
  }

  // Human-readable label for a corrected path, for the exports.
  function fieldLabel(path) {
    var parts = String(path || '').split('.');
    var section = parts[0];
    var key = parts[1];
    if (section === 'acquisition') {
      var all = ACQ_FIELDS.concat(ACQ_OPTIONAL_FIELDS);
      for (var i = 0; i < all.length; i++) {
        if (all[i].key === key) return all[i].label;
      }
      if (key === 'sourceName') return 'Source name';
      if (key === 'sourceAddress') return 'Source address';
      if (key === 'sourceFfl') return 'Source FFL';
      return key;
    }
    if (section === 'disposition') {
      if (key === 'buyerName') return 'Buyer name';
      if (key === 'buyerAddress') return 'Buyer address';
      if (key === 'buyerFfl') return 'Buyer FFL';
      return 'Disposition — ' + (DISP_FIELD_LABELS[key] || key);
    }
    return path;
  }

  // One line per correction, for the CSV column and the printed appendix.
  function correctionLines(entry) {
    return (entry.corrections || []).map(function (c) {
      return fieldLabel(c.field) + ': "' + (c.oldValue == null ? '' : c.oldValue) +
        '" → "' + (c.newValue == null ? '' : c.newValue) + '" (' + c.reason + ')' +
        (c.at ? ' on ' + String(c.at).slice(0, 10) : '');
    });
  }

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, obj);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // --- CSV export (backup format) ---

  function csvEscape(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  var CSV_COLUMNS = [
    { header: 'Entry ID', get: function (e) { return e.id; } },
    { header: 'Status', get: function (e) { return e.status; } },
    { header: 'Date received', get: function (e) { return cv(e, 'acquisition.dateReceived'); } },
    { header: 'Manufacturer/Importer', get: function (e) { return cv(e, 'acquisition.mfrImporter'); } },
    { header: 'Model', get: function (e) { return cv(e, 'acquisition.model'); } },
    { header: 'Serial', get: function (e) { return cv(e, 'acquisition.serial'); } },
    { header: 'Type', get: function (e) { return cv(e, 'acquisition.type'); } },
    { header: 'Caliber/Gauge', get: function (e) { return cv(e, 'acquisition.caliber'); } },
    { header: 'Source', get: function (e) { return party(e, 'source'); } },
    { header: 'Acq. paperwork', get: function (e) { return cv(e, 'acquisition.docLocation'); } },
    { header: 'Disposition type', get: function (e) { return e.disposition ? dispTypeLabel(e.disposition.dispositionType) : ''; } },
    { header: 'Disposition date', get: function (e) { return e.disposition ? cv(e, 'disposition.date') : ''; } },
    { header: 'Buyer/Transferee', get: function (e) { return e.disposition ? party(e, 'buyer') : ''; } },
    { header: '4473/Transfer ref', get: function (e) { return e.disposition ? cv(e, 'disposition.formSerial') : ''; } },
    { header: 'Eligibility doc', get: function (e) { return e.disposition ? cv(e, 'disposition.eligibilityNote') : ''; } },
    { header: 'NICS ref', get: function (e) { return e.disposition ? cv(e, 'disposition.nicsRef') : ''; } },
    { header: 'NICS date', get: function (e) { return e.disposition ? cv(e, 'disposition.nicsDate') : ''; } },
    { header: 'Report ref', get: function (e) { return e.disposition ? cv(e, 'disposition.reportRef') : ''; } },
    { header: 'Disp. paperwork', get: function (e) { return e.disposition ? cv(e, 'disposition.docLocation') : ''; } },
    { header: 'Disp. note', get: function (e) { return e.disposition ? cv(e, 'disposition.note') : ''; } },
    // The corrected values above are the effective record; this column is what
    // keeps the export from looking like a silent overwrite.
    { header: 'Corrections', get: function (e) { return correctionLines(e).join('; '); } }
  ];

  function cv(e, path) {
    var v = currentValue(e, path);
    return v == null ? '' : v;
  }

  // Render a party ('source' or 'buyer') as "name, address" or "FFL# ...".
  // For dispositions with no transferee (theft, destruction, own collection) the
  // type itself is the answer to "where did it go".
  function party(e, which) {
    var prefix = which === 'source' ? 'acquisition.source' : 'disposition.buyer';
    var name = cv(e, prefix + 'Name');
    var addr = cv(e, prefix + 'Address');
    var ffl = cv(e, prefix + 'Ffl');
    if (name || addr) return [name, addr].filter(Boolean).join(', ');
    if (ffl) return 'FFL# ' + ffl;
    if (which === 'buyer' && e.disposition && dispType(e.disposition.dispositionType).party === 'none') {
      return '(' + dispTypeLabel(e.disposition.dispositionType) + ')';
    }
    return '';
  }

  function toCSV(entries) {
    var lines = [CSV_COLUMNS.map(function (c) { return csvEscape(c.header); }).join(',')];
    entries.forEach(function (e) {
      lines.push(CSV_COLUMNS.map(function (c) { return csvEscape(c.get(e)); }).join(','));
    });
    return lines.join('\r\n');
  }

  return {
    ACQ_FIELDS: ACQ_FIELDS,
    ACQ_OPTIONAL_FIELDS: ACQ_OPTIONAL_FIELDS,
    DISP_TYPES: DISP_TYPES,
    DISP_FIELD_LABELS: DISP_FIELD_LABELS,
    DEFAULT_DISP_TYPE: DEFAULT_DISP_TYPE,
    RECORD_MODES: RECORD_MODES,
    DEFAULT_RECORD_MODE: DEFAULT_RECORD_MODE,
    recordMode: recordMode,
    TYPE_SUGGESTIONS: TYPE_SUGGESTIONS,
    CALIBER_SUGGESTIONS: CALIBER_SUGGESTIONS,
    MFR_SUGGESTIONS: MFR_SUGGESTIONS,
    dispType: dispType,
    dispTypeLabel: dispTypeLabel,
    dispositionFields: dispositionFields,
    normalizeType: normalizeType,
    isHandgun: isHandgun,
    normalizeSerial: normalizeSerial,
    isValidDate: isValidDate,
    dateBefore: dateBefore,
    validateAcquisition: validateAcquisition,
    acquisitionWarnings: acquisitionWarnings,
    validateDisposition: validateDisposition,
    newEntry: newEntry,
    applyDisposition: applyDisposition,
    addCorrection: addCorrection,
    currentValue: currentValue,
    correctionsFor: correctionsFor,
    correctionLines: correctionLines,
    fieldLabel: fieldLabel,
    party: party,
    toCSV: toCSV,
    csvEscape: csvEscape,
    CSV_COLUMNS: CSV_COLUMNS
  };
});
