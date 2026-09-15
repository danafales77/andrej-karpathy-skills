// customers.js — the people on the other side of every entry.
//
// The record has always held them: a name and address (or an FFL number) typed
// into each acquisition and each disposition. What it never had was the idea
// that two entries might refer to the SAME person. Every transfer created a
// fresh string, so a repeat buyer was invisible, and the multiple-handgun alarm
// — which groups sales by buyer — only fired when the licensee happened to type
// the name and address identically both times.
//
// So this module is really about one thing: **identity that survives typing.**
// Everything else (the customer list, the history, the autofill) falls out of
// getting that right.
//
// Customers are a PROJECTION of the chained log, never a separate store. There
// is no customer table to drift out of sync with the record, and no way to edit
// a customer except by correcting the entries that mention them — which goes
// through the ordinary append-only correction path. A customer is a reading of
// the record, not a thing beside it.
//
// Same conventions as core.js: pure, no Date/random inside.
// Runs in the browser (window.Customers) and Node (require) for tests.

(function (root, factory) {
  var core = (typeof module === 'object' && module.exports) ? require('./core.js') : root.BoundBook;
  var mod = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.Customers = mod;
})(typeof self !== 'undefined' ? self : this, function (BB) {
  'use strict';

  // --- address normalization -------------------------------------------------
  // Deliberately simple: this is spelling normalization, NOT postal address
  // validation. It exists to stop "9 Elm St" and "9 Elm Street" being two
  // people. It does not know whether an address is real.

  var SUFFIXES = {
    STREET: 'ST', ST: 'ST', AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE',
    ROAD: 'RD', RD: 'RD', DRIVE: 'DR', DR: 'DR', LANE: 'LN', LN: 'LN',
    BOULEVARD: 'BLVD', BLVD: 'BLVD', COURT: 'CT', CT: 'CT',
    PLACE: 'PL', PL: 'PL', TERRACE: 'TER', TER: 'TER',
    CIRCLE: 'CIR', CIR: 'CIR', HIGHWAY: 'HWY', HWY: 'HWY',
    PARKWAY: 'PKWY', PKWY: 'PKWY', TRAIL: 'TRL', TRL: 'TRL',
    SQUARE: 'SQ', SQ: 'SQ', TURNPIKE: 'TPKE', TPKE: 'TPKE',
    EXTENSION: 'EXT', EXT: 'EXT', WAY: 'WAY', LOOP: 'LOOP', RUN: 'RUN'
  };

  var DIRECTIONS = {
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
    NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
    N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW'
  };

  // "FLOOR"/"FL" is left out on purpose — FL is also Florida, and guessing
  // wrong there would merge or split the wrong records.
  var UNITS = {
    APARTMENT: 'APT', APT: 'APT', UNIT: 'APT', NUMBER: 'APT', NO: 'APT',
    SUITE: 'STE', STE: 'STE', ROOM: 'RM', RM: 'RM', BUILDING: 'BLDG', BLDG: 'BLDG'
  };

  var STATES = ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN ' +
    'MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR')
    .split(' ').reduce(function (acc, s) { acc[s] = true; return acc; }, {});

  var ZIP = /^\d{5}(\d{4})?$/;

  function scrub(s) {
    return String(s == null ? '' : s)
      .toUpperCase()
      .replace(/#/g, ' APT ')
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();
  }

  // Split an address into the part that identifies a doorway (house number,
  // street, unit) and the part that identifies a town. Matching uses the core;
  // the locality is only consulted to rule a match OUT.
  function addressParts(raw) {
    var s = scrub(raw);
    if (!s) return { core: '', locality: '' };

    var toks = s.split(' ');
    var core = [];
    var locality = [];
    var unit = '';
    var i = 0;
    var streetDone = false;

    if (/\d/.test(toks[0])) { core.push(toks[0]); i = 1; }

    for (; i < toks.length; i++) {
      var t = toks[i];
      if (UNITS[t]) {
        unit = UNITS[t] + (toks[i + 1] ? ' ' + toks[i + 1] : '');
        i++;
        streetDone = true;
        continue;
      }
      if (streetDone) { locality.push(t); continue; }
      if (SUFFIXES[t]) { core.push(SUFFIXES[t]); streetDone = true; continue; }
      core.push(DIRECTIONS[t] || t);
    }

    // No street suffix anywhere ("9 Elm", "PO Box 4"): peel a trailing ZIP, and
    // a state with the town before it, off the end so they don't pollute the key.
    if (!streetDone) {
      if (core.length && ZIP.test(core[core.length - 1])) locality.unshift(core.pop());
      for (var j = core.length - 1; j >= 1 && j >= core.length - 2; j--) {
        if (STATES[core[j]]) {
          locality = core.splice(j - 1 >= 1 ? j - 1 : j).concat(locality);
          break;
        }
      }
    }

    return {
      core: core.join(' ') + (unit ? ' ' + unit : ''),
      locality: locality.join(' ')
    };
  }

  function addressCore(raw) { return addressParts(raw).core; }

  // A compact stand-in for "which town": the ZIP if we have one, else the state.
  // It belongs in the identity key because two people really can live at the
  // same street address in different towns, and without it "9 Elm St,
  // Springfield IL" and "9 Elm St, Boston MA" key identically. An address with
  // no town at all gets an empty discriminator and is bridged to the others by
  // probablySame(), which treats a missing town as "not stated", not "differs".
  function localityKey(raw) {
    var loc = addressParts(raw).locality;
    if (!loc) return '';
    var toks = loc.split(' ');
    var zip = toks.filter(function (t) { return ZIP.test(t); })[0];
    if (zip) return zip.slice(0, 5);
    var state = toks.filter(function (t) { return STATES[t]; })[0];
    return state || '';
  }

  // Two localities conflict only when both are specific AND disagree. A missing
  // town is not a disagreement — people leave it off.
  function localityConflict(a, b) {
    var la = addressParts(a).locality;
    var lb = addressParts(b).locality;
    if (!la || !lb) return false;

    var za = la.split(' ').filter(function (t) { return ZIP.test(t); })[0];
    var zb = lb.split(' ').filter(function (t) { return ZIP.test(t); })[0];
    if (za && zb) return za.slice(0, 5) !== zb.slice(0, 5);

    var sa = la.split(' ').filter(function (t) { return STATES[t]; })[0];
    var sb = lb.split(' ').filter(function (t) { return STATES[t]; })[0];
    if (sa && sb && sa !== sb) return true;

    return false;
  }

  // --- name normalization ----------------------------------------------------

  function nameTokens(raw) {
    var s = String(raw == null ? '' : raw);
    var swapped = null;
    // "Buyer, Jane" is the same person as "Jane Buyer".
    var comma = s.split(',');
    if (comma.length === 2 && comma[0].trim() && comma[1].trim()) {
      swapped = scrub(comma[1] + ' ' + comma[0]).split(' ').filter(Boolean);
    }
    var direct = scrub(s).split(' ').filter(Boolean);
    return swapped ? [direct, swapped] : [direct];
  }

  function nameKey(raw) {
    var variants = nameTokens(raw);
    // The last-first variant is the canonical one when a comma was used, so
    // "Buyer, Jane" and "Jane Buyer" key the same.
    return (variants[1] || variants[0]).join(' ');
  }

  function initialMatch(a, b) {
    if (a === b) return true;
    if (a.length === 1) return b.charAt(0) === a;
    if (b.length === 1) return a.charAt(0) === b;
    return false;
  }

  // Same first and last name, and the middle names don't contradict. "Jane
  // Buyer" and "Jane A Buyer" are compatible; "Jane A Buyer" and "Jane B Buyer"
  // are not.
  function tokensCompatible(a, b) {
    if (!a.length || !b.length) return false;
    if (a.join(' ') === b.join(' ')) return true;
    if (a[0] !== b[0]) return false;
    if (a[a.length - 1] !== b[b.length - 1]) return false;
    var midA = a.slice(1, -1);
    var midB = b.slice(1, -1);
    if (!midA.length || !midB.length) return true;
    if (midA.length !== midB.length) return false;
    for (var i = 0; i < midA.length; i++) {
      if (!initialMatch(midA[i], midB[i])) return false;
    }
    return true;
  }

  function namesCompatible(rawA, rawB) {
    var as = nameTokens(rawA);
    var bs = nameTokens(rawB);
    for (var i = 0; i < as.length; i++) {
      for (var j = 0; j < bs.length; j++) {
        if (tokensCompatible(as[i], bs[j])) return true;
      }
    }
    return false;
  }

  // --- party identity --------------------------------------------------------

  function fflKey(ffl) {
    return String(ffl == null ? '' : ffl).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // A party as read off one entry.
  function partyOf(entry, which) {
    var prefix = which === 'source' ? 'acquisition.source' : 'disposition.buyer';
    function v(k) {
      var x = BB.currentValue(entry, prefix + k);
      return x == null ? '' : String(x).trim();
    }
    return { name: v('Name'), address: v('Address'), ffl: v('Ffl') };
  }

  // An FFL number is a real identifier issued to one licensee, so it wins
  // outright. Everyone else is identified by normalized name + doorway.
  function identityKey(party) {
    if (!party) return '';
    var ffl = fflKey(party.ffl);
    if (ffl) return 'ffl:' + ffl;
    var n = nameKey(party.name);
    var a = addressCore(party.address);
    if (!n && !a) return '';
    return 'p:' + n + '|' + a + '|' + localityKey(party.address);
  }

  function isLicensee(party) {
    return !!fflKey(party && party.ffl);
  }

  // Would a careful person say these are the same customer? Used to cluster
  // spellings, and deliberately conservative about the address: a different
  // doorway is a different customer, because two people really can share a name.
  function probablySame(a, b) {
    if (!a || !b) return false;
    var fa = fflKey(a.ffl);
    var fb = fflKey(b.ffl);
    if (fa || fb) return fa === fb;
    if (!namesCompatible(a.name, b.name)) return false;
    var ca = addressCore(a.address);
    var cb = addressCore(b.address);
    if (!ca || !cb) return false;
    if (ca !== cb) return false;
    return !localityConflict(a.address, b.address);
  }

  // --- projection ------------------------------------------------------------

  function longest(list) {
    return list.slice().sort(function (x, y) { return y.length - x.length; })[0] || '';
  }

  function pushUnique(list, value) {
    if (value && list.indexOf(value) === -1) list.push(value);
  }

  // Build the customer list from the projected ledger. Every entry contributes
  // its source (who you got it from) and, once disposed, its buyer — both are
  // people you dealt with.
  function customers(entries) {
    var groups = [];

    function absorb(entry, which) {
      var party = partyOf(entry, which);
      if (!identityKey(party)) return;
      var date = which === 'source'
        ? BB.currentValue(entry, 'acquisition.dateReceived')
        : BB.currentValue(entry, 'disposition.date');

      var group = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].key === identityKey(party) || probablySame(groups[i].sample, party)) {
          group = groups[i];
          break;
        }
      }
      if (!group) {
        group = {
          key: identityKey(party),
          sample: party,
          kind: isLicensee(party) ? 'licensee' : 'person',
          ffl: party.ffl,
          names: [],
          addresses: [],
          transactions: []
        };
        groups.push(group);
      }
      pushUnique(group.names, party.name);
      pushUnique(group.addresses, party.address);
      if (!group.ffl && party.ffl) group.ffl = party.ffl;
      group.transactions.push({
        entryId: entry.id,
        entry: entry,
        direction: which === 'source' ? 'acquired' : 'disposed',
        date: date || '',
        serial: BB.currentValue(entry, 'acquisition.serial'),
        firearm: BB.currentValue(entry, 'acquisition.mfrImporter') + ' ' +
                 BB.currentValue(entry, 'acquisition.model'),
        type: BB.currentValue(entry, 'acquisition.type'),
        dispositionType: entry.disposition ? entry.disposition.dispositionType : null
      });
    }

    (entries || []).forEach(function (e) {
      absorb(e, 'source');
      if (e.disposition) absorb(e, 'buyer');
    });

    return groups.map(function (g) {
      g.transactions.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
      var dates = g.transactions.map(function (t) { return t.date; }).filter(Boolean);
      var bought = g.transactions.filter(function (t) { return t.direction === 'disposed'; });
      return {
        key: g.key,
        kind: g.kind,
        ffl: g.ffl,
        // Show the fullest spelling seen — usually the one with the town on it.
        displayName: longest(g.names),
        displayAddress: longest(g.addresses),
        names: g.names,
        addresses: g.addresses,
        spellings: Math.max(g.names.length, g.addresses.length),
        transactions: g.transactions,
        acquiredCount: g.transactions.length - bought.length,
        disposedCount: bought.length,
        handgunsBought: bought.filter(function (t) { return BB.isHandgun(t.type); }).length,
        firstDealt: dates.length ? dates[0] : '',
        lastDealt: dates.length ? dates[dates.length - 1] : ''
      };
    }).sort(function (a, b) { return String(b.lastDealt).localeCompare(String(a.lastDealt)); });
  }

  function find(list, key) {
    return (list || []).filter(function (c) { return c.key === key; })[0] || null;
  }

  function search(list, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return list;
    return (list || []).filter(function (c) {
      var hay = c.names.concat(c.addresses).concat([c.ffl || '']).join(' ').toLowerCase();
      if (hay.indexOf(q) !== -1) return true;
      return c.transactions.some(function (t) {
        return BB.normalizeSerial(t.serial).indexOf(BB.normalizeSerial(q)) !== -1 &&
          BB.normalizeSerial(q).length > 0;
      });
    });
  }

  // --- duplicates ------------------------------------------------------------
  // Customers that clustering did NOT merge but that a person might still call
  // the same: same name at a different doorway, or the same doorway under
  // incompatible names. These are shown for review, never merged automatically —
  // the fix is to correct the entries, which is a logged event.

  function duplicateCandidates(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = list[i];
        var b = list[j];
        if (a.kind === 'licensee' || b.kind === 'licensee') continue;
        var sameName = namesCompatible(a.displayName, b.displayName);
        var sameDoor = addressCore(a.displayAddress) === addressCore(b.displayAddress) &&
          !!addressCore(a.displayAddress);
        if (!sameName && !sameDoor) continue;
        out.push({
          a: a,
          b: b,
          reason: sameName && sameDoor
            ? 'Same name and address, kept apart by a locality that disagrees.'
            : (sameName
                ? 'Same name at a different address — one person who moved, or two people.'
                : 'Same address under names that do not match — a household, or a typo.')
        });
      }
    }
    return out;
  }

  // The corrections that would restandardize one customer's entries onto a
  // chosen spelling. Returns one correction per field that actually differs, so
  // nothing is written that would not change anything.
  function standardizeCorrections(customer, canonicalName, canonicalAddress, which) {
    var out = [];
    (customer.transactions || []).forEach(function (t) {
      var prefix = t.direction === 'acquired' ? 'acquisition.source' : 'disposition.buyer';
      if (which && which !== t.direction) return;
      var name = BB.currentValue(t.entry, prefix + 'Name');
      var address = BB.currentValue(t.entry, prefix + 'Address');
      if (name && canonicalName && name !== canonicalName) {
        out.push({ entryId: t.entryId, field: prefix + 'Name', newValue: canonicalName });
      }
      if (address && canonicalAddress && address !== canonicalAddress) {
        out.push({ entryId: t.entryId, field: prefix + 'Address', newValue: canonicalAddress });
      }
    });
    return out;
  }

  return {
    scrub: scrub,
    addressParts: addressParts,
    addressCore: addressCore,
    localityConflict: localityConflict,
    localityKey: localityKey,
    nameKey: nameKey,
    namesCompatible: namesCompatible,
    fflKey: fflKey,
    partyOf: partyOf,
    identityKey: identityKey,
    isLicensee: isLicensee,
    probablySame: probablySame,
    customers: customers,
    find: find,
    search: search,
    duplicateCandidates: duplicateCandidates,
    standardizeCorrections: standardizeCorrections
  };
});
