# bitwarden-backup YubiKey Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `age-plugin-yubikey` binary to the bitwarden-backup image so `BITWARDEN_AGE_RECIPIENTS` can include YubiKey-backed recipients (`age1yubikey1…`), without changing `backup.sh`.

**Architecture:** age is already multi-recipient and `backup.sh` already loops `BITWARDEN_AGE_RECIPIENTS` into `-r` args, so YubiKey support is purely a matter of installing the plugin binary that `age` `exec`s to resolve `age1yubikey1…` recipients. We add the binary from the pinned upstream release, the `pcsc-lite` runtime lib it links against, a CI presence-check guard, a Renovate rule, and docs.

**Tech Stack:** Docker (wolfi-base), age 1.3.1 (wolfi apk), age-plugin-yubikey 0.5.0 (upstream GitHub release binary), GitHub Actions, Renovate.

## Global Constraints

- **Platform:** linux/amd64 only.
- **No keys in the repo:** no age recipients (public *or* private) are committed. The YubiKey recipient used in verification is supplied locally via the gitignored `.env` and must never be printed, echoed, or committed.
- **`backup.sh`:** no changes — its existing recipient loop already does the job.
- **`age`:** stays on wolfi (currently 1.3.1), version-bound to the `chainguard/wolfi-base` digest pin. Not pinned explicitly.
- **`age-plugin-yubikey`:** pinned to **v0.5.0**, the last release with an `x86_64-linux` asset (latest v0.5.1 ships macOS/Windows only). SHA256 `019b35a13fc81be56d73d0723db0a2082fbd04c936c2c6836381111f7f51b2c3`.
- **`pcsc-lite`:** required at runtime — the plugin binary links `libpcsclite.so.1` (verified with `readelf`).
- **Secrets convention (unchanged):** each secret accepts `FOO` or `FOO_FILE`; both set is an error.

---

### Task 1: Install age-plugin-yubikey + pcsc-lite in the Dockerfile

**Files:**
- Modify: `images/bitwarden-backup/Dockerfile`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: an image in which `/usr/local/bin/age-plugin-yubikey` exists and runs, and `age` can resolve `age1yubikey1…` recipients. Local build tag used throughout this plan: `bitwarden-backup:dev`.

- [ ] **Step 1: Confirm the plugin is absent in the current image (failing state)**

Build the current image and prove the plugin is missing, establishing the "red" baseline.

Run:
```bash
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
docker run --rm --entrypoint sh bitwarden-backup:dev -c 'command -v age-plugin-yubikey || echo MISSING'
```
Expected: `MISSING`

- [ ] **Step 2: Add the version/sha ARGs to the Dockerfile**

In `images/bitwarden-backup/Dockerfile`, immediately after the existing `BW_SHA256` ARG line, add:

```dockerfile

# renovate: datasource=github-releases depName=str4d/age-plugin-yubikey extractVersion=^v(?<version>.+)$
ARG AGE_PLUGIN_YUBIKEY_VERSION=0.5.0
ARG AGE_PLUGIN_YUBIKEY_SHA256=019b35a13fc81be56d73d0723db0a2082fbd04c936c2c6836381111f7f51b2c3
```

- [ ] **Step 3: Add `pcsc-lite` to the apk install**

Replace the existing `RUN apk add` block and its comment:

```dockerfile
# libstdc++ is needed by the bw binary (C++ runtime).
# wget is not in wolfi-base by default; install for the bw zip fetch.
# age and ca-certificates ride the wolfi-base digest pin — no version pin needed.
RUN apk add --no-cache \
        ca-certificates \
        age \
        libstdc++ \
        wget
```

with:

```dockerfile
# libstdc++ is needed by the bw binary (C++ runtime).
# pcsc-lite provides libpcsclite.so.1, needed by the age-plugin-yubikey binary.
# wget is not in wolfi-base by default; install for the release downloads.
# age and ca-certificates ride the wolfi-base digest pin — no version pin needed.
RUN apk add --no-cache \
        ca-certificates \
        age \
        libstdc++ \
        pcsc-lite \
        wget
```

