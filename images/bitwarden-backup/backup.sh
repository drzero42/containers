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
# --password is encrypted_json-only per docs; included defensively in case a version re-prompts.
bw --raw export --format json --password "$BW_PASSWORD" > "$plaintext"

step 8 "plaintext sanity check"
size=$(stat -c%s "$plaintext")
if [ "$size" -lt "$MIN_PLAINTEXT_BYTES" ]; then
    die "plaintext export is $size bytes (< MIN_PLAINTEXT_BYTES=$MIN_PLAINTEXT_BYTES); refusing to encrypt a likely-truncated export"
fi

step 9 "encrypt with age"
# Build -r <recipient> args from BITWARDEN_AGE_RECIPIENTS (whitespace-separated).
# `set --` portably builds an argv from whitespace-split words.
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
