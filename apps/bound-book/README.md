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
  name + address or FFL number). One shipment of identical firearms is **one
  form fill**: paste the rest of the serial numbers and each gets its own entry.
- **Dispose** — record where an open firearm went. A firearm can leave in more
  than one way, and the **disposition type** decides which facts the record
  needs (see below).
- **Inventory** — what you still have on hand, how long you have held it, the
  alarms the record raises about itself, and **physical inventory counts**.
- **Ledger** — searchable, chronological view of every entry.
- **Correct** — append-only corrections: the original value is never erased,
  it's shown struck-through with the reason and the new value (the "line-out,
  don't erase" convention).
- **Export / Print** — print or **Save as PDF** for your official record, and
  download a **CSV** as your backup. Date-range filtering, a corrections
  appendix, a certification block, and a one-click **discontinuance bundle**.
- **Packages** — track what is inbound from USPS, UPS and FedEx, and catch the
  gap between *delivered* and *written into the bound book* (see below).
- **Integrity** — every action is stored in an append-only, **hash-chained**
  event log; the screen verifies the chain (no gaps, nothing altered) and shows
  the full audit trail. Also holds **backup / restore**, plain or
  **passphrase-encrypted**, with verify-on-restore.

## The record model (important)

With the **ATF variance approved**, this app is the **electronic system of
record**. The record is a tamper-evident, hash-chained, append-only log:

- There is no edit-in-place or delete — the only way to change a recorded value
  is a **logged correction**, so the record stays tamper-evident by construction
  (see the **Integrity** screen and `integrity.js`).
- Print / Save-as-PDF and CSV remain available as the human-readable
  **surrender copy**, but they are no longer the system of record — the log is.
  **They carry the corrections with them**: the original value appears struck
  through in the printed ledger, and every correction is listed in full in the
  appendix, so the surrender copy can never look like a silent overwrite.

### How a firearm can leave

One required-field list for every disposition forced people to type fictional
data into a regulated record — there was no way to log a theft without inventing
a 4473 number. Each type now carries its own requirements:

| Type | Requires | Transferee |
|------|----------|------------|
| Sale / transfer to a non-licensee | date, 4473 reference, eligibility documentation | name + address, or FFL |
| Transfer to a licensee (FFL-to-FFL) | date | name + address, or FFL |
| Returned to the person it came from | date | name + address, or FFL |
| Theft or loss | date, ATF / police report reference | none |
| Destroyed / scrapped | date, note | none |
| Transferred to personal collection | date, note | none |

Entries recorded before disposition types existed read as 4473 sales, which is
what they were.

> Reporting a theft or loss to ATF and to local law enforcement is a **separate,
> time-limited obligation** that this app does not perform. It records that it
> happened; you make the report.

### Back up — it's now a compliance step

Because the record lives on this machine, **your backup is the continuity copy
and the surrender copy**. Use **Integrity → Download full backup (.json)**
regularly. Restore verifies the chain on import and **refuses a tampered or
corrupt backup** rather than loading it.

The Integrity screen also tracks your last backup: it shows a warning whenever
entries have been recorded since — *"N changes have been recorded since your
last backup"* — and clears to *"All changes backed up"* once you download a
current copy. This is a local nudge only; it does not store backups for you or
replace keeping an offsite copy.

**Backup cadence (policy).** In *Licensee → Backup policy* you can set a
required backup interval in days. When your record is otherwise fully backed up
but the last backup is older than that interval, the Integrity screen reminds
you. Set the interval to whatever your variance requires; `0` turns the
time-based reminder off. **Moving a copy offsite is a manual step this
local-first app cannot do for you.**

**Encrypted backups.** A plain backup is your whole record in the clear — names,
addresses, serial numbers. That is fine on a drive in a safe and not fine in a
synced cloud folder, which is exactly where an offsite copy wants to live.
*Integrity → Encrypted backup* produces the same record under a passphrase
(AES-256-GCM, PBKDF2-SHA256, both from the platform's own WebCrypto — nothing
hand-rolled). Restore accepts either kind and asks for the passphrase when it
needs one. **Lose the passphrase and the file is gone with it**; there is no
recovery, by design.