- [ ] **Step 4: Add the download/verify/install RUN**

Immediately after the existing `bw` install `RUN` block (the one ending `rm -f bw.zip bw`), add:

```dockerfile

RUN set -eu; \
    cd /tmp; \
    wget -O age-plugin-yubikey.tar.gz "https://github.com/str4d/age-plugin-yubikey/releases/download/v${AGE_PLUGIN_YUBIKEY_VERSION}/age-plugin-yubikey-v${AGE_PLUGIN_YUBIKEY_VERSION}-x86_64-linux.tar.gz"; \
    echo "${AGE_PLUGIN_YUBIKEY_SHA256}  age-plugin-yubikey.tar.gz" | sha256sum -c -; \
    tar xzf age-plugin-yubikey.tar.gz; \
    install -m 0755 age-plugin-yubikey/age-plugin-yubikey /usr/local/bin/age-plugin-yubikey; \
    rm -rf age-plugin-yubikey.tar.gz age-plugin-yubikey
```

(`/usr/local/bin` is created by the preceding `bw` RUN, so it exists here.)

- [ ] **Step 5: Build and verify the plugin loads (passing state)**

Run:
```bash
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
docker run --rm --entrypoint age-plugin-yubikey bitwarden-backup:dev --version
```
Expected: prints `age-plugin-yubikey 0.5.0` and exits 0. (Exit 0 also proves `libpcsclite.so.1` and the other shared libs load — a missing `pcsc-lite` would fail here with a loader error.)

- [ ] **Step 6: Commit**

```bash
git add images/bitwarden-backup/Dockerfile
git commit -m "Install age-plugin-yubikey and pcsc-lite in bitwarden-backup image"
```

---

### Task 2: Prove YubiKey recipient resolution end-to-end (local, no hardware)

This is a **manual verification gate**, not a code change — it produces no commit. It validates the foundational assumption (the plugin resolves a real `age1yubikey1…` recipient with no YubiKey attached) before we build CI and docs around it. It requires the operator to supply one real recipient string.

**Files:** none (verification only).

**Interfaces:**
- Consumes: `bitwarden-backup:dev` from Task 1.

- [ ] **Step 1: Operator adds a YubiKey recipient to the gitignored `.env`**

The operator (not the agent) adds a line to `/home/abo/workspace/home/containers/.env`:
```
APY_TEST_RECIPIENT=age1yubikey1...   # one of their real YubiKey recipient strings
```
The agent must never read, echo, or print this file or the variable. `.env` is gitignored (verified earlier).

- [ ] **Step 2: Encrypt a dummy payload to the recipient with no hardware attached**

Run (references the var by name; never prints it):
```bash
docker run --rm \
  --env-file /home/abo/workspace/home/containers/.env \
  --entrypoint sh bitwarden-backup:dev -c '
    printf "smoke-test-payload" | age -r "$APY_TEST_RECIPIENT" -a -o /tmp/out.age \
      && echo "ENCRYPT OK (exit $?)" \
      && head -1 /tmp/out.age'
```
Expected:
```
ENCRYPT OK (exit 0)
-----BEGIN AGE ENCRYPTED FILE-----
```
A non-zero exit or a "no plugin" / "unknown recipient" error is a FAIL — stop and investigate before proceeding. Success proves `age` resolved the YubiKey recipient through the plugin using only the public key, with no card present (the cluster-side guarantee).

- [ ] **Step 3: Operator removes the test line from `.env`**

The operator deletes the `APY_TEST_RECIPIENT` line again. (Decrypt-with-hardware is confirmed by the operator independently on their own machine; it is out of scope for this automated gate.)

---

### Task 3: Add the plugin presence check to CI

**Files:**
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: the built image loaded locally in CI as `steps.tags.outputs.load_tag`.

- [ ] **Step 1: Verify the check command locally first**

