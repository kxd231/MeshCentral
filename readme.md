# MeshCentral (kxd231 fork)

A fork of [MeshCentral](https://github.com/Ylianst/MeshCentral) by Ylian Saint-Hilaire and contributors.
MeshCentral is a self-hosted web site for remote management of computers: install the server,
create a device group, install the agent on each computer and control it from the browser (remote desktop,
terminal, files). This fork keeps all of that and changes the parts below.

This is not the official MeshCentral. Report problems of this fork in
[this repository](https://github.com/kxd231/MeshCentral/issues), not upstream.

## What is different

### Remote desktop with H.264 video (optional)

The remote desktop of the MeshAgent (Desktop tab, "Connect") can send moving content as video. Each user turns it on
for themselves in the desktop settings (gear button): **Encoding: H.264 (video)**.

- The parts of the screen that move (a video, scrolling, a window being dragged) arrive as video, like in a video
  call, and everything else stays sharp JPEG. When the movement stops, the moved areas are sent once more as JPEG, so
  text never stays blurry. The aim is smooth motion on slow links at the same or lower bandwidth.
- It needs the Windows x64 agent of this fork (below) and a browser that can decode H.264 (Chrome, Edge and other
  browsers that pass the built-in check; the option is hidden where it cannot work). JPEG stays the default, and
  nothing changes for users who keep it.
- Video is used while one person is watching the device. When a second viewer connects, everybody gets JPEG, and
  video comes back when that viewer leaves.
- If anything goes wrong (an older agent, the agent cannot encode, the browser cannot decode or keep up) the session
  continues in JPEG and the footer of the session says why.
- Recorded sessions keep the video, which is meant to make recordings of moving content smaller. The session player plays them
  like a live session, seeking included.
- An administrator can hide the option for everybody with `"desktop": { "h264": false }` in the domain section of
  `config.json`.

### Auto frame rate

The frame rate list of the desktop settings has an **Auto** entry next to High (60 frames per second), Medium (30),
Low (20) and Slow (10). With H.264 the agent picks the rate by itself, from how well the computer and the network keep
up: down quickly when the processor or the link is the limit, up again carefully. With JPEG or an older agent the
browser picks the rate from what it receives.

### A faster remote desktop in general

Pictures are drawn in order in the browser, frame rates go up to 60 frames per second, each user can set a bandwidth
limit (from 1 to 20 Mbit/s) and turn on a small readout of frames per second and data used. Shared sessions get flow
control on the server. Details: [docs/kvm.md](docs/kvm.md).

### Windows x64 agent of this fork

The default `MeshService64.exe` comes from the [h264-v1 release of kxd231/MeshAgent](https://github.com/kxd231/MeshAgent/releases/tag/h264-v1).
Computers that run the Windows x64 agent update to it like to any new default agent. Compared with the upstream
agent it:

- asks Windows which parts of the screen changed and sends only those, with the classic capture as automatic fallback;
- compresses with libjpeg-turbo, lowers the quality of moving areas and sharpens them again when they stop;
- respects the bandwidth limit of the viewer;
- encodes H.264 on the graphics card when a short self test shows that the card's encoder works, and in software
  otherwise. Tested on AMD and NVIDIA graphics; Intel graphics have not been tested yet.

All other agents (Linux, macOS, 32-bit and ARM Windows) are the upstream ones. More about the agent: its
[readme](https://github.com/kxd231/MeshAgent#readme).

### A size limit for session recordings

`"sessionRecording": { "maxSessionRecordingSizeMegabytes": 500 }` in the domain section of `config.json` limits the
size of one recording (no limit by default). At 80 % and 95 % every viewer of the session sees how many megabytes
are left; at the limit the recording is closed properly, the session ends with a message and connecting again starts
a new session with a new recording. This keeps one busy session from filling the disk of the server. It is a
different setting from `maxRecordingSizeMegabytes`, which deletes old recordings.

### Web-RDP in JavaScript

The RDP client is a new engine written in JavaScript, isolated per session, with NLA (CredSSP/NTLMv2), clipboard,
resize and the graphics pipeline (RDPGFX): Progressive, RemoteFX, ClearCodec and H.264 (AVC420 / AVC444, decoded with
WebCodecs and WebAssembly SIMD in a worker). It replaces node-rdpjs. See [docs/webrdp.md](docs/webrdp.md).

### Server updates from the web interface, signed

The server updates itself from the releases of this repository, not from the upstream npm package.

- The version dialog of the web interface (My Server) shows when a new version is out; a full administrator starts
  the update with one click. With `"selfUpdate": true` in the `settings` section of `config.json` the server does it
  by itself after midnight.
- Every release is signed with a key of the fork's owner that is never stored on GitHub. Before it installs anything
  the server checks that signature and the size and hashes of the package. Somebody who took over the GitHub
  repository or its build system still could not make a server install a package of their own.
- A failed update installs nothing; the server keeps running on its current version and says why.
- Where the server cannot update itself (as a Windows service, in a Docker container, from a git clone) the version
  dialog says so. Containers are updated by pulling the new image.

Details, including the trust model and how releases are made: [docs/fork-updates.md](docs/fork-updates.md).

## Installing

Download `meshcentral-<version>.tgz` from the [releases](https://github.com/kxd231/MeshCentral/releases) and install
it in the folder that holds (or will hold) `node_modules`. Node.js 22.21.1 or newer is needed, as in upstream:

```sh
npm install --save-exact --no-audit ./meshcentral-1.3.1-custom.4.tgz
node node_modules/meshcentral
```

Docker images are built with every release: `ghcr.io/kxd231/meshcentral`.

Configuration, databases, TLS, reverse proxies, users and everything else not listed above work as in upstream; the
[upstream documentation](https://ylianst.github.io/MeshCentral/) applies.

## Updating

- **From 1.3.1-custom.3 on:** the Update button in the web interface, or `selfUpdate`, as described above.
- **Node.js first:** 1.3.1-custom.4 and newer need Node.js 22.21.1 or newer (the upstream requirement). 1.3.1-custom.3
  and older do not check this before an update: on an older Node.js they install the new version and it does not
  start. Update Node.js before the server. From 1.3.1-custom.4 on the update is refused with a message instead.
- **From 1.3.1-custom.2 or older, once:** these versions do not know the signing key yet. Add the pin of the new
  version to `meshcentral-data/serverupdate-pins.json` (the release notes show it; your own build of the tag with
  `tools/release/build-server-tgz.sh` prints the same), start the update in the web interface and restart the service
  when it is done. Later versions need nothing by hand.
- **From the upstream npm package:** install the fork once by hand as above.
- **Back to upstream:** install the upstream package by hand (`npm install --save-exact meshcentral@<version>`) and
  restart the service. The fork does not install npm packages by itself.

## License

Apache License 2.0, like upstream; see [LICENSE](LICENSE). MeshCentral is © Ylian Saint-Hilaire and contributors.
