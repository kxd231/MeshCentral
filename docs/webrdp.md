<!-- SPDX-License-Identifier: Apache-2.0 -->

# Web-RDP administration

MeshCentral provides Remote Desktop in the browser using its JavaScript RDP engine.
The RDP tab in both desktop UIs and the standalone `mstsc.html` page use the same
engine. No FreeRDP executable, guacd, native helper or browser extension is required.
The former node-rdpjs engine and its browser client have been removed. An existing
`settings.webRdp.engine` setting is accepted but ignored; `"legacy"` produces one
startup warning. Remove the setting when upgrading. The graphics value `legacy`
now means **Classic bitmaps** within the JavaScript engine. Update any custom
templates or theme overrides that loaded `mstsc/*` or checked `webrdpengine`
to match the current templates.

The MeshAgent remote desktop (KVM) changes of this fork are described in [kvm.md](kvm.md).

## Requirements and access

- Node.js 20 or newer, as required by MeshCentral. Use a supported Node release
  with its permission model available for process isolation.
- An RDP server offering TLS 1.2 or newer, or Network Level Authentication (NLA/CredSSP) over TLS 1.2 or newer.
  Standard RDP Security (RC4) is unsupported. Enable Remote Desktop and allow
  the target account to log on remotely. xrdp 0.10 and FreeRDP shadow are test targets.
- An online MeshAgent with access to the target RDP port (normally TCP 3389),
  or the existing MeshCentral supported local/gateway relay route. The RDP service
  need not be exposed to the Internet. Set the device RDP port in its settings.
- A modern browser with WebSocket, Canvas and Web Worker support. HTTPS is
  recommended and is required for browser features such as WebCodecs H.264 and
  clipboard APIs. H.264 is optional; the client probes decoder availability and
  speed before requesting it. Browser/OS codec support varies.
- Remote control permission on the device, and relay permission where required.
  View-only and limited-input restrictions are enforced on the server. The
  domain `mstsc: false` setting disables Web-RDP. Credential storage follows the
  domain `allowSavingDeviceCredentials` policy.

Sign into MeshCentral, open a device and its RDP desktop, or use **RDP Connect**
to open the standalone page. Supply the target account's username, password and,
when needed, domain. These are distinct from your MeshCentral login. Credentials
may be saved only when the domain permits it. Browser clipboard permissions and
focus can affect copy/paste; the protocol supports text clipboard data, not files.

## How it works

The browser connects to the authenticated `mstscrelay.ashx` WebSocket. MeshCentral
checks the session, origin, device rights and capacity before starting the RDP
engine. The agent or gateway transports the RDP byte stream to the selected target.
RDP TLS and CredSSP terminate in the engine on the MeshCentral server. This is
not an end-to-end encrypted connection from the browser to the RDP target:
MeshCentral and its administrators are trusted with session contents and credentials.

Each session runs in a separate Node process by default. It parses RDP and
validates graphics operations, then sends bounded messages through IPC to the main
process and browser. A browser worker decodes graphics and renders through Canvas
or OffscreenCanvas where available. H.264 uses the browser's WebCodecs decoder.
There is no server-side video transcoder.

