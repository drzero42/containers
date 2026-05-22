# bitwarden-backup Image Design

Date: 2026-05-22
Status: Draft — awaiting user review

## Goal

Publish `ghcr.io/drzero42/bitwarden-backup`, the container image consumed by
the cloudzero CronJob designed in
[`2026-05-22-bitwarden-vault-backup-design.md`](../../../../cloudzero/docs/superpowers/specs/2026-05-22-bitwarden-vault-backup-design.md)
(separate repo). The image bundles the Bitwarden CLI, `age`, and a small
shell script that logs into Bitwarden by API key, exports the vault to
JSON, encrypts it to N age recipients, writes the result to a mounted
backup directory, prunes old files, and refreshes a `RECOVERY.md`. The
image holds no keys, no recipients, no paths, no credentials — every
configurable input is supplied at runtime.

This is the **first image** to land in this repo. The work also extends the
shared CI workflow to support a date-build-number tag scheme that applies
to every future image too.

## Scope

This spec covers the containers-repo side of the bitwarden-vault-backup
work:

- A new `images/bitwarden-backup/` directory: Dockerfile and entrypoint script.
- Modifications to `.github/workflows/build.yml`: per-day `N`-incrementing
  tag scheme for all images, plus a smoke-test step.
- A new `.github/renovate.json`: auto-bumps for alpine, the `age` apk
  pin, and the Bitwarden CLI release pin (version + sha256 in lockstep).
- A minor edit to `CLAUDE.md` to document the new tag scheme.

Out of scope: anything in the cloudzero repo (the consumer side). One
note for the consumer: the image accepts secret inputs in both env-var
and `*_FILE` form (see Image Contract below), so the cloudzero spec
should be amended to mention `*_FILE` once the consumer manifest lands.

## Decisions

