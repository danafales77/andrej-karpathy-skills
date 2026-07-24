# Bound Book — budget A&D record (prototype)

A deliberately tiny, local-first tool for keeping a firearms **Acquisition &
Disposition (A&D)** record. Built for home-based, very small FFLs (Type 01 home
dealers, Type 03 C&R collectors) who want to stay compliant without a full
POS/inventory suite.

Scope and rationale live in [`../../docs/bound-book-budget-prd.md`](../../docs/bound-book-budget-prd.md).

## Run it

No install, no server, no build step. Open `index.html` in any modern browser
(double-click it, or `File → Open`). All data stays **on your machine** in the
browser's local storage — nothing is sent anywhere.

## What it does

- **Acquire** — log a firearm coming in (all ATF-required fields; source by
  name + address or FFL number).
- **Dispose** — record where an open firearm went (buyer, 4473 reference,
  eligibility documentation note).
- **Ledger** — searchable, chronological view of every entry.
- **Correct** — append-only corrections: the original value is never erased,
  it's shown struck-through with the reason and the new value (the "line-out,
  don't erase" convention).
- **Export / Print** — print or **Save as PDF** for your official record, and
  download a **CSV** as your backup.

## The record model (important)

This budget tier follows the **companion / printable ledger** approach: the
**printed or PDF ledger is your official ATF record**. The app helps you keep
it and print it; you store the output. Export a CSV regularly as backup.

There is no edit-in-place or delete: the only way to change a recorded value is
a logged correction, so the record stays tamper-evident by construction.

> Not legal advice. Requirements summarized from 27 CFR Part 478. Confirm
> current ATF rules and any state requirements for your situation before
> relying on this.

## Layout

| File | Role |
|------|------|
| `core.js` | Pure logic: validation, entry model, append-only corrections, CSV. Storage-agnostic; runs in browser and Node. |
| `core.test.js` | Node tests for `core.js`. Run: `node --test` |
| `index.html` / `app.js` / `styles.css` | UI, localStorage persistence, print stylesheet. |

## Test

```
cd apps/bound-book
node --test
```

## Not in this tier (by design)

POS/payments, integrated e-4473, multi-user roles, multi-location, barcode
hardware, accounting. See the PRD for the intended upgrade path.
