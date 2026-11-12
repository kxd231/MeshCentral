#!/usr/bin/env bash
# Builds meshcentral-<version>.tgz for a GitHub release of the fork, from a clean export of a git commit or tag.
# Node and npm run in Docker only. Nothing is published or pushed: the script prints the file, its sha256 and the
# command the owner runs to create the release (see docs/fork-updates.md).
#
# Like the upstream npm package, the tgz carries the generated files that git does not hold: the translated pages
# (views/translations, emails/translations) and the minified pages and scripts (-min.*). They are made with
# translate/translate.js minifyall + translateall. The tools (html-minifier-terser, jsdom, esprima) are installed with
# npm ci from tools/release/translate-tools/package-lock.json; that step is the only one that uses the network, translating
# and packing run with --network none. translate.js exits with 0 even when it fails, so the result is checked below.
#
# Usage: tools/release/build-server-tgz.sh [--check-agents] <version> [<git-ref> [<output-dir>]]
#   <version>       release version without "v": <upstream base>-custom.<n> such as 1.3.1-custom.1 (see docs/fork-updates.md),
#                   or X.Y.Z / X.Y.Z.W; numbers without leading zeros
#   <git-ref>       commit, tag or branch to pack (default HEAD)
#   <output-dir>    where the .tgz is written (default ./release-out); an existing file is never overwritten
#   --check-agents  also run agents/check-releases.js (needs network): the default agent files that
#                   agents/agent-defaults.json points to must be published and verified
set -euo pipefail
umask 022

# Pinned Node image.
NODE_IMAGE='node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c'

CHECK_AGENTS=0
if [ "${1:-}" = "--check-agents" ]; then CHECK_AGENTS=1; shift; fi
if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
    echo "Usage: $0 [--check-agents] <version> [<git-ref> [<output-dir>]]" >&2
    exit 2
fi
VERSION=$1
REF=${2:-HEAD}
OUT_DIR=${3:-./release-out}

if ! printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5})|-custom\.[1-9][0-9]{0,5})?$'; then
    echo "Invalid version '$VERSION': expected <upstream base>-custom.<n> (for example 1.3.1-custom.1), or X.Y.Z / X.Y.Z.W, numbers without leading zeros and no leading v" >&2
    exit 2
fi

REPO_DIR=$(git rev-parse --show-toplevel)
COMMIT=$(git -C "$REPO_DIR" rev-parse --verify "$REF^{commit}")
FILE="meshcentral-$VERSION.tgz"
mkdir -p "$OUT_DIR"
OUT_DIR=$(CDPATH= cd -- "$OUT_DIR" && pwd)
if [ -e "$OUT_DIR/$FILE" ]; then
    echo "$OUT_DIR/$FILE already exists, not overwriting it. Remove it or choose another output directory." >&2
    exit 1
fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/meshcentral-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/src" "$WORK/out" "$WORK/tools"
DOCKER_USER=(-u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache -e npm_config_update_notifier=false -e npm_config_fund=false -e npm_config_audit=false)

echo "Exporting $COMMIT ..."
git -C "$REPO_DIR" archive --format=tar -o "$WORK/src.tar" "$COMMIT"
tar -xf "$WORK/src.tar" -C "$WORK/src"
rm -f "$WORK/src.tar"

echo "Checking package.json version ..."
PKG_VERSION=$(docker run --rm --network none "${DOCKER_USER[@]}" -v "$WORK/src:/src:ro" -w /src "$NODE_IMAGE" node -p "require('./package.json').version")
if [ "$PKG_VERSION" != "$VERSION" ]; then
    echo "package.json at $COMMIT has version $PKG_VERSION, not $VERSION. Bump it and commit before releasing." >&2
    exit 1
fi

echo "Installing the translate tools from the lockfile - the only step that uses the network ..."
cp "$REPO_DIR/tools/release/translate-tools/package.json" "$REPO_DIR/tools/release/translate-tools/package-lock.json" "$WORK/tools/"
docker run --rm "${DOCKER_USER[@]}" -v "$WORK/tools:/tools" -w /tools "$NODE_IMAGE" npm ci --ignore-scripts >/dev/null

echo "Generating minified and translated pages (translate.js minifyall, translateall) ..."
for command in minifyall translateall; do
    docker run --rm --network none "${DOCKER_USER[@]}" -e NODE_PATH=/tools/node_modules -v "$WORK/src:/src" -v "$WORK/tools:/tools:ro" -w /src/translate "$NODE_IMAGE" node translate.js "$command" > "$WORK/translate-$command.log" 2>&1
    if grep -Eq 'Unable to|Cannot find module|ERROR|Error:|Failed|Missing' "$WORK/translate-$command.log"; then
        echo "translate.js $command reported a problem:" >&2; grep -E 'Unable to|Cannot find module|ERROR|Error:|Failed|Missing' "$WORK/translate-$command.log" | head -10 >&2; exit 1
    fi
done

