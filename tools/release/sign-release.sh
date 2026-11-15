#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Makes the manifest and the signature of a server release (see docs/fork-updates.md). Run by the release owner, never by an automated agent.
# Everything that touches the key runs in Docker (pinned Node image, no network); the package is mounted read-only. The manifest is made from the package and
# signed in one process, from the same bytes. The passphrase of the key is typed here and reaches the container through stdin only. Uploading the two
# files and publishing the release is not done here.
#
# Usage: tools/release/sign-release.sh --key <key.json> --tgz <meshcentral-<version>.tgz> --version <v> --tag <tag> --commit <sha> --out <dir>
#                                      [--channel stable|prerelease] [--repository kxd231/MeshCentral] [--append <existing .sig>]
# --append adds a second signature to an existing signature file (two keys while a key is replaced). The manifest next to that file must be exactly the
# manifest of this package and these values, and every signature in the file must be valid; --out is then the folder of that file.
# The output folder belongs to you and is closed to others (mode 700); before the passphrase is asked, the script shows what changed in the key list and in the
# release tools since the previous release and asks you to type yes.
set -euo pipefail
set +x +a   # no trace, no export: nothing of what is typed below may reach a log or the environment of another process
umask 022
unset PASSPHRASE P1 P2 passphrase PASSWORD 2>/dev/null || true

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/node-image.sh"
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
usage() { sed -n '/^# Usage:/,/^set -/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }

KEY= TGZ= VERSION= TAG= COMMIT= OUT= CHANNEL=stable REPOSITORY=kxd231/MeshCentral APPEND=
while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || usage
    case "$1" in
        --key) KEY=$2 ;; --tgz) TGZ=$2 ;; --version) VERSION=$2 ;; --tag) TAG=$2 ;; --commit) COMMIT=$2 ;; --out) OUT=$2 ;;
        --channel) CHANNEL=$2 ;; --repository) REPOSITORY=$2 ;; --append) APPEND=$2 ;;
        *) usage ;;
    esac
    shift 2
done
for v in KEY TGZ VERSION TAG COMMIT; do [ -n "${!v}" ] || usage; done
[ -n "$OUT" ] || [ -n "$APPEND" ] || usage
case "$CHANNEL" in stable|prerelease) ;; *) echo "--channel is stable or prerelease." >&2; exit 2 ;; esac
printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5})|-custom\.[1-9][0-9]{0,5})?$' || { echo "Invalid version '$VERSION'." >&2; exit 2; }
printf '%s\n' "$COMMIT" | grep -Eq '^[a-f0-9]{40}$' || { echo "--commit must be the full 40 character commit hash." >&2; exit 2; }
# The key and the package are given to Docker as bind mounts: a colon or a comma in a path would be read as an option
case "$KEY$TGZ$OUT$APPEND" in *:*|*,*) echo "Paths with a colon or a comma are not supported." >&2; exit 2 ;; esac
# A remote Docker would receive the passphrase over the network
case "${DOCKER_HOST:-}" in ''|unix://*) ;; *) echo "DOCKER_HOST points to a remote Docker; refusing to send the passphrase there." >&2; exit 1 ;; esac
[ -f "$KEY" ] || { echo "Key file not found: $KEY" >&2; exit 1; }
[ -f "$TGZ" ] || { echo "Package not found: $TGZ" >&2; exit 1; }
MANIFEST_NAME="meshcentral-$VERSION.manifest.json"
SIG_NAME="$MANIFEST_NAME.sig"
[ "$(basename -- "$TGZ")" = "meshcentral-$VERSION.tgz" ] || { echo "The package must be named meshcentral-$VERSION.tgz." >&2; exit 2; }

