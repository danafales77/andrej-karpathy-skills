# Product Requirements — "Bound Book" Budget Tier

**Audience:** Home-based, very small FFLs (Type 01 dealers run from home, Type 03 C&R collectors).
**One-line pitch:** The cheapest way to keep a compliant Acquisition & Disposition (A&D) record — nothing more, nothing you don't need.
**Status:** Draft for review.

> **Not legal advice.** This spec summarizes federal recordkeeping rules (27 CFR Part 478) to scope the product. Confirm current ATF requirements and any state rules with counsel or your ATF Industry Operations office before shipping. Rules change; the code must not hardcode assumptions that go stale silently.

---

## 1. Problem & Opportunity

A licensee must maintain a bound A&D record. Full firearms-retail software (POS, e-4473, inventory, labels, accounting) is overkill and overpriced for someone doing a handful of transfers a year from home. That segment wants one thing: **stay compliant, cheaply.**

A "bound book only" tier is a clean, well-bounded slice of that market. The discipline of this tier is: **strip features aggressively, never strip compliance.**

## 2. Goals / Non-Goals

**Goals**
- Record acquisitions and dispositions with every ATF-required field.
- Produce a searchable ledger and an ATF-ready export/print on demand.
- Preserve record integrity and retention.
- Be dramatically simpler and cheaper than full FFL suites.

**Non-Goals (explicitly out of the budget tier)**
- Point-of-sale / payments
- Integrated e-4473 (separate, heavier regulated workflow)
- Multi-user roles, multi-location
- Barcode/label hardware, scanners
- Accounting, tax, sales reporting
- Inventory valuation / merchandising

These become optional paid add-ons later, not part of the floor.

## 3. The Compliance Floor (non-negotiable, even at $0)

Per firearm the record must capture:

**Acquisition**
- Date received
- Manufacturer and/or importer
- Model
- Serial number
- Type (e.g., pistol, rifle, receiver)
- Caliber / gauge
- Source: name + address, or FFL number if from a licensee

**Disposition**
- Date of disposition
- Buyer/transferee name + address (or FFL number)
- 4473 form serial / transfer reference
- Eligibility documentation trail (the fact that a background check / 4473 was completed and where that paperwork lives)

**Cross-cutting integrity requirements**
- **Retention:** records must be preserved (long-horizon — treat as permanent) and be surrenderable to ATF on license discontinuance.
- **No silent mutation:** entries must not be quietly deleted or overwritten. Corrections follow the "line-out, don't erase" convention — keep the original visible and append the correction with a timestamp and reason.
- **Chronological, gap-free ordering** of entries.
- **Export on demand:** ATF-consumable output (print + PDF + CSV).

If a feature cut would violate any bullet in this section, it is not on the table for the budget tier.

## 4. The Key Decision — Legal Role of the Software (advisory)

You asked which role to pick. Here is the tradeoff and my recommendation.

### Option A — Companion / printable ledger (**recommended for the budget tier**)
The app helps you *keep* the record, but the **printed (or exported PDF) ledger is the official ATF record**. The user prints, signs where required, and stores paper.

- **Pros:** Lowest compliance risk and lowest build cost. No ATF electronic-recordkeeping variance/approval needed. Integrity burden is mostly "generate a clean, correct printout." Perfect fit for someone doing low volume from home.
- **Cons:** User still handles paper. The app is an aid, not the sole legal system.
- **Why it fits:** A budget, home-based FFL is exactly the user who is fine printing a ledger and does not want the obligations of a fully electronic system of record.

### Option B — Electronic system of record
The app **is** the legal bound book; no paper.

- **Pros:** Fully paperless, higher perceived value.
- **Cons:** ATF imposes specific conditions on electronic A&D systems (typically prior approval/variance, guaranteed no data gaps, tamper-evidence, reliable reproduction on demand, defined backup/continuity). Materially more to build, test, and stand behind legally. Overkill for the budget persona.

### Recommendation
**Ship Option A as the default and let Option B be switched on by the licensee
who holds the approval.** The integrity work was built on the append-only model
from the start, so supporting both is a matter of what the product *claims*
rather than how it stores anything.

