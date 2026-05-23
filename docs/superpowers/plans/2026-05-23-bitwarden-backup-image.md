# bitwarden-backup Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `ghcr.io/drzero42/bitwarden-backup` image (Dockerfile + POSIX shell entrypoint), extend the shared CI workflow with a per-day `N`-incrementing tag scheme and an entrypoint smoke test, and add a Renovate config that keeps the wolfi-base digest and the bw release pin fresh.

**Architecture:** Single-stage `chainguard/wolfi-base` image (glibc-based; required because the official `bw-linux-X.zip` is a glibc-dynamic C++ binary) with `bw` (downloaded release, sha256-verified) and `age`/`libstdc++` (apk). A POSIX `sh` entrypoint normalizes `*_FILE` inputs, validates required env, runs `bw login → unlock → sync → export`, encrypts to N age recipients, writes to a mounted backup dir, prunes by mtime, and refreshes a static `RECOVERY.md`. CI gains a date-N tagger (via `crane ls`) plus a smoke test that asserts the image exits non-zero with `must be set` on stderr when run without env. Renovate watches the wolfi-base digest and the bw release pin (version + sha256); `age` rides the wolfi-base digest since wolfi rebuilds daily.

**Tech Stack:** Docker / buildx, GitHub Actions, `imjasonh/setup-crane`, Renovate (GitHub App), `chainguard/wolfi-base` (glibc, apk-tooling), GNU coreutils, Bitwarden CLI 2026.x, `age` 1.3.x.

**Spec reference:** [`docs/superpowers/specs/2026-05-22-bitwarden-backup-image-design.md`](../specs/2026-05-22-bitwarden-backup-image-design.md)

**Plan amendment 2026-05-23:** The spec picked `alpine:3.23` on the assumption that `bw-linux-X.zip` was a static binary. It is not — it is a glibc-dynamic C++ binary that fails even with `gcompat + libstdc++` on alpine (still needs glibc-specific `fcntl64`). After testing options (alpine+npm, debian-slim, wolfi), this plan uses `chainguard/wolfi-base` pinned by digest. Net effect: ~30-50 MB final image (vs ~110 MB on debian-slim), glibc available, alpine-style `apk` tooling. The `age` apk pin from the spec drops — wolfi rebuilds packages daily and the base-image digest pin already controls reproducibility, so `apk add age` (unpinned) is correct here.

---

## File structure

After this plan lands:

```
/home/abo/workspace/home/containers/
├── .github/
│   ├── renovate.json                              # NEW (Task 11)
│   └── workflows/
│       └── build.yml                              # MODIFIED (Tasks 9, 10)
├── images/
│   └── bitwarden-backup/                          # NEW (Tasks 1–8)
│       ├── Dockerfile                             # base + pins + entrypoint copy
│       ├── backup.sh                              # POSIX sh, sourced by entrypoint
│       └── RECOVERY.md.tmpl                       # static heredoc body (Task 7)
├── CLAUDE.md                                      # MODIFIED (Task 12)
├── README.md
└── devenv.nix
```

Responsibilities:

- `images/bitwarden-backup/Dockerfile` — base image + all version pins + binary installs. Renovate's primary target.
- `images/bitwarden-backup/backup.sh` — all entrypoint logic. POSIX `sh`. Ordered steps with `==> step N:` markers.
- `images/bitwarden-backup/RECOVERY.md.tmpl` — static, non-parameterized recovery instructions; copied verbatim by the entrypoint into `$BACKUP_DIR/RECOVERY.md` each run.
- `.github/workflows/build.yml` — discover + build + push, now with per-day date-N tag computation (via `crane`) and an entrypoint smoke-test step.
- `.github/renovate.json` — wolfi-base digest (built-in dockerfile manager), bw release pin (custom regex manager).

---

## Conventions enforced by this plan

- **TDD-ish:** For each behavioral step in `backup.sh`, write a failing `docker run` invocation that pins expected behavior (exit code + stderr substring) BEFORE implementing the step.
- **Verification gating:** A dedicated task (Task 2) verifies the actual `bw` flags on the pinned version before the script depends on them. The spec's open item — "verify the flags actually exist on the pinned version" — is non-skippable.
- **Frequent commits:** Every task ends with a commit. No commit covers more than one task.
- **No backwards-compat shims:** First image, no consumers in this repo yet. Move fast on the entrypoint contract; only the cloudzero consumer pin freezes it.
- **POSIX sh:** No bash-isms in `backup.sh`. `set -eu`; `set -o pipefail` is invoked with `|| true` so the script still works if wolfi's `/bin/sh` happens to be a strict POSIX shell without it. Verify what `/bin/sh` actually points to during Task 1's image-shell session and adjust the disclaimer if needed.

---

## Task 1: Scaffold image directory with buildable Dockerfile and stub entrypoint

**Files:**
- Create: `images/bitwarden-backup/Dockerfile`
- Create: `images/bitwarden-backup/backup.sh`

- [ ] **Step 1: Determine the current bw version and wolfi-base digest**

```bash
# Latest bw CLI release tag (looking for cli-v<X.Y.Z>)
curl -fsSL https://api.github.com/repos/bitwarden/clients/releases \
  | grep -oE '"tag_name":\s*"cli-v[0-9.]+"' \
  | head -5
```

Pick the newest stable `cli-v<X.Y.Z>` — write the stripped version (e.g. `2026.4.2`) down for the next step.

```bash
# Pull the wolfi-base image and capture its sha256 digest
docker pull chainguard/wolfi-base:latest
docker inspect --format='{{index .RepoDigests 0}}' chainguard/wolfi-base:latest
# Output looks like: chainguard/wolfi-base@sha256:<64-hex>
```

Note the `sha256:<64-hex>` suffix — this is your `WOLFI_DIGEST`.

- [ ] **Step 2: Compute the bw zip sha256**

```bash
BW_VERSION=<version-from-step-1>
curl -fsSL "https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/bw-linux-${BW_VERSION}.zip" \
  | sha256sum
```

Note the 64-hex output for `BW_SHA256`.

- [ ] **Step 3: Write the Dockerfile**