# translate.js exits with 0 on failure too: every language must have the same set of translated files as Polish,
# and the set must not be small.
check_translations() { # <dir> <extension...>
    local dir=$1; shift
    local ext reference="$WORK/ref-$(basename "$dir").txt" count=0 lang
    : > "$reference"
    for ext in "$@"; do (cd "$dir" && ls | grep -E "_pl\.$ext\$" | sed -E "s/_pl\.$ext\$//; s/\$/.$ext/" >> "$reference") || true; done
    sort -o "$reference" "$reference"
    if [ "$(wc -l < "$reference")" -lt 20 ]; then echo "Too few translated files in $dir for Polish: $(wc -l < "$reference")" >&2; exit 1; fi
    for lang in $(cd "$dir" && ls | grep -oE '^default_[a-z-]+\.handlebars$|^account-check_[a-z-]+\.html$' | sed -E 's/^[a-z0-9-]+_([a-z-]+)\..*$/\1/' | sort -u); do
        count=$((count + 1))
        local have="$WORK/have-$(basename "$dir")-$lang.txt"
        : > "$have"
        for ext in "$@"; do (cd "$dir" && ls | grep -E "_$lang\.$ext\$" | sed -E "s/_$lang\.$ext\$//; s/\$/.$ext/" >> "$have") || true; done
        sort -o "$have" "$have"
        if ! cmp -s "$reference" "$have"; then echo "Incomplete translation for '$lang' in $dir:" >&2; diff "$reference" "$have" | head -10 >&2; exit 1; fi
    done
    if [ "$count" -lt 20 ]; then echo "Only $count languages found in $dir" >&2; exit 1; fi
}
check_translations "$WORK/src/views/translations" handlebars
check_translations "$WORK/src/emails/translations" html txt

echo "Running npm pack in Docker ..."
docker run --rm --network none "${DOCKER_USER[@]}" -v "$WORK/src:/src" -v "$WORK/out:/out" -w /src "$NODE_IMAGE" npm pack --ignore-scripts --pack-destination /out >/dev/null
if [ ! -f "$WORK/out/$FILE" ]; then
    echo "npm pack did not produce $FILE" >&2
    exit 1
fi

echo "Checking package contents ..."
tar -tzf "$WORK/out/$FILE" > "$WORK/list.txt"
for required in package/package.json package/meshcentral.js package/serverupdates.js package/httpsdownloads.js package/agents/agent-defaults.json package/npm-shrinkwrap.json package/meshcentral-config-schema.json \
        package/views/default.handlebars package/views/default-min.handlebars package/views/translations/default_pl.handlebars \
        package/emails/translations/account-invite_pl.html package/public/scripts/meshcentral-min.js; do
    grep -qx "$required" "$WORK/list.txt" || { echo "Missing $required in the package." >&2; exit 1; }
done
# Agent binaries are separate release assets, they must not be part of the server package.
AGENT_RE='^package/agents/(meshagent[_-]|MeshService|MeshConsole|MeshCmd[^/]*\.exe$|agents_[^/]+/)'
if grep -Eiq "$AGENT_RE" "$WORK/list.txt"; then
    echo "The package contains agent binaries; they must be release assets." >&2
    grep -Ei "$AGENT_RE" "$WORK/list.txt" >&2
    exit 1
fi

if [ "$CHECK_AGENTS" = 1 ]; then
    echo "Checking the default agent release files (agents/check-releases.js, network) ..."
    docker run --rm "${DOCKER_USER[@]}" -v "$WORK/src:/src" -w /src "$NODE_IMAGE" sh -c 'npm pack --dry-run --json --ignore-scripts > /tmp/meshcentral-package.json && node agents/check-releases.js --package /tmp/meshcentral-package.json'
fi

cp -n "$WORK/out/$FILE" "$OUT_DIR/$FILE"
SHA=$(sha256sum "$OUT_DIR/$FILE" | cut -d' ' -f1)
SHA384=$(sha384sum "$OUT_DIR/$FILE" | cut -d' ' -f1)
SIZE=$(wc -c < "$OUT_DIR/$FILE")
echo
echo "File:    $OUT_DIR/$FILE"
echo "Commit:  $COMMIT"
echo "Size:    $SIZE bytes"
echo "SHA256:  $SHA"
echo "SHA384:  $SHA384"
echo
echo "Entry for meshcentral-data/serverupdate-pins.json on the servers that may install it (docs/fork-updates.md):"
echo "  { \"version\": \"$VERSION\", \"size\": $SIZE, \"sha384\": \"$SHA384\" }"
echo
echo "Nothing was published."
if [ "$CHECK_AGENTS" = 0 ]; then echo "Not checked: the default agent release files. Run again with --check-agents, or run agents/check-releases.js, before releasing."; fi
echo "To release (the tag is the version, with or without a leading v). The target must be a commit that exists in the"
echo "published repository: build from a checkout of that repository, or give the SHA it has for this tree:"
echo "  gh release create $VERSION '$OUT_DIR/$FILE' --repo kxd231/MeshCentral --target <commit in kxd231/MeshCentral> --title $VERSION --notes-file <notes>"
echo "GitHub then shows the same sha256 as the asset digest."
