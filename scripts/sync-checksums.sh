#!/usr/bin/env bash
#
# sync-checksums.sh — recompute pinned *_SHA256 build args from the currently
# pinned version, for release downloads that publish no signatures/attestations.
#
# Renovate bumps the *_VERSION arg in an image Dockerfile but cannot update the
# matching checksum: bitwarden/clients tags releases as `cli-vX.Y.Z` while the
# asset is named with the bare version, a mismatch Renovate's
# github-release-attachments digest support can't map. This script closes that
# gap — it downloads the pinned asset, computes its sha256, and rewrites the
# checksum arg in place so a version bump and its hash stay consistent.
#
# Each managed download is declared in its Dockerfile with an annotation placed
# immediately after the checksum ARG:
#
#   # checksum-sync: sha256Arg=BW_SHA256 url=https://.../bw-linux-${BW_VERSION}.zip
#
# `${NAME}` references in the url are expanded from the Dockerfile's ARG values.
#
# Usage:
#   scripts/sync-checksums.sh [--check] [DOCKERFILE ...]
#
# With no file args, every images/*/Dockerfile is processed. Without --check a
# Dockerfile is rewritten in place when its hash differs (exit 0). With --check
# nothing is written and any drift causes exit 1 — useful as a verification gate.

set -euo pipefail

check=0
files=()
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    *) files+=("$arg") ;;
  esac
done

if [ ${#files[@]} -eq 0 ]; then
  shopt -s nullglob
  files=(images/*/Dockerfile)
fi

drift=0

for dockerfile in "${files[@]}"; do
  if [ ! -f "$dockerfile" ]; then
    echo "skip: $dockerfile not found" >&2
    continue
  fi

  # Map ARG name -> value, for ${...} expansion in annotation urls.
  declare -A args=()
  while IFS= read -r line; do
    if [[ "$line" =~ ^ARG[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      args["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
    fi
  done < "$dockerfile"

  # The annotation loop reads from a file descriptor opened now; rewriting the
  # file mid-loop is safe because the open fd keeps reading the original inode.
  while IFS= read -r line; do
    [[ "$line" == *"checksum-sync:"* ]] || continue

    sha_arg=$(sed -n 's/.*sha256Arg=\([^[:space:]]*\).*/\1/p' <<<"$line")
    url=$(sed -n 's/.*[[:space:]]url=\([^[:space:]]*\).*/\1/p' <<<"$line")
    if [ -z "$sha_arg" ] || [ -z "$url" ]; then
      echo "ERROR: malformed checksum-sync annotation in $dockerfile: $line" >&2
      exit 1
    fi

    for name in "${!args[@]}"; do
      url="${url//\$\{$name\}/${args[$name]}}"
    done
    if [[ "$url" == *'${'* ]]; then
      echo "ERROR: unresolved variable in url for $sha_arg ($dockerfile): $url" >&2
      exit 1
    fi

    current="${args[$sha_arg]:-}"
    if [ -z "$current" ]; then
      echo "ERROR: $sha_arg (from checksum-sync) is not an ARG in $dockerfile" >&2
      exit 1
    fi

    echo "checking $sha_arg <- $url" >&2
    actual=$(curl -fsSL "$url" | sha256sum | cut -d' ' -f1)

    if [ "$actual" = "$current" ]; then
      continue
    fi

    if [ "$check" -eq 1 ]; then
      echo "DRIFT: $dockerfile $sha_arg: pinned $current, actual $actual" >&2
      drift=1
    else
      tmp=$(mktemp)
      sed "s|^ARG ${sha_arg}=.*|ARG ${sha_arg}=${actual}|" "$dockerfile" > "$tmp"
      mv "$tmp" "$dockerfile"
      args["$sha_arg"]="$actual"
      echo "updated $dockerfile $sha_arg -> $actual" >&2
    fi
  done < "$dockerfile"

  unset args
done

if [ "$check" -eq 1 ] && [ "$drift" -ne 0 ]; then
  exit 1
fi
exit 0