### Restore will not quietly drop your record

Restore is the only action in the app that can destroy recorded history, so it
compares the two chains first and says exactly what is at stake:

- **identical** — nothing to do, and it says so rather than "restoring".
- **the backup continues this record** — safe; nothing recorded here is lost.
- **the backup is older** — names how many recent events would be dropped.
- **the two histories disagree** — names where they diverge. This is almost
  always the wrong file.

### What the hash chain does and does not prove

The chain proves nobody edited the history **in place**: change one recorded
byte and every hash after it stops matching. It **cannot** prove nobody
regenerated the whole history from scratch, because whoever holds the file can
recompute every hash in it.

Closing that gap needs an anchor kept **outside** the file. *Integrity → Head
hash* shows the one string that stands for every byte of your history. Write it
down somewhere you do not control — it prints on every page of the ledger, and
it is worth filing with each backup or mailing to yourself. A regenerated chain
will not match the copy you anchored.

### If this device cannot save

Every write is checked and read back. If the browser refuses one — quota,
private mode, blocked site data — a red banner appears and stays: the record in
the window is complete, the record on disk is not, and the only safe move is to
export immediately. Nothing is silently accepted.

This is the honest limit of a `file://` page: **the record lives in browser
local storage, which browser settings can clear.** The fix is a different
storage substrate, not a bigger warning — a desktop wrap (Tauri/Electron) that
owns a real file. The File System Access API is not that fix: it needs a secure
context, which a double-clicked `file://` page is not. Until then, treat the
backup as the record's real home.

## Inventory and physical counts

The **Inventory** screen answers "what do I have right now" — count, handgun
count, longest-held and typical days in inventory, a breakdown by type, and the
on-hand list sorted oldest first. Search matches a serial typed without its
punctuation, because `AB-123` and `ab123` are the same firearm to everyone
except a string comparison.

**Physical inventory** is the part every licensee does on paper before an
inspection. Start a count, walk the shelf, scan or type each serial (it ticks
itself off), and record anything you find that the book does **not** account
for — the direction of a discrepancy people forget to look for. Finishing a
count writes one dated `inventory` event into the chain: the licensee's
tamper-evident attestation of what was physically present, discrepancies and
all. It cannot be edited afterwards. Counts do not appear in the A&D projection
— they are about the record, not about any one firearm's line in it.

## Alarms the record raises about itself

The data was always there; nothing surfaced it. All thresholds live in
*Licensee → Alarm thresholds*.

- **Multiple handguns to one buyer.** Two or more handguns sold to the same
  non-licensee inside a short window triggers a separate report to ATF. The app
  detects the pattern and names the serials. Frames and receivers are
  deliberately **not** counted — whether a given frame counts is a legal
  question this app does not answer.
- **Entries that reached the book late.** The gap between when something
  happened and when it was written down. Retrospective by nature — the app
  cannot know about a transfer nobody entered — but it is exactly the pattern an
  inspection looks for, so it is better to find it yourself first.
- **Firearms open far longer than usual.** Usually a consignment that went quiet
  or a transfer nobody wrote down.

> These thresholds approximate rules that have conditions this app does not
> model, and they vary by state. They are **your policy settings**. Confirm the
> real ones and set them accordingly.

## Inspection and discontinuance