```dockerfile
FROM chainguard/wolfi-base:latest@<WOLFI_DIGEST-from-step-1>

# renovate: datasource=github-releases depName=bitwarden/clients extractVersion=^cli-v(?<version>.+)$
ARG BW_VERSION=<from-step-1>
ARG BW_SHA256=<from-step-2>

# libstdc++ is needed by the bw binary (C++ runtime).
# wget is not in wolfi-base by default; install for the bw zip fetch.
# age and ca-certificates ride the wolfi-base digest pin — no version pin needed.
RUN apk add --no-cache \
        ca-certificates \
        age \
        libstdc++ \
        wget

RUN set -eu; \
    cd /tmp; \
    wget -O bw.zip "https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/bw-linux-${BW_VERSION}.zip"; \
    echo "${BW_SHA256}  bw.zip" | sha256sum -c -; \
    unzip bw.zip; \
    install -m 0755 bw /usr/local/bin/bw; \
    rm -f bw.zip bw

RUN adduser -D -u 1000 backup

COPY backup.sh /usr/local/bin/bitwarden-backup
RUN chmod 0755 /usr/local/bin/bitwarden-backup

ENV HOME=/tmp \
    BITWARDENCLI_APPDATA_DIR=/tmp/bw-appdata

USER 1000:1000
WORKDIR /tmp

ENTRYPOINT ["/usr/local/bin/bitwarden-backup"]
```

Substitute `<WOLFI_DIGEST-from-step-1>`, `<from-step-1>` (BW_VERSION), and `<from-step-2>` (BW_SHA256) with the literal values you noted. The `@sha256:...` on the FROM line is the digest pin; Renovate's docker manager updates it on each wolfi-base rebuild.

Notes:
- `unzip` is in wolfi-base by default (GNU `unzip` at `/usr/bin/unzip`), so it doesn't need installation.
- Wolfi uses GNU coreutils throughout (`stat`, `find`, `date`, etc.), so the `stat -c%s` syntax in later tasks works without a busybox-vs-GNU caveat.
- `adduser -D -u 1000` (no explicit `-g`) is correct on wolfi's shadow-style `adduser`; the `-g 1000` form from the spec was a busybox idiom. Verify with `adduser --help` if unsure.

- [ ] **Step 4: Write a stub backup.sh**

```sh
#!/bin/sh
set -eu
echo "stub: not implemented" >&2
exit 1
```

- [ ] **Step 5: Build locally and confirm both tools are on `PATH`**

```bash
cd /home/abo/workspace/home/containers
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
docker run --rm --entrypoint sh bitwarden-backup:dev -c 'bw --version && age --version'
```

Expected: `bw` prints the pinned version; `age` prints its version. Both succeed (exit 0).

- [ ] **Step 6: Confirm stub entrypoint exits 1 with stderr message**

```bash
docker run --rm bitwarden-backup:dev 2>&1 1>/dev/null || echo "exit=$?"
docker run --rm bitwarden-backup:dev 2>&1 >/dev/null | grep -q "stub: not implemented" && echo "stderr ok"
```

Expected: `exit=1` and `stderr ok`.

- [ ] **Step 7: Commit**

```bash
git add images/bitwarden-backup/Dockerfile images/bitwarden-backup/backup.sh
git commit -m "feat(bitwarden-backup): scaffold image with pinned bw + age and stub entrypoint"
```

---

## Task 2: Verify bw CLI flag spellings on the pinned version

This is the spec's open item ("verify the flags actually exist on the pinned version") moved to a gate before any code depends on those flags. Done once, results recorded in this plan as ground truth for subsequent tasks.

**Files:** none (verification-only)

- [ ] **Step 1: Open a shell in the built image**

```bash
docker run --rm -it --entrypoint sh bitwarden-backup:dev
```

- [ ] **Step 2: Confirm each flag spelling**

Inside the container shell:

```sh
bw --version              # must print the version you pinned
bw config --help          # must show: bw config server <url>
bw login --help           # must show: --apikey
bw unlock --help          # must show: --passwordenv and --raw
bw export --help          # must show: --raw, --format <fmt>, --password <pw>
bw logout --help          # must exist
bw sync --help            # must exist
```

- [ ] **Step 3: Resolve any flag drift** — verified against bw 2026.4.2 on 2026-05-23:

| Script use | `--help` result on 2026.4.2 |
|---|---|
| `bw config server <url>` | ✅ documented as `bw config server <url>` |
| `bw login --apikey` | ✅ `--apikey` accepted; reads `BW_CLIENTID`/`BW_CLIENTSECRET` from env |
| `bw unlock --passwordenv BW_PASSWORD --raw` | ✅ `--passwordenv <name>` and `--raw` both listed |
| `bw --raw export --format json --password "$BW_PASSWORD"` | ⚠️ `--raw` is a **global** flag, not a `bw export` option — must come BEFORE the subcommand. Spec line updated in Task 4 step 1. |
| `bw sync` | ✅ exists |
| `bw logout` | ✅ exists |

Findings recorded so future re-runs of this gate task don't have to redo the work. If a future bw version drifts further, this table will need re-verification.

- [ ] **Step 4: Exit the container shell**

```sh
exit
```

- [ ] **Step 5: No commit**

Verification only. If flag adjustments are needed, they land in the relevant task's commit.

---

## Task 3: Implement `*_FILE` resolution + required-input validation

This is the only set of behaviors that can be exhaustively tested without real Bitwarden credentials. Build the failing-test suite first, then implement.

**Files:**
- Modify: `images/bitwarden-backup/backup.sh` (replace stub)

- [ ] **Step 1: Write the failing tests**

These are concrete `docker run` invocations. Run them now against the current stub image; all five should fail in the wrong way (stub exits 1 with "stub: not implemented" regardless of input).