KEY=$(realpath -- "$KEY"); TGZ=$(realpath -- "$TGZ")
if [ -n "$APPEND" ]; then
    APPEND=$(realpath -- "$APPEND")
    [ "$(basename -- "$APPEND")" = "$SIG_NAME" ] || { echo "--append must name $SIG_NAME." >&2; exit 2; }
    OUT=$(dirname -- "$APPEND")
    [ -f "$OUT/$MANIFEST_NAME" ] || { echo "The manifest $OUT/$MANIFEST_NAME must be next to the signature file." >&2; exit 1; }
else
    mkdir -p -m 700 -- "$OUT"
    OUT=$(realpath -- "$OUT")
    [ ! -e "$OUT/$MANIFEST_NAME" ] && [ ! -e "$OUT/$SIG_NAME" ] || { echo "$MANIFEST_NAME or $SIG_NAME already exists in $OUT; not overwriting." >&2; exit 1; }
fi
# The folder is ours and closed to others, so nobody can change the files between the checks and the signature
[ "$(stat -c %u -- "$OUT")" = "$(id -u)" ] || { echo "$OUT does not belong to you." >&2; exit 1; }
[ "$(( 0$(stat -c %a -- "$OUT") & 077 ))" = 0 ] || { echo "$OUT must not be accessible for group and others (chmod 700 $OUT)." >&2; exit 1; }
if git -C "$(dirname -- "$KEY")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "WARNING: the key file $KEY is inside a git repository. Keep keys outside of repositories." >&2; fi

DOCKER=(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -u "$(id -u):$(id -g)" -v "$REPO_DIR:/repo:ro")
TOOL=(node /repo/tools/release/release-signing.js)

# The key lists of the commit that is released and of the previous release (the servers know that one)
VERIFY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sign-release.XXXXXX")
trap 'rm -rf "$VERIFY_DIR"' EXIT
git -C "$REPO_DIR" show "$COMMIT:serverupdate-keys.json" > "$VERIFY_DIR/commit-keys.json" || { echo "serverupdate-keys.json is not in commit $COMMIT." >&2; exit 1; }
# The previous release of the fork (a tag of the form <base>-custom.<n>), not just any tag: upstream tags say nothing about what the servers know
PREVIOUS=$(git -C "$REPO_DIR" describe --tags --abbrev=0 --match '*-custom.*' "$COMMIT^" 2>/dev/null || true)
HAVE_PREVIOUS_KEYS=0
if [ -n "$PREVIOUS" ] && git -C "$REPO_DIR" show "$PREVIOUS:serverupdate-keys.json" > "$VERIFY_DIR/previous-keys.json" 2>/dev/null; then HAVE_PREVIOUS_KEYS=1; fi
tool() { "${DOCKER[@]}" -v "$VERIFY_DIR:/keys:ro" "$NODE_IMAGE" "${TOOL[@]}" "$@"; }  # for the key lists only

# The servers trust the key list that is IN the package, so that is the list that is shown and used: it is read from the package and must be the file of the commit
"${DOCKER[@]}" -v "$(dirname -- "$TGZ"):/in:ro" -v "$VERIFY_DIR:/keys" "$NODE_IMAGE" "${TOOL[@]}" extract-keys --tgz "/in/meshcentral-$VERSION.tgz" --out /keys/package-keys.json
cmp -s "$VERIFY_DIR/commit-keys.json" "$VERIFY_DIR/package-keys.json" || { echo "serverupdate-keys.json in the package is not the file of commit $COMMIT. Build the package from that commit." >&2; exit 1; }

# 1. Everything that can be checked without the key: the manifest of this package and these values (and with --append the existing manifest and signatures)
SIGN_ARGS=(sign --key /key/key.json --tgz "/in/meshcentral-$VERSION.tgz" --version "$VERSION" --tag "$TAG" --commit "$COMMIT" --repository "$REPOSITORY" --channel "$CHANNEL" --out /out --keys /keys/package-keys.json)
[ -z "$APPEND" ] || SIGN_ARGS+=(--append)
signer() { "${DOCKER[@]}" "$@" -v "$(dirname -- "$TGZ"):/in:ro" -v "$OUT:/out" -v "$VERIFY_DIR:/keys:ro" -v "$KEY:/key/key.json:ro" "$NODE_IMAGE" "${TOOL[@]}" "${SIGN_ARGS[@]}" "${EXTRA_ARGS[@]}"; }
EXTRA_ARGS=(--check-only)
signer

