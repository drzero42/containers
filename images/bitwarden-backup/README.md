# bitwarden-backup

Container image that logs into Bitwarden by API key, exports the vault to
JSON, encrypts it to one or more [age](https://age-encryption.org/)
recipients, writes the ciphertext to a mounted backup directory, prunes
old backups, and refreshes a `RECOVERY.md` next to them. Designed to run
as a Kubernetes CronJob.

Output filename pattern: `${FILENAME_PREFIX}-YYYY-MM-DD.json.age`
(default prefix `bitwarden`). Same-day reruns overwrite — that's the
intentional refresh story.

## Image

- Registry: `ghcr.io/drzero42/bitwarden-backup`
- Base: `chainguard/wolfi-base` (digest-pinned)
- User: UID 1000, GID 1000 (non-root)
- Supports `readOnlyRootFilesystem: true` — `/tmp` must be writable
- ENTRYPOINT runs the backup script with no arguments

## Environment variables

Secrets accept **either** the plain env var **or** the `*_FILE` form
(path to a file containing the value, typically a mounted Kubernetes
Secret volume). Setting both forms is an error. The file form is
preferred for k8s deployments — values aren't visible in `ps` or
`/proc/<pid>/environ` and rotate without restarting the pod.

### Required

| Variable | Secret? | Description |
|---|---|---|
| `BW_SERVER` | no | Bitwarden server URL (e.g. `https://vault.bitwarden.eu` or a self-hosted URL) |
| `BW_CLIENTID` / `BW_CLIENTID_FILE` | yes | API client ID from your Bitwarden account (Settings → Security → Keys → API key) |
| `BW_CLIENTSECRET` / `BW_CLIENTSECRET_FILE` | yes | API client secret from the same API key |
| `BW_PASSWORD` / `BW_PASSWORD_FILE` | yes | Account master password — needed to unlock the vault session |
| `BACKUP_DIR` | no | Path inside the container where the ciphertext and `RECOVERY.md` are written; mount a PVC or hostPath here |
| `BITWARDEN_AGE_RECIPIENTS` | no | Whitespace-separated list of age recipients — software keys (`age1...`) and/or YubiKey keys (`age1yubikey1...`); at least one required. See [YubiKey recipients](#yubikey-recipients). |

### Optional

| Variable | Default | Description |
|---|---|---|
| `RETENTION_DAYS` | `30` | Delete `${FILENAME_PREFIX}-*.json.age` files in `BACKUP_DIR` older than this |
| `FILENAME_PREFIX` | `bitwarden` | Filename stem; full name is `<prefix>-YYYY-MM-DD.json.age` |
| `MIN_PLAINTEXT_BYTES` | `1024` | Minimum size of the bw export before we'll encrypt — guards against a truncated/empty export silently overwriting yesterday's good backup |

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

## Local run

```sh
docker run --rm \
  -e BW_SERVER=https://vault.bitwarden.eu \
  -e BW_CLIENTID="$BW_CLIENTID" \
  -e BW_CLIENTSECRET="$BW_CLIENTSECRET" \
  -e BW_PASSWORD="$BW_PASSWORD" \
  -e BACKUP_DIR=/backup \
  -e BITWARDEN_AGE_RECIPIENTS="age1abc...xyz" \
  -v "$(pwd)/backups:/backup" \
  ghcr.io/drzero42/bitwarden-backup:latest
```

After the run completes, `./backups/` contains the day's
`bitwarden-YYYY-MM-DD.json.age` and a `RECOVERY.md` with decryption
instructions.

## Kubernetes (CronJob)

Sketch — adapt to your secret-mounting conventions:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: bitwarden-backup
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
            fsGroup: 1000
          containers:
            - name: bitwarden-backup
              image: ghcr.io/drzero42/bitwarden-backup:2026-05-23-1@sha256:...
              env:
                - name: BW_SERVER
                  value: "https://vault.bitwarden.eu"
                - name: BW_CLIENTID_FILE
                  value: /secrets/bw-clientid
                - name: BW_CLIENTSECRET_FILE
                  value: /secrets/bw-clientsecret
                - name: BW_PASSWORD_FILE
                  value: /secrets/bw-password
                - name: BACKUP_DIR
                  value: /backup
                - name: BITWARDEN_AGE_RECIPIENTS
                  value: "age1abc... age1def..."
              securityContext:
                readOnlyRootFilesystem: true
                allowPrivilegeEscalation: false
                capabilities:
                  drop: ["ALL"]
              volumeMounts:
                - name: secrets
                  mountPath: /secrets
                  readOnly: true
                - name: backup
                  mountPath: /backup
                - name: tmp
                  mountPath: /tmp
          volumes:
            - name: secrets
              secret:
                secretName: bitwarden-backup-creds
            - name: backup
              persistentVolumeClaim:
                claimName: bitwarden-backups
            - name: tmp
              emptyDir:
                medium: Memory
```

Pin by `tag@sha256:<digest>` — date-N tags are mutable enough to bump
across rebuilds, the digest is not.

## Recovery

Each run refreshes a `RECOVERY.md` inside `BACKUP_DIR` with step-by-step
decryption instructions. In short, with an age identity whose public key
was listed in `BITWARDEN_AGE_RECIPIENTS`:

```sh
age -d -i your.key -o vault.json bitwarden-YYYY-MM-DD.json.age
```

The resulting `vault.json` imports into any Bitwarden vault (web vault →
Tools → Import data → "Bitwarden (json)").

## Behavior

The entrypoint emits `==> step N: <label>` lines to stderr so a failure
is unambiguous in CronJob logs:

| Step | What |
|---|---|
| 1 | Resolve `*_FILE` inputs, validate required env, set defaults |
| 2 | `mktemp` plaintext tempfile, install EXIT/INT/TERM trap to delete it (memory-backed `/tmp` recommended so the plaintext never touches disk) |
| 3 | `bw config server` |
| 4 | `bw login --apikey` (reads `BW_CLIENTID`/`BW_CLIENTSECRET` from env) |
| 5 | `bw unlock --passwordenv BW_PASSWORD --raw` → capture session |
| 6 | `bw sync` |
| 7 | `bw --raw export --format json` → plaintext tempfile (no `--password` — it would leak the master password via `/proc/<pid>/cmdline`) |
| 8 | Sanity check: plaintext ≥ `MIN_PLAINTEXT_BYTES` |
| 9 | `age -r <key> -r <key> -o <out>.json.age` |
| 10 | Prune `${FILENAME_PREFIX}-*.json.age` files older than `RETENTION_DAYS` |
| 11 | Refresh `${BACKUP_DIR}/RECOVERY.md` from the image-baked template |
| 12 | `bw logout` |

Any required-input error emits `must be set` on stderr — CI smoke-tests
the image by running it with no env vars and grepping for that string.
