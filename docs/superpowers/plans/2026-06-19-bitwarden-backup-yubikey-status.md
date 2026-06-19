# bitwarden-backup YubiKey — Work Status / Resume Handoff

**Status:** ⏸️ PARKED (blocked on hardware confirmation) as of 2026-06-19.

This file is the source of truth for resuming this work on another machine.
It contains no secrets. A machine-local execution ledger also exists at
`.git/sdd/progress.md`, but `.git` is not pushed — do not rely on it after a
fresh clone; this file is self-contained.

## What this work is

Add YubiKey support to the `bitwarden-backup` image so
`BITWARDEN_AGE_RECIPIENTS` can include hardware-backed age recipients.

- **Spec:** `docs/superpowers/specs/2026-06-19-bitwarden-backup-yubikey-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-19-bitwarden-backup-yubikey.md`
- **Branch:** `feat/bitwarden-backup-image` (this is PR #1; the YubiKey work is a
  follow-up committed onto the same branch). Rebased on `main`; the duplicate
  root `renovate.json` from Renovate onboarding has been removed (config lives
  at `.github/renovate.json`).
- **Execution method:** superpowers `subagent-driven-development` skill (fresh
  implementer subagent per task, task review after each, final whole-branch
  review at the end).

## Why it is parked

The design uses `age-plugin-yubikey`, which is **PIV-based**. The YubiKey
available at the time of this work was a **Security Key NFC** — a FIDO-only
device with **no PIV applet** (`ykman info` showed `PIV: Not available`), so
`age-plugin-yubikey` cannot work with it.

The operator has a different set of keys elsewhere, believed to be **YubiKey 5**
(which has PIV). Work is paused until that hardware is confirmed.

## Decision gate to resume

Run `ykman info` on the home keys:

- **If `PIV` is `Enabled` (YubiKey 5 or other PIV-capable key)** → the current
  plan is correct and unchanged. Resume at Task 2 (see below). Verified fact:
  a YubiKey 5 runs **PIV and FIDO2 simultaneously**, so using PIV for age does
  not disturb existing FIDO2/passkey credentials. If PIV shows as available but
  not enabled, enable the CCID interface: `ykman config usb --enable CCID`.
- **If the keys are also FIDO-only** → the current plan is not viable. Reopen
  the design (see "Fallback options" below) before writing any more code.

## Progress so far

- **Task 1: DONE and reviewed clean** — commit `4b057c7` "Install
  age-plugin-yubikey and pcsc-lite in bitwarden-backup image". Modifies only
  `images/bitwarden-backup/Dockerfile`: adds the `age-plugin-yubikey` v0.5.0
  ARGs (version + sha256), adds `pcsc-lite` to the apk install, and adds the
  download/verify/install RUN. Verified locally: `docker run --rm --entrypoint
  age-plugin-yubikey bitwarden-backup:dev --version` prints `age-plugin-yubikey
  0.5.0`, exit 0. Task review: spec ✅, quality Approved.
- **Tasks 2–5: NOT STARTED.**
  - **Task 2** is a manual verification gate (no commit): operator adds one real
    `age1yubikey1…` recipient to the gitignored `.env` as `APY_TEST_RECIPIENT`,
    then the controller runs an `age -r "$APY_TEST_RECIPIENT"` encrypt of a dummy
    payload with **no hardware attached** to prove tokenless encryption resolves
    the recipient, then the operator removes the line. The recipient string must
    never be printed or committed (public repo).
  - **Task 3** adds an `age-plugin-yubikey --version` presence check to
    `.github/workflows/build.yml`, guarded `if: matrix.image == 'bitwarden-backup'`.
  - **Task 4** adds a `packageRule` to `.github/renovate.json` that **disables**
    auto-bump for `str4d/age-plugin-yubikey` (upstream stopped shipping
    `x86_64-linux` binaries at v0.5.1).
  - **Task 5** documents YubiKey recipients in
    `images/bitwarden-backup/README.md` and `RECOVERY.md.tmpl`.
  - After Tasks 2–5: a final whole-branch code review, then
    `finishing-a-development-branch`.

## How to resume (for another Claude Code instance)

1. Check out `feat/bitwarden-backup-image` and pull. Confirm `git log` shows
   commit `4b057c7` (Task 1).
2. Read the spec and plan (paths above). Re-invoke the
   `subagent-driven-development` skill.
3. Run the decision gate above with the operator's hardware. If PIV-capable,
   resume at **Task 2** in the plan; otherwise go to Fallback options.
4. The local `bitwarden-backup:dev` image will not exist on a fresh machine —
   rebuild it: `docker buildx build -t bitwarden-backup:dev images/bitwarden-backup`.

## Verified facts (don't re-derive these)

- `age-plugin-yubikey` is **not** in wolfi. It is installed from the upstream
  GitHub release.
- **v0.5.0 is the last release with an `x86_64-linux` asset** (latest v0.5.1
  ships macOS/Windows only). sha256 of the v0.5.0 linux tarball:
  `019b35a13fc81be56d73d0723db0a2082fbd04c936c2c6836381111f7f51b2c3`. Binary is
  at `age-plugin-yubikey/age-plugin-yubikey` inside the tarball.
- The plugin binary links `libpcsclite.so.1`, so `pcsc-lite` (available in
  wolfi) is a required runtime dependency.
- The image's `age` is **1.3.1** from wolfi — new enough for the age plugin
  protocol (introduced in age v1.1.0). age resolves plugins by `exec`ing
  `age-plugin-*` off `$PATH`; encrypting to a PIV recipient needs only the
  recipient string, no token attached.
- A YubiKey 5 supports PIV and FIDO2 at the same time.

## Fallback options (only if home keys are also FIDO-only)

Researched 2026-06-19 — reopen the design before acting:

1. **`age-plugin-fido2-hmac`.** Works with FIDO-only keys. Encryption is
   **tokenless** (a recipient is generated once with a touch; later encryption
   needs no key), so it fits the unattended CronJob model. BUT: it is
   **experimental** (pre-v1.0.0, Go), and has a weaker security property than
   PIV — at decrypt time a derived identity is loaded into RAM and, if extracted
   from memory, can decrypt without the token. **Open question to resolve first:**
   whether stock `age` can encrypt to the recipient (→ no image change needed,
   recovery-side tooling only) or whether the plugin must be installed on the
   encrypting side too. The README example uses plain `age -r age1…`, but a
   second reading suggested the plugin is required to encrypt — verify before
   designing.
2. **Software age key, hardware-protected at rest.** The CronJob encrypts to a
   normal `age1…` software recipient (already fully supported — no image change)
   and the operator protects the decryption private key with the YubiKey at the
   storage layer (outside this image). Matches the operator's stated concern:
   "it's a question of how I protect the private key needed to decrypt."

## Cleanup note

If the direction changes away from `age-plugin-yubikey` (FIDO-only fallback),
Task 1's commit `4b057c7` should be reverted.