# 2. What changed since the previous release in what the servers trust and in what runs with the key: shown, and confirmed
echo
echo "Release keys in the package (and commit $COMMIT):"
tool keys --keys /keys/package-keys.json | sed 's/^/  /'
CHANGES=0
if [ -z "$PREVIOUS" ]; then
    echo "WARNING: no previous release tag found: there is nothing to compare the key list and the tools with."; CHANGES=1
else
    echo "Previous release: $PREVIOUS"
    if [ "$HAVE_PREVIOUS_KEYS" = 1 ]; then
        echo "Release keys of $PREVIOUS (what servers on that version trust):"
        tool keys --keys /keys/previous-keys.json | sed 's/^/  /'
    else
        echo "WARNING: $PREVIOUS has no serverupdate-keys.json: its servers need a pin in serverupdate-pins.json for this release."; CHANGES=1
    fi
    DIFF=$(git -C "$REPO_DIR" diff --stat "$PREVIOUS" "$COMMIT" -- serverupdate-keys.json tools/release serverupdates.js httpsdownloads.js meshcentral.js package.json npm-shrinkwrap.json || true)
    if [ -n "$DIFF" ]; then echo "Changed since $PREVIOUS in the key list, the release tools and the update code:"; echo "$DIFF" | sed 's/^/  /'; CHANGES=1; fi
fi
# Always asked, with the key list in front of you: signing is rare, and a key that is on the list can sign the next releases
[ "$CHANGES" = 1 ] && echo "Read the changes above (git diff ${PREVIOUS:-<previous>} $COMMIT -- serverupdate-keys.json tools/release serverupdates.js httpsdownloads.js meshcentral.js package.json npm-shrinkwrap.json)."
echo "Only sign if every key id above is one you made (compare with what keygen.sh printed)."
IFS= read -r -p 'Type yes to sign: ' CONFIRM || CONFIRM=
[ "$CONFIRM" = yes ] || { echo "Not signed." >&2; exit 1; }

# 3. The passphrase and the signature
IFS= read -r -s -p 'Key passphrase: ' PASSPHRASE; echo >&2
# printf is a shell builtin: the passphrase is not in any argument list
EXTRA_ARGS=()
printf '%s\n' "$PASSPHRASE" | signer -i
unset PASSPHRASE

# 4. The result is checked again from the files: every signature, the manifest against the package and the values
echo "Verifying with the keys of commit $COMMIT ..."
verify() { "${DOCKER[@]}" -v "$OUT:/out:ro" -v "$VERIFY_DIR:/keys:ro" -v "$(dirname -- "$TGZ"):/in:ro" "$NODE_IMAGE" "${TOOL[@]}" verify --manifest "/out/$MANIFEST_NAME" --sig "/out/$SIG_NAME" --keys "/keys/$1" "${@:2}"; }
verify package-keys.json --tgz "/in/meshcentral-$VERSION.tgz" --version "$VERSION" --tag "$TAG" --commit "$COMMIT" --repository "$REPOSITORY" --channel "$CHANNEL" || { echo "The signature files do not verify against the package and the keys of the released commit." >&2; exit 1; }
if [ "$HAVE_PREVIOUS_KEYS" = 1 ]; then
    echo "Verifying with the keys of the previous release $PREVIOUS (what servers on that version trust) ..."
    verify previous-keys.json || echo "WARNING: servers on $PREVIOUS do not trust this key, they cannot install this release from the web interface (see docs/fork-updates.md)."
fi

echo
echo "Upload these two files to the draft release of $TAG:"
echo "  $OUT/$MANIFEST_NAME"
echo "  $OUT/$SIG_NAME"