```bash
# Rebuild the image first to be sure we're testing the current backup.sh
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup

# Test 1: no env vars → must mention BW_SERVER
docker run --rm bitwarden-backup:dev 2>&1 | grep -q "BW_SERVER must be set" \
  && echo "TEST 1 PASS" || echo "TEST 1 FAIL"

# Test 2: BW_SERVER only → next missing var is BW_CLIENTID (secret, both forms)
docker run --rm -e BW_SERVER=https://bw.example bitwarden-backup:dev 2>&1 \
  | grep -q "BW_CLIENTID or BW_CLIENTID_FILE must be set" \
  && echo "TEST 2 PASS" || echo "TEST 2 FAIL"

# Test 3: BW_CLIENTID and BW_CLIENTID_FILE both set → ambiguity error
docker run --rm \
  -e BW_SERVER=https://bw.example \
  -e BW_CLIENTID=cid \
  -e BW_CLIENTID_FILE=/tmp/cid \
  bitwarden-backup:dev 2>&1 \
  | grep -q "BW_CLIENTID and BW_CLIENTID_FILE both set" \
  && echo "TEST 3 PASS" || echo "TEST 3 FAIL"

# Test 4: BW_CLIENTID_FILE points to missing file → unreadable error
docker run --rm \
  -e BW_SERVER=https://bw.example \
  -e BW_CLIENTID_FILE=/tmp/does-not-exist \
  bitwarden-backup:dev 2>&1 \
  | grep -q "BW_CLIENTID_FILE=/tmp/does-not-exist" \
  && echo "TEST 4 PASS" || echo "TEST 4 FAIL"

# Test 5: BW_CLIENTID_FILE points to empty file → empty-content error
EMPTY=$(mktemp)
docker run --rm \
  -e BW_SERVER=https://bw.example \
  -e BW_CLIENTID_FILE=/tmp/empty \
  -v "${EMPTY}:/tmp/empty:ro" \
  bitwarden-backup:dev 2>&1 \
  | grep -q "BW_CLIENTID_FILE=/tmp/empty" \
  && echo "TEST 5 PASS" || echo "TEST 5 FAIL"
rm -f "$EMPTY"
```

Expected at this stage: all five print `TEST N FAIL` (the stub always prints "stub: not implemented" instead of the expected substrings).

- [ ] **Step 2: Implement resolution + validation**

Replace `images/bitwarden-backup/backup.sh` with:

```sh
#!/bin/sh
set -eu
# pipefail is widely available but not POSIX; tolerate its absence.
set -o pipefail 2>/dev/null || true

step() {
    printf '==> step %s: %s\n' "$1" "$2" >&2
}

die() {
    printf '%s\n' "$1" >&2
    exit 1
}

# Resolve a secret input from <VAR> or <VAR>_FILE.
# Sets <VAR> in the parent environment via eval.
resolve_secret() {
    name=$1
    file_name="${name}_FILE"
    eval "value=\${$name:-}"
    eval "file_value=\${$file_name:-}"

    if [ -n "$value" ] && [ -n "$file_value" ]; then
        die "$name and $file_name both set: pick one"
    fi

    if [ -n "$file_value" ]; then
        if [ ! -r "$file_value" ]; then
            die "$file_name=$file_value: not readable"
        fi
        # $(...) strips trailing newlines from the command output — that
        # handles the "trim trailing newline" requirement portably.
        contents=$(cat "$file_value")
        if [ -z "$contents" ]; then
            die "$file_name=$file_value: empty"
        fi
        eval "$name=\$contents"
        unset "$file_name"
    fi

    eval "final=\${$name:-}"
    if [ -z "$final" ]; then
        die "$name or $file_name must be set"
    fi
}

require_env() {
    name=$1
    eval "value=\${$name:-}"
    if [ -z "$value" ]; then
        die "$name must be set"
    fi
}

step 1 "resolve and validate inputs"

# Order matches the Step-4 test sequence: server → creds → output location.
require_env BW_SERVER

# Secret required inputs (env or *_FILE).
resolve_secret BW_CLIENTID
resolve_secret BW_CLIENTSECRET
resolve_secret BW_PASSWORD

# Non-secret required inputs that follow the secrets.
require_env BACKUP_DIR
require_env BITWARDEN_AGE_RECIPIENTS

: "${RETENTION_DAYS:=30}"
: "${FILENAME_PREFIX:=bitwarden}"
: "${MIN_PLAINTEXT_BYTES:=1024}"

# Placeholder: subsequent tasks add steps 2..N.
echo "validation OK (further steps not yet implemented)" >&2
exit 1
```

- [ ] **Step 3: Rebuild and rerun the test suite**

```bash
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
# rerun all 5 invocations from Step 1
```

Expected: all five tests print `TEST N PASS`.

- [ ] **Step 4: Add tests for `BW_CLIENTSECRET`, `BW_PASSWORD`, `BACKUP_DIR`, `BITWARDEN_AGE_RECIPIENTS`**

```bash
# BW_CLIENTSECRET missing
docker run --rm \
  -e BW_SERVER=https://bw.example \
  -e BW_CLIENTID=cid \
  bitwarden-backup:dev 2>&1 \
  | grep -q "BW_CLIENTSECRET or BW_CLIENTSECRET_FILE must be set" \
  && echo "PASS" || echo "FAIL"

# BW_PASSWORD missing
docker run --rm \
  -e BW_SERVER=https://bw.example \
  -e BW_CLIENTID=cid -e BW_CLIENTSECRET=cs \
  bitwarden-backup:dev 2>&1 \
  | grep -q "BW_PASSWORD or BW_PASSWORD_FILE must be set" \
  && echo "PASS" || echo "FAIL"

# BACKUP_DIR missing
docker run --rm \
  -e BW_SERVER=https://bw.example \
  -e BW_CLIENTID=cid -e BW_CLIENTSECRET=cs -e BW_PASSWORD=pw \
  bitwarden-backup:dev 2>&1 \
  | grep -q "BACKUP_DIR must be set" \
  && echo "PASS" || echo "FAIL"

# BITWARDEN_AGE_RECIPIENTS missing — should error AFTER BACKUP_DIR is set
docker run --rm \
  -e BW_SERVER=https://bw.example \
  -e BW_CLIENTID=cid -e BW_CLIENTSECRET=cs -e BW_PASSWORD=pw \
  -e BACKUP_DIR=/backup \
  bitwarden-backup:dev 2>&1 \
  | grep -q "BITWARDEN_AGE_RECIPIENTS must be set" \
  && echo "PASS" || echo "FAIL"
```

All four expected: `PASS`.

- [ ] **Step 5: Confirm the smoke-test contract**

The CI smoke test will grep for `must be set` on stderr when the image is run with no env. Confirm:

```bash
docker run --rm bitwarden-backup:dev 2>&1 | grep -q "must be set" && echo "smoke OK"
```

Expected: `smoke OK`.

- [ ] **Step 6: Commit**

