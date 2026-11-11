<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote desktop (KVM) in this fork

The MeshAgent remote desktop (Desktop tab, "Connect") works as in upstream MeshCentral, with these additions:
a faster Windows agent, more frame rates, a bandwidth limit chosen by the viewer, an optional frame-rate readout,
and flow control for shared sessions on the server. The Web-RDP client is described separately in
[webrdp.md](webrdp.md).

## Desktop settings (viewer)

Open the settings with the gear button of the Desktop tab. They are remembered per user and apply to the next
frames immediately; the mobile interface has the same lists.

| Setting | Values | Notes |
|---|---|---|
| Frame rate | Very fast (16 ms, about 60 frames/s), Fast (20 ms), Medium (50 ms, default), Slow (100 ms) | The fastest rate needs an agent that accepts intervals below 20 ms (the Windows x64 agent of this fork). Older agents run at 20 ms instead. A saved rate that is no longer in the list (400 or 1000 ms) becomes Slow. |
| Bandwidth limit | No limit (default), 20, 10, 6, 4, 2, 1 Mbit/s | Upper limit for the picture data the agent sends. Supported by the Windows x64 agent of this fork; other agents ignore it. It does not apply to PNG. |
| Encoding | JPEG (default), PNG (lossless) | Agents have no WebP encoder and browsers do not decode TIFF, so those choices were removed; a saved WebP or TIFF setting becomes JPEG. |
| Quality, Scaling | as in upstream | |

Choosing a limit: about 10-20 Mbit/s on a local network, 2-6 Mbit/s over a VPN or a slow uplink, 1 Mbit/s for very
slow links. Under the limit the agent lowers the JPEG quality of moving areas first, then the motion frame rate, and
finally sends the picture at 75 % scale while the screen keeps changing; still areas are sharpened again afterwards.

The **FPS / bandwidth** option in the Tools panel of the Desktop tab (off by default, remembered in the browser)
shows the frames drawn per second and the data received per second, averaged over the last two seconds, in the
session footer.

## Windows agent of the fork

The default Windows x64 agent (`MeshService64.exe`) comes from the `dxgi` release of
[kxd231/MeshAgent](https://github.com/kxd231/MeshAgent/releases/tag/dxgi) (pinned with size and SHA-384 in
`agents/agent-defaults.json`); all other agent files are the upstream ones. Windows x64 agents connected to the
server update to it like to any new default agent. Compared with the upstream agent it:

- captures the screen with DXGI Desktop Duplication and encodes only the changed areas, with GDI as automatic
  fallback (Windows 7, several monitors in one picture, rotated screens, errors);
- removes the software cursor that some virtual machines draw into the captured image;
- encodes tiles with libjpeg-turbo, adapts the JPEG quality to motion and congestion and sharpens still areas;
- honours the viewer's bandwidth limit and frame intervals down to 10 ms.

Switches in the environment of the agent service (registry
`HKLM\SYSTEM\CurrentControlSet\Services\<service name>\Environment`, `REG_MULTI_SZ`, `NAME=value` per line,
then restart the service):

| Variable | Effect |
|---|---|
| `MESH_KVM_FORCE_GDI=1` | Capture with GDI instead of DXGI. |
| `MESH_KVM_ADAPT=0` | Turn off the adaptive quality, the bandwidth limit and the motion frame limit. |
| `MESH_KVM_BUDGET_KBPS=<kbit/s>` | Bandwidth limit when the viewer sets none (the viewer's choice wins). |
| `MESH_KVM_STATS_LOG=1` | Write the diagnostic log `<agent exe name>-kvm.log` next to the agent (at most 1 MB). Off by default. |

Technical details and measurements: `meshcore/KVM/Windows/README-kvm-perf.md` in the agent repository.

## Server settings

| Setting (`settings` section of `config.json`) | Default | Effect |
|---|---|---|
| `desktopMultiplex` | `false` | Upstream option: one agent stream shared by all viewers of a device, so a slow browser does not slow down the others. |
| `desktopMultiplexAck` | `true` | Only with `desktopMultiplex`. Browsers that support it acknowledge painted frames; the server then keeps a bounded window of unacknowledged image data per browser (between `minWindow` and `maxWindow`, adapted to the measured rate and round trip). `false` turns the offer off; the browsers then work as without it. |

With `desktopMultiplex` on and several viewers on one device, the agent gets one set of settings: the best quality,
the largest scaling and the shortest frame interval among the viewers, and the **lowest** bandwidth limit any of
them chose (viewers that set no limit do not count). When that viewer leaves, the limit of the others applies
again.
