#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Makes a release of the fork from the commit that is checked out: tag, draft of the workflow, local build, signature, upload, publication (docs/fork-updates.md,
# "Making a release"). Run by the release owner, on the computer that holds the signing key. Nothing irreversible happens before you type yes, twice.
#
# Usage: tools/release/release.sh [--dry-run] --key <key.json> [--channel stable|prerelease] [--repository kxd231/MeshCentral] [--remote origin]
#                                 [--out <dir>] [--timeout-minutes 40] [--notes-file <file>] <version>
#   --dry-run  checks (read only) and prints the steps; creates, pushes, uploads, signs and publishes nothing.
#
# Steps: 1 checks (clean tree, version in package.json and npm-shrinkwrap.json, commit is on the remote, tag and release do not exist);
#        2 tag and push of the tag (after yes); 3 wait for the draft of the workflow; 4 one local build, its sha256 must be the one of the draft;
#        5 sign-release.sh (asks the passphrase); 6 upload manifest and signature to the draft (never --clobber); 7 download the three files again and verify;
#        8 publish (after yes). Nothing is deleted or moved, nothing is forced.
set -euo pipefail
set +x +a
umask 022

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/node-image.sh"
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
usage() { sed -n '/^# Usage:/,/^set -/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }

DRY=0 KEY= CHANNEL=stable REPOSITORY=kxd231/MeshCentral REMOTE=origin OUT= TIMEOUT=40 NOTES= VERSION=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1; shift ;;
        --key|--channel|--repository|--remote|--out|--timeout-minutes|--notes-file)
            [ "$#" -ge 2 ] || usage
            case "$1" in --key) KEY=$2 ;; --channel) CHANNEL=$2 ;; --repository) REPOSITORY=$2 ;; --remote) REMOTE=$2 ;; --out) OUT=$2 ;; --timeout-minutes) TIMEOUT=$2 ;; --notes-file) NOTES=$2 ;; esac
            shift 2 ;;
        -*) usage ;;
        *) [ -z "$VERSION" ] || usage; VERSION=$1; shift ;;
    esac
done
[ -n "$VERSION" ] && [ -n "$KEY" ] || usage
case "$CHANNEL" in stable|prerelease) ;; *) echo "--channel is stable or prerelease." >&2; exit 2 ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) echo "--timeout-minutes is a number." >&2; exit 2 ;; esac
# The tag of the workflow: <upstream base>-custom.<n>, no leading v
printf '%s\n' "$VERSION" | grep -Eqx '(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})-custom\.[1-9][0-9]{0,5}' || { echo "Invalid version '$VERSION': expected <upstream base>-custom.<n>, for example 1.3.1-custom.3." >&2; exit 2; }
case "$REPOSITORY$REMOTE$OUT$KEY" in *[[:space:]]*|*:*|*,*) echo "Spaces, colons and commas are not supported in the arguments." >&2; exit 2 ;; esac
OUT=${OUT:-$REPO_DIR/release-out}

FILE="meshcentral-$VERSION.tgz"
MANIFEST="meshcentral-$VERSION.manifest.json"
SIGNATURE="$MANIFEST.sig"
say() { printf '%s\n' "$*"; }
step() { say; say "== Step $1: $2"; }
# Runs a command, or only says that it would (dry run)
act() { if [ "$DRY" = 1 ]; then say "   [dry-run] would run: $*"; else "$@"; fi; }
ask() { # <question>: the answer must be exactly yes; no answer is no
    if [ "$DRY" = 1 ]; then say "   [dry-run] would ask: $1 (type yes)"; return 0; fi
    local answer=; IFS= read -r -p "$1 (type yes) " answer || answer=
    [ "$answer" = yes ] || { say "Stopped: the answer was not yes. Nothing further was done." >&2; exit 1; }
}
fail() { say "ERROR: $*" >&2; exit 1; }
# sha256 of the three files as GitHub reports them now ("name sha256" per line), and of the files that were downloaded and verified
github_digests() { gh release view "$VERSION" -R "$REPOSITORY" --json assets --jq '.assets[] | select(.name == "'"$FILE"'" or .name == "'"$MANIFEST"'" or .name == "'"$SIGNATURE"'") | .name + " " + ((.digest // "none") | sub("^sha256:"; ""))' | sort; }
local_digests() { local n; for n in "$FILE" "$MANIFEST" "$SIGNATURE"; do printf '%s %s\n' "$n" "$(sha256sum "$CHECK_DIR/$n" | cut -d' ' -f1)"; done | sort; }
# The files on GitHub must still be the ones that passed the verification
same_digests() { # <when>
    local now; now=$(github_digests) || fail "could not read the digests of the release $1."
    [ "$now" = "$VERIFIED_DIGESTS" ] || fail "the files of the release $VERSION are not the ones that were verified ($1). Verified: $(printf '%s' "$VERIFIED_DIGESTS" | tr '\n' ';') Now: $(printf '%s' "$now" | tr '\n' ';')"
}

