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

# Non-secret required inputs (env-only).
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
