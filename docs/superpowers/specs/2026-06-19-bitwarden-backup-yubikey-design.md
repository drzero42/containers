# bitwarden-backup YubiKey Support Design

## Summary

Extend the existing `images/bitwarden-backup` image so `BITWARDEN_AGE_RECIPIENTS`
can include YubiKey-backed age recipients (`age1yubikey1…`) in addition to the
software recipients (`age1…`) it already accepts. The intended deployment lists
**two** YubiKey recipients — a primary and a backup key — producing a single
`.age` file that *either* key can decrypt. Software recipients remain fully
supported.

This is a follow-up to the initial bitwarden-backup image
(`2026-05-22-bitwarden-backup-image-design.md` /
`2026-05-23-bitwarden-backup-image.md`), which shipped with `age` but no
plugin, so `age1yubikey1…` recipients would fail at encrypt time.

## Background: why this is small

`age` is natively multi-recipient. A single `age -r A -r B …` invocation
encrypts the payload **once** with a random file key, then wraps that file key
separately for each recipient. The output is one `.age` file decryptable by any
one of the listed recipients. `backup.sh` already builds `-r <recipient>` args
by splitting `BITWARDEN_AGE_RECIPIENTS` on whitespace. So "two YubiKeys, single
file, either decrypts" is purely a matter of *which recipient strings the
operator supplies* — not a code change.

The only thing the image lacks is the `age-plugin-yubikey` binary. `age`
resolves an `age1yubikey1…` recipient by `exec`ing `age-plugin-yubikey` off
`$PATH` and speaking the stable age-plugin stdio protocol (`recipient-v1` /
`identity-v1`). Encrypting to a YubiKey recipient wraps the file key against the
public key embedded in the recipient string — **pure software, no hardware
attached**. The physical key (plus PIN/touch) is required only at *decrypt*
time, on the recovery machine. This is what makes YubiKey-encrypted backups
viable from an unattended Kubernetes CronJob.

## Verified facts

These were checked, not assumed:

- **`age` in the image is 1.3.1**, installed from wolfi via `apk add age`,
  version-bound to the `chainguard/wolfi-base` digest pin (no explicit
  `age=<version>`). 1.3.1 is well past v1.1.0, where age gained plugin support.
- **`age-plugin-yubikey` is NOT packaged in wolfi.** Exact and glob searches
  (`*yubikey*`, `*age-plugin*`) return nothing. So `apk add` is not an option
  for the plugin; it must come from the upstream `str4d/age-plugin-yubikey`
  GitHub release.
- **`pcsc-lite` IS in wolfi** (`pcsc-lite-2.5.1-r1`). If the plugin binary needs
  the smartcard runtime library to load, it can be satisfied with `apk add
  pcsc-lite` — no extra sourcing.

## Decisions

| Decision | Choice | Rationale / alternatives rejected |
| --- | --- | --- |
| `age` source | Stays on wolfi apk (1.3.1) | wolfi security-patches it for free via the base digest. Installing from upstream release for "consistency" was considered and rejected: age and the plugin are separate upstream projects regardless, and the age-plugin protocol — not shared source — guarantees compatibility. |
| Plugin source | Upstream `str4d/age-plugin-yubikey` GitHub release, sha256-pinned | Only option (not in wolfi). Mirrors the existing `bw` install pattern exactly (`ARG VERSION` + `ARG SHA256` + `sha256sum -c`). `cargo install` rejected — drags a Rust toolchain in for one binary. |
| `pcsc-lite` runtime lib | Added only if the binary requires it | Determined empirically at build time, not assumed. Available in wolfi if needed. |
| CI guard | Presence check only: `age-plugin-yubikey --version` asserts exit 0 | Catches the likely regression (a Dockerfile/Renovate change silently dropping or breaking the plugin) without baking any recipient string into the repo. A full encrypt-to-a-sample-recipient CI test was rejected because it would require committing a YubiKey recipient string — and **no keys, public or private, go into GitHub**. |
| `backup.sh` | No change | age's multi-recipient model already delivers the desired behaviour. |

## Scope

### Changes