```bash
git add images/bitwarden-backup/backup.sh
git commit -m "feat(bitwarden-backup): validate required inputs and resolve *_FILE secrets"
```

---

## Task 4: Implement Bitwarden session (login + unlock + sync) and export with plaintext sanity check

These four steps (the spec's steps 3–6) cannot be unit-tested without a real Bitwarden account. They're implemented together because each depends on the prior session state. End-to-end verification lands in Task 8.

**Files:**
- Modify: `images/bitwarden-backup/backup.sh`

- [ ] **Step 1: Replace the placeholder block at the bottom of `backup.sh`**

Find the lines starting at `# Placeholder: subsequent tasks add steps 2..N.` and replace them with:

```sh
step 2 "set up tmpfile and cleanup trap"
plaintext=$(mktemp /tmp/bw-export.XXXXXX.json)
trap 'rm -f "$plaintext"' EXIT INT TERM

step 3 "configure bitwarden server"
bw config server "$BW_SERVER" >/dev/null

step 4 "bw login --apikey"
# bw login --apikey reads BW_CLIENTID and BW_CLIENTSECRET from the env.
bw login --apikey >/dev/null

step 5 "bw unlock and capture session"
BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)
export BW_SESSION

step 6 "bw sync"
bw sync >/dev/null

step 7 "bw export vault to json"
# --raw is a *global* bw flag; it goes before the subcommand (verified
# against bw 2026.4.2 --help: examples show `bw --raw export`).
# --password is documented as applying only to encrypted_json format;
# we pass it anyway as defensive belt-and-braces against any version that
# re-prompts for the master password on plaintext export.
bw --raw export --format json --password "$BW_PASSWORD" > "$plaintext"

step 8 "plaintext sanity check"
size=$(stat -c%s "$plaintext")
if [ "$size" -lt "$MIN_PLAINTEXT_BYTES" ]; then
    die "plaintext export is $size bytes (< MIN_PLAINTEXT_BYTES=$MIN_PLAINTEXT_BYTES); refusing to encrypt a likely-truncated export"
fi

echo "export OK ($size bytes); encryption not yet implemented" >&2
exit 1
```

- [ ] **Step 2: Rebuild and confirm validation tests from Task 3 still pass**

```bash
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
docker run --rm bitwarden-backup:dev 2>&1 | grep -q "BW_SERVER must be set" && echo "validation still ok"
```

Expected: `validation still ok`. This confirms the new code path runs only AFTER validation.

- [ ] **Step 3: Confirm the image now reaches `step 3` when given fake env**

```bash
docker run --rm \
  -e BW_SERVER=https://invalid.example.invalid \
  -e BW_CLIENTID=fake -e BW_CLIENTSECRET=fake -e BW_PASSWORD=fake \
  -e BACKUP_DIR=/tmp/backup \
  -e BITWARDEN_AGE_RECIPIENTS=age1xxx \
  bitwarden-backup:dev 2>&1 | head -20
```

Expected: prints `==> step 1: resolve and validate inputs`, then `==> step 2: set up tmpfile...`, then `==> step 3: configure bitwarden server`, then an error from `bw` (failed DNS / connection refused / bad config). Image exits non-zero.

The point is to confirm the script reaches the bw call site, not that it succeeds against a fake host.

- [ ] **Step 4: Commit**

```bash
git add images/bitwarden-backup/backup.sh
git commit -m "feat(bitwarden-backup): wire bitwarden login/unlock/sync/export with sanity check"
```

---

## Task 5: Implement age encryption to N recipients

**Files:**
- Modify: `images/bitwarden-backup/backup.sh`

- [ ] **Step 1: Replace the trailing placeholder with the encryption block**

Find `echo "export OK ($size bytes); encryption not yet implemented" >&2` and the `exit 1` line below it; replace them with:

```sh
step 9 "encrypt with age"
# Build -r <recipient> args from BITWARDEN_AGE_RECIPIENTS (whitespace-separated).
# Using set -- to portably build a positional arg list.
# shellcheck disable=SC2086
set -- $BITWARDEN_AGE_RECIPIENTS
age_args=""
for r in "$@"; do
    age_args="$age_args -r $r"
done
if [ -z "$age_args" ]; then
    die "BITWARDEN_AGE_RECIPIENTS expanded to zero recipients"
fi

out="${BACKUP_DIR}/${FILENAME_PREFIX}-$(date -u +%F).json.age"
# Intentional: same-day reruns overwrite — that's the refresh story.
# shellcheck disable=SC2086
age $age_args -o "$out" < "$plaintext"
echo "wrote $out" >&2

echo "encryption OK; prune and recovery not yet implemented" >&2
exit 1
```

- [ ] **Step 2: Test the age args expansion logic in isolation (no Bitwarden needed)**

The recipient parsing can be exercised by running the script under a fake `bw` that fakes a successful export. Easiest is to skip ahead and test against a real account in Task 8. For now, sanity-check by reading the diff:

```bash
git diff images/bitwarden-backup/backup.sh
```

Confirm: `set --` splits whitespace, loop builds `-r <r>` per recipient, `age` invocation places `-o "$out"` and reads `< "$plaintext"`.

- [ ] **Step 3: Rebuild**

```bash
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
```

- [ ] **Step 4: Smoke test still passes**

```bash
docker run --rm bitwarden-backup:dev 2>&1 | grep -q "must be set" && echo "smoke OK"
```

- [ ] **Step 5: Commit**

```bash
git add images/bitwarden-backup/backup.sh
git commit -m "feat(bitwarden-backup): encrypt export to N age recipients"
```

---

## Task 6: Implement retention pruning

**Files:**
- Modify: `images/bitwarden-backup/backup.sh`

- [ ] **Step 1: Replace the trailing placeholder**

Find `echo "encryption OK; prune and recovery not yet implemented" >&2` and the `exit 1` below it; replace with:

```sh
step 10 "prune old backups"
find "$BACKUP_DIR" -maxdepth 1 -type f \
    -name "${FILENAME_PREFIX}-*.json.age" \
    -mtime "+${RETENTION_DAYS}" \
    -delete

echo "prune OK; recovery and logout not yet implemented" >&2
exit 1
```

- [ ] **Step 2: Validate the find expression on the host (no docker needed)**

```bash
mkdir -p /tmp/prune-test
touch -d '60 days ago' /tmp/prune-test/bitwarden-2026-01-01.json.age
touch -d '5 days ago'  /tmp/prune-test/bitwarden-2026-05-18.json.age
touch              /tmp/prune-test/bitwarden-2026-05-23.json.age
touch              /tmp/prune-test/UNRELATED.txt

find /tmp/prune-test -maxdepth 1 -type f \
    -name "bitwarden-*.json.age" \
    -mtime +30 \
    -delete

ls /tmp/prune-test
```

Expected: `bitwarden-2026-05-18.json.age`, `bitwarden-2026-05-23.json.age`, `UNRELATED.txt` remain. The 60-days-ago file is gone. Cleanup:

```bash
rm -rf /tmp/prune-test
```

- [ ] **Step 3: Rebuild and smoke-test**

```bash
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
docker run --rm bitwarden-backup:dev 2>&1 | grep -q "must be set" && echo "smoke OK"
```

- [ ] **Step 4: Commit**

```bash
git add images/bitwarden-backup/backup.sh
git commit -m "feat(bitwarden-backup): prune backups older than RETENTION_DAYS"
```

---

## Task 7: Refresh `RECOVERY.md` and log out

**Files:**
- Create: `images/bitwarden-backup/RECOVERY.md.tmpl`
- Modify: `images/bitwarden-backup/Dockerfile` (copy the template into the image)
- Modify: `images/bitwarden-backup/backup.sh`

- [ ] **Step 1: Write the RECOVERY.md template**

Create `images/bitwarden-backup/RECOVERY.md.tmpl`:

```markdown
# Bitwarden vault recovery

This directory contains encrypted exports of a Bitwarden vault. Filenames
follow `<prefix>-YYYY-MM-DD.json.age`. Each file is an age-encrypted JSON
export from `bw export --format json`.

## To decrypt one file

You need an age identity (private key) whose public key was listed in
`BITWARDEN_AGE_RECIPIENTS` at backup time.

```sh
age -d -i /path/to/your.key -o vault.json <prefix>-YYYY-MM-DD.json.age
```

The resulting `vault.json` is the raw, unencrypted Bitwarden export. Treat
it as a plaintext copy of every credential in the vault — store it on an
encrypted volume only, and shred it when you're done.

## To restore into a Bitwarden vault

1. Stand up a fresh Bitwarden vault (Bitwarden.com account or self-hosted).
2. Log into the web vault UI.
3. Tools → Import data → pick "Bitwarden (json)" → upload `vault.json`.

## Why age, not GPG?

`age` is a minimal, modern file-encryption tool. The image only needs to
produce ciphertext for a list of public-key recipients — `age` ships a
single static binary, no keyring, no key-server, no metadata leaks.

Public-key recipients are configured per-cluster via the
`BITWARDEN_AGE_RECIPIENTS` env var, so adding a new recovery key is a
config change rather than an image change.
```

- [ ] **Step 2: Add the COPY line to the Dockerfile**

Insert between the `COPY backup.sh ...` line and the `RUN chmod ...` line:

```dockerfile
COPY RECOVERY.md.tmpl /usr/share/bitwarden-backup/RECOVERY.md
```

So that section reads:

```dockerfile
COPY backup.sh /usr/local/bin/bitwarden-backup
RUN chmod 0755 /usr/local/bin/bitwarden-backup

COPY RECOVERY.md.tmpl /usr/share/bitwarden-backup/RECOVERY.md
```

- [ ] **Step 3: Replace the trailing placeholder in backup.sh**

Find `echo "prune OK; recovery and logout not yet implemented" >&2` and the `exit 1` below it; replace with:

```sh
step 11 "refresh RECOVERY.md"
cp /usr/share/bitwarden-backup/RECOVERY.md "${BACKUP_DIR}/RECOVERY.md"

step 12 "bw logout"
bw logout >/dev/null

echo "backup complete" >&2
```

(Note: no `exit 1` at the end. Set `-e` propagates failures from each step; reaching the end means success and exit 0.)

- [ ] **Step 4: Rebuild and smoke-test**

```bash
docker buildx build -t bitwarden-backup:dev images/bitwarden-backup
docker run --rm bitwarden-backup:dev 2>&1 | grep -q "must be set" && echo "smoke OK"
docker run --rm --entrypoint cat bitwarden-backup:dev /usr/share/bitwarden-backup/RECOVERY.md | head -3
```

Expected: smoke OK; the first three lines of the template print.

- [ ] **Step 5: Commit**

```bash
git add images/bitwarden-backup/RECOVERY.md.tmpl \
        images/bitwarden-backup/Dockerfile \
        images/bitwarden-backup/backup.sh
git commit -m "feat(bitwarden-backup): refresh RECOVERY.md and log out at end of run"
```

---

## Task 8: End-to-end verification against a real Bitwarden account

The script's behavior past validation can only be confirmed against a real account. The export is read-only with respect to the vault, so this is non-destructive.

**Files:** none (verification-only)

- [ ] **Step 1: Generate a throwaway age keypair for the test**

```bash
mkdir -p /tmp/bw-backup-test
cd /tmp/bw-backup-test
age-keygen -o test.key 2>/tmp/bw-backup-test/test.pub
cat /tmp/bw-backup-test/test.pub
```

If `age-keygen` is not on the host, do it inside the image:

```bash
docker run --rm --entrypoint sh ghcr.io/drzero42/bitwarden-backup:dev -c 'age-keygen' \
  > /tmp/bw-backup-test/test.key 2> /tmp/bw-backup-test/test.pub
```

Note the `# public key:` line from `test.pub` — that's the recipient.

- [ ] **Step 2: Collect Bitwarden API credentials**

You need a working `client_id` / `client_secret` from the Bitwarden web vault (Settings → Security → Keys → API key) and the account master password. Confirm they're valid by running `bw login --apikey` on the host first if you have `bw` installed; otherwise rely on the image run.

- [ ] **Step 3: Run end-to-end with real credentials**

```bash
mkdir -p /tmp/bw-backup-test/out
docker run --rm \
  -e BW_SERVER=https://vault.bitwarden.com \
  -e BW_CLIENTID="<your-client-id>" \
  -e BW_CLIENTSECRET="<your-client-secret>" \
  -e BW_PASSWORD="<your-master-password>" \
  -e BACKUP_DIR=/backup \
  -e BITWARDEN_AGE_RECIPIENTS="$(grep '^age1' /tmp/bw-backup-test/test.pub | head -1)" \
  -v /tmp/bw-backup-test/out:/backup \
  bitwarden-backup:dev
```

Expected stderr: each `==> step N: <label>` line, finally `backup complete`. Exit 0.

- [ ] **Step 4: Verify the output**

```bash
ls -la /tmp/bw-backup-test/out
# expect: bitwarden-YYYY-MM-DD.json.age and RECOVERY.md

age -d -i /tmp/bw-backup-test/test.key \
    -o /tmp/bw-backup-test/out/decrypted.json \
    /tmp/bw-backup-test/out/bitwarden-*.json.age

# Quick sanity: should parse as JSON with an "items" array
head -c 200 /tmp/bw-backup-test/out/decrypted.json
echo
grep -o '"items"' /tmp/bw-backup-test/out/decrypted.json | head -1
```

Expected: `decrypted.json` is created, starts with `{`, contains `"items"`.

- [ ] **Step 5: Verify the *_FILE form works end-to-end**

```bash
printf '%s' '<your-master-password>' > /tmp/bw-backup-test/pw

docker run --rm \
  -e BW_SERVER=https://vault.bitwarden.com \
  -e BW_CLIENTID="<your-client-id>" \
  -e BW_CLIENTSECRET="<your-client-secret>" \
  -e BW_PASSWORD_FILE=/secrets/pw \
  -e BACKUP_DIR=/backup \
  -e BITWARDEN_AGE_RECIPIENTS="$(grep '^age1' /tmp/bw-backup-test/test.pub | head -1)" \
  -v /tmp/bw-backup-test/out:/backup \
  -v /tmp/bw-backup-test/pw:/secrets/pw:ro \
  bitwarden-backup:dev
```

Expected: same successful run. Confirms `*_FILE` resolution in the real path.

- [ ] **Step 6: Cleanup**

```bash
shred -u /tmp/bw-backup-test/test.key /tmp/bw-backup-test/pw /tmp/bw-backup-test/out/decrypted.json
rm -rf /tmp/bw-backup-test
```

- [ ] **Step 7: No commit (verification only)**

If a flag spelling needed adjusting based on what you observed, that fix lands in a follow-up commit *before* Task 9.

---

## Task 9: Update CI workflow — date-N tag computation via crane

**Files:**
- Modify: `.github/workflows/build.yml`

- [ ] **Step 1: Add the `setup-crane` step**

In `.github/workflows/build.yml`, inside the `build:` job's `steps:` list, insert AFTER the `docker/login-action` step and BEFORE the `Compute tags` step:

```yaml
      - name: Set up crane
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        uses: imjasonh/setup-crane@v0.4
```

(PR runs don't push, so they don't need `crane`. The compute-tags step keeps the existing PR branch.)

- [ ] **Step 2: Replace the `Compute tags` step**

The existing step (lines 59–72 of `build.yml`):

```yaml
      - name: Compute tags
        id: tags
        run: |
          owner="${GITHUB_REPOSITORY_OWNER,,}"
          image="ghcr.io/${owner}/${{ matrix.image }}"
          short_sha="${GITHUB_SHA::7}"
          if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then
            echo "tags=${image}:latest,${image}:sha-${short_sha}" >> "$GITHUB_OUTPUT"
            echo "push=true" >> "$GITHUB_OUTPUT"
          else
            echo "tags=${image}:pr-${short_sha}" >> "$GITHUB_OUTPUT"
            echo "push=false" >> "$GITHUB_OUTPUT"
          fi
```

Replace with:

```yaml
      - name: Compute tags
        id: tags
        run: |
          set -euo pipefail
          owner="${GITHUB_REPOSITORY_OWNER,,}"
          image="ghcr.io/${owner}/${{ matrix.image }}"
          short_sha="${GITHUB_SHA::7}"
          if [ "${{ github.event_name }}" = "push" ] && [ "${{ github.ref }}" = "refs/heads/main" ]; then
            date_today=$(date -u +%F)
            # crane ls exits non-zero on a not-yet-published image; that's expected on first push.
            existing=$(crane ls "${image}" 2>/dev/null \
              | grep -E "^${date_today}-[0-9]+$" \
              | sed "s/^${date_today}-//" \
              | sort -n \
              | tail -1 || true)
            n=$(( ${existing:-0} + 1 ))
            tag="${date_today}-${n}"
            echo "tags=${image}:${tag},${image}:latest" >> "$GITHUB_OUTPUT"
            echo "load_tag=${image}:${tag}" >> "$GITHUB_OUTPUT"
            echo "push=true" >> "$GITHUB_OUTPUT"
          else
            echo "tags=${image}:pr-${short_sha}" >> "$GITHUB_OUTPUT"
            echo "load_tag=${image}:pr-${short_sha}" >> "$GITHUB_OUTPUT"
            echo "push=false" >> "$GITHUB_OUTPUT"
          fi
```

Note: the new `load_tag` output is needed by Task 10's smoke test. The PR branch sets it too so the smoke test runs identically on both.

- [ ] **Step 3: Validate the YAML parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))"
```

Expected: no output (valid YAML).

- [ ] **Step 4: Validate the crane-grep-sed pipeline against a fake input on the host**

```bash
date_today=2026-05-23
printf '2026-05-22-1\n2026-05-23-1\n2026-05-23-2\nlatest\nsha-abcdef0\n' \
  | grep -E "^${date_today}-[0-9]+$" \
  | sed "s/^${date_today}-//" \
  | sort -n \
  | tail -1
