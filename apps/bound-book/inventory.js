// inventory.js — what you actually have on hand, and the alarms the record can
// raise about itself.
//
// Two jobs that both read the projected ledger and nothing else:
//
//   1. On-hand inventory — the open entries, aged, grouped, and countable in a
//      physical inventory session (walk the shelf, tick off serials, keep the
//      discrepancy report).
//   2. Alarms — facts the record already contains but never surfaced: a
//      multiple-handgun sale that triggers a separate report, entries written
//      into the book later than policy allows, firearms open far longer than
//      usual.
//
// Same conventions as core.js: no Date/random inside pure functions — callers
// pass ids and timestamps. Runs in the browser (window.Inventory) and Node.
//
// None of the thresholds here are legal advice. Every one is configurable
// because the rule it approximates has conditions this app does not model.

(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var core = isNode ? require('./core.js') : root.BoundBook;
  var cust = isNode ? require('./customers.js') : root.Customers;
  var mod = factory(core, cust);
  if (isNode) module.exports = mod;
  else root.Inventory = mod;
})(typeof self !== 'undefined' ? self : this, function (BB, CUST) {
  'use strict';

  var DAY_MS = 86400000;

  // Defaults, all overridable from the licensee profile.
  var DEFAULTS = {
    // Two or more handguns to the same non-licensee inside a short window
    // triggers a separate ATF report. Threshold and window are settings because
    // the real rule has conditions (and state variants) this app does not model.
    handgunThreshold: 2,
    handgunWindowBusinessDays: 5,
    // Policy limits for how late an entry reached the book, in business days
    // after the event it records.
    acquisitionEntryLimit: 1,
    dispositionEntryLimit: 7,
    // An open entry older than this is worth a look — usually a consignment that
    // went quiet or a transfer that never got written down.
    openAgeAlertDays: 365
  };

  function settings(profile) {
    profile = profile || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = parseInt(profile[k], 10);
      out[k] = isNaN(v) || v < 0 ? DEFAULTS[k] : v;
    });
    return out;
  }

  function cv(e, path) {
    var v = BB.currentValue(e, path);
    return v == null ? '' : v;
  }

  function dayOf(iso) {
    return String(iso || '').slice(0, 10);
  }

  function daysBetween(fromDay, toDay) {
    var a = new Date(String(fromDay) + 'T00:00:00Z').getTime();
    var b = new Date(String(toDay) + 'T00:00:00Z').getTime();
    if (isNaN(a) || isNaN(b)) return null;
    return Math.floor((b - a) / DAY_MS);
  }

  // Weekdays between two calendar days. Holidays are not modeled — this is a
  // policy nudge, not a legal clock.
  function businessDaysBetween(fromDay, toDay) {
    var a = new Date(String(fromDay) + 'T00:00:00Z').getTime();
    var b = new Date(String(toDay) + 'T00:00:00Z').getTime();
    if (isNaN(a) || isNaN(b) || b <= a) return 0;
    var n = 0;
    for (var t = a; t < b;) {
      t += DAY_MS;
      var wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6) n++;
    }
    return n;
  }

  // --- on hand ---------------------------------------------------------------

  function onHand(entries) {
    return (entries || []).filter(function (e) { return e.status === 'open'; });
  }

  // Open entries with days-in-inventory attached, longest held first.
  function aged(entries, nowIso) {
    var today = dayOf(nowIso);
    return onHand(entries).map(function (e) {
      var received = cv(e, 'acquisition.dateReceived');
      var days = BB.isValidDate(received) ? daysBetween(received, today) : null;
      return { entry: e, days: days === null ? null : Math.max(0, days) };
    }).sort(function (a, b) {
      return (b.days === null ? -1 : b.days) - (a.days === null ? -1 : a.days);
    });
  }

  function countBy(rows, label) {
    var counts = {};
    rows.forEach(function (r) {
      var k = label(r) || '(unspecified)';
      counts[k] = (counts[k] || 0) + 1;
    });
    return Object.keys(counts).sort().map(function (k) {
      return { label: k, count: counts[k] };
    });
  }

  function summary(entries, nowIso) {
    var rows = aged(entries, nowIso);
    var withDays = rows.filter(function (r) { return r.days !== null; });
    return {
      count: rows.length,
      handguns: rows.filter(function (r) { return BB.isHandgun(cv(r.entry, 'acquisition.type')); }).length,
      byType: countBy(rows, function (r) { return cv(r.entry, 'acquisition.type'); }),
      byCaliber: countBy(rows, function (r) { return cv(r.entry, 'acquisition.caliber'); }),
      oldestDays: withDays.length ? withDays[0].days : null,
      medianDays: median(withDays.map(function (r) { return r.days; }))
    };
  }

  function median(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  // Free-text filter over the fields someone counting a shelf would search by.
  function filterOnHand(entries, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return onHand(entries);
    var qSerial = BB.normalizeSerial(q);
    return onHand(entries).filter(function (e) {
      var hay = [
        cv(e, 'acquisition.mfrImporter'), cv(e, 'acquisition.model'),
        cv(e, 'acquisition.type'), cv(e, 'acquisition.caliber'),
        cv(e, 'acquisition.serial')
      ].join(' ').toLowerCase();
      if (hay.indexOf(q) !== -1) return true;
      return qSerial.length > 0 &&
        BB.normalizeSerial(cv(e, 'acquisition.serial')).indexOf(qSerial) !== -1;
    });
  }

  // --- physical inventory ----------------------------------------------------
  // A count session is working state while it is open: it lives outside the
  // chained log, exactly like the package list, because a half-finished count is
  // not a record of anything. Completing it writes ONE `inventory` event into
  // the chain — the licensee's dated attestation of what was physically found —
  // which is the thing worth being tamper-evident.

  function startCount(entries, id, at) {
    return {
      id: id,
      startedAt: at,
      // Snapshot the expected serials so a count stays meaningful even if the
      // ledger changes mid-count.
      expected: onHand(entries).map(function (e) {
        return {
          entryId: e.id,
          serial: cv(e, 'acquisition.serial'),
          mfrImporter: cv(e, 'acquisition.mfrImporter'),
          model: cv(e, 'acquisition.model'),
          type: cv(e, 'acquisition.type'),
          caliber: cv(e, 'acquisition.caliber')
        };
      }),
      foundIds: [],
      unexpected: [],
      note: ''
    };
  }

  function markFound(session, entryId, found) {
    var next = clone(session);
    var at = next.foundIds.indexOf(entryId);
    if (found && at === -1) next.foundIds.push(entryId);
    if (!found && at !== -1) next.foundIds.splice(at, 1);
    return next;
  }

  // A serial on the shelf that the book does not account for. The other
  // direction of a discrepancy, and the one licensees forget to look for.
  function addUnexpected(session, serial, note) {
    var next = clone(session);
    next.unexpected = next.unexpected.concat([{ serial: serial, note: note || '' }]);
    return next;
  }

  function removeUnexpected(session, index) {
    var next = clone(session);
    next.unexpected = next.unexpected.filter(function (_, i) { return i !== index; });
    return next;
  }

  // Match a typed serial against the expected list, punctuation-insensitively.
  function findExpectedBySerial(session, serial) {
    var want = BB.normalizeSerial(serial);
    if (!want) return null;
    var hits = session.expected.filter(function (x) {
      return BB.normalizeSerial(x.serial) === want;
    });
    return hits.length === 1 ? hits[0] : null;
  }

  function countStatus(session) {
    var found = {};
    session.foundIds.forEach(function (id) { found[id] = true; });
    var missing = session.expected.filter(function (x) { return !found[x.entryId]; });
    return {
      expected: session.expected.length,
      found: session.expected.length - missing.length,
      missing: missing,
      unexpected: session.unexpected.slice(),
      complete: missing.length === 0 && session.unexpected.length === 0,
      discrepancies: missing.length + session.unexpected.length
    };
  }

  // The payload committed to the chain when a count is finished.
  function countEventPayload(session, at) {
    var st = countStatus(session);
    return {
      sessionId: session.id,
      startedAt: session.startedAt,
      completedAt: at,
      expectedCount: st.expected,
      foundCount: st.found,
      missing: st.missing.map(function (x) {
        return { entryId: x.entryId, serial: x.serial, mfrImporter: x.mfrImporter, model: x.model };
      }),
      unexpected: st.unexpected,
      note: session.note || ''
    };
  }

  // Completed counts, newest first, read straight off the event log.
  function countsFromLog(log) {
    return (log || [])
      .filter(function (e) { return e.type === 'inventory'; })
      .map(function (e) { return { seq: e.seq, timestamp: e.timestamp, payload: e.payload }; })
      .reverse();
  }

  // --- alarms ----------------------------------------------------------------

  // Buyer identity comes from customers.js. It used to be an exact-ish match on
  // the name and address strings, which meant the alarm below only fired when
  // the licensee typed both identically each time — "9 Elm St" and "9 Elm
  // Street" were two different people and the alarm stayed silent. An alarm that
  // depends on perfect typing is worse than no alarm, because it reads as an
  // all-clear.
  function buyerKey(e) {
    return CUST.identityKey(CUST.partyOf(e, 'buyer'));
  }

  function buyerLabel(e) {
    return BB.party(e, 'buyer');
  }

  // Two or more handguns to the same non-licensee inside the window. Only
  // 4473 sales are considered: a transfer to another licensee is not what the
  // multiple-handgun report is about.
  //
  // Frames and receivers are not counted as handguns (see core.isHandgun) —
  // whether a given frame counts is a legal question, so this alarm stays
  // conservative and the hint says so.
  function multipleHandgunSales(entries, opts) {
    var s = settings(opts);

    // Cluster by identity, then fold together clusters that are probably the
    // same person spelled differently. Erring toward a warning is the right
    // trade here: a false positive costs a glance, a miss costs a report that
    // was owed and never filed.
    var clusters = [];
    (entries || []).forEach(function (e) {
      if (!e.disposition) return;
      if (BB.dispType(e.disposition.dispositionType).key !== 'sale_4473') return;
      if (!BB.isHandgun(cv(e, 'acquisition.type'))) return;
      var party = CUST.partyOf(e, 'buyer');
      var key = CUST.identityKey(party);
      if (!key) return;
      for (var i = 0; i < clusters.length; i++) {
        if (clusters[i].key === key || CUST.probablySame(clusters[i].party, party)) {
          clusters[i].sales.push(e);
          return;
        }
      }
      clusters.push({ key: key, party: party, sales: [e] });
    });

    var out = [];
    clusters.forEach(function (cluster) {
      var key = cluster.key;
      var sales = cluster.sales.slice().sort(function (a, b) {
        return String(cv(a, 'disposition.date')).localeCompare(String(cv(b, 'disposition.date')));
      });
      // Sliding window: for each sale, collect the later sales that fall inside
      // the window, and report the widest cluster that reaches the threshold.
      for (var i = 0; i < sales.length; i++) {
        var run = [sales[i]];
        var from = cv(sales[i], 'disposition.date');
        for (var j = i + 1; j < sales.length; j++) {
          if (businessDaysBetween(from, cv(sales[j], 'disposition.date')) > s.handgunWindowBusinessDays - 1) break;
          run.push(sales[j]);
        }
        if (run.length >= s.handgunThreshold) {
          var spellings = run.map(function (e) { return BB.party(e, 'buyer'); })
            .filter(function (v, idx, arr) { return arr.indexOf(v) === idx; });
          out.push({
            buyerKey: key,
            buyer: buyerLabel(run[0]),
            count: run.length,
            firstDate: cv(run[0], 'disposition.date'),
            lastDate: cv(run[run.length - 1], 'disposition.date'),
            entries: run,
            // The distinct spellings this run was written under. More than one
            // means the record does not look like a repeat buyer even though it
            // is — worth saying out loud, because the licensee may not realize
            // these were the same person.
            spellings: spellings,
            spellingsMerged: spellings.length > 1
          });
          i += run.length - 1; // don't re-report the same run from inside it
        }
      }
    });
    return out.sort(function (a, b) { return String(b.lastDate).localeCompare(String(a.lastDate)); });
  }

  // How long after the event each line reached the book. Retrospective by
  // nature — the app cannot know about a transfer nobody entered — but this is
  // exactly the pattern an inspection looks for, so it is better to find it
  // yourself first.
  function lateEntries(entries, opts) {
    var s = settings(opts);
    var out = [];
    (entries || []).forEach(function (e) {
      var received = cv(e, 'acquisition.dateReceived');
      if (BB.isValidDate(received) && e.createdAt) {
        var lag = businessDaysBetween(received, dayOf(e.createdAt));
        if (lag > s.acquisitionEntryLimit) {
          out.push({
            entry: e, kind: 'acquisition', lagBusinessDays: lag,
            limit: s.acquisitionEntryLimit, eventDate: received, recordedOn: dayOf(e.createdAt)
          });
        }
      }
      if (e.disposition && e.disposition.recordedAt) {
        var date = cv(e, 'disposition.date');
        if (BB.isValidDate(date)) {
          var dlag = businessDaysBetween(date, dayOf(e.disposition.recordedAt));
          if (dlag > s.dispositionEntryLimit) {
            out.push({
              entry: e, kind: 'disposition', lagBusinessDays: dlag,
              limit: s.dispositionEntryLimit, eventDate: date, recordedOn: dayOf(e.disposition.recordedAt)
            });
          }
        }
      }
    });
    return out.sort(function (a, b) { return b.lagBusinessDays - a.lagBusinessDays; });
  }

  function longOpen(entries, nowIso, opts) {
    var s = settings(opts);
    return aged(entries, nowIso).filter(function (r) {
      return r.days !== null && r.days >= s.openAgeAlertDays;
    });
  }

  // Everything the alarms panel needs in one pass.
  function alarms(entries, nowIso, opts) {
    return {
      multipleHandgun: multipleHandgunSales(entries, opts),
      lateEntries: lateEntries(entries, opts),
      longOpen: longOpen(entries, nowIso, opts),
      settings: settings(opts)
    };
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  return {
    DEFAULTS: DEFAULTS,
    settings: settings,
    daysBetween: daysBetween,
    businessDaysBetween: businessDaysBetween,
    onHand: onHand,
    aged: aged,
    summary: summary,
    filterOnHand: filterOnHand,
    startCount: startCount,
    markFound: markFound,
    addUnexpected: addUnexpected,
    removeUnexpected: removeUnexpected,
    findExpectedBySerial: findExpectedBySerial,
    countStatus: countStatus,
    countEventPayload: countEventPayload,
    countsFromLog: countsFromLog,
    buyerKey: buyerKey,
    multipleHandgunSales: multipleHandgunSales,
    lateEntries: lateEntries,
    longOpen: longOpen,
    alarms: alarms
  };
});
