# ADR-001 — Where the record physically lives

**Status:** Open. Needs a decision from the product owner.
**Date raised:** 2026-09-16
**Blocks:** any licensee relying on this app as their bound book.

> Not legal advice. The regulatory framing below is a summary written to scope a
> technical decision, not a reading of current ATF rules. Confirm retention and
> reproduction requirements before relying on any of it.

## The problem

The record lives in browser **local storage**, reached from a `file://` page.
That was the right call for a prototype: no install, no server, no build step,
data never leaves the machine. It is the wrong call for a legal record with
long-horizon retention, for one reason:

**Browser local storage is not durable against ordinary user actions.** Clearing
browsing data, clearing site data, resetting or recreating a browser profile, or
some privacy-tool cleanups will delete it. None of these look like "delete my
firearms record" to the person doing them. There is no undo and no warning.

Two mitigations already shipped and neither closes the gap:

- Writes are checked and read back; a failed write raises an alarm that stays
  (commit `252f933`).
- A damaged record is detected and refuses to be written over, rather than
  rendering as an empty book (commit `455ec36`).

Both handle *failure to write* and *damage in place*. Neither can survive the
store simply being gone, because by then there is nothing left to detect.

The backup story (chained JSON, verify-on-restore, change- and calendar-based
reminders, passphrase encryption) is the real safety net today. That makes the
current posture: **the record's durability depends on the licensee remembering
to back up.** That is acceptable for a prototype and not acceptable for a
product whose entire pitch is compliance.

## What is explicitly NOT the fix

**The File System Access API.** It would let the page own a real file the user
picks, which is exactly the shape we want — but it requires a secure context,
and a double-clicked `file://` page is not one. Adopting it means serving the
app over `http://localhost` or packaging it, at which point we are already in
one of the options below. It is not an incremental improvement on the current
design.

## Options

### A. Desktop wrap (Tauri or Electron)

Package the existing HTML/JS as a desktop app that owns a real file on disk.

- **Durability:** solved. A file in the user's documents folder, backed up by
  whatever backs up their machine, invisible to browser data clearing.
- **Unlocks:** atomic writes, automatic versioned local backups, encryption at
  rest via the OS keychain, a real "open/save as" story, and an obvious home for
  the carrier poller that currently has to be run by hand.
- **Costs:** a build and release pipeline where there is currently none; code
  signing on both platforms (an Apple Developer account and a Windows
  certificate, both recurring costs) or users get scary warnings; an update
  mechanism; per-platform testing. Tauri is far smaller to ship than Electron
  and needs a Rust toolchain; Electron is heavier but better trodden.
- **Keeps:** the whole codebase. The UI is already storage-agnostic behind a
  handful of `persist()` / `readJson()` calls.

### B. Local server (a small Node process the user runs)

Serve the app from `localhost` and persist through a tiny local API.

- **Durability:** solved, same as A — a real file.
- **Unlocks:** the File System Access API becomes available (secure context),
  and the carrier poller could live in the same process instead of the current
  download-a-file / import-a-file round trip.
- **Costs:** the user has to start a process. For the stated audience — a
  home-based FFL who wants to double-click a file — that is a real usability
  regression and a support burden. Windows service / launch-at-login work claws
  some of it back and adds its own complexity.
- **Note:** this is roughly what the existing `tracker/` poller already assumes,
  so it is less of a departure than it first appears.

### C. Stay put, and be loud about it

Keep local storage, make the backup story mandatory in practice: refuse to run
past N unbacked-up changes, nag harder, block on a stale backup.

- **Durability:** not solved. Moved onto the user's discipline.
- **Costs:** near zero to build.
- **Honest assessment:** this is the current position plus friction. It is a
  reasonable holding pattern while A or B is built, and not a destination.

## Recommendation

**Option A with Tauri.** It solves the actual problem, keeps every line of the
existing app, matches the local-first and privacy posture that makes this
product attractive to its audience, and the audience already expects to install
software on the shop PC. The real cost is not engineering — it is code signing
and the release pipeline, which are ongoing obligations rather than one-off
work, and should be budgeted as such before starting.

Option B is the cheaper path to durability and the wrong trade for this
audience. Option C is what we are doing now and should not be mistaken for a
decision.

## What the decision needs from the owner

1. **Is a desktop install acceptable** to the target licensee, or is
   double-click-a-file a hard product constraint?
2. **Is there budget and appetite** for code signing certificates and an update
   pipeline as recurring costs?
3. **Which platforms?** Windows only (the shop PC) materially reduces the work
   versus Windows + macOS.

Until this is decided, the product should keep saying plainly what it does
today: the backup is the record's real home. The README does.