```

Expected: `2`.

```bash
# First-push behavior: no existing tags
printf 'latest\n' \
  | grep -E "^${date_today}-[0-9]+$" \
  | sed "s/^${date_today}-//" \
  | sort -n \
  | tail -1 || true
# (prints nothing; n=0+1=1)
```

Expected: empty stdout, no error.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci: tag images YYYY-MM-DD-N via crane lookup of same-day rebuilds"
```

---

## Task 10: Add CI smoke-test step

**Files:**
- Modify: `.github/workflows/build.yml`

- [ ] **Step 1: Split the existing single `build-push-action` step into build-then-smoke-then-push**

The current step (lines 73–79):

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: images/${{ matrix.image }}
          push: ${{ steps.tags.outputs.push }}
          tags: ${{ steps.tags.outputs.tags }}
          cache-from: type=gha,scope=${{ matrix.image }}
          cache-to: type=gha,scope=${{ matrix.image }},mode=max
```

Replace with two steps — first builds and loads locally, second runs the smoke test, third pushes (only on main):

```yaml
      - name: Build (load locally for smoke test)
        uses: docker/build-push-action@v6
        with:
          context: images/${{ matrix.image }}
          load: true
          tags: ${{ steps.tags.outputs.load_tag }}
          cache-from: type=gha,scope=${{ matrix.image }}
          cache-to: type=gha,scope=${{ matrix.image }},mode=max

      - name: Smoke test entrypoint
        run: |
          set -euo pipefail
          load_tag="${{ steps.tags.outputs.load_tag }}"
          # Run with no env vars; expect non-zero exit + "must be set" on stderr.
          if docker run --rm "${load_tag}" >/tmp/smoke.stdout 2>/tmp/smoke.stderr; then
            echo "ERROR: image exited 0 with no env vars set" >&2
            cat /tmp/smoke.stdout /tmp/smoke.stderr >&2
            exit 1
          fi
          if ! grep -q "must be set" /tmp/smoke.stderr; then
            echo "ERROR: stderr did not contain 'must be set'" >&2
            cat /tmp/smoke.stderr >&2
            exit 1
          fi
          echo "smoke OK"

      - name: Push
        if: steps.tags.outputs.push == 'true'
        uses: docker/build-push-action@v6
        with:
          context: images/${{ matrix.image }}
          push: true
          tags: ${{ steps.tags.outputs.tags }}
          cache-from: type=gha,scope=${{ matrix.image }}
          cache-to: type=gha,scope=${{ matrix.image }},mode=max
