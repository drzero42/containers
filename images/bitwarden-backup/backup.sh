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
# Sets and exports <VAR> so child processes (the `bw` CLI) inherit it.
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
        # $() strips trailing newlines only — deliberate; embedded newlines survive.
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

    # Export so child processes (the `bw` CLI) inherit it. The _FILE branch sets
    # a plain shell variable, which is NOT in the environment; without this,
    # `bw login --apikey` / `bw unlock --passwordenv` can't see the value and
    # fall back to interactive prompts. Re-exporting a plain-env value is a no-op.
    # shellcheck disable=SC2163  # dynamic export by computed name is intended
    export "$name"
}

require_env() {
    name=$1
    eval "value=\${$name:-}"
    if [ -z "$value" ]; then
        die "$name must be set"
    fi
}

step 1 "resolve and validate inputs"

require_env BW_SERVER

# Secrets accept both <VAR> and <VAR>_FILE (k8s mount-as-file).
resolve_secret BW_CLIENTID
resolve_secret BW_CLIENTSECRET
resolve_secret BW_PASSWORD

require_env BACKUP_DIR
require_env BITWARDEN_AGE_RECIPIENTS

: "${RETENTION_DAYS:=30}"
: "${FILENAME_PREFIX:=bitwarden}"
: "${MIN_PLAINTEXT_BYTES:=1024}"

step 2 "set up tmpfile and cleanup trap"
# busybox mktemp requires the X-run to be the last template chars (no suffix).
plaintext=$(mktemp /tmp/bw-exportXXXXXX)
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
# --raw is a global bw flag — must precede the subcommand (verified on bw 2026.4.2).
# Don't pass --password: it's only used for encrypted_json format, and putting
# BW_PASSWORD on the cmdline would leak it via /proc/<pid>/cmdline — defeating
# the *_FILE secret-mounting protection. If a future bw version re-prompts on
# plaintext export, the script fails loudly rather than silently leaking.
bw --raw export --format json > "$plaintext"

step 8 "plaintext sanity check"
size=$(stat -c%s "$plaintext")
if [ "$size" -lt "$MIN_PLAINTEXT_BYTES" ]; then
    die "plaintext export is $size bytes (< MIN_PLAINTEXT_BYTES=$MIN_PLAINTEXT_BYTES); refusing to encrypt a likely-truncated export"
fi

step 9 "encrypt with age"
# Build argv as -r key1 -r key2 ... from whitespace-separated env var.
set --
# shellcheck disable=SC2086
for r in $BITWARDEN_AGE_RECIPIENTS; do
    set -- "$@" -r "$r"
done
if [ "$#" -eq 0 ]; then
    die "BITWARDEN_AGE_RECIPIENTS expanded to zero recipients"
fi

out="${BACKUP_DIR}/${FILENAME_PREFIX}-$(date -u +%F).json.age"
# Intentional: same-day reruns overwrite — that's the refresh story.
age "$@" -o "$out" < "$plaintext"
echo "wrote $out" >&2

step 10 "prune old backups"
find "$BACKUP_DIR" -maxdepth 1 -type f \
    -name "${FILENAME_PREFIX}-*.json.age" \
    -mtime "+${RETENTION_DAYS}" \
    -delete

step 11 "refresh RECOVERY.md"
cp /usr/share/bitwarden-backup/RECOVERY.md "${BACKUP_DIR}/RECOVERY.md"

step 12 "bw logout"
bw logout >/dev/null

echo "backup complete" >&2
