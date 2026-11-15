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
   **newer** than the installed one. The
   server process passes the exact version to the parent process (the one that restarts
   the server), and the parent installs exactly that version. `serverupdate` without a
   version installs the newest release only if it is newer than the installed version, so
   a prerelease you installed is never replaced by an older stable release. An explicit
   `serverupdate <version>` from the console or the web UI still refuses a downgrade, as
   before; only a version named in the configuration (`selfUpdate: "1.3.2"`) is installed
   even if it is older, because the administrator asked for exactly that.
4. **Trust, then install.** Before the server restarts, the server process makes sure that the
   version has a pin in `meshcentral-data/serverupdate-pins.json`: either one that the administrator
   wrote by hand, or one that the server writes itself after it verified the signature of the
   release owner on the release (see [Signed releases](#signed-releases) and
   [Local pins](#local-pins)). Without a pin nothing is downloaded and the update stops with a
   message that says why. The parent process downloads the asset to
   `meshcentral-data/serverupdates/` with a size limit equal to the pinned size (which must equal
   the asset size from the API) and an overall time limit of 15 minutes, compares its size and
   SHA-384 with the pin and its SHA-256 with the `digest` field that GitHub reports for the asset
   (`sha256:<hex>`). A missing pin, a missing or different digest, or a size or SHA-384 that differs
   from the pin aborts the update. It then reads `package/package.json` from the
   archive and refuses it unless the name is `meshcentral` and the version is the
   version of the release. Then it runs
   `npm install --save-exact --no-audit --ignore-scripts '<path to the verified .tgz>'` in the folder that
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
not a Windows service or a Docker image; otherwise update the installation by hand. The
server checks this at start (and the parent process again before it installs anything).
When it is blocked, the version dialog shows why, the update button and the check boxes are
off, the console command `serverupdate` answers `Server self-update not possible.`, and
`selfUpdate` does not restart the server. The reasons and their messages:

| Reason | Message |
|---|---|
| `windows-service` (a `daemon` folder next to `meshcentral.js`) | MeshCentral runs as a Windows service and cannot update itself. Update it by hand. |
| `container` (`MESHCENTRAL_CONTAINER=1`, set by the Docker images of this repository) | MeshCentral runs in a container. Update the container image to install a new version. |
| `not-package` (the code is not in a folder `node_modules/meshcentral`, for example a git clone) | MeshCentral is not installed as node_modules/meshcentral, so it cannot update itself. Update it by hand (see docs/fork-updates.md). |
| `not-writable` (`meshcentral-data/serverstate.txt` cannot be written) | The server cannot write to its data folder, so it cannot update itself. |

The reason is checked this strictly because `npm install <tarball>` in another layout
succeeds without replacing the running code, which would look like a successful update.

**Who may start an update.** Only a full administrator of the default domain, who is not
signed in with a login token, and only when the `myServer` settings of the domain allow the
upgrade (no `myServer` setting, `true`, or `upgrade: true`). The same rule applies to the
update button, the web socket command `serverupdate`, the console command `serverupdate` and the feature flag that enables the
button. Users with only the "Server Updates" right can still see the versions. A refused
request is answered with `{ action: 'serverupdate', result: 'error', code, message }`. The text is
"Only a full administrator of the default domain can start a server update.", for a login token
(also on a WebSocket, e.g. meshctrl) "Sign in with your password, not a login token, to start a server update.",
and for a domain whose `myServer` settings forbid the upgrade "Server updates are turned off for your account (My Server rights).".

The `print` command of the control socket (it writes text to the output of the server process, which the parent process reads) is only for a full
administrator of the default domain, and the parent process starts an update only when the server process ended with the exit code 200 that
the update uses; text alone, from anybody, cannot start one.

## Signed releases

The release owner signs every release with an ed25519 key that is not on GitHub. A server
that has the public key writes the pin of a signed release itself, so nobody has to log in to
the server to update it, and nobody who only controls the repository or its Actions can
make a server install anything.

**What is signed.** The owner builds the package locally, checks that the build is the same as the
draft that Actions made, and then signs a small manifest (`meshcentral-<version>.manifest.json`)
that names the repository, version, tag, channel (`stable` or `prerelease`), asset, size,
SHA-256, SHA-384 and commit of the package. The signature is made over the exact bytes of the
manifest file, and kept in `meshcentral-<version>.manifest.json.sig`. Both files are
uploaded to the draft release before it is published. Immutable releases then freeze them
together with the package.

**What the server checks** (in this order, any failure stops the update and installs nothing):

1. The manifest and the signature file are downloaded (each at most 16 KiB; their sizes and SHA-256
   come from the GitHub API too).
2. The signature file is read strictly (type, 1 to 4 signatures, each `ed25519` with a key id and a
   canonical base64 signature of 64 bytes). Only then the signatures are verified, over the raw bytes
   of the manifest, with the trusted public keys. One valid signature of a trusted key is enough.
   The manifest is parsed after that, never before.
3. The manifest must say exactly what GitHub says about the release: repository (case
   insensitive), version, tag, asset name, size and SHA-256 (the SHA-256 from the API is required), and
   it must have valid SHA-384, commit, channel and issue time. A manifest of another version or tag cannot be
   used for a release, and an old manifest cannot be attached to a new tag.
4. The release must be newer than the installed version. The automatic update (the nightly one and `selfUpdate: true`) and the
   "Stable Version" choice of the dialog take only a release that is stable by the **signed** manifest (`channel`) and has no prerelease flag on GitHub:
   removing the flag on GitHub cannot make a test release stable, and a pin by hand does not change that. The one exception is a pin by hand that
   has `"allowAutomatic": true` (written by you for that version). The same pin setting is needed when the release has **no** signed manifest at all (a release
   from before signatures, or one whose signature was removed): the flag of GitHub alone never makes a release stable for the automatic update. An administrator can still install a test release by naming it (`serverupdate <version>`)
   or with `selfUpdate: "<version>"`. An older version can be installed only with `selfUpdate: "<version>"` in the configuration.
5. The server writes the pin: size and SHA-384 from the manifest, `source: "signature"`, the key id
   and the SHA-256 of the manifest. Then the installation goes on as it always did (pin, size, SHA-256 of
   the API, inner `package.json`, `npm install --ignore-scripts`).

A signed release that is installed from the web interface asks for the same permission as before
(see above). The update is recorded in the server events (the `server` event type, action
`serverupdaterequest`, with the user, the version, the key id and whether it was automatic). A
release whose signature is wrong, revoked or does not match GitHub, or whose pin differs from the
signed manifest, is recorded as `serverupdateverify` and shown as a server warning.

**Release keys.** The public keys are in `serverupdate-keys.json` in the package (the
keys of the installed version) and optionally in `meshcentral-data/serverupdate-keys.json`
(needs access to the server files). Trusted keys are the keys of both files without every key id in
either `revoked` list.

```json
{
  "schemaVersion": 1,
  "keys": [ { "keyId": "0123456789abcdef", "algorithm": "ed25519", "publicKey": "<43 characters, base64url of the 32 byte key>", "comment": "primary" } ],
  "revoked": [ "fedcba9876543210" ]
}
```

`keyId` is the first 16 hex characters of the SHA-256 of the 32 raw bytes of the public key, and
the server checks it. A key list with anything wrong (bad JSON, a key id that does not match, more than 16 keys or 64
revoked ids, a file larger than 64 KiB, a symbolic link) switches the trust from signatures off with one error line and
a server warning; pins keep working. The list is read at every check. The list of the new package works
only after that package is installed.

A server without keys (the state of a version that has not got the keys of the owner yet) behaves as
before: only pins. The version dialog shows `no-keys`.

**Settings.** `serverUpdateTrust` is `signature` (the default) or `pin`. With `pin` the
server ignores signatures **and the pins that it wrote from signatures earlier**, and installs only versions with a pin written by hand
(the dialog says `pin` and shows no signature status). Any other value is logged and counts as `pin`.

**The audit comes first.** Before the server exits for an update it writes the event `serverupdaterequest` to the database and waits for it. When the event cannot be
saved (a database error, or no answer in 5 seconds) **no update is started**: the button, the console and `selfUpdate` show or log the reason, and the nightly update
tries again the next night. How an error is noticed depends on the database: with NeDB and MongoDB (single writes) a failing write reaches the server at once; with SQLite, PostgreSQL, MariaDB/MySQL
and MongoDB in bulk mode the error does not come back to the server, so there the limit of 5 seconds is what stops the update. If the database answers after the 5 seconds, the request is in the audit although the update was not started; the server then writes a second event `serverupdateverify`
(`audit timeout, update not started`) to say so. If the database is the problem, fix it first. In an emergency the update can still be done by hand, without the web interface:
check the package first: its SHA-384 must be the one of your own local build of that tag, or the package must verify against the signed manifest of the release
(`node tools/release/release-signing.js verify --manifest <manifest> --sig <sig> --keys serverupdate-keys.json --tgz <package> --version <v> --tag <tag> --commit <sha> --repository <owner/repo> --channel <stable|prerelease>`,
in the pinned Node Docker image on the owner's computer, prints the key id and exits with 0). Then put the pin of the version into `meshcentral-data/serverupdate-pins.json` (size and SHA-384 of that package), then install it as the user of the service,
in the folder that holds `node_modules`: `npm install --save-exact --no-audit --ignore-scripts <path of the package>` and restart the service.

**A pin from a signature counts only while its key is trusted.** Every use of such a pin (the button, the console, the nightly update,
`selfUpdate`, and the parent process before it installs) looks the key of the pin up in the key lists again; a pin whose key is revoked or no longer in the lists is
ignored, and reported as a `revoked` event. The keys are also read again after the manifest and the signature were downloaded and before
a pin is written, so a key that is revoked while a check runs does not get a pin. The parent process looks again after it downloaded the package and
before `npm install`; when the key was revoked meanwhile nothing is installed. The parent has no database, so it leaves a marker (`serverupdates/last-refusal.json`),
and the server turns it into the event `serverupdateverify` when it starts. A new signature of another key on the same package replaces the key in the pin.

**Pins written by hand always work** (a signature is not needed) and they win over a missing or wrong
signature, which is then reported. They lose only against a valid but different signed manifest: that is
a `conflict`, nothing is installed, and you decide which one is right.

### Rotating and losing keys

There are two keys from the start: a primary key and an offline backup. Only the owner makes
them (`tools/release/keygen.sh`, see below) and no tool or agent may be given a private key or its passphrase.

- Replace a key only for a reason (a lost medium, a changed computer, a doubt): add the new public key in a commit of its
  own, sign the next release with the old and the new key (`--append`), and remove the old key in the release after that,
  when the servers have got the first one. `release.sh` warns when the key that signs is not in the key list of the previous release,
  because servers on that version do not know it.
- A lost primary key: sign the next release with the backup key (the servers trust it), remove the primary key from the key list
  and add a new backup key. Add the lost key to `revoked` when the medium could be in other hands.
- A leaked key and passphrase: first secure the GitHub account (an attacker needs the key and the right to publish a release), then publish a release
  signed by the other key with the leaked key in `revoked` and a new backup key. Until servers have it, `selfUpdate` can be switched off
  or the key revoked on the server in `meshcentral-data/serverupdate-keys.json`; pins that came from that key stop counting at once, and you can also
  delete their entries (`source: "signature"`, that `keyId`) from `serverupdate-pins.json`. Look at the `serverupdaterequest` events that name that key id.
- Both keys lost: one release with new keys, installed by a pin written by hand on each server, like the move described below.

### Tools (owner only)

Everything that touches a key runs in Docker with the pinned Node image and no network; the passphrase is typed in the
terminal and passed through standard input, never as an argument, in the environment or in a file.

```sh
# once, outside of any git repository, two times (primary and backup); then commit the .pub.json entries to serverupdate-keys.json
tools/release/keygen.sh ~/release-keys primary
tools/release/keygen.sh ~/release-keys backup
# for a release, after the local build has the same hashes as the draft of the workflow (the folder is created with mode 700):
tools/release/sign-release.sh --key ~/release-keys/<keyId>.key.json --tgz release-out/meshcentral-<v>.tgz \
    --version <v> --tag <tag> --commit <40 hex commit> --out release-out/sign
# a second signature (two keys during a replacement); the manifest in that folder must be the one of this package:
tools/release/sign-release.sh --key <second key.json> --tgz release-out/meshcentral-<v>.tgz --version <v> --tag <tag> --commit <40 hex> \
    --append release-out/sign/meshcentral-<v>.manifest.json.sig
# then upload release-out/sign/meshcentral-<v>.manifest.json and .manifest.json.sig to the draft release (without --clobber), and publish
```

`keygen.sh` refuses to write inside a git repository (it also looks for a `.git` folder when git itself is not usable), warns when its folder is open to others,
and refuses a remote `DOCKER_HOST`. The key file is encrypted with the
passphrase (scrypt and AES-256-GCM); keep it and the passphrase apart, and keep the backup key offline. The passphrase is read with `IFS= read -r -s`
(leading and trailing spaces count) and a variable of the same name in your environment is removed first.

`sign-release.sh` signs only what it checked:
1. it computes size, SHA-256 and SHA-384 of the package, makes the manifest from them and from the values you gave (version, tag, commit, repository, channel) and signs
   exactly those bytes in the same process; nothing can be put in between. With `--append` the existing manifest must be byte for byte the manifest of this package and these
   values, and every signature in the file must be valid; otherwise it stops before the key is opened.
2. All of that is checked **before** it asks for the passphrase. It reads the key list **from the package** (`package/serverupdate-keys.json`, which is what the servers will trust
   after the update) and refuses when it is not the file of the commit. Then it shows the keys of the package and of the previous release tag of the fork (`*-custom.*`), and the
   difference since that tag in `serverupdate-keys.json`, `tools/release/`, `serverupdates.js`, `httpsdownloads.js`, `meshcentral.js`, `package.json` and `npm-shrinkwrap.json`, and **always** asks you to type `yes`.
   Compare the key ids with the ones `keygen.sh` printed when the keys were made: the key list is the root of trust that every release carries on.
3. After the signature it verifies the two files again: manifest against the package and the values, every signature, with the keys of the released
   commit (and, as information, with the keys of the previous release: servers on that version only know those).

The output folder must belong to you and be closed to others (mode 700). The release steps that upload and publish are described under [Making a release](#making-a-release-owner).

### Moving a server to the first signed version

A server that runs 1.3.1-custom.2 has no keys and an older update logic in its parent process.

1. The first version with keys (X) is released and signed as above.
2. On each server, once: add the pin of X to `meshcentral-data/serverupdate-pins.json` (from your local build), start the update from the web interface, and when it is done restart the service
   (`systemctl restart meshcentral` or the equivalent), so that the parent process runs the new code too.
3. The next version is installed from the web interface with the signature, and the parent process then loads the installing code of
   the running version freshly at every update.

A pin written by a signature is readable by 1.3.1-custom.2 too (it ignores the extra fields), so a server that was not restarted yet can still
install from it.

### Limits of this model

The signature proves that the owner released this package. It does not protect against a
stolen key together with the right to publish, against the owner's computer being compromised, or against a
key list that was changed on the server itself. There is no expiry date on a signature: a server cannot tell that it
is not told about new versions (a frozen release list). Look at the version dialog from time to time.
Test releases are signed with the same key, with the channel `prerelease`. The automatic update and the "Stable Version" choice never take them; the
dialog does not offer a field for them, so an administrator installs one with the console command `serverupdate <version>`, or with `selfUpdate: "<version>"`.

**Local write access is code execution.** A user who can write to the installation folder (the code, `node_modules`, `serverupdate-keys.json`) or to
`meshcentral-data` (the configuration, the local key list, the pins) can make the server run code, with or without a signature: the signature protects against
GitHub, the network and a wrong release, not against a local writer. The installation folder and `meshcentral-data` must belong to the user of the service, with no write access
for anybody else (and not for the parent folders), and the service user should be the only account that can change them.

## Local pins

The server installs only a package whose size and SHA-384 are pinned in `meshcentral-data/serverupdate-pins.json`
(the same idea as the size and SHA-384 pins of the agent files in `agents/agent-defaults.json`). A pin is written by a
signed release, or by hand. The digest that GitHub reports comes from the same release as the file, so it cannot be the
only check.

```json
{
  "schemaVersion": 1,
  "releases": [
    { "version": "1.3.1-custom.2", "size": 69029801, "sha384": "<96 lower case hex characters>" },
    { "version": "1.3.1-custom.3", "size": 69100000, "sha384": "<96 lower case hex characters>", "source": "signature", "keyId": "0123456789abcdef", "manifestSha256": "<64 hex>", "addedAt": "2026-11-21T03:00:00Z" }
  ]
}
```

- The first entry is a pin by hand, the second one was written by the server from a signed release. A pin by hand has no `source`. The
  server never removes or rewrites a pin by hand and keeps its other fields. Of the pins written from signatures it keeps the 20 newest
  versions (and at most 256 pins in all). The file is replaced atomically (mode 600).
- `version` is written like in the asset name, without `v`. `size` is in bytes. Several versions may be listed.
- Take the values of a pin by hand from a package you checked yourself, not from the release page alone: the output of
  `tools/release/build-server-tgz.sh` (the build is reproducible, so a local build of the tag gives the same
  file), or a download you verified another way, then `stat -c %s` and `sha384sum` of that file.
- The file is read for every update, no restart is needed. A missing file means no version is pinned. A
  file that is not valid (bad JSON, a hash that is not 96 lower case hex characters, a version listed twice)
  stops every update with a log line, and it is not a symbolic link.
- `selfUpdate` (the true form) skips a release that is not signed by a trusted key and has no pin with one log line, and keeps the server running; it does not
  restart for it. The Update button and `serverupdate` show the reason at once; they restart the server only for a release that is signed or pinned.
- Pins apply to the `github` source. Installing from the `npm` source is blocked, because a package
  from the npm registry has no local pin.

## Trust model

Read this before relying on automatic updates.

- The SHA-256 digest comes from the same GitHub account as the file. It protects against a
  damaged or truncated download and a faulty CDN. It does **not** prove who built the package.
  The pin is what ties an update to a package that somebody checked, and the signature is what
  ties it to the release owner.
- **Without a pin or a signature, whoever can create or change releases in the repository would run code on every
  server that follows it.** With a signature, that takes the key of the owner and its passphrase as well as the
  right to publish a release. A pin by hand is only as good as the check made before writing it. The package is installed by `npm`
  as the user the MeshCentral service runs as (often root) with `--ignore-scripts`, so no
  lifecycle script of the package or its dependencies runs, but its code runs when the server starts. A server with `selfUpdate: true` takes a new release
  within a day.
- A TLS-intercepting proxy (a company root certificate in the system or
  `NODE_EXTRA_CA_CERTS` store) or a wrongly issued certificate can replace both the API
  answer (with its digest) and the file. The digest gives no protection against that; the signature and the pin do.
- Dependencies are not part of the package, but the package carries `npm-shrinkwrap.json`
  (the lockfile of the repository, with the exact version and integrity hash of every
  dependency). `npm install` downloads exactly that tree from the npm registry, so the
  dependencies of a signed or pinned package are pinned too. Modules that the server installs at
  startup for optional features (database drivers, SMTP, syslog ...) are not part of it.
  A dependency fix arrives with a new release; until then an `overrides` entry in the
  `package.json` of the folder that holds `node_modules` still applies.
- The signed manifest also names the commit, but the server cannot check that the package was built from it: that is what the
  owner's local, reproducible build is for.

What to do: turn on two-factor authentication for every account with access to the
repository, keep the number of collaborators and the scope of tokens (fine-grained,
no `contents:write` for automation you do not need) minimal, and enable GitHub's
**immutable releases** for the repository, so that the assets of a published release can
no longer be replaced or deleted. Turn `selfUpdate` off on servers where an unreviewed update is not acceptable, and update them by hand.

## Settings (`settings` section of config.json)

| Setting | Default | Meaning |
| --- | --- | --- |
| `serverUpdateSource` | `"github"` | `"github"`: releases of `serverUpdateRepository`. `"npm"`: versions are read from the npm registry (`npm view meshcentral ...`) as upstream does, but **installing is blocked**: the Update button, `serverupdate` and `selfUpdate` log `Server update from serverUpdateSource "npm" is blocked ...` and the server keeps running on its version. The value is not case sensitive. Any other value logs an error and disables **all** server updates (checks, `selfUpdate`, the Update button); it never falls back to npm. |
| `serverUpdateTrust` | `"signature"` | `"signature"`: a release signed by a trusted key writes its own pin. `"pin"`: only pins written by hand count. Not case sensitive; another value is logged and counts as `"pin"`. See [Signed releases](#signed-releases). |
| `serverUpdateRepository` | `"kxd231/MeshCentral"` | `owner/repo` of a public GitHub repository. Strictly validated; an invalid value is logged once and disables the GitHub update checks. |
| `npmPath`, `npmProxy` | unchanged | `npmPath` is a command line run by the shell, as before (it may hold quotes, `node /path/npm-cli.js`, variables); it is used for both sources. `npmProxy` is also used for the GitHub requests. |
| `npmTag` | unset | Show only that tag (`latest`, `stable` or `prerelease`). |
| `selfUpdate` | `false` | `true`: update to the newest stable release after midnight, only when it is signed by a trusted key or pinned by hand. A version such as `"1.3.2"` (this one needs a pin or a signature too) updates to exactly that version at startup; it is compared as a version (`v1.3.1-custom.2` equals `1.3.1-custom.2`, `1.3.2.0` equals `1.3.2`) and is never reinstalled when it is already installed. A value that is not an exact version (`latest`, `stable`, `1.3.2-beta`, `1.3.1-custom`) is logged and treated as `false`. |

`runOnServerUpdated` and `cleanNpmCacheOnUpdate` work as before.

The install command quotes the package path and the proxy for the shell. Nothing from the GitHub API reaches it as text: the release tag must match the version pattern (digits, dots, `-custom.`, an optional leading `v`), the asset name must be exactly `meshcentral-<version>.tgz` built from that version, and the command only holds the local path `<data folder>/serverupdates/meshcentral-<version>.tgz`. On Linux and macOS a
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

The package is built by GitHub Actions from a tag, and a published release cannot be changed: the repository
has immutable releases on, and rulesets forbid force pushes to `custom` and moving or deleting tags.

```sh
# 1. package.json and npm-shrinkwrap.json hold the release version, <upstream base>-custom.<n>
#    (see Versioning); that commit is on the custom branch.
# 2. Tag it and push the tag. This starts .github/workflows/server-release.yml, which builds
#    meshcentral-<version>.tgz from the tag and puts it into a draft release. The run summary shows
#    commit, size, sha256 and sha384.
git tag 1.3.1-custom.3 <commit> && git push origin 1.3.1-custom.3
# 3. Build the same tag locally. The build is reproducible, so the hashes must be equal:
tools/release/build-server-tgz.sh --check-agents 1.3.1-custom.3 1.3.1-custom.3 ./release-out
#    -> checks the version, makes the translated and minified pages, packs, checks that translations are
#       in and agent binaries are not, runs agents/check-releases.js, prints size, sha256, sha384 and the
#       serverupdate-pins.json entry.
gh api repos/kxd231/MeshCentral/releases --jq '.[] | select(.tag_name=="1.3.1-custom.3") | .assets[] | [.name,.size,.digest]'
# 4. Sign the package of your local build (see Signed releases > Tools) and put the manifest and the signature on the draft.
#    Never use --clobber: if the files are there already, stop and find out why.
tools/release/sign-release.sh --key <key.json> --tgz release-out/meshcentral-1.3.1-custom.3.tgz --version 1.3.1-custom.3 \
    --tag 1.3.1-custom.3 --commit <40 hex commit> --out release-out/sign
gh release upload 1.3.1-custom.3 release-out/sign/meshcentral-1.3.1-custom.3.manifest.json release-out/sign/meshcentral-1.3.1-custom.3.manifest.json.sig --repo kxd231/MeshCentral
# 5. Write the notes and publish the draft. Publishing starts the Docker image builds.
gh release edit 1.3.1-custom.3 --repo kxd231/MeshCentral --notes-file notes.md --draft=false
# 6. Servers that have the key list install it from the web interface (or at night with selfUpdate). Others need the pins entry from step 3.
```

Sign only after the local build and the draft have the same size and hashes. If the workflow runs again for the draft after the signature was added,
the package of the draft changes and servers refuse the release (the SHA-256 in the manifest no longer fits), so check the digest of the draft again before you publish.

If the build in step 2 failed, fix the cause and start the workflow again for the same tag
(Actions, "Server release package", Run workflow, or `gh workflow run server-release.yml -f tag=<tag>`);
it replaces the package of a draft, never of a published release. A wrong tag cannot be moved: delete the
draft and use the next version number.

Use `--prerelease` (in `gh release edit`) for a test release: it appears only as the `prerelease` tag and is
never offered as `latest`. Publish a newer version instead of changing a published one. The package is about
70 MB; the server refuses assets above 256 MiB.

The release helper runs everything in Docker (pinned Node image, no Node on the host) from a
clean `git archive` of a commit or tag. It does not tag, push or publish anything. Like the
upstream npm package, the tgz carries the generated pages that git does not hold: it runs
`translate/translate.js minifyall` and `translateall` first (the tool packages
`html-minifier-terser`, `jsdom` and `esprima` are installed with `npm ci` from the lockfile in
`tools/release/translate-tools/`; that is the only step with network access, and the script fails
when the translation is incomplete) so that
`views/translations/`, `emails/translations/` and the `-min` pages and scripts are in the
package. A server updated from it keeps its translated UI and `minify` option.

The releases `1.3.1` and `1.3.1.1` have no asset and are ignored by servers. The first
release accepted by the new mechanism is `1.3.1-custom.1` (newer than `1.3.1`), or the asset can
be added to an existing release with `gh release upload`. A server running
an older build still checks npm, so the first move to the new mechanism is a manual install.
Put the file where later updates expect it first, because npm records the path:

```sh
mkdir -p meshcentral-data/serverupdates
cp meshcentral-1.3.1-custom.1.tgz meshcentral-data/serverupdates/
cd <folder that holds node_modules>
npm install --save-exact --no-audit --ignore-scripts ./meshcentral-data/serverupdates/meshcentral-1.3.1-custom.1.tgz
```

Restart the MeshCentral process or service afterwards.

## Switching back to npm

The server no longer installs from the npm registry (`"serverUpdateSource": "npm"` only shows
the versions there). To go back to the upstream package, install it by hand in the folder that
holds `node_modules` (`npm install --save-exact meshcentral@<version>`) and restart the service.
This replaces the fork's code with upstream's and overwrites the `file:` entry that GitHub
updates left for `meshcentral` in `package.json`.

## Related

[Web-RDP administration](webrdp.md)