```

Notes:
- `load: true` requires single-platform; we're amd64-only so this is fine.
- The "Push" step rebuilds from the same cache, so it's near-instant — buildx pulls the just-built layers from the gha cache.
- The smoke step doesn't push, so a failing smoke test blocks the push step on main.

- [ ] **Step 2: Validate YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))"
```

Expected: no output.

- [ ] **Step 3: Local smoke-test rehearsal**

This is the same logic the CI step runs. Confirm it passes against the locally-built image:

```bash
load_tag=bitwarden-backup:dev
if docker run --rm "${load_tag}" >/tmp/smoke.stdout 2>/tmp/smoke.stderr; then
    echo "FAIL: exit 0"
else
    grep -q "must be set" /tmp/smoke.stderr && echo "smoke OK" || echo "FAIL: substring missing"
fi
```

Expected: `smoke OK`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci: smoke-test image entrypoint before pushing"
```

---

## Task 11: Add Renovate config

**Files:**
- Create: `.github/renovate.json`

- [ ] **Step 1: Write the initial config**

Create `.github/renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "customManagers": [
    {
      "customType": "regex",
      "fileMatch": ["^images/[^/]+/Dockerfile$"],
      "matchStrings": [
        "# renovate: datasource=(?<datasource>.+?) depName=(?<depName>.+?)(?: versioning=(?<versioning>.+?))?(?: extractVersion=(?<extractVersion>.+?))?\\s+ARG \\w+=(?<currentValue>.+?)\\s"
      ],
      "versioningTemplate": "{{#if versioning}}{{versioning}}{{else}}semver{{/if}}"
    }
  ],
  "packageRules": [
    {
      "matchManagers": ["custom.regex"],
      "matchDepNames": ["bitwarden/clients"],
      "groupName": "bitwarden-cli",
      "commitMessageTopic": "bitwarden CLI"
    },
    {
      "matchManagers": ["dockerfile"],
      "matchPackageNames": ["chainguard/wolfi-base"],
      "groupName": "wolfi-base",
      "commitMessageTopic": "wolfi-base"
    }
  ]
}
```

Notes on what this does:
- `config:recommended` gives standard PR cadence, semantic commits, schedule.
- The custom regex manager matches the `# renovate: ...` annotation comments in any `images/*/Dockerfile`, paired with the next `ARG`. This means new images get Renovate coverage automatically as long as they follow the annotation pattern.
- The wolfi base image (`FROM chainguard/wolfi-base:latest@sha256:...`) is handled by Renovate's built-in `dockerfile` manager — it tracks both the tag and the digest and raises a PR when the digest under `:latest` changes (which happens daily on wolfi). The packageRule above just groups those PRs.
- `age` no longer has a Renovate channel: it rides the wolfi-base digest. Whenever the wolfi-base PR merges, `apk add age` at build time picks up whatever age version is in the wolfi repo at that snapshot.
- **Known limitation:** auto-cobumping the `BW_VERSION` and `BW_SHA256` pair is not handled by this config. Renovate will raise a `BW_VERSION` bump PR; the CI build will fail at `sha256sum -c`; the maintainer manually updates `BW_SHA256` in the same PR. See "Open items" at end of plan.

