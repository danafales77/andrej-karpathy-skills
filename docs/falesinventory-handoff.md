# Handoff — starting a Claude Code session on FalesInventory

This exists because the work on FalesInventory has to happen **on Shop-PC-Tower**.
A cloud session cannot reach `C:\Fales Guns Website\inventory program\FalesInventory`,
and a session started there begins with no memory of the conversation that
produced this file.

## Starting it

In a terminal on Shop-PC-Tower:

```
cd "C:\Fales Guns Website\inventory program\FalesInventory"
git checkout feat/spanish-4473-multi-ffl
claude
```

That session works on local files. Nothing in it touches GitHub unless you ask
it to.

## First message to paste

Everything below the line is written to stand alone. Paste it as the opening
message.

---

I'm working in FalesInventory on branch `feat/spanish-4473-multi-ffl`.
**Never push, never touch GitHub — local commits only.**

Start by orienting me, before changing anything:

1. What is this program, and what does it do?
2. Where does the inventory data live, and in what format?
3. How is that data read at startup?
4. Are there any automated tests or CI?

Then check for one specific bug class. In a sibling prototype (a browser-based
A&D bound book) the record loader treated two different failures as the same
thing:

```js
try { return JSON.parse(stored) || []; }
catch (e) { return []; }          // <- "corrupt" became "empty"
```

The consequence was serious. Truncating the stored record made the app report
*"No entries yet"* with no warning anywhere. A user would have concluded nothing
was lost and started writing new entries on top of the damaged data.

**Check whether this codebase has the same flaw:**

- Find where persisted inventory data is loaded at startup.
- Look for any catch/rescue/error path that falls back to an empty collection,
  empty list, or fresh database on a read or parse failure.
- If you find one, **prove it before fixing it**: damage the stored data, start
  the program, and see whether it reports the damage or reports emptiness.

If it is there, the fix shape that worked in the prototype was:

- Report **empty / ok / corrupt** as three distinct states. Never return a
  usable-looking empty collection for a corrupt read.
- On corrupt: refuse to write anything, say so unmissably and persistently, and
  preserve the damaged bytes for salvage — they are often partly recoverable and
  are the only copy of anything since the last backup.
- Make restore-from-backup the remedy, and have a successful restore clear the
  state.
- Keep *corruption* and *tampering* as separate failures with separate remedies:
  unreadable bytes mean restore; a record that reads fine but fails an integrity
  check means something changed the history, which is a different conversation
  and should not block new entries.

Do not port code blindly. I don't know whether this project shares a language,
a storage layer, or an architecture with that prototype. Reproduce first, then
propose a fix that fits *this* codebase, and show me the diff before committing.

---

## Context worth knowing, if it comes up

These are conclusions from reviewing the sibling prototype. They may or may not
apply here — treat them as questions to ask of FalesInventory, not findings
about it.

- **A compliance alarm that depends on perfect data entry is worse than none.**
  The prototype's multiple-handgun-sale alarm grouped sales by an exact string
  match on buyer name and address, so it only fired when the licensee typed both
  identically each time. Against six ordinary spelling variations it caught one.
  A silent alarm reads as an all-clear. If FalesInventory has any alarm that
  groups by a person, check what it keys on.
- **Whatever gets handed to an inspector must show corrections.** The prototype's
  printout rendered only corrected values, so the one artifact that leaves the
  building looked like a silent overwrite of a regulated record.
- **A disposition is not always a 4473 sale.** If the disposition form requires
  4473 fields unconditionally, there is no way to record a theft, an FFL-to-FFL
  transfer, a destruction, or a return to owner without inventing data.
- **Don't hardcode a regulatory claim.** The prototype asserted "ATF variance on
  file" as fact in its UI — true for one licensee, wrong for anyone else it
  shipped to. Anything the software asserts about a licensee's standing should be
  configured by that licensee.
- **Legal thresholds don't belong in source as constants.** Deadlines and limits
  should be settings with stated caveats, so they can't go stale silently.