*Export / Print* takes a **date range** and an **open entries only** filter, so
you can produce the period an inspector asked for instead of the whole book.
Every printout carries the licensee header, the range, the chain verification
line and the head hash; a repeating footer puts the licensee and head hash on
every sheet. (Page **numbers** come from your browser's own "Headers and
footers" print option — a page counter is not something CSS gives a web page.)

**Discontinuance bundle** produces, in one click, the complete record as JSON
and CSV plus the full printable copy: every entry, the corrections appendix, the
physical count history, and a certification block to sign.

## Inbound packages

A firearm that arrives is an acquisition waiting to be logged. This screen
tracks what is on its way and flags the gap between the two.

It is deliberately **not** an email scraper. Status comes from the carriers'
own APIs, which means it also sees the things no email would ever tell you:

- a package that **stopped scanning** four or more days ago;
- a package **past the date you expected it**;
- a package **delivered but not yet in the bound book** — escalating once more
  than one business day has passed, since an acquisition is due by the close of
  the next business day after receipt.

**Log as acquisition** carries a delivered package into the Acquire form with
the delivery date prefilled, then links the two so the reminder clears. The
firearm's details are still yours to enter — tracking cannot tell you what was
in the box.

### It is not part of the legal record

Package data lives in its own store, outside the hash-chained log. Carrier
status is third-party logistics information, not a regulated A&D field, so
putting it in the chain would pad your system of record with noise you cannot
correct or remove. Rows on this screen can be edited and deleted freely. The
only thing that ever reaches the chain is an acquisition you log yourself.

### There is no "everything coming to my address" API

Worth stating plainly, because it shapes the design. USPS, UPS and FedEx all
offer tracking APIs that take a *tracking number*. None offers a feed of
everything inbound to an address — the consumer dashboards that show that
(Informed Delivery, UPS My Choice, FedEx Delivery Manager) are web pages with
no public API.

So the poller in [`tracker/`](tracker/) does two separate things: it signs in to
those dashboards to **discover tracking numbers**, then resolves every number
against the **official API** for real status. Your carrier passwords are never
stored — you sign in yourself once per carrier in a real browser window, and
only the session is saved.

The poller is a separate Node program because this app has no server and never
gets one: a `file://` page cannot call those APIs, and an API secret in a web
page is a published secret. The two halves meet over a file, the same way
backup and restore already work:

```
Packages → Download tracking list   →   node poll.js poll --list tracking-list.json
                                    →   Packages → Import snapshot
```

Setup, credentials and options: [`tracker/README.md`](tracker/README.md).

## Field suggestions

Manufacturer, type and caliber offer suggestion lists while staying free text —
ATF's own type field is free text and real records contain everything from
"pistol" to "receiver". Consistent spelling is what makes a ledger legible to an
inspector and what makes the handgun alarm work; a closed dropdown would just
block the entry a real shipment needs. **The manufacturer list is a convenience
list, not ATF's official manufacturer/importer abbreviation list.**

## Layout

| File | Role |
|------|------|
| `core.js` | Pure logic: validation, entry model, disposition types, append-only corrections, field vocabularies, CSV. Storage-agnostic; runs in browser and Node. |
| `integrity.js` | Hash-chained, append-only event log: SHA-256, chain verification (no-gaps + tamper), chain comparison for safe restore, head hash, projection to ledger entries. |
| `inventory.js` | Pure logic for on-hand inventory, aging, physical inventory counts, and the record's self-raised alarms. |
| `packages.js` | Pure logic for the inbound package registry: carrier detection, status normalization, staleness, reconciliation against the ledger. Outside the chain by design. |
| `securebackup.js` | Passphrase-encrypted backups (AES-256-GCM + PBKDF2 via WebCrypto), verify-on-decrypt. |
| `tracker/` | Node poller: official USPS/UPS/FedEx APIs for status, portal sign-in for discovery. Has its own README. |
| `*.test.js` | Node tests. Run: `node --test` |
| `index.html` / `app.js` / `styles.css` | UI, localStorage persistence, print stylesheet. |

## Test

```
cd apps/bound-book
node --test
```

Logic tests need nothing but Node. `smoke.test.js` drives the real page in a
real browser and covers the wiring — it **skips** unless Playwright happens to
be installed:

```
npx playwright install chromium && node --test
```

Playwright is not a dependency of this project and will not become one: the app
ships as a double-clickable file with no build step.

## Not in this tier (by design)

POS/payments, integrated e-4473, multi-user roles, multi-location, barcode
hardware, accounting. See the PRD for the intended upgrade path.

**NFA / SOT items are explicitly out of scope.** They are a different
recordkeeping regime with their own forms, approvals and retention rules, and
supporting them halfway would be worse than not supporting them at all. If you
deal in NFA items, this app is not your record for them.

> Not legal advice. Requirements summarized from 27 CFR Part 478. Confirm
> current ATF rules and any state requirements for your situation before
> relying on this.
