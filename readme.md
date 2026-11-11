# MeshCentral (kxd231 fork)

A fork of [MeshCentral](https://github.com/Ylianst/MeshCentral) by Ylian Saint-Hilaire and contributors.
MeshCentral is a self-hosted web site for remote management of computers: install the server,
create a device group, install the agent on each computer and control it from the browser (remote desktop,
terminal, files). This fork keeps all of that and changes the parts below.

This is not the official MeshCentral. Report problems of this fork in
[this repository](https://github.com/kxd231/MeshCentral/issues), not upstream.

## What is different

- **Web-RDP in JavaScript.** The RDP client is a new engine written in JavaScript,
  isolated per session, with NLA (CredSSP/NTLMv2), clipboard, resize and the graphics pipeline (RDPGFX):
  Progressive, RemoteFX, ClearCodec and H.264 (AVC420 / AVC444, decoded with WebCodecs and WebAssembly SIMD in a
  worker). It replaces node-rdpjs. See [docs/webrdp.md](docs/webrdp.md).
- **Faster MeshAgent remote desktop (KVM).** Ordered drawing in the browser, optional flow control for shared
  sessions, frame rates up to 60 frames/s, a bandwidth limit chosen by the viewer and an FPS / bandwidth readout.
  See [docs/kvm.md](docs/kvm.md).
- **Windows x64 agent with DXGI capture.** The default `MeshService64.exe` comes from the
  [dxgi release of kxd231/MeshAgent](https://github.com/kxd231/MeshAgent/releases/tag/dxgi): DXGI Desktop
  Duplication, TurboJPEG, quality that adapts to motion and to the bandwidth limit. All other agents are the
  upstream ones.
- **Updates from this repository.** The server's Update button installs releases of this fork from GitHub
  (verified by digest), not the upstream npm package. See [docs/fork-updates.md](docs/fork-updates.md).


## Installing and updating

Download `meshcentral-<version>.tgz` from the [releases](https://github.com/kxd231/MeshCentral/releases) and install
it in the folder that holds (or will hold) `node_modules`:

```sh
npm install --save-exact --no-audit ./meshcentral-1.3.1-custom.1.tgz
node node_modules/meshcentral
```

A server that runs the upstream npm package still updates from npm; install the fork once by hand as above, after
that the Update button and `selfUpdate` take the fork's releases. To go back to the upstream npm releases set
`"serverUpdateSource": "npm"` in the `settings` section of `config.json`.

Configuration, databases, TLS, reverse proxies, users and everything else not listed above work as in upstream; the
[upstream documentation](https://ylianst.github.io/MeshCentral/) applies.

## License

Apache License 2.0, like upstream; see [LICENSE](LICENSE). MeshCentral is © Ylian Saint-Hilaire and contributors.