[ "$DRY" = 0 ] || say "DRY RUN: the checks are read only; nothing is created, pushed, uploaded, signed or published."

# ---- 1. checks
step 1 "checks"
[ -f "$KEY" ] || fail "key file not found: $KEY"
[ -z "$(git -C "$REPO_DIR" status --porcelain)" ] || fail "the working tree is not clean (commit or stash first)."
PKG_VERSION=$(grep -m1 '"version"' "$REPO_DIR/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
[ "$PKG_VERSION" = "$VERSION" ] || fail "package.json has version '$PKG_VERSION', not $VERSION."
# npm-shrinkwrap.json: the version of the package itself, in its first two "version" lines
SHRINK=$(grep -m2 '"version"' "$REPO_DIR/npm-shrinkwrap.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' | sort -u | tr '\n' ' ')
[ "$SHRINK" = "$VERSION " ] || fail "npm-shrinkwrap.json has version '${SHRINK% }' in its first two lines, not $VERSION."
git -C "$REPO_DIR" fetch --quiet "$REMOTE" || fail "git fetch $REMOTE failed."
COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD)
[ -n "$(git -C "$REPO_DIR" branch -r --contains "$COMMIT" 2>/dev/null)" ] || fail "commit ${COMMIT:0:12} is on no branch of the remote $REMOTE: push the branch first."
if git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/$VERSION" >/dev/null 2>&1; then fail "the tag $VERSION exists already."; fi
[ -z "$(git -C "$REPO_DIR" ls-remote --tags "$REMOTE" "refs/tags/$VERSION")" ] || fail "the tag $VERSION exists on $REMOTE already."
gh auth status >/dev/null 2>&1 || fail "gh is not signed in (gh auth login)."
if gh release view "$VERSION" -R "$REPOSITORY" >/dev/null 2>&1; then fail "a release $VERSION exists already in $REPOSITORY."; fi
say "   commit $COMMIT: $(git -C "$REPO_DIR" log -1 --format=%s "$COMMIT")"
say "   version $VERSION (package.json and npm-shrinkwrap.json agree), no tag, no release, channel $CHANNEL, repository $REPOSITORY"

# ---- 2. tag
step 2 "tag $VERSION on that commit and push of the tag to $REMOTE"
ask "Tag $VERSION on ${COMMIT:0:12} and push it? Pushing the tag starts the build of the draft in GitHub Actions."
act git -C "$REPO_DIR" tag "$VERSION" "$COMMIT"
act git -C "$REPO_DIR" push "$REMOTE" "refs/tags/$VERSION"

# ---- 3. the draft of the workflow
step 3 "wait for the draft release of the workflow (at most $TIMEOUT minutes)"
DRAFT_SHA256=
if [ "$DRY" = 1 ]; then
    say "   [dry-run] would poll: gh release view $VERSION -R $REPOSITORY (draft, asset $FILE with its digest)"
else
    DEADLINE=$(( $(date +%s) + TIMEOUT * 60 ))
    while :; do
        INFO=$(gh release view "$VERSION" -R "$REPOSITORY" --json isDraft,assets --jq '[.isDraft, ([.assets[] | select(.name == "'"$FILE"'" and .state == "uploaded") | .digest] | first // "")] | @tsv' 2>/dev/null || true)
        if [ "${INFO%%$'\t'*}" = true ] && [ "${INFO#*$'\t'}" != "" ]; then DRAFT_SHA256=${INFO#*$'\t'sha256:}; break; fi
        [ "${INFO%%$'\t'*}" != false ] || fail "the release $VERSION is published already."
        [ "$(date +%s)" -lt "$DEADLINE" ] || fail "no draft with $FILE after $TIMEOUT minutes. Look at the workflow run; the tag is pushed. Nothing else was done."
        sleep 20
    done
    printf '%s\n' "$DRAFT_SHA256" | grep -Eqx '[a-f0-9]{64}' || fail "the draft has no sha256 digest for $FILE."
    say "   draft found, sha256 $DRAFT_SHA256"
fi

# ---- 4. one local build
step 4 "local build of the tag, its sha256 must be the one of the draft"
act mkdir -p "$OUT"
act "$SCRIPT_DIR/build-server-tgz.sh" --check-agents "$VERSION" "refs/tags/$VERSION" "$OUT"
if [ "$DRY" = 1 ]; then
    say "   [dry-run] would compare: sha256sum $OUT/$FILE with the digest of the draft"
else
    LOCAL_SHA256=$(sha256sum "$OUT/$FILE" | cut -d' ' -f1)
    [ "$LOCAL_SHA256" = "$DRAFT_SHA256" ] || fail "the local build ($LOCAL_SHA256) is not the package of the draft ($DRAFT_SHA256). Do not sign. Find out why before anything else (a build that is not reproducible, or a draft that was changed)."
    say "   the same package: $LOCAL_SHA256"
fi

# ---- 5. signature
step 5 "sign the local package (sign-release.sh asks for the passphrase)"
act "$SCRIPT_DIR/sign-release.sh" --key "$KEY" --tgz "$OUT/$FILE" --version "$VERSION" --tag "$VERSION" --commit "$COMMIT" --repository "$REPOSITORY" --channel "$CHANNEL" --out "$OUT/sign-$VERSION"

# ---- 6. upload
step 6 "upload $MANIFEST and $SIGNATURE to the draft (never --clobber)"
if [ "$DRY" = 1 ]; then
    say "   [dry-run] would check that the draft has neither file, then run: gh release upload $VERSION $OUT/sign-$VERSION/$MANIFEST $OUT/sign-$VERSION/$SIGNATURE -R $REPOSITORY"
else
    gh release view "$VERSION" -R "$REPOSITORY" --json assets --jq '.assets[].name' | grep -Eqx "$MANIFEST|$SIGNATURE" && fail "the draft has a manifest or a signature already; not uploading over it."
    gh release upload "$VERSION" "$OUT/sign-$VERSION/$MANIFEST" "$OUT/sign-$VERSION/$SIGNATURE" -R "$REPOSITORY"
fi

# ---- 7. verify what is on GitHub
step 7 "download the package, the manifest and the signature from the draft and verify them"
CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/release-check.XXXXXX")
trap 'rm -rf "$CHECK_DIR"' EXIT
if [ "$DRY" = 1 ]; then
    say "   [dry-run] would run: gh release download $VERSION -R $REPOSITORY -D <temp> (three files), then in Docker: release-signing.js verify --tgz ... with the keys of the tag"
else
    gh release download "$VERSION" -R "$REPOSITORY" -D "$CHECK_DIR" -p "$FILE" -p "$MANIFEST" -p "$SIGNATURE"
    git -C "$REPO_DIR" show "$VERSION:serverupdate-keys.json" > "$CHECK_DIR/keys.json"
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -u "$(id -u):$(id -g)" -v "$REPO_DIR:/repo:ro" -v "$CHECK_DIR:/check:ro" "$NODE_IMAGE" \
        node /repo/tools/release/release-signing.js verify --manifest "/check/$MANIFEST" --sig "/check/$SIGNATURE" --keys /check/keys.json --tgz "/check/$FILE" \
        --version "$VERSION" --tag "$VERSION" --commit "$COMMIT" --repository "$REPOSITORY" --channel "$CHANNEL" || fail "what is on GitHub does not verify. Do not publish."
    VERIFIED_DIGESTS=$(local_digests)
    same_digests "right after the download"
fi

# ---- 8. publish
step 8 "publish the release (immutable releases: it cannot be changed afterwards)"
PUBLISH=(gh release edit "$VERSION" -R "$REPOSITORY" --draft=false)
[ "$CHANNEL" = stable ] || PUBLISH+=(--prerelease)
[ -z "$NOTES" ] || PUBLISH+=(--notes-file "$NOTES")
if [ "$DRY" = 1 ]; then say "   [dry-run] would compare the digests of the three files on GitHub with the ones that were verified, before and after the publication"; else same_digests "just before publishing"; fi
ask "Publish $VERSION ($CHANNEL)?"
act "${PUBLISH[@]}"
if [ "$DRY" = 0 ]; then same_digests "after publishing (the release is published and cannot be changed: do not use it and tell the people who use it)"; fi
say
say "Done: $VERSION. Servers with the key list take it from the web interface (or at night with selfUpdate)."