This replaces an earlier recommendation to operate unconditionally as Option B
on the strength of one licensee's approved variance. Per-licensee configuration
is the only version of that which can ship to a second customer.

### Option B — available, and configured per licensee

**Correction to an earlier version of this document.** This section previously
recorded the variance as approved and described the app as operating
unconditionally as the electronic system of record. That was true of one
licensee and got baked into the product: the UI asserted "ATF variance on file"
as fact for every install. A claim about a licensee's regulatory standing cannot
be a constant in the source.

Both options now ship, selected in *Licensee → Record mode*, **defaulting to
Option A**. Option B additionally requires a recorded variance reference before
it takes effect — an unnamed approval is treated as no approval, and the app
says so rather than quietly proceeding. Where Option B is in force, its
requirements are met as follows:

- **Tamper-evidence** — an append-only, **hash-chained event log**
  (`integrity.js`): every action (acquire, dispose, correct) is an immutable
  event; the ledger is a *projection* of the log, never edited in place. Each
  event hashes its contents plus the previous event's hash, so any after-the-fact
  edit, deletion, or reorder breaks the chain and is detected.
- **No data gaps** — sequential numbering verified on demand (the **Integrity**
  screen).
- **Reproduction on demand** — Print / Save-as-PDF and CSV export produce the
  human-readable / surrender copy.
- **Backup & continuity** — full-fidelity JSON backup of the entire chained log,
  with **verify-on-restore**: a tampered or corrupt backup fails the integrity
  check and is refused rather than loaded. Because the build is local-first, the
  user's backup is the continuity + surrender copy; regular backup is now a
  compliance step, surfaced in the first-run notice and on the Integrity screen.

Under Option B, print/PDF/CSV are the human-readable surrender copies and the
chained log is the system of record. Under Option A the printed ledger *is* the
record. The printout states which, so nobody reading it has to guess.

## 5. Scope — Screens

1. **Acquire** — form to log an incoming firearm (all Acquisition fields), with bulk serial entry for a single shipment.
2. **Dispose** — select an open (undisposed) firearm, pick how it left, log the fields that disposition type actually requires.
3. **Inventory** — what is on hand, aged; the alarms the record raises about itself; physical inventory counts.
4. **Ledger** — chronological, searchable/filterable list; shows open vs. closed entries; correction history visible.
5. **Export / Print** — ATF-ready PDF, printable ledger with corrections appendix and certification block, CSV backup, date-range filtering, discontinuance bundle.
6. **Integrity** — chain verification, head hash, backup/restore (plain or encrypted).
7. **Customers** — everyone on the other side of an entry, projected from the log.
8. **Packages** — inbound carrier tracking (explicitly outside the legal record).

Supporting (not full screens): licensee profile (name, FFL#, address, certifying
name, backup cadence, alarm thresholds), and a first-run disclaimer.

### Dispositions are not all the same shape

A single required-field list across all dispositions was a design error: it made
a theft, an FFL-to-FFL transfer and a destruction all demand a 4473 number,
which meant the only way to record them was to invent one. Each disposition type
now carries its own required fields (see the app README for the table). This is
a compliance-floor issue, not a convenience one — a record you cannot make a
true entry in is not a compliant record.

### Customers are a projection, never a second source of truth

The people named in the record are not a separate table. They are computed from
the log on demand, which means there is nothing to keep in sync, nothing to
back up separately, and no way to change a customer except by correcting the
entries that name them — through the same append-only path as any other fix.

This also fixed a defect worth recording: the multiple-handgun alarm originally
grouped sales by an exact match on the buyer's name and address strings, so it
only fired when the licensee typed both identically each time. Measured against
six ordinary spelling variations, it caught one. A compliance alarm that depends
on perfect data entry is worse than no alarm, because a silent one reads as an
all-clear. **Any future alarm that keys on a person must key on customer
identity, not on the raw strings.**

