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
| Frame rate | High (16 ms, about 60 frames/s), Medium (33 ms, about 30 frames/s, default), Low (50 ms, 20 frames/s), Slow (100 ms, 10 frames/s), Auto | Auto chooses 60, 30, 20, 15 or 10 frames/s during the session: the Windows x64 agent of this fork does it itself with H.264, otherwise the browser chooses from what it receives; `?kvmauto=0` or `localStorage.kvmAuto = '0'` makes Auto behave as Medium. The same list for JPEG and H.264. High needs an agent that accepts intervals below 20 ms (the Windows x64 agent of this fork); older agents run at 20 ms instead. The server does not limit the interval. A saved rate that is not in the list (400 or 1000 ms) becomes Slow. Settings saved before this list (Very fast, Fast, Medium 50 ms, Slow) are moved once by name: the old Medium (50 ms) becomes Medium (33 ms), Fast (20 ms) and Very fast (16 ms) become High, Slow stays. The saved setting then carries `frameratever`, so a Low chosen afterwards stays Low. The shared desktop pages use the same list and now start at Medium (33 ms); before, the default was 100 ms (browser page) or 50 ms (mobile page), and a saved 100, 400 or 1000 there becomes Slow. Thumbnails of the multi desktop view keep their own slow rate. |
| Bandwidth limit | No limit (default), 20, 10, 6, 4, 2, 1 Mbit/s | Upper limit for the picture data the agent sends. Supported by the Windows x64 agent of this fork; other agents ignore it. It does not apply to PNG. |
| Encoding | JPEG (default), PNG (lossless), H.264 (video) | Agents have no WebP encoder and browsers do not decode TIFF, so those choices were removed; a saved WebP or TIFF setting becomes JPEG. H.264 (video) is described [below](#h264-video). It is listed only when the browser can decode H.264 and the server allows it. |
| Quality, Scaling | as in upstream | |

Choosing a limit: about 10-20 Mbit/s on a local network, 2-6 Mbit/s over a VPN or a slow uplink, 1 Mbit/s for very
slow links. Under the limit the agent lowers the JPEG quality of moving areas first, then the motion frame rate, and
finally sends the picture at 75 % scale while the screen keeps changing; still areas are sharpened again afterwards.

The **FPS / bandwidth** option in the Tools panel of the Desktop tab (off by default, remembered in the browser)
shows the picture format in use (JPEG, PNG or H.264), the frames drawn per second and the data received per second,
averaged over the last two seconds, in the session footer.

## H.264 video

Experimental, chosen per user: **Encoding: H.264 (video)** in the desktop settings. The agent then sends the
areas of the screen that are moving (video, scrolling, window drags) as H.264 and keeps sending everything else as
JPEG. When the picture has been still for a moment the agent sends the moving areas once more as JPEG, so text and
icons are as sharp as in JPEG mode. The aim is a smoother picture at the same or a lower bandwidth, especially on
slow links. It has been tried on a few computers only (AMD and NVIDIA graphics, virtual machines), which is why it is
an option and not the default. The
bandwidth limit is meant to apply to it. Nothing changes for users who keep JPEG.

Requirements:

- A browser with WebCodecs and an H.264 decoder (tested with Chrome; other browsers show the option when their
  check passes). The option is not in the list when the browser cannot decode H.264; the check runs once per page.
- An agent that supports it: the Windows x64 agent of this fork with Media Foundation (Windows 8 or newer; the
  Windows N editions need the media feature pack). A Linux agent is planned. Other agents do not know the video commands: the
  session stays JPEG, the footer shows "Using JPEG instead of H.264: ..." with the reason, and nothing else
  changes. The same happens when the agent refuses (encoder failed, screen too large, another viewer).
- One viewer: video is used only while a single viewer is connected to the device, and the picture of every viewer
  is JPEG as soon as a second one joins; video comes back when it leaves. Thumbnails of the multi desktop view
  are always JPEG, and an open thumbnails page that shows the same device counts as a second viewer (with the
  desktop multiplexer at once, on a direct connection once the agent supports it), so video stays off while it is open.
- If the browser cannot keep up or the decoder fails three times in 30 seconds, the session goes back to JPEG until
  the next connection.

Recordings: a recorded session keeps the video, which is meant to make the files smaller than JPEG recordings of
moving content. A recording starts with a full JPEG picture and the first video frame is a key frame; while the session
is recorded the server asks the agent for another key frame every 30 seconds (the agent sends it with the next picture
that moves, so a still screen costs nothing). The session player plays the recording like a live session. A seek goes to
the nearest index point (the recording is indexed every 10 seconds); the player shows the JPEG picture of that point,
then decodes the video from the last key frame before it (at most 30 seconds of video; in a test with software
decoding of 30 seconds of full-screen 1080p video at 30 frames per second this took 7 to 8 seconds, ordinary content
less; the picture stays hidden meanwhile) and plays on, so moving areas are right at the point. A recording that was indexed
before this change, or one with no key frame in the last 60 seconds before the point, is sought the old way: the JPEG
picture of the point, and moving areas show the video from the next key frame (up to 30 seconds later). The player slows
down when the browser decodes slower than the recording plays.

Server switch: `domains.<id>.desktop.h264` in `config.json`, default `true`. With `false` the option is not
offered in any of the three interfaces and the desktop multiplexer (if enabled) refuses a request for video, so the
picture stays JPEG. The switch is not a lock and does not stop H.264 end to end:

- It protects the browsers of your users from a video stream they did not ask for. A modified browser can still ask
  an agent for video on a direct (1 to 1) connection, because the server forwards that connection unchanged and does
  not inspect it; meshcore on the device does not enforce the switch either.
- Recordings that already contain video are still decoded by the session player, whatever the switch says.
- It does not affect the end-to-end acknowledgement for JPEG (`?streamack=1`).

Security of the shared device: all viewers of a device share one KVM process. A viewer on a direct (1 to 1) connection
cannot set or lift the "more than one viewer" veto: the meshcore on the device drops every veto command from the tunnel of a
browser. Only the tunnel of the server's desktop multiplexer may write the multiplexer's veto, and the server marks that
tunnel itself: when the multiplexer applies, the server builds the address the agent connects to (it does not take the
address from the browser), so a browser cannot obtain the mark for a direct connection. Frames of more than 30000 bytes
from a tunnel are dropped, as are frames below 4 bytes, because the agent would read their content as commands.
The number of video control commands (240) a tunnel may send is limited to 20 per second. Both limits assume a
meshcore and an agent of this fork; an older server (without the mark) with this meshcore does not pass the
multiplexer's veto at all. Recordings do not store video frames that the multiplexer
rejected as malformed. The size of one recording can be limited (next section).

Size limit of one recording: `domains.<id>.sessionRecording.maxSessionRecordingSizeMegabytes` in `config.json`
(a number of megabytes; not set or 0 = no limit, which is the default; a value below 1 is raised to 1 MB, because a smaller limit would end every session at its first picture). It is not `maxRecordingSizeMegabytes`: that
one is a retention setting and deletes the oldest finished recordings once all of them together are larger than the
value, together with `maxRecordings` and `maxRecordingDays`; the new setting limits the file that is being written.
Without it, a device that sends a lot of data (or a hostile agent) can fill the disk of the server during one session.

- The size counts the file as it ends up, including its header and the last record, so a finished file is not
  larger than the limit. One exception: with `sessionRecording.index` on, the indexer appends its index and a new
  last record after the session, which makes the file a little larger (in proportion to the length of the session).
- At 80% and 95% of the limit every viewer of the session sees a message in the desktop window (once per viewer and
  level; a viewer that joins later sees the level reached so far). It says how many megabytes are left and that the
  session ends at the limit and that connecting again starts a new recording. Terminal and file windows show it too.
- At the limit the block that does not fit is not written, the viewers get a final message and the session ends. The
  file is closed with its last record, so it plays like any other recording; connecting again starts a new session and
  a new file. Recording is mandatory for the sessions that are selected for it, so the session does not go on
  without recording. The server writes an event ("Desktop recording size limit of ... MB reached ...") to the device
  event log.
- It applies to the recorded sessions of the desktop multiplexer and of the 1 to 1 relay (desktop, terminal, files,
  messenger, and Intel AMT that goes through the relay). Intel AMT sessions that the server records itself (CIRA and
  LMS connections, `handleRelayWebSocket`) have no limit. The messages need a web interface of this version: an older page shows the same text (the message
  carries it in English) and a viewer that does not know console messages ignores it. Messenger and Intel AMT
  sessions get the limit but no message, because their pages do not take console messages.

Measurement switch: opening the Desktop page with `?streamack=1` (or setting `StreamAckEnabled = true` on the
viewer) turns on the end-to-end acknowledgement for JPEG sessions too. The browser then reports to the agent which
pictures it has drawn, and the agent limits the data in flight to what the browser and the link can take. It is
off by default until it has been measured; choosing H.264 turns it on for that session.

## Windows agent of the fork

The default Windows x64 agent (`MeshService64.exe`) comes from the `h264-v1` release of
[kxd231/MeshAgent](https://github.com/kxd231/MeshAgent/releases/tag/h264-v1) (pinned with size and SHA-384 in
`agents/agent-defaults.json`); all other agent files are the upstream ones. Windows x64 agents connected to the
server update to it like to any new default agent. Compared with the upstream agent it:

- captures the screen with DXGI Desktop Duplication and encodes only the changed areas, with GDI as automatic
  fallback (Windows 7, several monitors in one picture, rotated screens, errors);
- removes the software cursor that some virtual machines draw into the captured image;
- encodes tiles with libjpeg-turbo, adapts the JPEG quality to motion and congestion and sharpens still areas;
- honours the viewer's bandwidth limit and frame intervals down to 10 ms;
- sends moving areas as H.264 when the viewer asks for it (Media Foundation), on the graphics card when a self test in
  a separate process has shown that its encoder works, else in software; an encoder that fails in a session is
  replaced by the software encoder at once and remembered. Tested on AMD and NVIDIA graphics, not yet on Intel;
- chooses the frame rate itself when the viewer selects Auto.

Switches in the environment of the agent service (registry
`HKLM\SYSTEM\CurrentControlSet\Services\<service name>\Environment`, `REG_MULTI_SZ`, `NAME=value` per line,
then restart the service):

| Variable | Effect |
|---|---|
| `MESH_KVM_FORCE_GDI=1` | Capture with GDI instead of DXGI. |
| `MESH_KVM_ADAPT=0` | Turn off the adaptive quality, the bandwidth limit and the motion frame limit. |
| `MESH_KVM_BUDGET_KBPS=<kbit/s>` | Bandwidth limit when the viewer sets none (the viewer's choice wins). |
| `MESH_KVM_VIDEO=0` | No H.264 on this computer: the viewer gets JPEG. |
| `MESH_KVM_VIDEO_HW=0` | Never use the graphics card encoder. The file `<agent exe name>-kvmhw-mode.txt` next to the agent with the word `sw` does the same without a restart (read at every session). |
| `MESH_KVM_AUTO=0` | The agent does not choose the frame rate for Auto; the browser does. |
| `MESH_KVM_STATS_LOG=1` | Write the diagnostic log `<agent exe name>-kvm.log` next to the agent (at most about 2 MB, then it rotates). Off by default. |

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
