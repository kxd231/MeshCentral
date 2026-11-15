#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Makes a release signing key for server updates (see docs/fork-updates.md). Run by the release owner, never by an automated agent.
# The key pair is made in Docker (pinned Node image, no network). The private key is encrypted with a passphrase (scrypt + AES-256-GCM) and
# written to <out-dir>/<keyId>.key.json (mode 600); the public entry for serverupdate-keys.json goes to <out-dir>/<keyId>.pub.json.
# The passphrase is typed here (twice, at least 16 characters) and reaches the container through stdin only: never in an argument, an
# environment variable or a file. The output folder must be outside of this repository and outside of any git repository.
#
# Usage: tools/release/keygen.sh <out-dir> <comment>      (run it twice: "primary" and "backup")
set -euo pipefail
set +x +a   # no trace, no export: the passphrase typed below must not reach a log or the environment of another process
umask 077
unset PASSPHRASE P1 P2 passphrase PASSWORD 2>/dev/null || true

if [ "$#" -ne 2 ]; then echo "Usage: $0 <out-dir> <comment>" >&2; exit 2; fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/node-image.sh"
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
OUT=$(realpath -m -- "$1")
COMMENT=$2

case "$COMMENT" in ''|*[![:print:]]*) echo "The comment must be printable text, 1 to 80 characters." >&2; exit 2 ;; esac
if [ "${#COMMENT}" -gt 80 ]; then echo "The comment must be printable text, 1 to 80 characters." >&2; exit 2; fi

# Refuse a folder under this repository or inside any git repository (the nearest existing parent decides)
case "$OUT/" in "$REPO_DIR"/*) echo "Refusing to write keys inside the repository $REPO_DIR." >&2; exit 1 ;; esac
# The Docker bind mount reads a colon or a comma in the path as an option
case "$OUT" in *:*|*,*) echo "A folder with a colon or a comma in its path is not supported." >&2; exit 2 ;; esac
# A remote Docker would receive the passphrase over the network
case "${DOCKER_HOST:-}" in ''|unix://*) ;; *) echo "DOCKER_HOST points to a remote Docker; refusing to send the passphrase there." >&2; exit 1 ;; esac
PROBE=$OUT
while [ ! -d "$PROBE" ]; do PROBE=$(dirname -- "$PROBE"); done
if git -C "$PROBE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "Refusing to write keys inside a git repository ($PROBE)." >&2; exit 1; fi
# Without git (or when git refuses the folder) a .git in the folder or in a parent still counts
SEARCH=$PROBE
while :; do
    if [ -e "$SEARCH/.git" ]; then echo "Refusing to write keys inside a git repository ($SEARCH)." >&2; exit 1; fi
    [ "$SEARCH" = / ] && break
    SEARCH=$(dirname -- "$SEARCH")
done
if [ -d "$OUT" ]; then
    [ "$(stat -c %u -- "$OUT")" = "$(id -u)" ] || { echo "$OUT does not belong to you." >&2; exit 1; }
    [ "$(( 0$(stat -c %a -- "$OUT") & 077 ))" = 0 ] || echo "WARNING: $OUT is accessible for group or others; somebody could replace the .pub.json file (chmod 700 $OUT)." >&2
fi
mkdir -p -m 700 -- "$OUT"

IFS= read -r -s -p 'Passphrase (at least 16 characters): ' P1; echo >&2
IFS= read -r -s -p 'Repeat the passphrase: ' P2; echo >&2
if [ "$P1" != "$P2" ]; then unset P1 P2; echo "The passphrases differ." >&2; exit 1; fi
if [ "${#P1}" -lt 16 ]; then unset P1 P2; echo "The passphrase must have at least 16 characters." >&2; exit 1; fi

# printf is a shell builtin: the passphrase is not in any argument list
printf '%s\n' "$P1" | docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    -u "$(id -u):$(id -g)" -v "$REPO_DIR:/repo:ro" -v "$OUT:/out" "$NODE_IMAGE" \
    node /repo/tools/release/release-signing.js keygen --out /out --comment "$COMMENT"
unset P1 P2
echo
echo "Keep the .key.json file and its passphrase apart (see docs/fork-updates.md). Give the .pub.json file to whoever commits the public key."