| Choice | Picked | Rejected alternatives |
|---|---|---|
| Base image | `alpine:3.23` | debian:bookworm-slim (heavier, no gain); distroless+busybox (more multi-stage complexity for no benefit at this size) |
| `bw` install method | Download upstream release zip (`bw-linux-<v>.zip`), verify sha256, unzip a single static binary | npm install (drags in node); alpine community package (doesn't exist); `bw-oss-linux` variant (functionally fine but the regular CLI is what users mean by "Bitwarden CLI" and the spec calls it out by that name) |
| `age` install method | `apk add age=<pinned>` from alpine main | Download from upstream release (loses signed package chain) |
| Tag scheme | `YYYY-MM-DD-N` (e.g. `2026-05-22-1`) + `latest`, applied to **all** images via `build.yml` | Keep `latest`+`sha-<short>` (rejected: cloudzero spec consumes the date-N format with Renovate regex versioning); per-image opt-in marker file (more moving parts than warranted for a single tag convention) |
| Per-day `N` computation | `crane ls ghcr.io/drzero42/<image>` filtered to today's date prefix, take max + 1 | In-repo counter file (commit-back loop, race conditions, per-day reset logic); `gh api` packages endpoint (equivalent but more response-shape work and same first-push fallback needed) |
| Secret inputs | Accept BOTH `<VAR>` env var AND `<VAR>_FILE` file path; setting both is an error | Env-var only (user runs in k8s and prefers file-mounted Secrets — see "Secret input convention" below) |
| Architecture | `linux/amd64` only | Add `arm64` later via `buildx --platforms` and a second `bw-linux-arm64-*.zip` download. Matches the repo's current CLAUDE.md baseline. |
| Renovate | Set up now in this repo (`.github/renovate.json`) with custom co-bumping of `BW_VERSION` + `BW_SHA256` | Defer (rejected: the pins about to be added are precisely the thing Renovate is for, and the bigger spec assigns the responsibility to this repo) |
| Smoke test | Run built image with no env vars in CI; assert exit non-zero and stderr contains `must be set` | Trust scheduled CronJob run to surface breakage (rejected: a broken entrypoint could ride a published tag for 24h before the cluster notices) |
| Script language | POSIX `sh` (`#!/bin/sh`, `set -eu`, `set -o pipefail`) | Bash (no need; alpine ships busybox ash); Python (overkill for ~80 lines of orchestration) |

## Repo layout (after this work)

```
/home/abo/workspace/home/containers/
├── .github/
│   ├── renovate.json                 # NEW
│   └── workflows/
│       └── build.yml                 # MODIFIED (date-N tags + smoke test)
├── images/
│   └── bitwarden-backup/             # NEW
│       ├── Dockerfile
│       └── backup.sh
├── CLAUDE.md                         # MINOR (tag scheme line)
├── README.md
└── devenv.nix                        # unchanged
```

## Secret input convention

Every image in this repo that will be deployed to Kubernetes accepts each
secret input via two forms:

1. `FOO` — env var with the value directly.
2. `FOO_FILE` — path to a file containing the value (typically a mounted
   Secret volume).

The script normalizes early: if `FOO_FILE` is set, read it (trim trailing
newline) into `FOO` and `unset FOO_FILE`. Subsequent code only ever
consults the env-var form.

| Both forms set | `FOO and FOO_FILE both set: pick one`, exit non-zero |
| `FOO_FILE` set but unreadable / empty | `FOO_FILE=<path>: <reason>`, exit non-zero |
| Neither set, var required | `FOO or FOO_FILE must be set`, exit non-zero |

The image rejects ambiguity rather than picking a winner, because the
k8s manifest reviewer needs to be able to look at the spec and know
exactly which source is in use.

Non-secret inputs (URLs, paths, recipient lists, retention) do not get
the `_FILE` variant — they're env-only.

## Image contract (cloudzero-facing)

This is what the cloudzero CronJob pins against. Any change here is a
two-repo coordination.

**Image identity**
- Registry / name: `ghcr.io/drzero42/bitwarden-backup`
- Tag scheme: `YYYY-MM-DD-N`, plus a moving `latest`
- Consumer pins by both tag **and** digest

**Tools on `PATH`**
- `bw` (Bitwarden CLI, pinned)
- `age` (pinned)
- POSIX shell + busybox: `sh`, `find`, `stat`, `mktemp`, `date`, `cat`,
  `rm`, `printf`, `test`, `trap`, `sed`, `tr`
- `ca-certificates`

**User**
- Default UID 1000, GID 1000, non-root

**Entrypoint**
- Runs `/usr/local/bin/bitwarden-backup` with no arguments

**Required inputs** (each must be supplied via env var OR `*_FILE`;
setting both forms for one input is an error):

| Input | Secret? | Env var | File variant |
|---|---|---|---|
| Bitwarden server URL | no | `BW_SERVER` | — |
| API client ID | yes | `BW_CLIENTID` | `BW_CLIENTID_FILE` |
| API client secret | yes | `BW_CLIENTSECRET` | `BW_CLIENTSECRET_FILE` |
| Master password | yes | `BW_PASSWORD` | `BW_PASSWORD_FILE` |
| Backup output dir | no | `BACKUP_DIR` | — |
| age recipients (space-sep) | no | `BITWARDEN_AGE_RECIPIENTS` | — |

**Optional inputs** (image supplies defaults; no `_FILE` variants since
none of these are secrets):

| Input | Env var | Default |
|---|---|---|
| Retention (days) | `RETENTION_DAYS` | `30` |
| Filename prefix | `FILENAME_PREFIX` | `bitwarden` |
| Min plaintext bytes | `MIN_PLAINTEXT_BYTES` | `1024` |

**Image-internal conventions** (the manifest needs to know about these
to provide the right mounts):

- `HOME=/tmp` (set in the image)
- `BITWARDENCLI_APPDATA_DIR=/tmp/bw-appdata` (set in the image)
- `/tmp` must be writable — manifest provides `emptyDir` with `medium: Memory`
- `readOnlyRootFilesystem: true` is supported

**Failure modes**

Every required-input error emits `must be set` somewhere in the message,
so the CI smoke test has a single substring to grep for.

## `backup.sh` behavior

Ordered steps. Each step prints a `==> step N: <label>` line before
executing, so failures are unambiguous in CronJob logs.

1. **Resolve `*_FILE` inputs.** For each of `BW_CLIENTID`,
   `BW_CLIENTSECRET`, `BW_PASSWORD`: if `<VAR>_FILE` is set, read the
   file (strip trailing newline) into `<VAR>` and `unset <VAR>_FILE`.
   Reject both-set as ambiguous. Reject unreadable / empty file.
2. **Validate required inputs.** After resolution, assert each required
   env var is non-empty. First missing one wins and exits with
   `<VAR> or <VAR>_FILE must be set` (or, for non-secret inputs without
   a file form: `<VAR> must be set`).
3. **Set up tmpfile + trap.** `plaintext=$(mktemp /tmp/bw-export.XXXXXX.json)`;
   `trap 'rm -f "$plaintext"' EXIT INT TERM`.
4. **Bitwarden session.** `bw config server "$BW_SERVER"`;
   `bw login --apikey` (consumes `BW_CLIENTID`/`BW_CLIENTSECRET` from env);
   `BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)`;
   `export BW_SESSION`; `bw sync`.
5. **Export vault.**
   `bw export --raw --format json --password "$BW_PASSWORD" > "$plaintext"`.
   Passing `--password` is mandatory: with a valid `BW_SESSION` but
   nothing supplied to `bw export`, current `bw` versions re-prompt and
   the container hangs forever.
6. **Plaintext sanity check.**
   `[ "$(stat -c%s "$plaintext")" -ge "${MIN_PLAINTEXT_BYTES:-1024}" ]`
   or exit non-zero with a clear message.
7. **Encrypt with `age`.** Build args by splitting
   `BITWARDEN_AGE_RECIPIENTS` on whitespace, prepending `-r` to each.
   Output to `${BACKUP_DIR}/${FILENAME_PREFIX:-bitwarden}-$(date -u +%F).json.age`.
   Same-day re-runs overwrite (intentional refresh).
8. **Prune.**
   `find "$BACKUP_DIR" -maxdepth 1 -name "${FILENAME_PREFIX:-bitwarden}-*.json.age" -mtime "+${RETENTION_DAYS:-30}" -delete`.
9. **Refresh `RECOVERY.md`.** Cat a static heredoc into
   `${BACKUP_DIR}/RECOVERY.md`. Template lives in the image; not parameterized.
10. **`bw logout`.** Releases the API session. The EXIT trap clears
    the plaintext file.

The exact `bw` flag spellings (e.g. `--passwordenv`, `bw export`
positional argument order) can drift between CLI versions. The
implementation plan must include a "verify the flags actually exist
on the pinned version with `bw <subcmd> --help`" step before declaring
the script done.

## Dockerfile shape

Single-stage. Pins captured as `ARG` so Renovate can grep them. Sketch
(exact lines settled in the implementation plan):

```dockerfile
FROM alpine:3.23

# renovate: datasource=repology depName=alpine_3_23/age versioning=loose
ARG AGE_VERSION=1.2.1-r15

# renovate: datasource=github-releases depName=bitwarden/clients extractVersion=^cli-v(?<version>.+)$
ARG BW_VERSION=2026.4.2
ARG BW_SHA256=431dbe784cc7de217cb3a826993eac451aa2fbaf336538c0ff6602c1ac884c91

RUN apk add --no-cache \
        ca-certificates \
        "age=${AGE_VERSION}"

RUN set -eu; \
    cd /tmp; \
    wget -O bw.zip "https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/bw-linux-${BW_VERSION}.zip"; \
    echo "${BW_SHA256}  bw.zip" | sha256sum -c -; \
    unzip bw.zip; \
    install -m 0755 bw /usr/local/bin/bw; \
    rm -f bw.zip bw

RUN adduser -D -u 1000 -g 1000 backup

COPY backup.sh /usr/local/bin/bitwarden-backup
RUN chmod 0755 /usr/local/bin/bitwarden-backup

ENV HOME=/tmp \
    BITWARDENCLI_APPDATA_DIR=/tmp/bw-appdata

USER 1000:1000
WORKDIR /tmp

ENTRYPOINT ["/usr/local/bin/bitwarden-backup"]
```

Notes:
- `unzip` is in busybox in alpine 3.23, so no extra apk needed.
- `wget` is also busybox — supports https with `ca-certificates` installed.
- `WORKDIR /tmp` avoids needing a writable working directory under `/`
  when `readOnlyRootFilesystem: true` is set.

## CI workflow changes (`.github/workflows/build.yml`)

Three changes; the discover-images job is unmodified.

**1. Compute tags step.** Replaces the existing "Compute tags". On a
main-branch push:

```sh
date_today=$(date -u +%F)
# crane ls returns exit 1 on a not-yet-published image; that's expected
existing=$(crane ls "ghcr.io/${owner}/${image}" 2>/dev/null \
    | grep -E "^${date_today}-[0-9]+$" \
    | sed "s/^${date_today}-//" \
    | sort -n \
    | tail -1)
n=$(( ${existing:-0} + 1 ))
tag="${date_today}-${n}"
```

Tags published: `ghcr.io/drzero42/<image>:${tag}` and `…:latest`.

PR builds keep `pr-<sha-short>`, `push: false`, no crane query.

Adds: `imjasonh/setup-crane@v0.4` step before tag computation.

**2. Smoke-test step.** Between build and push. Build locally with
`load: true` (single platform — already amd64-only), then:

```sh
docker run --rm "${load_tag}" 2>&1 | tee smoke.log; ec=$?
test "$ec" -ne 0 || { echo "image exited 0 with no env vars set"; exit 1; }
grep -q "must be set" smoke.log
```

Both PR and main runs smoke-test. Smoke-test must pass for push to
proceed on main.

**3. No matrix changes.** Smoke-test runs inside the existing per-image
matrix.

## Renovate config (`.github/renovate.json`)

Located at `.github/renovate.json` (not repo root) per the user's
convention. Three update channels:

- **Base image** (`FROM alpine:3.23`): handled by the built-in `dockerfile`
  manager, no config needed.
- **`age` apk pin** (`AGE_VERSION=1.2.1-r15`): handled via the `repology`
  datasource. Annotation in the Dockerfile;
  `repology/project/alpine_3_23/age`.
- **`bw` release pin** (`BW_VERSION` + `BW_SHA256`): handled via a custom
  regex manager that re-fetches the sha256 from the GitHub release on
  every version bump. Without this, a `BW_VERSION` bump alone would break
  the `sha256sum -c` step.

The exact JSON for the custom regex manager is settled in the
implementation plan — it requires a `customManagers` entry plus
post-upgrade behavior to recompute the hash. Renovate supports this via
`customDatasources` chained with a release-asset endpoint.

`renovate.json` also extends `config:recommended` for the standard
preset (PR cadence, semantic-commits, etc.).

Cross-repo note: the cloudzero repo's separate Renovate setup will have
the `versioning: "regex:^(?<major>\\d{4})-(?<minor>\\d{2})-(?<patch>\\d{2})-(?<build>\\d+)$"`
rule for `ghcr.io/drzero42/bitwarden-backup`. That belongs over there,
not in this file.

## CLAUDE.md update

The existing "Publishing" section in `CLAUDE.md` says images are tagged
`latest` and `sha-<short>`. Update to:

> CI handles publishing — on push to `main`, each image is tagged
> `YYYY-MM-DD-N` (N starts at 1 and increments per same-day rebuild) and
> `latest`, then pushed to `ghcr.io/drzero42/<name>`. PRs build but do not
> push. Consumers should pin by tag and digest.

## Verification

After the implementation lands:

1. **Local build sanity:** `docker buildx build -t bitwarden-backup:dev images/bitwarden-backup` succeeds.
2. **Local entrypoint sanity:** `docker run --rm bitwarden-backup:dev` exits non-zero with `must be set` on stderr.
3. **First PR build in CI:** the PR build job succeeds, including smoke-test.
4. **First main-push:** image lands in GHCR as both `ghcr.io/drzero42/bitwarden-backup:2026-MM-DD-1` and `:latest`. `crane manifest ghcr.io/drzero42/bitwarden-backup:2026-MM-DD-1` returns a manifest; the digest is captured and ready for the cloudzero CronJob's `image:` pin.
5. **Renovate first reconciliation:** Renovate's debug log on the next scheduled run shows it has discovered the alpine, age, and bw pins. Verifies the customManager regex actually matches.

## Open items

- **Exact `bw` CLI flag verification.** The `--passwordenv`, `--passwordfile`,
  and `bw export --password` flags are all documented for the 2026.x line,
  but spelling has drifted across versions historically. Verify against
  `bw <subcmd> --help` from the pinned 2026.4.2 image at implementation time.
- **customManager JSON exact shape.** The Renovate docs for chaining a
  version bump with a sha256 re-fetch are nuanced and version-dependent.
  Implementation plan must include a "Renovate dry-run with `--debug`" step
  on a side branch to confirm the bump actually fires.
- **Crane availability.** `imjasonh/setup-crane` is the de-facto action.
  If it has issues or is unmaintained, the implementation plan falls back
  to a `curl`-based GHCR token + manifest HEAD-loop.