- [ ] **Step 2: Validate JSON**

```bash
python3 -c "import json; json.load(open('.github/renovate.json'))"
```

Expected: no output.

- [ ] **Step 3: Renovate dry-run**

Renovate offers a hosted "validator" + a CLI dry-run mode. The CLI dry-run is the gold standard:

```bash
# In a side branch (no PR), confirm the config parses and matches:
docker run --rm \
  -v "$(pwd):/usr/src/app" \
  -e LOG_LEVEL=debug \
  -e RENOVATE_CONFIG_FILE=/usr/src/app/.github/renovate.json \
  -e RENOVATE_DRY_RUN=true \
  renovate/renovate:latest \
  --platform=local 2>&1 | tee /tmp/renovate-dryrun.log | tail -60
```

Look in `/tmp/renovate-dryrun.log` for:
- The string `bitwarden/clients` — confirms the bw ARG is detected by the custom regex manager.
- The string `chainguard/wolfi-base` — confirms the `FROM` line is detected by the built-in dockerfile manager.
- No `error` or `WARN` lines mentioning the custom manager regex.

If any of those are missing, iterate on the regex in `matchStrings` (the spec acknowledges this regex is the most failure-prone piece) and re-run the dry-run. The trailing `\s` in the regex is important — it requires a whitespace boundary after `currentValue`.