The graphics pipeline negotiates RDPGFX with the target and browser capabilities.
Implemented decoders include Progressive, RemoteFX, ClearCodec, raw graphics,
H.264 AVC420 and H.264 AVC444 / AVC444v2. The server selects the formats; enabling GFX
does not guarantee H.264, and target codec support differs. Windows 10 and 11 send
H.264 only when the client offers the RDPGFX 10.4 capability set with
`AVC_THINCLIENT` (the server does this whenever the browser's H.264 and AVC444 probes pass
and `h264` is not disabled); they then send AVC444v2, in practice only the luma view
(4:2:0), which is lossy. Without it they send lossless Progressive and ClearCodec.
Servers that send the AVC444 chroma view (FreeRDP shadow, Windows with the "Prioritize
H.264/AVC 444" policy) are decoded as full YUV444.
Classic bitmap updates support raw, interleaved RLE and planar compression.
Developer mode can additionally negotiate RemoteFX Surface Commands.

The **Graphics** option (both UIs and the standalone page, remembered in that browser)
has three choices. **Auto** (default) uses GFX with H.264 when the browser's decoder works
and the server allows it, otherwise lossless GFX. **Lossless** uses GFX without H.264
(Progressive / ClearCodec): exact pixels and text, more bandwidth, fewer frames on Windows.
**Classic bitmaps** uses plain bitmap updates. If a session that negotiated AVC444 fails
before its first picture, the browser reconnects once without AVC444 (GFX with Progressive on
Windows) and remembers the failure for 12 hours in this browser, so that following
connects do not offer AVC444; a second failure follows the rule below.

The normal **Auto** graphics choice tries GFX. If a graphics-specific failure occurs
before the first picture, the browser reconnects once with classic bitmaps and
shows **Simplified graphics (classic bitmaps)** with the original error code.
Authentication, certificate and network errors do not trigger this fallback.
After the first picture, a graphics failure offers **Reconnect with classic bitmaps**;
the user initiates that reconnect. Each reconnect is a new authenticated session,
with the same trust and admission checks. **Classic bitmaps** can also be selected
in RDP options (both UIs) or on the standalone page and is remembered in that browser.
It can be slower, especially on targets with a slow bitmap encoder. A target that
requires GFX may refuse this choice.

### H.264 picture quality on Windows targets (optional)

By default Windows sends H.264 with half-resolution colour (4:2:0), so coloured text
looks soft. The target's administrator can request full colour (AVC444) and a higher
image quality. These are Windows Remote Desktop policies on the target, not MeshCentral
settings. Set them with Group Policy (Computer Configuration → Administrative Templates →
Windows Components → Remote Desktop Services → Remote Desktop Session Host → Remote
Session Environment), or directly as `REG_DWORD` values under
`HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services`:

| Value | Policy | Effect |
|---|---|---|
| `AVC444ModePreferred` = 1 | Prioritize H.264/AVC 444 graphics mode | full-colour H.264; sharper coloured text |
| `ImageQuality` = 1–4 | Configure image quality for RemoteFX Adaptive Graphics | 1 Lossless, 2 High, 3 Medium (default when absent), 4 Low |
| `AVCHardwareEncodePreferred` = 1 | Configure H.264/AVC hardware encoding | uses the target's GPU encoder when available |

PowerShell as administrator on the target (or MeshCentral Run Commands as SYSTEM):

```powershell
$k = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty $k AVC444ModePreferred 1 -Type DWord
Set-ItemProperty $k ImageQuality 2 -Type DWord      # optional: 2 = High
# revert: Remove-ItemProperty $k AVC444ModePreferred,ImageQuality,AVCHardwareEncodePreferred
```

Notes:
- **When it applies.** Changes apply to new RDP sessions. If nothing changes, run `gpupdate /force`, or restart the `TermService` service; restarting it disconnects RDP sessions.
- **Domain GPO.** A domain Group Policy that sets these values overrides local values at the next refresh.
- **Bandwidth.** Expect more traffic: in a test on Windows 10, AVC444 with High quality used about twice the bandwidth of the default and looked visibly better.
- **Unconfirmed on Windows 11.** In a test on Windows 11 the policy showed no effect; the cause has not been investigated.
- **Choosing a level.** Medium quality with AVC444 is a middle ground. The browser's **Lossless** option avoids H.264 entirely.
- **Browser side.** The browser decodes AVC444 with WebAssembly SIMD kernels when available, so the client-side cost is small.

## Configuration

Put Web-RDP settings under `settings.webRdp` in `meshcentral-data/config.json`
and restart MeshCentral. Configuration keys are normalized to lowercase internally;
use the spelling below in your configuration. There is no `freerdpPath` setting.

```json
{
  "settings": {
    "webRdp": {
      "gfx": "on",
      "displayControl": true,
      "displayControlEvenHeight": false,
      "maxSessions": 32,
      "maxSessionsPerUser": 8,
      "maxEngineMemoryMb": 2048,
      "requireNla": true,
      "isolation": "process"
    }
  }
}
```

The example chooses a 2048 MiB admission budget and requires NLA; these two values
are examples, not the defaults. Requiring NLA refuses a TLS-only xrdp setup.

| Setting | Default | Meaning |
|---|---|---|
| `gfx` | `"on"` | `"on"` allows GFX, browser H.264 probing and the automatic fallback above. `"off"` forces classic bitmaps even if the browser requests GFX. `"dev"` enables GFX plus experimental RemoteFX Surface Commands, `window.__rdpStats` and standalone `?gfx=legacy\|gfx\|h264` / `?rfx=` developer controls; automatic fallback is disabled. |
| `h264` | `true` | `false` never offers an AVC (H.264) capability set, whatever the browser reports, and turns the browser's Auto into lossless GFX. Any other value keeps H.264 allowed. |
| `displayControl` | `true` | Request desktop resize through Display Control when supported by the target. With `false`, the browser scales the image; it sends no Display Control resize requests. GFX may still use dynamic virtual channels. |
| `displayControlEvenHeight` | `false` | Compatibility option: round Display Control height down to an even number. Width is always even as required by the protocol. |
| `maxSessions` | `32` | Simultaneous sessions per MeshCentral process, integer 1–1000. Slots remain held until their engines exit. |
| `maxSessionsPerUser` | `8` | Simultaneous sessions of one user, integer 1–1000, clamped to `maxSessions`. |
| `maxEngineMemoryMb` | Half of total host memory (or of the process/cgroup limit when lower), minimum 128 MiB | Total admission budget for live engines, integer 128–1048576 MiB. Uses the smaller of host RAM and the process/cgroup memory limit when Node reports one. Each new engine reserves 128 MiB, replaced by its larger measured usage. This budget does not include all MeshCentral/browser memory and is not an OS memory limit. |
| `requireNla` | `false` | `true` requires CredSSP and refuses TLS-only negotiation before sending credentials. `false` permits TLS unless sticky NLA already requires CredSSP for the target. |
| `isolation` | `"process"` | One Node child process per session. `"thread"` uses a worker thread in the MeshCentral process; see security limitations below. |
| `engine` | Ignored | Obsolete compatibility key. All values are ignored. `"legacy"` logs one warning at startup; remove it. |

`gfx` strings are case-insensitive; unset, `null` or `true` means `"on"`, and
`false` means `"off"`. Other values fail closed to `"off"` with one warning per
server process. Invalid integer/isolation settings use their defaults. Only the
boolean `true` enables `requireNla`/`displayControlEvenHeight`; only boolean
`false` disables `displayControl`. Isolation strings are case-sensitive.
The JSON schema documents the accepted configuration; the runtime also tolerates
old/invalid settings for compatibility, as described above.

## Certificate trust and sticky NLA

Web-RDP uses **trust on first use (TOFU)**, stored in the MeshCentral database
per device, target and effective TCP port. `self/3389` identifies that device's
own RDP address on port 3389. A user-selected address through an agent has a
separate key, such as `addr:rdp.example.internal/3389` (normalized to lowercase).
Pins never live in localStorage and are shared by both UIs and the standalone page.

After the first successful session, MeshCentral pins the RDP server certificate's
SHA-256 fingerprint. If CredSSP succeeded, it also remembers that NLA was seen.
Subsequent sessions compare the certificate just after TLS negotiation, before
sending credentials. A changed certificate fails with `RDP_ERROR_CERT_CHANGED`
and displays the pinned and presented fingerprints. If NLA was previously seen,
a TLS-only selection fails earlier with `RDP_ERROR_NLA_DOWNGRADE`, even with
`requireNla: false`. Accepting a rotated certificate preserves this NLA requirement.

TOFU compares certificate fingerprints rather than validating a public CA chain or hostname; self-signed certificates are supported. TOFU does not authenticate an unpinned first connection. Establish the initial
pin over a trusted network and verify fingerprints independently. On a certificate
change, compare the new fingerprint through a separate trusted channel before
accepting it. A damaged trust record fails closed and requires an administrative
reset. Back up the database: losing trust records creates a new first-use boundary.

Users with device editing permission (`Manage computers`, the same right as
`changedevice`) can inspect **Web-RDP trust** on the device's General page, accept
a presented new certificate or reset trust. Acceptance and reset are audited as
`webrdptrust` node events. Other users can see the refusal and ask a device
administrator; the standalone page has no acceptance control. Return to the main
UI to manage trust.

The authenticated `control.ashx` protocol exposes the same administrative actions:

```json
{"action":"webrdptrust","op":"list","nodeid":"node//DEVICE_ID","responseid":1}
{"action":"webrdptrust","op":"accept","nodeid":"node//DEVICE_ID","key":"self/3389","fingerprint256":"AA:BB:...:FF","responseid":2}
{"action":"webrdptrust","op":"reset","nodeid":"node//DEVICE_ID","key":"self/3389","responseid":3}
{"action":"webrdptrust","op":"reset","nodeid":"node//DEVICE_ID","all":true,"responseid":4}
```

Replace `DEVICE_ID` and the abbreviated fingerprint (a real value has 32
uppercase colon-separated bytes). Replies include `action`, `op`, `nodeid`,
`result` and the supplied `responseid`; `list` also returns `entries` and a
`corrupt` indication. Only the certificate most recently presented by a refused
session can be accepted. If it changed again, reconnect to inspect the current one.
**Reset clears both the pin and sticky NLA**, reopening first-use trust; it does
not override global `requireNla`. Disconnect affected sessions before resetting.

NeDB and MongoDB use conditional versioned updates to protect concurrent trust
changes across servers. SQL/AceBase use rereads, verification and best-effort
monotone repair; a delayed competing write can still roll back state there.
Avoid simultaneous trust changes on multiple MeshCentral instances with these
backends. A detected first-pin race can end with `RDP_ERROR_TRUST_RACE`:
credentials may already have reached that session's endpoint, so investigate
before retrying. Pins are not a substitute for network isolation or authenticated
RDP endpoints.

## Limits and deployment

In addition to configured admission limits, a user may launch at most 10 engines
per rolling minute, including reconnects and fallback attempts. These limits are
per MeshCentral process, not a cluster-wide quota. Admission refusals use
`RDP_ERROR_TOO_MANY_SESSIONS`; server logs identify total, per-user, launch-rate
or memory limits, with at most one log line per reason per minute.

Fixed limits include a 96 MiB V8 old-generation heap, a 96 MiB tracked engine
allocation budget and a 320 MiB engine RSS ceiling. In thread mode RSS is shared
with MeshCentral; the process boundary and independent RSS containment are lost.
The main process has a 512 MiB global queued-data budget; when exhausted it evicts
the largest queued session. Per-session byte windows apply backpressure instead
of dropping dependent graphics operations. A stalled browser is eventually closed
and its engine slot released. Deadlines grow with bytes in flight for slow links.

Desktop dimensions are bounded to 200–8192 pixels per axis, width even. Clipboard
text is limited to 4 MiB UTF-16LE including its terminator; typed text to 65536
UTF-16 units. Credentials, working directory and alternate shell fields are limited
to 255 UTF-16 units and are rejected rather than truncated. Resize requests are
paced and fitted to target limits (one outstanding, at least 500 ms apart, at most
six per minute). Trust storage allows 16 own-address ports and 32 selected-address
keys per device, including reset tombstones; deleting the device removes them.

Budget for browser memory as well as server engines: extreme allowed surfaces,
codec state and buffers can approach 1.3 GiB per tab. `maxEngineMemoryMb` governs
server admission only. Use container/OS memory and CPU limits appropriate for
your workload, leave headroom for MeshCentral and its database, and monitor RSS.
The production Dockerfiles need only Node for Web-RDP.
Ensure reverse proxies pass WebSocket upgrades and allow long-lived sessions.

## Troubleshooting

Record the error code, phase, hint and symbolic detail, the target type, selected
graphics option and browser version. Do not include passwords, login cookies or
clipboard contents in diagnostics. Relay debug logging (`settings.debug` including
`relay`) gives engine/isolation information; disable it again when finished.

| Error code(s) | Check or action |
|---|---|
| `RDP_ERROR_RELAY_FAILED` | Agent is online, device/relay permissions and server-to-agent route. |
| `RDP_ERROR_CONNECT_FAILED` | RDP service, device port, target firewall and reachability from the agent. |
| `RDP_ERROR_CONNECTION_LOST`, `RDP_ERROR_TIMEOUT` | Target, agent and proxy connectivity; suspend/resume and timeouts. TLS-only xrdp can close after RDP activation when account login fails: also check target authentication logs. |
| `RDP_ERROR_STANDARD_SECURITY_UNSUPPORTED` | Enable TLS or NLA on the target; RC4-only RDP is unsupported. |
| `RDP_ERROR_SECURITY_NEGOTIATION`, `RDP_ERROR_TLS_FAILED` | Target security policy and TLS compatibility; `requireNla: true` intentionally refuses TLS-only servers. |
| `RDP_ERROR_CERT_CHANGED` | Independently verify both fingerprints and approve rotation in the main UI. |
| `RDP_ERROR_NLA_DOWNGRADE` | Restore NLA on the target; investigate unexpected security changes before any reset. |
| `RDP_ERROR_TRUST_RACE` | Investigate competing pins/endpoints; credentials may have been sent. |
| `RDP_ERROR_NO_CREDENTIALS`, `RDP_ERROR_AUTHENTICATION_FAILED` | Target username, password, domain and stored credentials. |
| `RDP_ERROR_PASSWORD_EXPIRED`, `RDP_ERROR_PASSWORD_MUST_CHANGE` | Change the target password through an approved account management path. |
| `RDP_ERROR_ACCOUNT_LOCKED`, `RDP_ERROR_ACCOUNT_DISABLED`, `RDP_ERROR_ACCOUNT_RESTRICTION` | Target account status, expiry, workstation and logon-hour restrictions. |
| `RDP_ERROR_LOGON_TYPE_NOT_GRANTED`, `RDP_ERROR_ACCESS_DENIED` | Remote Desktop logon rights and target policy. |
| `RDP_ERROR_LICENSING`, `RDP_ERROR_SERVER_DENIED`, `RDP_ERROR_SERVER_DISCONNECTED` | RDP host/license configuration and server logs; a disconnect alone does not prove bad credentials. |
| `RDP_ERROR_CAPABILITIES_REJECTED`, `RDP_ERROR_H264_REQUIRED` | Follow `use-gfx`, `use-legacy` (Classic bitmaps) or `enable-h264` hints; use a browser with a working H.264 decoder if the target requires it. |
| `RDP_ERROR_TOO_MANY_SESSIONS` | Close sessions, wait for launch budget recovery, or adjust admission limits after checking server logs and memory. |
| `RDP_ERROR_RESOURCE_LIMIT`, `RDP_ERROR_CLIENT_STALLED` | Memory/queue limits, huge desktops, blocked background tabs or a slow/disconnected browser. |
| `RDP_ERROR_PROTOCOL`, `RDP_ERROR_CLIENT_DECODE`, `RDP_ERROR_CLIENT_PROTOCOL` | Invalid target/browser data or unsupported graphics; try Classic bitmaps for a graphics error, reproduce with the same target/browser and retain the code. |
| `RDP_ERROR_INTERNAL` | Startup/isolation and database/trust errors; check server logs and supported Node version. |

Hints are fixed identifiers: `use-gfx`, `use-legacy`, `enable-tls`, `enable-h264`
and `check-credentials`. They suggest a next step, not a security override.
A blank image after a graphics failure can be retried with Classic bitmaps.
If resize is unavailable, verify Display Control support and the Browser Size
option; the browser may scale a fixed-size desktop instead. H.264 performance
in a software-only browser can differ greatly from a hardware-decoded session.

## Security notes

Keep MeshCentral, Node, browser and target patched. Process isolation uses the
Node permission model when available, restricts filesystem reads to engine sources,
disables filesystem writes and child/worker creation, and strips inherited
credentials/environment. Startup logs report reduced hardening. This is defense
in depth, not an OS sandbox: engines run under the server account. Use a dedicated
service user and container/OS restrictions. Thread isolation contains JavaScript
exceptions and event-loop work but shares memory and process failure risks; it
is not an isolation choice for mutually untrusted code.

Keep HTTPS and origin checks enabled, configure only trusted reverse proxies,
and avoid broadly permitting `allowedOrigin`. Keep RDP reachable only through
trusted network paths. NLA is preferred; TLS-only sessions send account credentials
inside TLS to the pinned endpoint. TOFU has the first-use and shared-database
limits above. Credentials are passed to the isolated engine in memory and are
not placed in argv or environment; JavaScript strings cannot be reliably erased.
Saving credentials intentionally persists them according to MeshCentral policy.
View-only and limited-input enforcement remains on the server regardless of
hidden UI controls. Web-RDP does not add drive redirection, file clipboard transfer
or audio.

Server updates of this fork come from its GitHub releases, see [fork updates](fork-updates.md).

Protocol and developer details: [WIRE](../rdp/WIRE.md), [IPC](../rdp/IPC.md),
[codec contract](../public/rdp/codecs/README.md).
