# unifi-backup

Container image that logs into a UniFi OS gateway or console, fetches
a Network application backup (`.unf`), a full System Config Backup
(`.unifi`) or both, encrypts each to one or more
[age](https://age-encryption.org/) recipients, writes the ciphertext to a
mounted backup directory, prunes old backups, and refreshes a
`RECOVERY.md` next to them. Designed to run as a Kubernetes CronJob.

Output filename patterns (default prefix `unifi`; same-day reruns overwrite):

- `${FILENAME_PREFIX}-YYYY-MM-DD-network-<version>.unf.age`: `<version>` is
  the Network application version; a `.unf` restores only on the same or a
  newer one.
- `${FILENAME_PREFIX}-YYYY-MM-DD-system.unifi.age`

## The two backup kinds

UniFi OS has two backup kinds:

| | Network backup (`.unf`) | System Config Backup (`.unifi`) |
|---|---|---|
| Holds | the Network application | UniFi OS, every application, admins |
| API | `POST /proxy/network/api/s/<site>/cmd/backup` | `GET /api/backup/download` |
| Least role | Network: Full Admin, Control Plane: none | Super Admin (owner-equivalent) |
| `BACKUP_KINDS` | `network` | `system` |

The default is `network` only, so the account needs no Control Plane
rights. `system` needs a **Super Admin**: on UniFi OS 6 every narrower
role, including Network and Control Plane both at Full Admin (which grants
only UniFi OS user management), gets `403 ACTION_FORBIDDEN` from
`/api/backup/download` and from downloading the console's stored backups
(`/api/backup/local/<id>/download`). That puts an owner-equivalent
password in the job's secret; weigh it against the gap. `RECOVERY.md`
lists what a `.unf` leaves out.

With both kinds, the `.unf` is fetched first; if the `.unifi` then fails,
the `.unf` is still written and the job exits non-zero.

## Image

- Registry: `ghcr.io/drzero42/unifi-backup`
- Base: `chainguard/wolfi-base` (digest-pinned)
- User: UID 1000, GID 1000 (non-root)
- Supports `readOnlyRootFilesystem: true` — `/tmp` must be writable
- ENTRYPOINT runs the backup script with no arguments

## Environment variables

The secret accepts **either** the plain env var **or** the `*_FILE` form
(path to a file containing the value, typically a mounted Kubernetes
Secret volume). Setting both forms is an error.

### Required

| Variable | Secret? | Description |
|---|---|---|
| `UNIFI_HOST` | no | Gateway or console address (IP or name; HTTPS on 443) |
| `UNIFI_USERNAME` | no | A **local-only** UniFi OS account (local, so the login needs no MFA): Network: Full Admin and Control Plane: none for `network`; a Super Admin for `system`. |
| `UNIFI_PASSWORD` / `UNIFI_PASSWORD_FILE` | yes | That account's password |
| `BACKUP_DIR` | no | Path inside the container where the ciphertext and `RECOVERY.md` are written; mount a PVC here |
| `AGE_RECIPIENTS` | no | Whitespace-separated age recipients, software (`age1...`) and/or YubiKey (`age1yubikey1...`); at least one. Any one of them can decrypt. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `BACKUP_KINDS` | `network` | Whitespace-separated: `network` (`.unf`) and/or `system` (`.unifi`) |
| `UNIFI_SITE` | `default` | Network application site name |
| `UNIFI_PINNED_PUBKEY` | _(unset)_ | `sha256//<base64>` pin of the gateway's public key. See [TLS](#tls). |
| `RETENTION_DAYS` | `30` | Delete `${FILENAME_PREFIX}-*.unf.age` / `*.unifi.age` files at the top of `BACKUP_DIR` older than this, each kind only after its own backup succeeded. Subdirectories are never touched. |
| `FILENAME_PREFIX` | `unifi` | Filename stem |
| `MIN_PLAINTEXT_BYTES` | `16384` | Minimum size of each downloaded backup before it's encrypted — guards against a truncated download replacing a good backup |

## TLS

UniFi OS serves a self-signed certificate, so the script calls curl with
`-k`. To check the certificate anyway, pin its public key; curl enforces a
pin even with `-k`:

```sh
openssl s_client -connect 192.168.1.1:443 </dev/null 2>/dev/null |
  openssl x509 -pubkey -noout |
  openssl pkey -pubin -outform der |
  openssl dgst -sha256 -binary | base64
# UNIFI_PINNED_PUBKEY=sha256//<that output>
```

The gateway's key changes when its certificate is regenerated; update the
pin then, or the job fails.

## Local run

```sh
docker run --rm \
  -e UNIFI_HOST=192.168.1.1 \
  -e UNIFI_USERNAME=backup \
  -e UNIFI_PASSWORD_FILE=/secrets/password \
  -e BACKUP_DIR=/backup \
  -e AGE_RECIPIENTS="age1abc...xyz" \
  -v "$(pwd)/password:/secrets/password:ro" \
  -v "$(pwd)/backups:/backup" \
  ghcr.io/drzero42/unifi-backup:latest
```

## Recovery

See `RECOVERY.md`, refreshed into `BACKUP_DIR` on every run. In short:

```sh
age -d -i your.key -o backup.unifi unifi-YYYY-MM-DD-system.unifi.age
age -d -i your.key -o backup.unf unifi-YYYY-MM-DD-network-<version>.unf.age
```

then Settings > Control Plane > Backups > Restore from Backup on the console.

## Behavior

The entrypoint emits `==> step N: <label>` lines to stderr so a failure
is unambiguous in CronJob logs:

| Step | What |
|---|---|
| 1 | Resolve `*_FILE` inputs, validate required env and `BACKUP_KINDS`, set defaults |
| 2 | Make a temp dir in `/tmp` (memory-backed recommended) for the cookie jar and the plaintext; a trap logs out and deletes it on exit |
| 3 | `POST /api/auth/login` (password on curl's stdin, not its argv); read the CSRF token from the `TOKEN` cookie |
| 4 | `network`: `POST /proxy/network/api/s/<site>/cmd/backup` with `{"cmd":"backup","days":-1}`, download the returned `/dl/backup/<version>.unf`, check size ≥ `MIN_PLAINTEXT_BYTES`, age-encrypt, prune old `*.unf.age` |
| 5 | `system`: `GET /api/backup/download` (the console makes a fresh backup), check size, age-encrypt, prune old `*.unifi.age` |
| 6 | Refresh `${BACKUP_DIR}/RECOVERY.md` |
| 7 | `POST /api/auth/logout`; exit non-zero if any kind failed |

Any required-input error emits `must be set` on stderr — CI smoke-tests
the image by running it with no env vars and grepping for that string.