**PII floor:** the bound book needs a name and address, or an FFL. The customer
module stores exactly that and no more — no dates of birth, ID numbers, phone
numbers or email addresses. Anything richer belongs on the 4473, and duplicating
it here would create a second, less protected copy of the most sensitive data in
the business for no compliance benefit.

### Alarms are policy settings, not legal constants

The app surfaces patterns already present in the data: multiple handguns to one
non-licensee inside a window, entries that reached the book later than policy
allows, firearms open far longer than usual. Every threshold is user-configurable
and labelled as the licensee's policy, because each approximates a rule with
conditions this app does not model (and state variants it does not know). The
code must not encode a legal threshold as a constant that goes stale silently.

## 6. Data Model (sketch)

- **Firearm/Entry** (one row = one firearm's lifecycle)
  - `id`, acquisition fields, disposition fields (nullable until disposed), `status` (open/disposed), `created_at`.
- **Correction** (append-only)
  - `entry_id`, `field`, `old_value`, `new_value`, `reason`, `corrected_at`. Never mutate the original field in place — render the line-out from these records.
- **LicenseeProfile** — header data for exports, backup cadence, alarm thresholds.
- **InventoryCount** (append-only, in the chain) — a dated attestation of what was
  physically found: expected vs. found, what was missing, and what was present but
  not in the book. Not part of any firearm's A&D line; it is a fact about the record.

Integrity rules enforced at the data layer: no hard deletes of entries; edits to regulated fields go through the Correction append path.

## 7. Success Criteria

- A user can log an acquisition, later log its disposition, and produce a PDF that contains **every** required field in ATF-acceptable form.
- No regulated field can be silently deleted or overwritten; every correction is visible with timestamp + reason.
- Full ledger exports to CSV for backup and to PDF for ATF.
- Zero features from the Non-Goals list ship in this tier.

## 8. Open Questions

1. **State-level rules** — any target states with extra logging (e.g., specific record formats, additional retention)? Budget tier may need a "state notes" flag. **Still open.** The alarm thresholds are configurable partly to absorb state variation, but nothing models a state rule directly.
2. ~~**Multi-firearm transactions**~~ — **Answered: support them.** One shipment is one form fill with a pasted list of serials; each serial still becomes its own entry with its own line. Strict one-at-a-time was costing real users real minutes per shipment for no compliance benefit.
3. ~~**Backup responsibility**~~ — **Answered: more than export.** Full-fidelity chained JSON backup, change-based and calendar-based reminders, verify-on-restore, chain comparison before any destructive restore, and passphrase-encrypted backups so the offsite copy can live in a synced folder. What remains manual is *moving* the file offsite.
4. **Distribution** — **now the most consequential open question.** Local-first is right for this audience, but browser local storage is not a safe home for a legal record: browser settings can clear it, and a `file://` page cannot use the File System Access API to own a real file (no secure context). Writes are checked and failures are loud, which is the ceiling for this substrate. A desktop wrap (Tauri/Electron) owning a real file on disk is the fix. **Decision needed.**
5. ~~**Upgrade path**~~ — **Answered: committed, and done.** The variance is approved and the app operates as Option B.
6. **NFA / SOT items** — deliberately out of scope so far. A different recordkeeping regime with its own forms, approvals and retention. **Decision needed on whether this becomes a separate tier or stays permanently out.**

## 9. Deliberately excluded

Beyond the Non-Goals in §2:

- **NFA / SOT recordkeeping.** Supporting it halfway is worse than not supporting it.
- **"Do not transfer" flags on customers.** Recording an adverse judgment about a named individual inside a compliance record has real consequences for that person and is the licensee's decision, not a default feature. Eligibility is determined by a background check at the time of transfer, never by a note in this app. Open for discussion, not shipped by assumption.
- **Customer PII beyond the compliance floor.** See the PII floor above.
- **Legal thresholds as constants.** Every deadline and threshold is a user setting with a stated caveat, not a number in the source that quietly goes stale.
- **Any claim the software cannot back.** The hash chain proves no in-place edit; it does not prove no wholesale regeneration, and the docs and UI say so and give the user an external anchor instead.