Run the exact shell the CI step will run, against the local image:
```bash
out=$(docker run --rm --entrypoint age-plugin-yubikey bitwarden-backup:dev --version)
echo "$out"
echo "$out" | grep -q '^age-plugin-yubikey ' && echo "CHECK PASS" || echo "CHECK FAIL"
```
Expected: prints the version line and `CHECK PASS`.

- [ ] **Step 2: Add the CI step**

In `.github/workflows/build.yml`, insert this step between the existing `Smoke test entrypoint` step (ends at the `echo "smoke OK"` line) and the `Push` step:

```yaml
      - name: Smoke test age-plugin-yubikey
        if: matrix.image == 'bitwarden-backup'
        run: |
          set -euo pipefail
          load_tag="${{ steps.tags.outputs.load_tag }}"
          out=$(docker run --rm --entrypoint age-plugin-yubikey "${load_tag}" --version)
          echo "$out"
          if ! echo "$out" | grep -q '^age-plugin-yubikey '; then
            echo "ERROR: age-plugin-yubikey --version output unexpected" >&2
            exit 1
          fi
          echo "plugin smoke OK"
```

The `if: matrix.image == 'bitwarden-backup'` guard keeps the check from running against other images (which don't ship the plugin) as the repo grows.

- [ ] **Step 3: Validate the workflow YAML parses**

Run:
```bash
python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/build.yml")); print("YAML OK")'
```
Expected: `YAML OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "Gate bitwarden-backup pushes on age-plugin-yubikey presence check"
```

---

### Task 4: Track the plugin in Renovate (manual-bump, disabled)

The existing `customManager` in `renovate.json` already matches the `# renovate:` + `ARG` comment added in Task 1, so the dependency `str4d/age-plugin-yubikey` is auto-discovered. Because upstream stopped shipping `x86_64-linux` binaries at v0.5.1, an automatic bump would 404 the asset and break the build — so we disable automated PRs for this one dep while keeping it visible for the maintainer.

**Files:**
- Modify: `.github/renovate.json`

- [ ] **Step 1: Add a disabling packageRule**

In `.github/renovate.json`, add this object as a new entry in the `packageRules` array (after the existing `wolfi-base` rule):

```json
    {
      "matchManagers": ["custom.regex"],
      "matchDepNames": ["str4d/age-plugin-yubikey"],
      "enabled": false,
      "description": "Pinned manually: upstream stopped publishing x86_64-linux release assets at v0.5.1. Bump AGE_PLUGIN_YUBIKEY_VERSION + AGE_PLUGIN_YUBIKEY_SHA256 by hand and re-enable this rule once Linux binaries resume."
    }
```

- [ ] **Step 2: Validate the JSON parses**

Run:
```bash
python3 -c 'import json; json.load(open(".github/renovate.json")); print("JSON OK")'
```
Expected: `JSON OK`

- [ ] **Step 3: Commit**

```bash
git add .github/renovate.json
git commit -m "Disable Renovate auto-bump for age-plugin-yubikey (no upstream linux binary)"
```

---

### Task 5: Document YubiKey recipients (README + RECOVERY)

**Files:**
- Modify: `images/bitwarden-backup/README.md`
- Modify: `images/bitwarden-backup/RECOVERY.md.tmpl`

- [ ] **Step 1: Update the `BITWARDEN_AGE_RECIPIENTS` row in README**

In `images/bitwarden-backup/README.md`, replace the `BITWARDEN_AGE_RECIPIENTS` table row:

```markdown
| `BITWARDEN_AGE_RECIPIENTS` | no | Whitespace-separated list of age public keys (e.g. `age1abc... age1def...`); at least one required |
```

with:

```markdown
| `BITWARDEN_AGE_RECIPIENTS` | no | Whitespace-separated list of age recipients — software keys (`age1...`) and/or YubiKey keys (`age1yubikey1...`); at least one required. See [YubiKey recipients](#yubikey-recipients). |
```

- [ ] **Step 2: Add a YubiKey recipients section to README**

In `images/bitwarden-backup/README.md`, add this section immediately before the `## Local run` heading:

```markdown
## YubiKey recipients

The image bundles [`age-plugin-yubikey`](https://github.com/str4d/age-plugin-yubikey),
so `BITWARDEN_AGE_RECIPIENTS` may list YubiKey-backed recipients
(`age1yubikey1...`) alongside or instead of software `age1...` keys. A
single `.age` file is produced regardless of how many recipients you list,
and **any one** of them can decrypt it (age wraps the file key per
recipient — it does not encrypt multiple times).

A typical hardware setup lists **two** YubiKey recipients — a primary and a
backup key — so either can recover the vault:

```sh
BITWARDEN_AGE_RECIPIENTS="age1yubikey1qprimary... age1yubikey1qbackup..."
```

Encryption needs **no** YubiKey attached: the recipient string contains the
public key, and the plugin wraps the file key against it in software. That is
what lets the CronJob run unattended. The physical key (plus PIN/touch) is
required only at **decryption** time — see `RECOVERY.md`.
```

- [ ] **Step 3: Add YubiKey decryption instructions to RECOVERY template**

In `images/bitwarden-backup/RECOVERY.md.tmpl`, add this section immediately after the `## To decrypt one file` section (before `## To restore into a Bitwarden vault`):

```markdown
### If the recipient was a YubiKey

If the backup was encrypted to a YubiKey recipient (`age1yubikey1...`), you
need both [`age`](https://age-encryption.org/) and
[`age-plugin-yubikey`](https://github.com/str4d/age-plugin-yubikey) installed,
and one of the YubiKeys that was listed as a recipient inserted.

```sh
# With the YubiKey inserted, export a stub identity for it:
age-plugin-yubikey --identity > yubikey-identity.txt

# Decrypt (you will be prompted for the PIN and a touch):
age -d -i yubikey-identity.txt -o vault.json <prefix>-YYYY-MM-DD.json.age
```

Any one of the YubiKeys listed at backup time works — you do not need all of
them.
```

- [ ] **Step 4: Verify the new content is present**

Run:
```bash
grep -q 'YubiKey recipients' images/bitwarden-backup/README.md && \
grep -q 'age1yubikey1' images/bitwarden-backup/README.md && \
grep -q 'age-plugin-yubikey --identity' images/bitwarden-backup/RECOVERY.md.tmpl && \
echo "DOCS OK"
```
Expected: `DOCS OK`

- [ ] **Step 5: Commit**

```bash
git add images/bitwarden-backup/README.md images/bitwarden-backup/RECOVERY.md.tmpl
git commit -m "Document YubiKey recipients and decryption"
```

---

## Self-Review

**Spec coverage:**
- Plugin install from pinned upstream release → Task 1. ✓
- `pcsc-lite` runtime dependency → Task 1 (now confirmed required, not conditional). ✓
- CI presence check (option 2) → Task 3. ✓
- Renovate handling → Task 4 (amended: disabled, because upstream dropped the Linux binary — see note below). ✓
- README + RECOVERY docs → Task 5. ✓
- Local end-to-end proof with no-egress recipient handling → Task 2. ✓
- No `backup.sh` change, no new env vars, no keys in repo → honored throughout (Global Constraints). ✓

**Amendments vs. the spec** (`docs/superpowers/specs/2026-06-19-bitwarden-backup-yubikey-design.md`):
- Plugin pinned to **v0.5.0** (not "latest"): v0.5.1 ships no `x86_64-linux` asset.
- `pcsc-lite` is **required**, not conditional: `readelf` confirms `NEEDED libpcsclite.so.1`.
- Renovate auto-bump is **disabled** for the plugin rather than enabled: an auto-bump to a Linux-less release would break the build.

**Placeholder scan:** none — all versions, hashes, paths, URLs, and code blocks are concrete.

**Type/name consistency:** `bitwarden-backup:dev`, `AGE_PLUGIN_YUBIKEY_VERSION`, `AGE_PLUGIN_YUBIKEY_SHA256`, `load_tag`, and `str4d/age-plugin-yubikey` are used identically across all tasks.
