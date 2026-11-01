# Web-RDP

Web-RDP lets users open a Remote Desktop session to a device from the MeshCentral web interface. The RDP protocol itself is handled by a small native helper, `meshfreerdp`, built on top of [FreeRDP](https://www.freerdp.com/) 3. MeshCentral (`freerdpclient.js`) starts the helper as a child process and exchanges framed messages with it; the protocol is described in `freerdp/PROTOCOL.md`.

**If the helper is not available, Web-RDP is disabled.** The rest of MeshCentral is not affected.

## Requirements

* FreeRDP 3 (version 3.x), including the client library and WinPR.
* libjpeg-turbo with the TurboJPEG API (`libturbojpeg`).
* CMake, a C compiler and `pkg-config` to build the helper.

Linux is currently the supported platform.

### Installing the dependencies

Arch Linux:

```
pacman -S freerdp libjpeg-turbo cmake
```

Debian / Ubuntu (needs a release that ships FreeRDP 3, for example Debian 13 (trixie)):

```
apt install freerdp3-dev libturbojpeg0-dev zlib1g-dev cmake build-essential pkg-config
```

Alpine:

```
apk add freerdp-dev libjpeg-turbo-dev cmake build-base pkgconf
```

At runtime only the shared libraries are needed. On Debian/Ubuntu these are `libfreerdp3-3 libfreerdp-client3-3 libwinpr3-3 libturbojpeg0`, on Alpine `freerdp-libs libturbojpeg`.

H.264 support comes from the FreeRDP build (FFmpeg or OpenH264). If FreeRDP has no H.264 decoder, the helper falls back to GFX without H.264.

## Building the helper

From the MeshCentral directory (the one containing `freerdpclient.js`):

```
cmake -B freerdp/build freerdp
cmake --build freerdp/build
```

This produces `freerdp/build/meshfreerdp`. Restart MeshCentral after building it.

## Locating the helper

MeshCentral looks for the helper in this order:

1. The path set in `settings.freerdpPath` in `config.json`.
2. `freerdp/build/meshfreerdp` relative to the MeshCentral directory.
3. `meshfreerdp` in the `PATH`.

To use a custom location, set it in `config.json`:

```json
{
  "settings": {
    "freerdpPath": "/usr/local/bin/meshfreerdp"
  }
}
```

## Session settings

The RDP tab of the desktop settings dialog offers:

* **Graphics**: `GFX + H.264` (default), `GFX` (RemoteFX/progressive, sharper text, more bandwidth on motion) or `Legacy (GDI)` for servers that have trouble with the graphics pipeline.
* **Image Quality**: JPEG quality of the tiles sent from the MeshCentral server to the browser (High 90, Medium 75, Low 50).
* **Color Depth (Legacy)**: 15/16/24/32 bit, used only in Legacy mode. GFX always uses 32 bit.
* The performance options (wallpaper, theming, font smoothing, ...) are sent as RDP performance flags.

## Linux targets

RDP Connect on the Desktop tab is offered for every agent type, so Linux devices running xrdp or GNOME Remote Desktop
can be reached the same way as Windows. The RDP port of a device is set with *Alternate Port* in the context menu of
its Web-RDP link.
GNOME Remote Desktop accepts only clients that use the graphics pipeline, so choose `GFX` or `GFX + H.264`; with
`Legacy` GNOME ends the connection during capability exchange. Its Remote Login mode (port 3389) uses the credentials
configured for Remote Login in GNOME Settings, not the Linux account.

## Troubleshooting

Set `"debug": "relay"` in the `settings` section of `config.json`. FreeRDP warnings and errors from the helper then show up in the server log prefixed with `RDP: meshfreerdp:`, followed by `RDP: freerdpclient: helper exited, code=..., signal=...` when the session ends.

## Docker

The official `docker/Dockerfile` and `docker/Dockerfile-debian` build the helper in a separate build stage and install it as `freerdp/build/meshfreerdp` inside the MeshCentral directory of the image, together with the required runtime libraries. No extra configuration is needed.

To build and run an image from this source tree, see `docker/compose.new.yaml` and the "Web-RDP with FreeRDP" section of `docker/README.md`.