- [ ] **Step 4: Commit**

```bash
git add .github/renovate.json
git commit -m "ci: add Renovate config for wolfi base digest and bw release pin"
```

---

## Task 12: Update CLAUDE.md tag scheme documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the Publishing section**

In `CLAUDE.md`, find this block:

```
## Publishing

CI handles publishing — on push to `main`, each image is tagged `latest` and `sha-<short>` and pushed to `ghcr.io/<owner>/<name>`. PRs build but do not push. No manual `docker push` workflow.
```

Replace with:

```
## Publishing

CI handles publishing — on push to `main`, each image is tagged `YYYY-MM-DD-N` (N starts at 1 and increments per same-day rebuild) and `latest`, then pushed to `ghcr.io/<owner>/<name>`. PRs build but do not push. Consumers should pin by tag and digest.
```

- [ ] **Step 2: Confirm the diff is minimal**

```bash
git diff CLAUDE.md
```

Expected: only the Publishing paragraph changed.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document YYYY-MM-DD-N tag scheme in CLAUDE.md"
```

---

## Task 13: Final verification — open a PR and watch the first CI run

**Files:** none

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin HEAD
gh pr create --title "Add bitwarden-backup image and date-N tag scheme" --body "$(cat <<'EOF'
## Summary
- New `images/bitwarden-backup/` image (Dockerfile + POSIX sh entrypoint).
- CI workflow now tags images `YYYY-MM-DD-N` + `latest` via `crane ls`.
- New entrypoint smoke test gates pushes.
- New `.github/renovate.json` covers wolfi-base digest and bw release pin.

## Test plan
- [ ] PR build job succeeds, including smoke-test.
- [ ] On main-push, image appears in GHCR as `ghcr.io/drzero42/bitwarden-backup:2026-MM-DD-1` and `:latest`.
- [ ] `crane manifest ghcr.io/drzero42/bitwarden-backup:2026-MM-DD-1` returns a manifest; digest captured for the cloudzero CronJob pin.
- [ ] Renovate's first scheduled run picks up wolfi-base digest and bw release pin (see Renovate dashboard / debug log).
EOF
)"
```

- [ ] **Step 2: Watch the PR build**

```bash
gh pr checks --watch
```

Expected: `build (bitwarden-backup)` job succeeds, including the `Smoke test entrypoint` step.

- [ ] **Step 3: Merge the PR and watch the main-branch build**

After review/approval:

```bash
gh pr merge --squash
gh run watch
```

Expected: the workflow on `main` runs the same matrix; `crane ls` returns empty (first push), `n=1`, tag is `2026-MM-DD-1`. Image is pushed.

- [ ] **Step 4: Confirm the image is in GHCR**

```bash
crane ls ghcr.io/drzero42/bitwarden-backup
# expect: latest, 2026-MM-DD-1

crane digest ghcr.io/drzero42/bitwarden-backup:2026-MM-DD-1
# Note this digest down — the cloudzero CronJob will pin it.
```

- [ ] **Step 5: Sanity-rerun a same-day build**

Push any trivial commit to `main` (e.g. a CLAUDE.md typo fix) and confirm the next CI run tags the image `2026-MM-DD-2`:

```bash
gh run watch
crane ls ghcr.io/drzero42/bitwarden-backup
# expect: latest, 2026-MM-DD-1, 2026-MM-DD-2
```

This verifies the `crane ls | grep | sed | sort -n | tail -1` logic actually increments.

- [ ] **Step 6: Confirm Renovate has indexed the repo**

After Renovate's first scheduled scan (typically within an hour), check the Renovate dashboard issue (`Configure Renovate` / `Dependency Dashboard`) for entries naming `bitwarden/clients` and `chainguard/wolfi-base`. If the dashboard is missing, enable `dependencyDashboard: true` in `renovate.json` and push.

- [ ] **Step 7: No further commit**

Verification only.

---

## Self-review notes

- Every spec section has a corresponding task: image directory (1, 5–7), input contract / `*_FILE` convention (3), bw flag verification (2), bw session + export (4), encryption (5), prune (6), RECOVERY.md (7), CI tag scheme (9), CI smoke test (10), Renovate config (11), CLAUDE.md (12), end-to-end verification (8, 13).
- The `bw` flag spellings used in Task 4 are gated by Task 2's verification. If a flag differs from the spec, fix the script line in Task 4 before committing — no work has been built on top of that line yet.
- Identifier consistency: `BACKUP_DIR`, `FILENAME_PREFIX`, `RETENTION_DAYS`, `MIN_PLAINTEXT_BYTES`, `BITWARDEN_AGE_RECIPIENTS`, `BW_SERVER`, `BW_CLIENTID`, `BW_CLIENTSECRET`, `BW_PASSWORD` — these names are used identically in the spec's "Image contract" section, in the validation in Task 3, in the script bodies in Tasks 4–7, and in the verification commands in Task 8. The smoke test asserts `must be set`, which `die()` emits via every `require_env` / `resolve_secret` path.
- No "TBD" / "implement later" placeholders in any task body — every code-step ships the complete code.

---

## Open items (carried over from spec)

1. **`BW_VERSION` / `BW_SHA256` auto-cobumping.** This plan's Renovate config bumps `BW_VERSION` only. A version-only bump will fail at `sha256sum -c` in CI; the maintainer manually updates `BW_SHA256` in the same PR before re-running CI. A future improvement is a `customDatasources` entry that wires the version-and-digest pair together, or a GitHub Action triggered on Renovate PRs that rewrites the hash. Out of scope for the first image; revisit when a second hash-pinned binary appears.
2. **`arm64`.** Image is amd64-only. Spec marks this explicitly. Add later by enabling `docker/setup-qemu-action` and `platforms: linux/amd64,linux/arm64` on the push step, plus a parallel `bw-linux-arm64-<v>.zip` download in the Dockerfile.
3. **Crane availability.** If `imjasonh/setup-crane@v0.4` is unmaintained at implementation time, fall back to `curl`-against-the-GHCR-token-endpoint inside the Compute-tags step. Detect by checking https://github.com/imjasonh/setup-crane for recent commits before Task 9.