1. **`images/bitwarden-backup/Dockerfile`**
   - Add `ARG AGE_PLUGIN_YUBIKEY_VERSION` and `ARG AGE_PLUGIN_YUBIKEY_SHA256`,
     preceded by a `# renovate: datasource=github-releases
     depName=str4d/age-plugin-yubikey` comment (same shape as the existing
     `BW_VERSION` / `BW_SHA256` block).
   - Download the release tarball, verify with `sha256sum -c`, extract, and
     `install -m 0755` the `age-plugin-yubikey` binary into `/usr/local/bin`.
     The exact asset name (`x86_64-linux`), URL, and the path of the binary
     inside the tarball are to be confirmed against the actual release during
     implementation.
   - Add `pcsc-lite` to the `apk add` line **iff** `age-plugin-yubikey
     --version` fails to load without it (verified at build time).

2. **`.github/renovate.json`**
   - Track `str4d/age-plugin-yubikey` releases for the version ARG via the
     github-releases datasource, extending the existing config. The sha256
     follows the same accepted workflow already used for `bw`: Renovate PRs the
     version bump, CI fails at `sha256sum -c`, the maintainer updates the hash
     in the same PR. No new mechanism.

3. **`.github/workflows/build.yml`**
   - Add a step beside the existing "Smoke test entrypoint" that runs
     `age-plugin-yubikey --version` in the freshly built image and asserts exit
     0. Gates push exactly like the existing no-env smoke test. No keys, no
     recipients.

4. **`images/bitwarden-backup/README.md`**
   - Document that `BITWARDEN_AGE_RECIPIENTS` accepts `age1yubikey1…`
     recipients, the two-YubiKey pattern, and the key fact that encryption needs
     no hardware while decryption needs the plugin plus a YubiKey.

5. **`images/bitwarden-backup/RECOVERY.md.tmpl`**
   - Add YubiKey decryption instructions (install `age` + `age-plugin-yubikey`,
     insert a key, PIN/touch), preserving the existing software-key recovery
     path.

### Explicitly out of scope

- No `backup.sh` changes.
- No new environment variables.
- No keys (public or private) committed to the repository.
- No arm64 / multi-arch work (the image remains amd64-only, per the original
  spec).

## Verification

1. Build the image locally.
2. Confirm `age-plugin-yubikey --version` runs inside the image (the option-2
   check, performed locally before CI exists).
3. **One-time local end-to-end**: the operator provides one real
   `age1yubikey1…` recipient string locally and confirms success — proving
   recipient resolution works on the cluster side, with **no hardware
   attached**. Decrypt-with-hardware is confirmed by the operator on their own
   machine.

   The recipient string, although public, is treated with the same no-egress
   discipline as the secrets: the operator writes it to a local file (e.g. the
   gitignored `.env` or a sibling file); the test consumes it **by reference**
   (env var / `--env-file`) and must never echo, cat, or otherwise print it.
   It is never committed and never leaves the local machine.
4. Confirm the new CI presence-check step passes on the PR.

## Open risks

- **`pcsc-lite` dependency** — unverified until the plugin binary is built and
  run; resolved during implementation.
- **Release asset naming and tarball internal layout** for
  `str4d/age-plugin-yubikey` — confirmed against the actual release during
  implementation.
- **sha256 auto-bump** — inherits the same known limitation as `bw`: Renovate
  cannot bump the hash automatically, so a version-bump PR fails CI until the
  maintainer updates the hash. Acceptable and already documented for `bw`.

## Amendments (from implementation verification)

Resolved while writing the implementation plan
(`docs/superpowers/plans/2026-06-19-bitwarden-backup-yubikey.md`):

- **Plugin pinned to v0.5.0, not "latest".** The latest release (v0.5.1) ships
  only macOS and Windows assets; v0.5.0 is the last release with an
  `x86_64-linux` tarball
  (`age-plugin-yubikey-v0.5.0-x86_64-linux.tar.gz`, sha256
  `019b35a13fc81be56d73d0723db0a2082fbd04c936c2c6836381111f7f51b2c3`, binary at
  `age-plugin-yubikey/age-plugin-yubikey` inside the tarball).
- **`pcsc-lite` is required, not conditional.** `readelf -d` on the v0.5.0
  binary shows `NEEDED libpcsclite.so.1`, so `pcsc-lite` is added to the apk
  install unconditionally.
- **Renovate is disabled for this dependency, not enabled.** Because upstream
  dropped the Linux binary, letting Renovate bump the version would 404 the
  asset and break the build. The dependency stays discoverable (the `# renovate:`
  comment remains) but a `packageRule` sets `enabled: false`; the maintainer
  bumps version + sha by hand and re-enables once upstream resumes Linux
  releases.
