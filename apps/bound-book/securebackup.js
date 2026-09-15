// securebackup.js — passphrase-encrypted backups.
//
// The plain .json backup is the continuity copy, but it is also the entire
// record in the clear: names, addresses and serial numbers. That is fine on a
// drive in a safe and not fine in a synced cloud folder, which is exactly where
// an offsite copy wants to live. This module encrypts the same backup envelope
// under a passphrase so the offsite copy can go anywhere.
//
// AES-256-GCM (authenticated: a modified ciphertext fails to decrypt rather
// than decrypting to garbage), key derived with PBKDF2-SHA256. Both halves come
// from the platform's own WebCrypto — no crypto is hand-rolled here.
//
// Everything is async because WebCrypto is. Runs in the browser
// (window.SecureBackup) and in Node 18+ (require) for tests.
//
// WHAT THIS DOES NOT DO: it does not move the file offsite. A browser page
// opened from file:// cannot reach your cloud storage, and it never will — see
// the README. This makes the copy safe to put somewhere; putting it there is
// still yours to do.

(function (root, factory) {
  var integrity = (typeof module === 'object' && module.exports) ? require('./integrity.js') : root.Integrity;
  var mod = factory(integrity);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SecureBackup = mod;
})(typeof self !== 'undefined' ? self : this, function (INT) {
  'use strict';

  var APP = 'bound-book';
  var FORMAT = 'aes-256-gcm/pbkdf2-sha256';
  // Cost of one passphrase guess. Raising this is the only defence against a
  // weak passphrase, and it is stored in the file so old backups stay readable
  // after the default changes.
  var ITERATIONS = 310000;
  var SALT_BYTES = 16;
  var IV_BYTES = 12;

  function subtle() {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (!c || !c.subtle) {
      throw new Error(
        'Encrypted backup needs WebCrypto, which this browser is not exposing. ' +
        'Plain .json backup still works; keep it somewhere you control.'
      );
    }
    return c;
  }

  function toBytes(str) {
    return new TextEncoder().encode(str);
  }

  function fromBytes(bytes) {
    return new TextDecoder().decode(bytes);
  }

  // Chunked so a large record does not blow the argument limit on apply().
  function b64encode(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function b64decode(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function deriveKey(passphrase, salt, iterations) {
    var c = subtle();
    return c.subtle.importKey('raw', toBytes(passphrase), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return c.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      });
  }

  function passphraseProblems(passphrase) {
    var p = String(passphrase == null ? '' : passphrase);
    var errors = [];
    if (p.length < 12) {
      errors.push('Use at least 12 characters — this passphrase is the only thing between the file and whoever finds it.');
    }
    return errors;
  }

  // Encrypt a backup envelope (the object makeBackup() returns). Resolves to the
  // text to write to disk.
  function encryptBackup(backup, passphrase, exportedAt) {
    return Promise.resolve().then(function () {
      var c = subtle();
      var salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
      var iv = c.getRandomValues(new Uint8Array(IV_BYTES));
      return deriveKey(passphrase, salt, ITERATIONS).then(function (key) {
        return c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, toBytes(JSON.stringify(backup)));
      }).then(function (buf) {
        return JSON.stringify({
          app: APP,
          encrypted: true,
          format: FORMAT,
          iterations: ITERATIONS,
          exportedAt: exportedAt,
          salt: b64encode(salt),
          iv: b64encode(iv),
          ciphertext: b64encode(new Uint8Array(buf))
        }, null, 2);
      });
    });
  }

  function isEncryptedBackup(text) {
    try {
      var d = JSON.parse(text);
      return !!(d && d.app === APP && d.encrypted === true && d.ciphertext);
    } catch (e) {
      return false;
    }
  }

  // Decrypt and then run the SAME integrity check a plain restore runs: a
  // backup that decrypts cleanly but fails the chain check is still refused.
  // Resolves to { ok, log } or { ok:false, error }.
  function decryptBackup(text, passphrase) {
    return Promise.resolve().then(function () {
      var data;
      try { data = JSON.parse(text); }
      catch (e) { return { ok: false, error: 'Not a valid backup file (could not read JSON).' }; }
      if (!data || data.app !== APP || !data.encrypted || !data.ciphertext) {
        return { ok: false, error: 'This does not look like an encrypted Bound Book backup.' };
      }
      if (data.format && data.format !== FORMAT) {
        return { ok: false, error: 'Unsupported encryption format: ' + data.format };
      }
      var c = subtle();
      var iterations = parseInt(data.iterations, 10) || ITERATIONS;
      return deriveKey(passphrase, b64decode(data.salt), iterations)
        .then(function (key) {
          return c.subtle.decrypt(
            { name: 'AES-GCM', iv: b64decode(data.iv) }, key, b64decode(data.ciphertext)
          );
        })
        .then(function (buf) {
          return INT.parseBackup(fromBytes(new Uint8Array(buf)));
        })
        .catch(function () {
          // GCM cannot tell "wrong passphrase" from "altered file" — both fail
          // the authentication tag. Say both.
          return { ok: false, error: 'Could not decrypt: wrong passphrase, or the file has been altered.' };
        });
    });
  }

  return {
    FORMAT: FORMAT,
    ITERATIONS: ITERATIONS,
    passphraseProblems: passphraseProblems,
    encryptBackup: encryptBackup,
    isEncryptedBackup: isEncryptedBackup,
    decryptBackup: decryptBackup
  };
});
