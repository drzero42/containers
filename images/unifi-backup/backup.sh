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

# Resolve a secret input from <VAR> or <VAR>_FILE and export <VAR>, so jq can
# read it from the environment (env.<VAR>) and it never lands on a command line.
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

# Decode the payload of a JWT (base64url, unpadded) to JSON on stdout.
jwt_payload() {
    p=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
    case $(( ${#p} % 4 )) in
        2) p="${p}==" ;;
        3) p="${p}=" ;;
    esac
    printf '%s' "$p" | base64 -d
}

step 1 "resolve and validate inputs"

require_env UNIFI_HOST
require_env UNIFI_USERNAME
resolve_secret UNIFI_PASSWORD
require_env BACKUP_DIR
require_env AGE_RECIPIENTS

: "${UNIFI_SITE:=default}"
: "${UNIFI_PINNED_PUBKEY:=}"
: "${RETENTION_DAYS:=30}"
: "${FILENAME_PREFIX:=unifi}"
: "${MIN_PLAINTEXT_BYTES:=16384}"

case "$UNIFI_PINNED_PUBKEY" in
    ''|sha256//*) : ;;
    *) die "UNIFI_PINNED_PUBKEY must look like sha256//<base64>; see README" ;;
esac

step 2 "set up tmpfiles and cleanup trap"
# busybox mktemp requires the X-run to be the last template chars (no suffix).
work=$(mktemp -d /tmp/unifi-backupXXXXXX)
cookies="$work/cookies"
plaintext="$work/backup.unf"
logged_in=
logout() {
    if [ -n "$logged_in" ]; then
        api -X POST -o /dev/null "$base/api/auth/logout" || true
    fi
}
trap 'logout; rm -rf "$work"' EXIT
trap 'exit 1' INT TERM

base="https://${UNIFI_HOST}"
# The gateway serves UniFi OS's self-signed certificate, so the chain can't be
# verified (-k). With UNIFI_PINNED_PUBKEY set, curl still checks the server's
# public key against the pin, even with -k.
set -- -k
if [ -n "$UNIFI_PINNED_PUBKEY" ]; then
    set -- "$@" --pinnedpubkey "$UNIFI_PINNED_PUBKEY"
fi
tls_args=$*
api() {
    if [ -n "$csrf" ]; then
        set -- -H "X-CSRF-Token: $csrf" "$@"
    fi
    # shellcheck disable=SC2086  # tls_args holds flags without spaces
    curl -sS --fail-with-body --max-time 120 $tls_args \
        -b "$cookies" -c "$cookies" "$@"
}
csrf=

step 3 "log in to UniFi OS as $UNIFI_USERNAME"
# The password goes to curl on stdin, never on its command line.
jq -n '{username: env.UNIFI_USERNAME, password: env.UNIFI_PASSWORD, rememberMe: false}' |
    api -X POST -H 'Content-Type: application/json' --data-binary @- \
        -o /dev/null "$base/api/auth/login" ||
    die "login failed: check UNIFI_HOST, UNIFI_USERNAME and the password"
logged_in=1
unset UNIFI_PASSWORD

# Writes need the CSRF token, which UniFi OS keeps in the TOKEN cookie's JWT.
token=$(awk '$6 == "TOKEN" { print $7 }' "$cookies")
[ -n "$token" ] || die "login returned no TOKEN cookie"
csrf=$(jwt_payload "$token" | jq -r '.csrfToken // empty')
[ -n "$csrf" ] || die "TOKEN cookie carries no csrfToken"

step 4 "ask the Network application for a backup"
# days=-1 includes all history the application keeps. Works with Network:
# Full Admin; the full UniFi OS backup (/api/backup/download) would need Super Admin.
resp=$(api -X POST -H 'Content-Type: application/json' \
    --data-binary '{"cmd":"backup","days":-1}' \
    "$base/proxy/network/api/s/${UNIFI_SITE}/cmd/backup") ||
    die "backup request failed: $resp"
url=$(printf '%s' "$resp" | jq -r 'select(.meta.rc == "ok") | .data[0].url // empty')
case "$url" in
    /dl/backup/*.unf) : ;;
    *) die "unexpected backup response: $resp" ;;
esac
version=${url#/dl/backup/}
version=${version%.unf}
case "$version" in
    *[!0-9A-Za-z._-]*|'') die "unexpected backup file name: $url" ;;
esac

step 5 "download ${version}.unf"
api -o "$plaintext" "$base/proxy/network${url}"

step 6 "plaintext sanity check"
size=$(stat -c%s "$plaintext")
if [ "$size" -lt "$MIN_PLAINTEXT_BYTES" ]; then
    die "backup is $size bytes (< MIN_PLAINTEXT_BYTES=$MIN_PLAINTEXT_BYTES); refusing to encrypt a likely-truncated download"
fi

step 7 "encrypt with age"
# Build argv as -r key1 -r key2 ... from whitespace-separated env var.
set --
# shellcheck disable=SC2086
for r in $AGE_RECIPIENTS; do
    set -- "$@" -r "$r"
done
if [ "$#" -eq 0 ]; then
    die "AGE_RECIPIENTS expanded to zero recipients"
fi

# The Network version is in the name: a .unf restores only on the same or a
# newer Network application.
out="${BACKUP_DIR}/${FILENAME_PREFIX}-$(date -u +%F)-network-${version}.unf.age"
# Intentional: same-day reruns overwrite.
age "$@" -o "$out" < "$plaintext"
echo "wrote $out" >&2

step 8 "prune old backups"
# Top level only: manual downloads in subdirectories are never pruned.
find "$BACKUP_DIR" -maxdepth 1 -type f \
    -name "${FILENAME_PREFIX}-*.unf.age" \
    -mtime "+${RETENTION_DAYS}" \
    -delete

step 9 "refresh RECOVERY.md"
cp /usr/share/unifi-backup/RECOVERY.md "${BACKUP_DIR}/RECOVERY.md"

step 10 "log out"
logout
logged_in=

echo "backup complete" >&2
