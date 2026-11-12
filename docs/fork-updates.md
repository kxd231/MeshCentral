<!-- SPDX-License-Identifier: Apache-2.0 -->

# Server updates in this fork

This fork (`kxd231/MeshCentral`) takes its server updates from the releases of its own
GitHub repository, not from the `meshcentral` package on npm. Installing the upstream
package would replace the fork's work (pure-JavaScript Web-RDP, KVM changes). No npm
account and no GitHub token are needed.

## How an update works

1. **Version check** (Update button, `serverversion`, `selfUpdate`, meshctrl): the server
   reads `https://api.github.com/repos/<serverUpdateRepository>/releases?per_page=100`
   without a token. The list is cached for 5 minutes in each process; after that it is
   revalidated with an ETag (an unauthenticated 304 answer still counts against GitHub's
   limit of 60 requests per hour per address, the cache is what saves requests). When the
   limit is reached, GitHub is unreachable, or the repository was renamed or moved (GitHub
   answers with a redirect, which is refused; set the new `serverUpdateRepository`), the
   latest version is reported as unknown and the server keeps running.
2. **Which releases count.** A release is usable when it is not a draft, its tag is a
   version (`1.3.1-custom.2`, `v1.3.1-custom.2`, a plain `1.3.2`, or the older four part form
   `1.3.1.1`; see [Versioning](#versioning)) and it has an asset named exactly
   `meshcentral-<version>.tgz` (`<version>` is the tag without a leading `v`). `latest`
   (and `stable`) is the newest usable release that is not marked prerelease. A usable
   prerelease that is newer than `latest` is shown as the tag `prerelease`. `npmTag`
   limits the tags like it does for npm (`latest`, `stable` or `prerelease`).
3. **The decision is made once.** `selfUpdate: true` only updates to a version that is
   **newer** than the installed one (the npm source still updates on any difference). The
   server process passes the exact version to the parent process (the one that restarts
   the server), and the parent installs exactly that version. `serverupdate` without a
   version installs the newest release only if it is newer than the installed version, so
   a prerelease you installed is never replaced by an older stable release. An explicit
   `serverupdate <version>` from the console or the web UI still refuses a downgrade, as
   before; only a version named in the configuration (`selfUpdate: "1.3.2"`) is installed
   even if it is older, because the administrator asked for exactly that.
4. **Install.** The version must have a local pin in `meshcentral-data/serverupdate-pins.json`
   (see [Local pins](#local-pins)); without one nothing is downloaded and the update stops with a
   log line that names the file. The parent process downloads the asset to
   `meshcentral-data/serverupdates/` with a size limit equal to the pinned size (which must equal
   the asset size from the API) and an overall time limit of 15 minutes, compares its size and
   SHA-384 with the pin and its SHA-256 with the `digest` field that GitHub reports for the asset
   (`sha256:<hex>`). A missing pin, a missing or different digest, or a size or SHA-384 that differs
   from the pin aborts the update. It then reads `package/package.json` from the
   archive and refuses it unless the name is `meshcentral` and the version is the
   version of the release. Then it runs
   `npm install --save-exact --no-audit '<path to the verified .tgz>'` in the folder that
   holds `node_modules`. The package inside is still named `meshcentral`, so
   `node_modules/meshcentral` keeps its path. After npm returns, the installed
   `node_modules/meshcentral/package.json` must show the same version, or the update is
   counted as failed.
5. **Failures do not loop.** When an update fails (download, pin, digest, wrong package, npm
   error), nothing is installed, the server restarts on the current version and a marker
   `meshcentral-data/serverupdates/last-failure.json` (version, time, reason) is written.
   The automatic update (`selfUpdate`) does not try the same version again for 24 hours;
   an administrator who starts the update by hand (button, `serverupdate`) always gets a
   new attempt. A pinned `selfUpdate` version is retried at the first server start after the 24 hours. A successful update removes the marker.
6. After a successful install the server restarts and older downloaded packages are
   deleted. The installed package stays in `meshcentral-data/serverupdates/`: npm records
   it in `package.json` as a `file:` dependency and needs it for later `npm install` runs.
   The folder is inside the data folder, so it is part of server backups; exclude it with
   `autoBackup.backupSkipFoldersGlob` if that matters.

Downloads use the same HTTPS client as the default agent downloads (HTTPS on port 443,
checks that DNS answers are public addresses, no redirects to other protocols, no
compression). Behind a proxy the proxy resolves the host, so the address checks do not
apply. The proxy is `npmProxy`, or when that is not set the `HTTPS_PROXY`/`HTTP_PROXY`
environment variables; `NO_PROXY` is ignored.

Self-update only works when MeshCentral is installed as `node_modules/meshcentral` and is
not a Windows service or a Docker image; otherwise update the installation by hand.

## Local pins

The server installs only a package whose size and SHA-384 the administrator wrote down on the server
beforehand, in `meshcentral-data/serverupdate-pins.json` (the same idea as the size and SHA-384 pins of
the agent files in `agents/agent-defaults.json`). The digest that GitHub reports comes from the same
release as the file, so it cannot be the only check.

```json
{
  "schemaVersion": 1,
  "releases": [
    { "version": "1.3.1-custom.2", "size": 69029801, "sha384": "<96 lower case hex characters>" }
  ]
}
```

- `version` is written like in the asset name, without `v`. `size` is in bytes. Several versions may be listed.
- Take the values from a package you checked yourself, not from the release page alone: the output of
  `tools/release/build-server-tgz.sh` (the build is reproducible, so a local build of the tag gives the same
  file), or a download you verified another way, then `stat -c %s` and `sha384sum` of that file.
- The file is read for every update, no restart is needed. A missing file means no version is pinned. A
  file that is not valid (bad JSON, a hash that is not 96 lower case hex characters, a version listed twice)
  stops every update with a log line.
- `selfUpdate` skips a version without a pin with one log line and keeps the server running; it does not
  restart for it. The Update button and `serverupdate` restart the server, which then logs
  `Update failed, nothing was installed: ...` and starts again on the current version.
- Pins apply to the `github` source. The `npm` source installs `meshcentral` from the npm registry
  without a local pin (the previous upstream behavior).

## Trust model

Read this before relying on automatic updates.

- The SHA-256 digest comes from the same GitHub account as the file. It protects against a
  damaged or truncated download and a faulty CDN. It does **not** prove who built the package.
  The local pin is what ties an update to a package the administrator checked.
- **Without a local pin, whoever can create or change releases in the repository would run code on every
  server that follows it.** With pins, a changed or new release is refused until an administrator pins it,
  so the pin is only as good as the check made before writing it. That means collaborators with write access, a leaked token with
  `contents:write`, and a compromised owner account. The package is installed by `npm`
  as the user the MeshCentral service runs as (often root), and lifecycle scripts of the
  package and its dependencies run. A server with `selfUpdate: true` takes a new release
  within a day.
- A TLS-intercepting proxy (a company root certificate in the system or
  `NODE_EXTRA_CA_CERTS` store) or a wrongly issued certificate can replace both the API
  answer (with its digest) and the file. The digest gives no protection against that; the local pin does.
- Dependencies are not part of the package, but the package carries `npm-shrinkwrap.json`
  (the lockfile of the repository, with the exact version and integrity hash of every
  dependency). `npm install` downloads exactly that tree from the npm registry, so the
  dependencies of a pinned package are pinned too. Modules that the server installs at
  startup for optional features (database drivers, SMTP, syslog ...) are not part of it.
  A dependency fix arrives with a new release; until then an `overrides` entry in the
  `package.json` of the folder that holds `node_modules` still applies.

What to do: turn on two-factor authentication for every account with access to the
repository, keep the number of collaborators and the scope of tokens (fine-grained,
no `contents:write` for automation you do not need) minimal, and enable GitHub's
**immutable releases** for the repository, so that the assets of a published release can
no longer be replaced or deleted. Use `"serverUpdateSource": "npm"` or turn `selfUpdate`
off on servers where an unreviewed update is not acceptable, and update them by hand.

Possible future work, not implemented: a detached signature asset
(`meshcentral-<version>.tgz.sig`) checked against a public key built into the server, so
that GitHub access alone is not enough to ship code.

## Settings (`settings` section of config.json)

| Setting | Default | Meaning |
| --- | --- | --- |
| `serverUpdateSource` | `"github"` | `"github"`: releases of `serverUpdateRepository`. `"npm"`: the previous upstream behavior (`npm view meshcentral ...`, `npm install meshcentral@<ver>`), code path unchanged. The value is not case sensitive. Any other value logs an error and disables **all** server updates (checks, `selfUpdate`, the Update button); it never falls back to npm. |
| `serverUpdateRepository` | `"kxd231/MeshCentral"` | `owner/repo` of a public GitHub repository. Strictly validated; an invalid value is logged once and disables the GitHub update checks. |
| `npmPath`, `npmProxy` | unchanged | `npmPath` is a command line run by the shell, as before (it may hold quotes, `node /path/npm-cli.js`, variables); it is used for both sources. `npmProxy` is also used for the GitHub requests. |
| `npmTag` | unset | Show only that tag (`latest`, `stable` or `prerelease`). |
| `selfUpdate` | `false` | `true`: update to the newest release after midnight. A version such as `"1.3.2"` updates to exactly that version at startup; it is compared as a version (`v1.3.1-custom.2` equals `1.3.1-custom.2`, `1.3.2.0` equals `1.3.2`) and is never reinstalled when it is already installed. A value that is not an exact version (`latest`, `stable`, `1.3.2-beta`, `1.3.1-custom`) is logged and treated as `false`. |

`runOnServerUpdated` and `cleanNpmCacheOnUpdate` work as before.

The install command quotes the package path and the proxy for the shell. On Linux and macOS a
single quote or control character in the data folder path is refused; on Windows a
double quote, `%`, `!` or `^` is refused (non-ASCII characters and spaces are fine). A refused
path aborts the update with a log line and counts as a failure.

## Versioning

The fork's version is `<upstream base>-custom.<n>`: the MeshCentral version the code is based
on, then the number of the fork's release on that base.

| Version | Meaning |
| --- | --- |
| `1.3.1` | upstream 1.3.1 as it is |
| `1.3.1-custom.1` | first release of the fork based on upstream 1.3.1 |
| `1.3.1-custom.2` | second release of the fork on the same base |
| `1.3.5-custom.1` | first release after merging upstream 1.3.5 |

The same text is used everywhere: the `package.json` `version` (shown as "Current Version" in the
server Update dialog, in the log, and available as the `serverversion` placeholder in the domain
footer text), the GitHub release tag (`1.3.1-custom.1`) and the asset `meshcentral-1.3.1-custom.1.tgz`.
The `package.json` inside the asset must hold exactly the same text, or the server refuses the
download.

A leading `v` is accepted on release tags (`v1.3.1-custom.1`) and in the `selfUpdate` setting; it is
dropped from the version, so the asset is still `meshcentral-1.3.1-custom.1.tgz`. It is not accepted
in `package.json`, in the asset name, in the argument of `tools/release/build-server-tgz.sh`, or in
the version the server passes to its parent process (which are always the plain text).

Accepted forms: `X.Y.Z`, `X.Y.Z-custom.N` (`N` is at least 1) and the older `X.Y.Z.W`.
Numbers have no leading zeros. Anything else is not a version and is ignored: `1.3.1-beta`,
`1.3.1-custom`, `1.3.1-custom.01`, `latest`.

Ordering: the upstream base `X.Y.Z` is compared first, numerically, then the fork number.
So `1.3.1` < `1.3.1-custom.1` < `1.3.1-custom.2` < `1.3.2` < `1.3.2-custom.1`. A newer upstream
base always wins, even over a higher fork number (`1.3.2` is newer than `1.3.1-custom.9`).
The older form `X.Y.Z.W` is ordered as `X.Y.Z-custom.W`, so `1.3.1.1` and `1.3.1-custom.1` are
the same version for ordering. When a release list holds both with a usable asset, the
`-custom` one is used and the other is ignored; of `1.3.2` and `1.3.2.0` the one listed
first is used.

Which tag is used decides the `prerelease` flag: it is the flag of the release that is kept after
this selection, so a `-custom` release marked prerelease stays a prerelease even if the ignored
older-form tag of the same version is not.

npm and semver read `1.3.1-custom.1` as a prerelease of `1.3.1`, so by semver rules it sorts
*below* `1.3.1`. This does not matter here: the server orders versions with its own comparison
described above, never with semver, and the update is installed from a local file
(a `file:` dependency in `package.json`), so npm never resolves the version against a range.

Plugins see the fork as its upstream base: `1.3.1-custom.1` satisfies a `meshCentralCompat`
of `>=1.3.1`.

How to bump:

- Next release on the same upstream base: increase `n` (`1.3.1-custom.1` to `1.3.1-custom.2`).
- After merging a newer upstream release: `<new base>-custom.1` (for example `1.3.5-custom.1`).
- Set `version` in `package.json` and `npm-shrinkwrap.json` (the first two `"version"` lines), commit,
  then build with `tools/release/build-server-tgz.sh <version>`, which checks that
  `package.json` at that commit has this version.

## Making a release (owner)

Normally the package is built by GitHub Actions: publishing a release (tag = version, on the commit whose
`package.json` has that version) starts `.github/workflows/server-release.yml`, which runs the release helper
below on the tag and attaches `meshcentral-<version>.tgz` to the release; the run summary shows the commit, size
and sha256. Servers see the release once the file is attached. The same workflow can be started by hand for an
existing tag. Building locally, as below, is the fallback.

The release helper runs everything in Docker (pinned Node image, no Node on the host) from a
clean `git archive` of a commit or tag. It does not tag, push or publish anything. Like the
upstream npm package, the tgz carries the generated pages that git does not hold: it runs
`translate/translate.js minifyall` and `translateall` first (the tool packages
`html-minifier-terser`, `jsdom` and `esprima` are installed with `npm ci` from the lockfile in
`tools/release/translate-tools/`; that is the only step with network access, and the script fails
when the translation is incomplete) so that
`views/translations/`, `emails/translations/` and the `-min` pages and scripts are in the
package. A server updated from it keeps its translated UI and `minify` option.

```sh
# 1. package.json "version" is the release version, <upstream base>-custom.<n>
#    (see Versioning); commit it in the repository you publish.
# 2. Build the package from that commit (the output file must not exist yet):
tools/release/build-server-tgz.sh --check-agents 1.3.1-custom.1 HEAD ./release-out
#    -> checks package.json version == 1.3.1-custom.1, makes the translated and minified pages, packs,
#       checks that translations are in and agent binaries are not, optionally runs
#       agents/check-releases.js (--check-agents, needs network), prints the sha256.
# 3. Create the release and upload the asset yourself (the asset name must stay
#    meshcentral-<version>.tgz, the tag is the version, optionally with a leading v).
#    --target must be a commit that exists in kxd231/MeshCentral:
gh release create 1.3.1-custom.1 release-out/meshcentral-1.3.1-custom.1.tgz --repo kxd231/MeshCentral \
   --target <commit> --title 1.3.1-custom.1 --notes-file notes.md
# 4. Check that GitHub shows the same digest for the asset (this is what servers verify):
gh api repos/kxd231/MeshCentral/releases/tags/1.3.1-custom.1 --jq '.assets[] | [.name,.digest]'
```

Use `--prerelease` for a test release: it appears only as the `prerelease` tag and is
never offered as `latest`. Do not delete a published asset that servers may be
installing; publish a newer version instead. The package is about 70 MB; the server
refuses assets above 256 MiB.

The repository still contains upstream's `.github/workflows/release.yml`, which runs an npm
release action when `package.json` changes on `master`. It may create a tag or release without
an asset. Disable that workflow in the published repository, or create your release first.

The releases `1.3.1` and `1.3.1.1` have no asset and are ignored by servers. The first
release accepted by the new mechanism is `1.3.1-custom.1` (newer than `1.3.1`), or the asset can
be added to an existing release with `gh release upload`. A server running
an older build still checks npm, so the first move to the new mechanism is a manual install.
Put the file where later updates expect it first, because npm records the path:

```sh
mkdir -p meshcentral-data/serverupdates
cp meshcentral-1.3.1-custom.1.tgz meshcentral-data/serverupdates/
cd <folder that holds node_modules>
npm install --save-exact --no-audit ./meshcentral-data/serverupdates/meshcentral-1.3.1-custom.1.tgz
```

Restart the MeshCentral process or service afterwards.

## Switching back to npm

Set `"serverUpdateSource": "npm"` in `settings` and **restart the MeshCentral process or
service**: the parent process that installs updates keeps the settings it started with, and
the restart inside the web UI restarts only the child. Updates then use the upstream
`meshcentral` package exactly as before. Installing it replaces the fork's code with upstream's.
The `file:` entry that earlier GitHub updates left for `meshcentral` in `package.json` is
overwritten by the first `npm install meshcentral@<version>`.

## Related

[Web-RDP administration](webrdp.md)
