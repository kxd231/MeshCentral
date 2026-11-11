#!/bin/sh
# Builds the WebAssembly SIMD kernels of public/rdp/codecs/avc444-simd.js from avc444-simd.c in throwaway containers and embeds them as base64
# (with the sha256 of the module and the compiler version) between the GENERATED markers of the JavaScript file.
#   tools/avc444-simd/build.sh            rebuild and rewrite the embedded module
#   tools/avc444-simd/build.sh --check    rebuild and compare with the embedded module (exit 1 when they differ); writes nothing
# Needs docker and network access (apt, from the container). Nothing is built or run on the host. Toolchain: Debian bookworm clang-14 / lld-14
# at an exact package version in a base image fixed by digest; the output has to be the same bytes on every run (the check proves it).
set -eu
DEBIAN_IMAGE='debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc'
NODE_IMAGE='node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c'
CLANG_VERSION='1:14.0.6-12'
mode=${1:-}
case "$mode" in ''|--check) ;; *) echo "Usage: $0 [--check]" >&2; exit 2 ;; esac
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../.." && pwd)
OUT=$(mktemp -d)           # mode 700, owned by the invoking user
trap 'rm -rf "$OUT"' EXIT
docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -v "$HERE:/src:ro" -v "$OUT:/out" "$DEBIAN_IMAGE" sh -ec "
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends clang-14=$CLANG_VERSION lld-14=$CLANG_VERSION >/dev/null
    ln -sf /usr/bin/wasm-ld-14 /usr/local/bin/wasm-ld
    clang-14 --version | head -1 > /out/toolchain.txt
    clang-14 --target=wasm32 -O3 -msimd128 -mbulk-memory -ffreestanding -nostdlib -fno-builtin \
        -Wl,--no-entry -Wl,--import-memory -Wl,-z,stack-size=16384 -Wl,--strip-all \
        -o /out/avc444-simd.wasm /src/avc444-simd.c
    chown \"\$HOST_UID:\$HOST_GID\" /out/toolchain.txt /out/avc444-simd.wasm"
if [ "$mode" = --check ]; then
    docker run --rm --user "$(id -u):$(id -g)" -v "$HERE:/tool:ro" -v "$REPO/public/rdp/codecs:/codecs:ro" -v "$OUT:/out:ro" "$NODE_IMAGE" node /tool/embed.js /out/avc444-simd.wasm /out/toolchain.txt /codecs/avc444-simd.js --check
else
    docker run --rm --user "$(id -u):$(id -g)" -v "$HERE:/tool:ro" -v "$REPO/public/rdp/codecs:/codecs" -v "$OUT:/out:ro" "$NODE_IMAGE" node /tool/embed.js /out/avc444-simd.wasm /out/toolchain.txt /codecs/avc444-simd.js
fi
