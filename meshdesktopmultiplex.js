/**
* @description MeshCentral remote desktop multiplexor
* @author Ylian Saint-Hilaire
* @copyright Intel Corporation 2018-2022
* @license Apache-2.0
* @version v0.0.1
*/

/*jslint node: true */
/*jshint node: true */
/*jshint strict:false */
/*jshint -W097 */
/*jshint esversion: 6 */
"use strict";


/*
--- KVM Commands ---
MNG_KVM_NOP = 0,
MNG_KVM_KEY = 1,
MNG_KVM_MOUSE = 2,
MNG_KVM_MOUSE_CURSOR = 88,
MNG_KVM_MOUSE_MOVE = 89,
MNG_KVM_PICTURE = 3,
MNG_KVM_COPY = 4,
MNG_KVM_COMPRESSION = 5,
MNG_KVM_REFRESH = 6,
MNG_KVM_SCREEN = 7,
MNG_KVM_PAUSE = 8,
MNG_TERMTEXT = 9,
MNG_CTRLALTDEL = 10,
MNG_KVM_GET_DISPLAYS = 11,
MNG_KVM_SET_DISPLAY = 12,
MNG_KVM_FRAME_RATE_TIMER = 13,
MNG_KVM_INIT_TOUCH = 14,
MNG_KVM_TOUCH = 15,
MNG_KVM_CONNECTCOUNT = 16,
MNG_KVM_MESSAGE = 17,
MNG_KVM_KEYSTATE = 18,
MNG_ECHO = 21,
MNG_JUMBO = 27,
MNG_GETDIR = 50,
MNG_FILEMOVE = 51,
MNG_FILEDELETE = 52,
MNG_FILECOPY = 53,
MNG_FILECREATEDIR = 54,
MNG_FILETRANSFER = 55,
MNG_FILEUPLOAD = 56,
MNG_FILESEARCH = 57,
MNG_FILETRANSFER2 = 58,
MNG_KVM_DISCONNECT = 59,
MNG_GETDIR2 = 60,						// Same as MNG_GETDIR but with date/time.
MNG_FILEUPLOAD2 = 61,					// Used for slot based fast upload.
MNG_FILEDELETEREC = 62,					// Same as MNG_FILEDELETE but recursive
MNG_USERCONSENT = 63,					// Used to notify management console of user consent state
MNG_DEBUG = 64,							// Debug/Logging Message for ILibRemoteLogging
MNG_ERROR = 65,
MNG_ENCAPSULATE_AGENT_COMMAND = 70,
MNG_KVM_DISPLAY_INFO = 82
MNG_KVM_VIEWER_ACK = 0x4B41             // Viewer -> multiplexor only, never forwarded. 0x4B40-0x4B4F are terminated by the multiplexor.
*/

/*
--- Viewer ACK (opt-in flow control between the multiplexor and one browser) ---
The multiplexor adds "kvmAck":1 to its metadata message. A browser that supports it answers with the text frame
{"ctrlChannel":"102938","type":"kvmack","op":"req","v":1}; the multiplexor confirms with {"type":"kvmack","op":"on","v":1,"epoch":E,"seq":0}
(or refuses with "op":"off"). From the confirmation on, every frame of the image stream (tiles, cmd 3, and the screen size, cmd 7)
gets a tag (epoch, seq): cmd 7 opens a new epoch, both counters are u32 and skip 0. The browser acknowledges with the binary frame
0x4B41, 0x000C, epoch u32, seq u32 once everything up to that frame has left its draw queue. The multiplexor keeps at most a window of
unacknowledged bytes in flight per viewer; a viewer whose window is full is a slow viewer (see checkViewerOverflow). Without progress for
the timeout the viewer falls back to the legacy flow control. Nothing of this reaches the agent.
*/

const KVM_ACK_CMD = 0x4B41;
const KVM_ACK_RANGE_LO = 0x4B40;
const KVM_ACK_RANGE_HI = 0x4B4F;
const KVM_ACK_DEFAULTS = { minwindow: 131072, maxwindow: 4194304, initialwindow: 262144, queuedelay: 200, tiles: 512, timeout: 10 };
const KVM_ACK_RATE = 100;               // ACK frames per second per viewer (token bucket rate and capacity)
const KVM_ACK_FLOOD = 1000;             // ACK frames dropped by the bucket within one activation before the viewer is cut off
const KVM_ACK_MAX_REQUESTS = 8;         // kvmack control messages per connection
const KVM_ACK_MAX_ACTIVATIONS = 4;      // activations per connection
const KVM_ACK_COOLDOWN = 30000;         // ms between a timeout and a new activation
const KVM_ACK_MAX_REQUEST_LENGTH = 256;

// Next value of a u32 counter that never uses 0
function kvmAckNext(x) { return (x >= 0xFFFFFFFF) ? 1 : (x + 1); }

// Parse settings.desktopMultiplexAck (config keys are lower case). Returns null when the feature is disabled.
function kvmAckConfig(settings) {
    var v = (settings != null) ? settings.desktopmultiplexack : undefined;
    if (v === false) return null;
    var c = Object.assign({}, KVM_ACK_DEFAULTS);
    if ((v != null) && (typeof v == 'object') && !Array.isArray(v)) {
        var num = function (name, lo, hi) { var x = v[name]; if ((typeof x == 'number') && Number.isInteger(x) && (x >= lo) && (x <= hi)) { c[name] = x; } };
        num('minwindow', 16384, 16777216);
        num('maxwindow', 16384, 16777216);
        num('queuedelay', 50, 2000);
        num('tiles', 16, 2048);
        num('timeout', 3, 60);
        if (c.maxwindow < c.minwindow) { c.maxwindow = c.minwindow; }
    }
    c.initialwindow = Math.min(Math.max(KVM_ACK_DEFAULTS.initialwindow, c.minwindow), c.maxwindow);
    return c;
}

// Framing rule V: the buffer, parsed exactly as the browser transport parses it (agent-redir-ws), must declare at most the bytes it carries.
// A frame that declares more makes the browser treat the following, unrelated frames as its continuation. Returns the command the browser
// will see, or -1 if the frame must not be sent to viewers. The minimum sizes cover the fields that the browser and the multiplexor read.
function viewerFrameOk(buf) {
    if ((buf == null) || (buf.length < 4)) return -1;
    var cmd = buf.readUInt16BE(0), size = buf.readUInt16BE(2), avail = buf.length;
    if ((cmd == 27) && (size == 8)) {
        if (buf.length < 12) return -1;
        size = buf.readUInt32BE(4);
        if (size >= 0x1000000) return -1;   // the browser reads only 24 bits of the jumbo length
        avail = buf.length - 8;
        if ((size < 4) || (size > avail)) return -1;
        cmd = buf.readUInt16BE(8);
    } else {
        if ((size < 4) || (size > avail)) return -1;
    }
    if ((cmd == 3) && (size < 10)) return -1;
    if ((cmd == 7) && (size < 8)) return -1;
    return cmd;
}

// Windowed min/max filter with two buckets of span/2 each
function kvmFilterRoll(f, now, span) {
    var half = span / 2;
    if ((f.start == null) || ((now - f.start) >= half)) {
        f.prev = ((f.start != null) && ((now - f.start) < span)) ? f.cur : null;
        f.cur = null;
        f.start = now;
    }
}
function kvmFilterAdd(f, value, now, span, isMax) {
    kvmFilterRoll(f, now, span);
    if ((f.cur == null) || (isMax ? (value > f.cur) : (value < f.cur))) { f.cur = value; }
}
function kvmFilterGet(f, now, span, isMax) {
    kvmFilterRoll(f, now, span);
    if (f.cur == null) return f.prev;
    if (f.prev == null) return f.cur;
    return isMax ? Math.max(f.cur, f.prev) : Math.min(f.cur, f.prev);
}

function CreateDesktopMultiplexor(parent, domain, nodeid, id, func) {
    var obj = {};
    obj.id = id;                        // Unique identifier for this session
    obj.nodeid = nodeid;                // Remote device nodeid for this session
    obj.parent = parent;                // Parent web server instance
    obj.agent = null;                   // Reference to the connection object that is the agent.
    obj.viewers = [];                   // Array of references to all viewers.
    obj.viewersOverflowCount = 0;       // Number of viewers currently in overflow state.
    obj.width = 0;                      // Current width of the display in pixels.
    obj.height = 0;                     // Current height of the display in pixels.
    obj.swidth = 0;                     // Current width of the display in tiles.
    obj.sheight = 0;                    // Current height of the display in tiles.
    obj.screen = null;                  // The main screen, (x * y) --> tile index. Indicates this image is covering each tile on the screen.
    obj.counter = 1;                    // The main counter, used as index for the obj.images table when now images come in.
    obj.imagesCount = 0;                // Total number of images in the obj.images table.
    obj.imagesBytes = 0;                // Total bytes of the tiles in the obj.images table (cache pressure).
    obj.imagesCounters = {};            // Main table of indexes --> tile count, the number of tiles still using this image.
    obj.images = {};                    // Main table of indexes --> image data object.
    obj.lastScreenSizeCmd = null;       // Pointer to the last screen size command from the agent.
    obj.lastScreenSizeCounter = 0;      // Index into the image table of the screen size command, this is generally also the first command.
    obj.lastConsoleMessage = null;      // Last agent console message.
    obj.firstData = null;               // Index in the image table of the first image in the table, generally this points to the display resolution command.
    obj.lastData = null;                // Index in the images table of the last image in the table.
    obj.lastDisplayInfoData = null;     // Pointer to the last display information command from the agent (Number of displays).
    obj.lastDisplayLocationData = null; // Pointer to the last display location and size command from the agent.
    obj.lastKeyState = null;            // Pointer to the last key state command from the agent.
    obj.desktopPaused = true;           // Current desktop pause state, it's true if all viewers are paused.
    obj.imageType = 1;                  // Current image type, 1 = JPEG, 2 = PNG, 3 = TIFF, 4 = WebP
    obj.imageCompression = 50;          // Current image compression, this is the highest value of all viewers.
    obj.imageScaling = 1024;            // Current image scaling, this is the highest value of all viewers.
    obj.imageFrameRate = 50;            // Current framerate setting, this is the lowest values of all viewers.
    obj.imageBudget = null;             // Current bandwidth budget in units of 100 kbit/s (0 = no limit): the smallest non-zero one of the viewers that sent one, 0 if they all sent 0, null if none did.
    obj.protocolOptions = null;         // Set to the protocol options of the first viewer that connected.
    obj.viewerConnected = false;        // Set to true if one viewer attempted to connect to the agent.
    obj.recordingFile = null;           // Present if we are recording to file.
    obj.recordingFileSize = 0;          // Current size of the recording file.
    obj.recordingFileWriting = false;   // Set to true is we are in the process if writing to the recording file.
    obj.startTime = null;               // Starting time of the multiplex session.
    obj.userIds = [];                   // List of userid's that have intertracted with this session.
    //obj.autoLock = false;               // Automatically lock the remote device once disconnected
    obj.kvmAck = kvmAckConfig((parent.parent && parent.parent.config) ? parent.parent.config.settings : null); // Viewer ACK settings, null = disabled
    obj.kvmAckTimer = null;             // Timeout check, runs while at least one viewer is in ACK mode
    obj.badFramesLogged = 0;            // Malformed agent frames written to the debug log (the first 10)
    obj.now = function () { return Date.now(); };

    // Accounting
    parent.trafficStats.desktopMultiplex.sessions++;
    function stat(name) { var s = parent.trafficStats.desktopMultiplex; s[name] = (s[name] || 0) + 1; }
    function debug(msg) { try { parent.parent.debug('relay', 'DesktopRelay: ' + msg); } catch (ex) { } }
    function peerIp(peer) { return (peer.req && peer.req.clientIp) ? peer.req.clientIp : ''; }

    // Add an agent or viewer
    obj.addPeer = function (peer) {
        if (obj.viewers == null) { parent.parent.debug('relay', 'DesktopRelay: Error, addingPeer on disposed session'); return; }
        if (peer.req == null) return; // This peer is already disposed, don't add it.
        if (peer.req.query.browser) {
            //console.log('addPeer-viewer', obj.nodeid);
                        
            // Setup the viewer
            if (obj.viewers.indexOf(peer) >= 0) return true;
            obj.viewers.push(peer);
            peer.desktopPaused = true;
            peer.imageType = 1;
            peer.imageCompression = 30;
            peer.imageScaling = 1024;
            peer.imageFrameRate = 100;
            peer.imageBudget = null;            // Bandwidth budget, 100 kbit/s units, 0 = no limit; null = the viewer never sent the optional field (thumbnails, older clients)
            peer.lastImageNumberSent = null;
            peer.dataPtr = obj.firstData;
            peer.sending = false;
            peer.overflow = false;
            peer.sendQueue = [];
            peer.paused = false;
            peer.startTime = Date.now();
            peer.kvmAck = null;             // Viewer ACK state, null for a viewer that never asked

            // Add the user to the userids list if needed
            if ((peer.user != null) && (obj.userIds.indexOf(peer.user._id) == -1)) { obj.userIds.push(peer.user._id); }

            // Setup slow relay is requested. This will show down sending any data to this viewer.
            if ((peer.req.query.slowrelay != null)) {
                var sr = null;
                try { sr = parseInt(peer.req.query.slowrelay); } catch (ex) { }
                if ((typeof sr == 'number') && (sr > 0) && (sr < 1000)) { peer.slowRelay = sr; }
            }

            // Update user last access time
            if ((peer.user != null) && (peer.guestName == null)) {
                const user = parent.users[peer.user._id];
                if (user != null) {
                    const timeNow = Math.floor(Date.now() / 1000);
                    if (user.access < (timeNow - 300)) { // Only update user access time if longer than 5 minutes
                        user.access = timeNow;
                        parent.db.SetUser(user);

                        // Event the change
                        var message = { etype: 'user', userid: user._id, username: user.name, account: parent.CloneSafeUser(user), action: 'accountchange', domain: domain.id, nolog: 1 };
                        if (parent.db.changeStream) { message.noact = 1; } // If DB change stream is active, don't use this event to change the user. Another event will come.
                        var targets = ['*', 'server-users', user._id];
                        if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                        parent.parent.DispatchEvent(targets, obj, message);
                    }
                }
            }

            // Check session recording
            var startRecord = false;
            if (typeof domain.sessionrecording == 'object') {
                // Check if this user is set to record all sessions
                if ((domain.sessionrecording.onlyselectedusers === true) && (peer.user != null) && (peer.user.flags != null) && ((peer.user.flags & 2) != 0)) { startRecord = true; }
                else if (domain.sessionrecording.onlyselectedusergroups === true) {
                    // Check if there is a usergroup that requires recording of the session
                    var user = null;
                    if (peer.user != null) { user = parent.users[peer.user._id]; }
                    if ((user != null) && (user.links != null) && (user.links[obj.meshid] == null) && (user.links[obj.nodeid] == null)) {
                        // This user does not have a direct link to the device group or device. Find all user groups the would cause the link.
                        for (var i in user.links) {
                            var ugrp = parent.userGroups[i];
                            if ((ugrp != null) && (typeof ugrp.flags == 'number') && ((ugrp.flags & 2) != 0) && (ugrp.links != null) && ((ugrp.links[obj.meshid] != null) || (ugrp.links[obj.nodeid] != null))) { startRecord = true; }
                        }
                    }
                }
            }

            startRecording(domain, startRecord, function () {
                // Indicated we are connected
                obj.sendToViewer(peer, obj.recordingFile ? 'cr' : 'c');

                // If the agent sent display information or console message, send it to the viewer
                if (obj.lastDisplayInfoData != null) { obj.sendToViewer(peer, obj.lastDisplayInfoData); }
                if (obj.lastDisplayLocationData != null) { obj.sendToViewer(peer, obj.lastDisplayLocationData); }
                if (obj.lastConsoleMessage != null) { obj.sendToViewer(peer, obj.lastConsoleMessage); }
                if (obj.lastKeyState != null) { obj.sendToViewer(peer, obj.lastKeyState); }
                
                // Log joining the multiplex session
                if (obj.startTime != null) {
                    var event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: peer.user ? peer.user._id : null, username: peer.user.name, msgid: 143, msgArgs: [obj.id], msg: "Joined desktop multiplex session \"" + obj.id + "\"", protocol: 2 };
                    parent.parent.DispatchEvent(['*', obj.nodeid, peer.user._id, obj.meshid], obj, event);
                }

                // Send an updated list of all peers to all viewers
                obj.sendSessionMetadata();
            });
        } else {
            //console.log('addPeer-agent', obj.nodeid);
            if (obj.agent != null) { parent.parent.debug('relay', 'DesktopRelay: Error, duplicate agent connection'); return false; }
            
            // Setup the agent
            obj.agent = peer;
            peer.sending = false;
            peer.overflow = false;
            peer.sendQueue = [];
            peer.paused = false;

            // Indicated we are connected and send connection options and protocol if needed
            obj.sendToAgent(obj.recordingFile?'cr':'c');
            if (obj.viewerConnected == true) {
                if (obj.protocolOptions != null) { obj.sendToAgent(JSON.stringify(obj.protocolOptions)); } // Send connection options
                obj.sendToAgent('2'); // Send remote desktop connect
            }
        }

        // Log multiplex session start
        if ((obj.agent != null) && (obj.viewers.length > 0) && (obj.startTime == null)) {
            var event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, msgid: 145, msgArgs: [obj.id], msg: "Started desktop multiplex session \"" + obj.id + "\"", protocol: 2 };
            if (obj.viewers[0].user != null) { event.userid = obj.viewers[0].user._id; event.username = obj.viewers[0].user.name; }
            const targets = ['*', obj.nodeid, obj.meshid];
            if (obj.viewers[0].user != null) { targets.push(obj.viewers[0].user._id); }
            parent.parent.DispatchEvent(targets, obj, event);
            obj.startTime = Date.now();
        }
        return true;
    }

    // The bandwidth budget (units of 100 kbit/s, 0 = no limit) for the agent, from the viewers that sent the optional field of command 5: the limit of the
    // slowest viewer wins, so it is the smallest non-zero budget; 0 (no limit) only when every viewer that sent one sent 0. Viewers without the field
    // (10 byte command: thumbnails, older clients) do not take part. null when no viewer sent one.
    // If no viewer has one any more but the agent was given one before, the result is 0: a command without the field would leave the old limit in place.
    function commonBudget() {
        var r = null;
        for (var i in obj.viewers) {
            var b = obj.viewers[i].imageBudget;
            if (b == null) continue;
            if (r == null) { r = b; } else if (b != 0) { r = (r == 0) ? b : Math.min(r, b); }
        }
        return ((r == null) && (obj.imageBudget != null)) ? 0 : r;
    }

    // Send the current common compression settings to the agent as command 5: 10 bytes, or 12 with the bandwidth budget once one is known.
    function sendCompressionToAgent() {
        var cmd = Buffer.alloc((obj.imageBudget == null) ? 10 : 12);
        cmd.writeUInt16BE(5, 0); // Command 5, compression
        cmd.writeUInt16BE(cmd.length, 2); // Command size
        cmd[4] = obj.imageType; // Image type: 1 = JPEG, 2 = PNG, 3 = TIFF, 4 = WebP
        cmd[5] = obj.imageCompression; // Image compression level
        cmd.writeUInt16BE(obj.imageScaling, 6); // Scaling level
        cmd.writeUInt16BE(obj.imageFrameRate, 8); // Frame rate timer
        if (obj.imageBudget != null) { cmd.writeUInt16BE(obj.imageBudget, 10); } // Bandwidth budget, 100 kbit/s units
        obj.sendToAgent(cmd);
    }

    // Remove an agent or viewer
    // Return true if this multiplexor is no longer needed.
    obj.removePeer = function (peer) {
        if (obj.viewers == null) return;
        if (peer == obj.agent) {
            //console.log('removePeer-agent', obj.nodeid);
            // Agent has disconnected, disconnect everyone.
            if (obj.viewers != null) { for (var i in obj.viewers) { obj.viewers[i].close(); } }

            // Clean up the agent
            obj.agent = null;

            dispose();
            return true;
        } else {
            //console.log('removePeer-viewer', obj.nodeid);
            // Remove a viewer
            if (obj.viewers != null) {
                var i = obj.viewers.indexOf(peer);
                if (i == -1) return false;
                obj.viewers.splice(i, 1);
            }

            // Resume flow control if this was the peer that was limiting traffic (because it was the fastest one).
            if (peer.overflow == true) {
                obj.viewersOverflowCount--;
                peer.overflow = false;
                if ((obj.viewersOverflowCount < obj.viewers.length) && (obj.recordingFileWriting == false) && obj.agent && (obj.agent.paused == true)) { obj.agent.paused = false; obj.agent.ws._socket.resume(); }
            }

            // Log leaving the multiplex session
            if (obj.startTime != null) { // Used to check if the agent has connected. If not, don't log this event since the session never really started.
                // In this code, we want to compute the share of in/out traffic that belongs to this viewer. It includes all of the viewers in/out traffic + all or a portion of the agents in/out traffic.
                // The agent traffic needs to get divided out between the viewers fairly. For the time that multiple viewers are present, the agent traffic is divided between the viewers.

                // Compute traffic to and from the browser
                var inTraffc, outTraffc;
                try { inTraffc = peer.ws._socket.bytesRead; } catch (ex) { }
                try { outTraffc = peer.ws._socket.bytesWritten; } catch (ex) { }

                // Add any previous agent traffic accounting
                if (peer.agentInTraffic) { inTraffc += peer.agentInTraffic; }
                if (peer.outTraffc) { inTraffc += peer.agentOutTraffic; }

                // Compute traffic to and from the agent
                if (obj.agent != null) {
                    // Get unaccounted bytes from/to the agent
                    var agentInTraffc, agentOutTraffc, agentInTraffc2, agentOutTraffc2;
                    try { agentInTraffc = agentInTraffc2 = obj.agent.ws._socket.bytesRead; } catch (ex) { }
                    try { agentOutTraffc = agentOutTraffc2 = obj.agent.ws._socket.bytesWritten; } catch (ex) { }
                    if (obj.agent.accountedBytesRead) { agentInTraffc -= obj.agent.accountedBytesRead; }
                    if (obj.agent.accountedBytesWritten) { agentOutTraffc -= obj.agent.accountedBytesWritten; }
                    obj.agent.accountedBytesRead = agentInTraffc2;
                    obj.agent.accountedBytesWritten = agentOutTraffc2;

                    // Devide up the agent traffic amoung the viewers
                    var viewerPartIn = Math.floor(agentInTraffc / (obj.viewers.length + 1));
                    var viewerPartOut = Math.floor(agentOutTraffc / (obj.viewers.length + 1));

                    // Add the portion to this viewer and all other viewer
                    inTraffc += viewerPartIn;
                    outTraffc += viewerPartOut;
                    for (var i in obj.viewers) {
                        if (obj.viewers[i].agentInTraffic) { obj.viewers[i].agentInTraffic += viewerPartIn; } else { obj.viewers[i].agentInTraffic = viewerPartIn; }
                        if (obj.viewers[i].agentOutTraffic) { obj.viewers[i].agentOutTraffic += viewerPartOut; } else { obj.viewers[i].agentOutTraffic = viewerPartOut; }
                    }
                }

                //var event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: peer.user._id, username: peer.user.name, msgid: 5, msg: "Left the desktop multiplex session", protocol: 2 };
                const sessionSeconds = Math.floor((Date.now() - peer.startTime) / 1000);
                var event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, msgid: 144, msgArgs: [obj.id, sessionSeconds], msg: "Left the desktop multiplex session \"" + obj.id + "\" after " + sessionSeconds + " second(s).", protocol: 2, bytesin: inTraffc, bytesout: outTraffc };
                if (peer.user != null) { event.userid = peer.user._id; event.username = peer.user.name; }
                if (peer.guestName) { event.guestname = peer.guestName; }
                if ((peer.kvmAck != null) && (peer.kvmAck.activations > 0)) { const k = peer.kvmAck; event.kvmack = { activations: k.activations, timeouts: k.timeouts, violations: k.violations, floods: k.floods, stalls: k.stalls }; }
                const targets = ['*', obj.nodeid, obj.meshid];
                if (peer.user != null) { targets.push(peer.user._id); }
                parent.parent.DispatchEvent(targets, obj, event);
            }

            // Aggressive clean up of the viewer
            delete peer.desktopPaused;
            delete peer.imageType;
            delete peer.imageCompression;
            delete peer.imageScaling;
            delete peer.imageFrameRate;
            delete peer.imageBudget;
            delete peer.lastImageNumberSent;
            delete peer.dataPtr;
            delete peer.sending;
            delete peer.overflow;
            delete peer.sendQueue;
            delete peer.startTime;
            delete peer.kvmAck;

            // If this is the last viewer, disconnect the agent
            if ((obj.viewers != null) && (obj.viewers.length == 0) && (obj.agent != null)) { obj.agent.close(); dispose(); return true; }

            // The budget follows the viewers that are left (only the budget: the other settings keep their value, as before)
            var leftBudget = commonBudget();
            if (leftBudget !== obj.imageBudget) { obj.imageBudget = leftBudget; sendCompressionToAgent(); }

            // Send an updated list of all peers to all viewers
            obj.sendSessionMetadata();
        }
        return false;
    }

    // Clean up ourselves
    function dispose() {
        if (obj.viewers == null) return;
        //console.log('dispose', obj.nodeid);
        if (obj.kvmAckTimer != null) { clearInterval(obj.kvmAckTimer); obj.kvmAckTimer = null; }
        delete obj.viewers;
        delete obj.imagesCounters;
        delete obj.images;

        // Close the recording file if needed
        if (obj.recordingFile != null) {
            // Compute session length
            if (obj.startTime != null) { obj.sessionStart = obj.startTime; obj.sessionLength = Math.round((Date.now() - obj.startTime) / 1000); }

            // Write the last record of the recording file
            var rf = obj.recordingFile;
            delete obj.recordingFile;
            recordingEntry(rf.fd, 3, 0, 'MeshCentralMCREC', function (fd, filename) {
                parent.parent.fs.close(fd);

                // Now that the recording file is closed, check if we need to index this file.
                if (domain.sessionrecording.index && domain.sessionrecording.index !== false) { parent.parent.certificateOperations.acceleratorPerformOperation('indexMcRec', filename); }

                // Add a event entry about this recording
                var basefile = parent.parent.path.basename(filename);
                var event = { etype: 'relay', action: 'recording', domain: domain.id, nodeid: obj.nodeid, msgid: 146, msgArgs: [obj.id, obj.sessionLength], msg: "Finished recording session \"" + obj.id + "\", " + obj.sessionLength + " second(s)", filename: basefile, size: obj.recordingFileSize, protocol: 2, icon: obj.icon, name: obj.name, meshid: obj.meshid, userids: obj.userIds, multiplex: true };
                var mesh = parent.meshes[obj.meshid];
                if (mesh != null) { event.meshname = mesh.name; }
                if (obj.sessionStart) { event.startTime = obj.sessionStart; event.lengthTime = obj.sessionLength; }
                parent.parent.DispatchEvent(['*', 'recording', obj.nodeid, obj.meshid], obj, event);

                cleanUpRecordings();
            }, rf.filename);
        }

        // Log end of multiplex session
        if (obj.startTime != null) {
            var event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, msgid: 147, msgArgs: [obj.id, Math.floor((Date.now() - obj.startTime) / 1000)], msg: "Closed desktop multiplex session \"" + obj.id + "\", " + Math.floor((Date.now() - obj.startTime) / 1000) + ' second(s)', protocol: 2 };
            parent.parent.DispatchEvent(['*', obj.nodeid, obj.meshid], obj, event);
            obj.startTime = null;
        }

        // Send an updated list of all peers to all viewers
        obj.sendSessionMetadata();

        parent.parent.debug('relay', 'DesktopRelay: Disposing desktop multiplexor');
    }

    // Send data to the agent or queue it up for sending
    obj.sendToAgent = function (data) {
        if ((obj.viewers == null) || (obj.agent == null)) return;
        //console.log('SendToAgent', data.length);
        if (obj.agent.sending) {
            obj.agent.sendQueue.push(data);

            // Flow control, pause all viewers is the queue is backing up
            if (obj.agent.sendQueue > 10) {
                obj.agent.overflow = true;
                for (var i in obj.viewers) {
                    var v = obj.viewers[i];
                    if (v.paused == false) { v.paused = true; v.ws._socket.pause(); }
                }
            }
        } else {
            obj.agent.ws.send(data, sendAgentNext);
        }
    }

    // Send more data to the agent
    function sendAgentNext() {
        if ((obj.viewers == null) || (obj.agent == null)) return;
        if (obj.agent.sendQueue.length > 0) {
            // Send from the pending send queue
            obj.agent.ws.send(obj.agent.sendQueue.shift(), sendAgentNext);
        } else {
            // Nothing to send
            obj.agent.sending = false;

            // Flow control, resume all viewers
            if (obj.agent.overflow == true) {
                obj.agent.overflow = false;
                for (var i in obj.viewers) {
                    var v = obj.viewers[i];
                    if (v.paused == true) { v.paused = false; v.ws._socket.resume(); }
                }
            }
        }
    }

    // Send the list of all users currently vieweing this session to all viewers and servers
    obj.sendSessionMetadata = function () {
        var allUsers = {};
        if (obj.viewers != null) {
            for (var i in obj.viewers) {
                var v = obj.viewers[i];
                if ((v.user != null) && (v.user._id != null)) {
                    var id = v.user._id;
                    if (v.guestName) { id += '/guest:' + Buffer.from(v.guestName).toString('base64'); } // If this is a guest connect, add the Base64 guest name.
                    if (allUsers[id] == null) { allUsers[id] = 1; } else { allUsers[id]++; }
                }
            }
            var metadata = { type: 'metadata', 'ctrlChannel': '102938', users: allUsers, startTime: obj.startTime };
            if (obj.kvmAck != null) { metadata.kvmAck = 1; } // Offer viewer ACK to browsers that support it
            obj.sendToAllViewers(JSON.stringify(metadata));
        }

        // Update the sessions attached the to agent
        if (obj.nodeid != null) {
            const xagent = parent.wsagents[obj.nodeid];
            if (xagent != null) {
                if (xagent.sessions == null) { xagent.sessions = {}; }
                xagent.sessions.multidesk = allUsers;
                xagent.updateSessions();
            }
        }
    }

    // Send this command to all viewers
    obj.sendToAllViewers = function (data) {
        if (obj.viewers == null) return;
        for (var i in obj.viewers) { obj.sendToViewer(obj.viewers[i], data); }
    }

    // Send this command to all viewers
    obj.sendToAllInputViewers = function (data) {
        if (obj.viewers == null) return;
        for (var i in obj.viewers) { if (obj.viewers[i].viewOnly != true) { obj.sendToViewer(obj.viewers[i], data); } }
    }

    // Send data to the viewer or queue it up for sending
    obj.sendToViewer = function (viewer, data) {
        if ((viewer == null) || (obj.viewers == null)) return;
        //console.log('SendToViewer', data.length);
        if (viewer.sending) {
            viewer.sendQueue.push(data);
        } else {
            viewer.sending = true;
            if (viewer.slowRelay) {
                setTimeout(function () { try { viewer.ws.send(data, function () { sendViewerNext(viewer); }); } catch (ex) { } }, viewer.slowRelay);
            } else {
                try { viewer.ws.send(data, function () { sendViewerNext(viewer); }); } catch (ex) { }
            }

            // Flow control, pause the agent if needed
            checkViewerOverflow(viewer);
        }
    }

    // A viewer is behind when images wait in the list for it. A viewer in ACK mode is never "behind" for flow control: its window already
    // bounds what it has in flight, and pausing the agent for it would only move the backlog into the agent connection, where stale tiles
    // can no longer be dropped. Reading on keeps the image list current (stale-tile removal), so the viewer gets fresh tiles when it can take them.
    // Exception: cache pressure. The image list is bounded by the screen cells only for well-formed tiles (images with fractional coverage counters are
    // never evicted). While the list holds more than 2 x cells + 256 images or more than 32 MiB, ACK viewers
    // are treated like legacy ones again: a slow ACK viewer can pause the agent, so the list grows no faster than with a legacy viewer.
    // Leaked images are never evicted, so the pressure lasts until the next screen size change: for the rest of that screen the ACK viewer
    // behaves like a legacy viewer with a window. The leak of such images itself is not fixed here.
    function cachePressure() {
        return (obj.imagesCount > ((2 * obj.swidth * obj.sheight) + 256)) || (obj.imagesBytes > 33554432);
    }
    obj.cachePressure = cachePressure;
    function viewerBehind(viewer) {
        if ((viewer.kvmAck != null) && (viewer.kvmAck.state === 1) && !cachePressure()) return false;
        return ((viewer.dataPtr != null) && (viewer.dataPtr != obj.lastData));
    }

    // Check if a viewer is in overflow situation
    function checkViewerOverflow(viewer) {
        if ((viewer.overflow == true) || (obj.viewers == null)) return;
        if ((viewer.sendQueue.length > 5) || viewerBehind(viewer)) {
            viewer.overflow = true;
            obj.viewersOverflowCount++;
            if ((obj.viewersOverflowCount >= obj.viewers.length) && obj.agent && (obj.agent.paused == false)) { obj.agent.paused = true; obj.agent.ws._socket.pause(); }
        }
    }

    // Check if a viewer is in underflow situation
    function checkViewerUnderflow(viewer) {
        if ((viewer.overflow == false) || (obj.viewers == null)) return;
        if ((viewer.sendQueue.length <= 5) && !viewerBehind(viewer)) {
            viewer.overflow = false;
            obj.viewersOverflowCount--;
            if ((obj.viewersOverflowCount < obj.viewers.length) && (obj.recordingFileWriting == false) && obj.agent && (obj.agent.paused == true)) { obj.agent.paused = false; obj.agent.ws._socket.resume(); }
        }
    }

    // Send more data to the viewer
    function sendViewerNext(viewer) {
        if ((viewer.sendQueue == null) || (obj.viewers == null)) return;
        if (viewer.sendQueue.length > 0) {
            // Send from the pending send queue
            if (viewer.sending == false) { viewer.sending = true; }
            if (viewer.slowRelay) {
                setTimeout(function () { try { viewer.ws.send(viewer.sendQueue.shift(), function () { sendViewerNext(viewer); }); } catch (ex) { } }, viewer.slowRelay);
            } else {
                try { viewer.ws.send(viewer.sendQueue.shift(), function () { sendViewerNext(viewer); }); } catch (ex) { }
            }
            checkViewerOverflow(viewer);
        } else {
            if (viewer.dataPtr != null) {
                // Send the next image
                //if ((viewer.lastImageNumberSent != null) && ((viewer.lastImageNumberSent + 1) != (viewer.dataPtr))) { console.log('SVIEW-S1', viewer.lastImageNumberSent, viewer.dataPtr); } // DEBUG
                var image = obj.images[viewer.dataPtr];
                if ((viewer.kvmAck != null) && (viewer.kvmAck.state === 1) && (kvmAckAdmit(viewer, image) == false)) {
                    // The ACK window of this viewer is full: hold the image stream (control frames still go out) until an ACK arrives
                    viewer.sending = false;
                    checkViewerUnderflow(viewer); // a viewer that entered ACK mode while behind no longer holds the agent
                    return;
                }
                viewer.lastImageNumberSent = viewer.dataPtr;
                //if ((image.next != null) && ((viewer.dataPtr + 1) != image.next)) { console.log('SVIEW-S2', viewer.dataPtr, image.next); } // DEBUG
                viewer.dataPtr = image.next;
                if (viewer.slowRelay) {
                    setTimeout(function () { try { viewer.ws.send(image.data, function () { sendViewerNext(viewer); }); } catch (ex) { } }, viewer.slowRelay);
                } else {
                    try { viewer.ws.send(image.data, function () { sendViewerNext(viewer); }); } catch (ex) { }
                }

                // Flow control, pause the agent if needed
                if (viewer.sending == false) { viewer.sending = true; }
                checkViewerOverflow(viewer);
            } else {
                // Nothing to send
                viewer.sending = false;

                // Flow control, resume agent if needed
                checkViewerUnderflow(viewer);
            }
        }
    }

    // Process data coming from the agent or any viewers
    obj.processData = function (peer, data) {
        if (obj.viewers == null) return;
        if (peer == obj.agent) {
            obj.recordingFileWriting = true;
            recordData(true, data, function () {
                if (obj.viewers == null) return;
                obj.recordingFileWriting = false;
                if ((obj.viewersOverflowCount < obj.viewers.length) && obj.agent && (obj.agent.paused == true)) { obj.agent.paused = false; obj.agent.ws._socket.resume(); }
                obj.processAgentData(data);
            });
        } else {
            obj.processViewerData(peer, data);
        }
    }

    // Process incoming viewer data
    obj.processViewerData = function (viewer, data) {
        if (typeof data == 'string') {
            if (data == '2') {
                if (obj.viewerConnected == false) {
                    if (obj.agent != null) {
                        if (obj.protocolOptions != null) { obj.sendToAgent(JSON.stringify(obj.protocolOptions)); } // Send connection options
                        obj.sendToAgent('2'); // Send remote desktop connect
                    }
                    obj.viewerConnected = true;
                }
                return;
            }
            var json = null;
            try { json = JSON.parse(data); } catch (ex) { }
            if (json == null) return;
            if ((json.ctrlChannel == '102938') && (json.type == 'kvmack')) { kvmAckControl(viewer, json, data.length); return; } // Viewer ACK negotiation, terminated here
            if ((json.type == 'options') && (obj.protocolOptions == null)) { obj.protocolOptions = json; }
            if (json.ctrlChannel == '102938') {
                if ((json.type == 'lock') && (viewer.viewOnly == false)) { obj.sendToAgent('{"ctrlChannel":"102938","type":"lock"}'); } // Account lock support
                if ((json.type == 'autolock') && (viewer.viewOnly == false) && (typeof json.value == 'boolean')) { obj.sendToAgent('{"ctrlChannel":"102938","type":"autolock","value":' + json.value + '}'); } // Lock on disconnect
            }
            return;
        }

        //console.log('ViewerData', data.length, typeof data, data);
        if (typeof data != 'object') return;
        // Viewer ACK range: recognised as soon as the command is readable and terminated here before any other check, so an incomplete
        // header from an active viewer is a violation like any other malformed ACK
        if ((data.length >= 2) && (data.readUInt16BE(0) >= KVM_ACK_RANGE_LO) && (data.readUInt16BE(0) <= KVM_ACK_RANGE_HI)) { kvmAckFrame(viewer, data.readUInt16BE(0), (data.length >= 4) ? data.readUInt16BE(2) : -1, data); return; }
        if (data.length < 4) return; // Ignore all control traffic for now (WebRTC)
        var command = data.readUInt16BE(0);
        var cmdsize = data.readUInt16BE(2);
        if (data.length != cmdsize) return; // Invalid command length

        //console.log('ViewerData', data.length, command, cmdsize);
        switch (command) {
            case 1: // Key Events, forward to agent
                if (viewer.viewOnly == false) { obj.sendToAgent(data); }
                break;
            case 2: // Mouse events, forward to agent
                if (viewer.viewOnly == false) { obj.sendToAgent(data); }
                break;
            case 5: // Compression
                if (data.length < 10) return;
                viewer.imageType = data[4]; // Image type: 1 = JPEG, 2 = PNG, 3 = TIFF, 4 = WebP
                viewer.imageCompression = data[5];
                viewer.imageScaling = data.readUInt16BE(6);
                viewer.imageFrameRate = data.readUInt16BE(8);
                viewer.imageBudget = (data.length >= 12) ? data.readUInt16BE(10) : null; // Optional bandwidth budget in 100 kbit/s units, only in the 12 byte form
                //console.log('Viewer-Compression', viewer.imageType, viewer.imageCompression, viewer.imageScaling, viewer.imageFrameRate, viewer.imageBudget);
                
                // See if this changes anything
                var viewersimageType = null;
                var viewersimageCompression = null;
                var viewersimageScaling = null;
                var viewersimageFrameRate = null;
                for (var i in obj.viewers) {
                    if (viewersimageType == null) { viewersimageType = obj.viewers[i].imageType; } else if (obj.viewers[i].imageType != viewersimageType) { viewersimageType = 1; }; // Default to JPEG if viewers has different image formats
                    if ((viewersimageCompression == null) || (obj.viewers[i].imageCompression > viewersimageCompression)) { viewersimageCompression = obj.viewers[i].imageCompression; };
                    if ((viewersimageScaling == null) || (obj.viewers[i].imageScaling > viewersimageScaling)) { viewersimageScaling = obj.viewers[i].imageScaling; };
                    if ((viewersimageFrameRate == null) || (obj.viewers[i].imageFrameRate < viewersimageFrameRate)) { viewersimageFrameRate = obj.viewers[i].imageFrameRate; };
                }
                var viewersimageBudget = commonBudget();
                if ((obj.imageCompression != viewersimageCompression) || (obj.imageScaling != viewersimageScaling) || (obj.imageFrameRate != viewersimageFrameRate) || (obj.imageBudget !== viewersimageBudget)) {
                    // Update and send to agent new compression settings
                    obj.imageType = viewersimageType;
                    obj.imageCompression = viewersimageCompression;
                    obj.imageScaling = viewersimageScaling;
                    obj.imageFrameRate = viewersimageFrameRate
                    obj.imageBudget = viewersimageBudget;
                    //console.log('Send-Agent-Compression', obj.imageType, obj.imageCompression, obj.imageScaling, obj.imageFrameRate, obj.imageBudget);
                    sendCompressionToAgent();
                }
                break;
            case 6: // Refresh, handle this on the server
                //console.log('Viewer-Refresh');
                viewer.dataPtr = obj.firstData; // Start over
                if (viewer.sending == false) { sendViewerNext(viewer); }
                break;
            case 8: // Pause and unpause
                if (data.length != 5) break;
                var pause = data[4]; // 0 = Unpause, 1 = Pause
                if (viewer.desktopPaused == (pause == 1)) break;
                viewer.desktopPaused = (pause == 1);
                //console.log('Viewer-' + ((pause == 1)?'Pause':'UnPause'));
                var viewersPaused = true;
                for (var i in obj.viewers) { if (obj.viewers[i].desktopPaused == false) { viewersPaused = false; }; }
                if (viewersPaused != obj.desktopPaused) {
                    obj.desktopPaused = viewersPaused;
                    //console.log('Send-Agent-' + ((viewersPaused == true) ? 'Pause' : 'UnPause'));
                    data[4] = (viewersPaused == true) ? 1 : 0;
                    obj.sendToAgent(data);
                }
                break;
            case 10: // CTRL-ALT-DEL, forward to agent
                if (viewer.viewOnly == false) { obj.sendToAgent(data); }
                break;
            case 12: // SET DISPLAY, forward to agent
                if (viewer.viewOnly == false) { obj.sendToAgent(data); }
                break;
            case 14: // Touch setup
                break;
            case 82: // Request display information
                if (obj.lastDisplayLocationData != null) { obj.sendToAgent(obj.lastDisplayLocationData); }
                break;
            case 85: // Unicode Key Events, forward to agent
                if (viewer.viewOnly == false) { obj.sendToAgent(data); }
                break;
            case 87: // Remote input lock, forward to agent
                if (viewer.viewOnly == false) { obj.sendToAgent(data); }
                break;
            default:
                console.log('Un-handled viewer command: ' + command);
                break;
        }
    }

    // Process incoming agent data
    obj.processAgentData = function (data) {
        if ((typeof data != 'object') || (data.length < 4)) {
            if (typeof data == 'string') {
                var json = null;
                try { json = JSON.parse(data); } catch (ex) { }
                if (json == null) return;
                if (json.type == 'console') {
                    // This is a console message, store it and forward this to all viewers
                    if (json.msg != null) { obj.lastConsoleMessage = data; } else { obj.lastConsoleMessage = null; }
                    obj.sendToAllViewers(data);
                }
                // All other control messages (notably WebRTC), are ignored for now.
            }
            return; // Ignore all other traffic
        }
        const jumboData = data;
        var command = data.readUInt16BE(0);
        var cmdsize = data.readUInt16BE(2);
        //console.log('AgentData', data.length, command, cmdsize);
        // Malformed agent frames are dropped through one path: counted in badFrames, the first 10 written to the debug log
        function badFrame(cmd, declared, actual) {
            stat('badFrames');
            if (obj.badFramesLogged < 10) { obj.badFramesLogged++; debug('dropped malformed agent frame cmd ' + cmd + ', declared ' + declared + ', actual ' + actual); }
        }
        if ((command == 27) && (cmdsize == 8)) {
            // Jumbo packet
            if (data.length < 12) { badFrame(27, 12, data.length); return; } // a jumbo header without the inner command
            command = data.readUInt16BE(8);
            cmdsize = data.readUInt32BE(4);
            // The agent pads jumbo packets up to an 8-byte boundary, so data.length is
            // usually 1..7 bytes longer than (cmdsize + 8). The previous exact-equality
            // check classified those complete frames as partial and dropped them.
            if (data.length >= (cmdsize + 8)) {
                data = data.slice(8, cmdsize + 8);
            } else {
                badFrame(command, cmdsize + 8, data.length); // partial jumbo: one websocket message is one command, the rest never comes
                return;
            }
        }

        // Framing rule V: every frame that is stored for or forwarded to viewers must parse in the browser to a length it actually has.
        // This also protects legacy viewers: a frame declaring more than it carries makes the browser swallow the following frames.
        if ((command == 3) || (command == 7) || (command == 11) || (command == 12) || (command == 17) || (command == 18) || (command == 65) || (command == 82) || (command == 87) || (command == 88)) {
            const outgoing = (command == 3) ? jumboData : data; // tiles are stored as received (jumbo header included), the others as unwrapped
            if (viewerFrameOk(outgoing) != command) { badFrame(command, cmdsize, outgoing.length); return; }
        }

        switch (command) {
            case 3: // Tile, check dimentions and store
                if ((data.length < 10) || (obj.lastData == null)) break;
                var x = data.readUInt16BE(4), y = data.readUInt16BE(6);
                var dimensions = require('image-size').imageSize(data.slice(8));
                var sx = (x / 16), sy = (y / 16), sw = (dimensions.width / 16), sh = (dimensions.height / 16);
                obj.counter++;
                
                // Keep a reference to this image & how many tiles it covers
                obj.images[obj.counter] = { next: null, prev: obj.lastData, data: jumboData };
                obj.images[obj.lastData].next = obj.counter;
                obj.lastData = obj.counter;
                obj.imagesCounters[obj.counter] = (sw * sh);
                obj.imagesCount++;
                obj.imagesBytes += jumboData.length;
                if (obj.imagesCount == 2000000000) { obj.imagesCount = 1; } // Loop the counter if needed

                //console.log('Adding Image ' + obj.counter, x, y, dimensions.width, dimensions.height);

                // Update the screen with the correct pointers.
                for (var i = 0; i < sw; i++) {
                    for (var j = 0; j < sh; j++) {
                        var k = ((obj.swidth * (j + sy)) + (i + sx));
                        const oi = obj.screen[k];
                        obj.screen[k] = obj.counter;
                        if ((oi != null) && (--obj.imagesCounters[oi] == 0)) {
                            // Remove data from the link list
                            obj.imagesCount--;
                            var d = obj.images[oi];
                            obj.imagesBytes -= d.data.length;
                            //console.log('Removing Image', oi, obj.images[oi].prev, obj.images[oi].next);
                            obj.images[d.prev].next = d.next;
                            obj.images[d.next].prev = d.prev;
                            delete obj.images[oi];
                            delete obj.imagesCounters[oi];

                            // If any viewers are currently on image "oi" must be moved to "d.next"
                            for (var l in obj.viewers) { const v = obj.viewers[l]; if (v.dataPtr == oi) { v.dataPtr = d.next; } }
                        }
                    }
                }

                // Any viewer on dataPtr null, change to this image
                for (var i in obj.viewers) {
                    const v = obj.viewers[i];
                    if (v.dataPtr == null) { v.dataPtr = obj.counter; if (v.sending == false) { sendViewerNext(v); } }
                }

                // Under cache pressure, ACK viewers that are behind become slow viewers again (they may pause the agent)
                if (cachePressure()) { for (var i in obj.viewers) { checkViewerOverflow(obj.viewers[i]); } }

                // Debug, display the link list
                //var xx = '', xptr = obj.firstData;
                //while (xptr != null) { xx += '>' + xptr; xptr = obj.images[xptr].next; }
                //console.log('list', xx);
                //console.log('images', obj.imagesCount);
                
                break;
            case 4: // Tile Copy, do nothing.
                break;
            case 7: // Screen Size, clear the screen state and compute the tile count
                if (data.length < 8) break;
                if ((obj.width === data.readUInt16BE(4)) && (obj.height === data.readUInt16BE(6))) break; // Same screen size as before, skip this.
                obj.counter++;
                obj.lastScreenSizeCmd = data;
                obj.lastScreenSizeCounter = obj.counter;
                obj.width = data.readUInt16BE(4);
                obj.height = data.readUInt16BE(6);
                obj.swidth = obj.width / 16;
                obj.sheight = obj.height / 16;
                if (Math.floor(obj.swidth) != obj.swidth) { obj.swidth = Math.floor(obj.swidth) + 1; }
                if (Math.floor(obj.sheight) != obj.sheight) { obj.sheight = Math.floor(obj.sheight) + 1; }
                
                // Reset the display
                obj.screen = new Array(obj.swidth * obj.sheight);
                obj.imagesCount = 0;
                obj.imagesBytes = 0;
                obj.imagesCounters = {};
                obj.images = {};
                obj.images[obj.counter] = { next: null, prev: null, data: data };
                obj.firstData = obj.counter;
                obj.lastData = obj.counter;
                
                // Add viewers must be set to start at "obj.counter"
                for (var i in obj.viewers) {
                    const v = obj.viewers[i];
                    v.dataPtr = obj.counter;
                    if (v.sending == false) { sendViewerNext(v); }
                }

                //console.log("ScreenSize", obj.width, obj.height, obj.swidth, obj.sheight, obj.swidth * obj.sheight);
                break;
            case 11: // GetDisplays
                // Store and send this to all viewers right away
                obj.lastDisplayInfoData = data;
                obj.sendToAllInputViewers(data);
                break;
            case 12: // SetDisplay
                obj.sendToAllInputViewers(data);
                break;
            case 14: // KVM_INIT_TOUCH
                break;
            case 15: // KVM_TOUCH
                break;
            case 17: // MNG_KVM_MESSAGE
                // Send this to all viewers right away
                obj.sendToAllViewers(data);
                break;
            case 18: // MNG_KVM_KEYSTATE
                // Store and send this to all viewers right away
                obj.lastKeyState = data;
                obj.sendToAllInputViewers(data);
                break;
            case 65: // Alert
                // Send this to all viewers right away
                obj.sendToAllViewers(data);
                break;
            case 82:
                // Display information
                if ((data.length < 14) || (((data.length - 4) % 10) != 0)) break; // Command must be 14 bytes and have header + 10 byte for each display.
                obj.lastDisplayLocationData = data;
                obj.sendToAllInputViewers(data);
                break;
            case 87: // MNG_KVM_INPUT_LOCK
                // Send this to all viewers right away
                // This will update all views on the current state of the input lock
                obj.sendToAllInputViewers(data);
                break;
            case 88: // MNG_KVM_MOUSE_CURSOR
                // Send this to all viewers right away
                obj.sendToAllInputViewers(data);
                break;
            default:
                console.log('Un-handled agent command: ' + command + ', length: ' + cmdsize);
                break;
        }
    }

    // ---- Viewer ACK ----

    function kvmAckState() {
        return {
            state: 0, reason: null, permanent: false, activations: 0, requests: 0, lastEpoch: 0, epoch: 0, seq: 0,
            ring: [], head: 0, inflightBytes: 0, lastAckE: 0, lastAckS: 0,
            delivered: 0, deliveredTime: 0, firstSentTime: 0, lastProgress: 0, stalled: false, win: 0, minRtt: null, rate: {}, acks: [],
            tokens: KVM_ACK_RATE, tokenTime: 0, dropped: 0, stray: 0, timeouts: 0, violations: 0, floods: 0, stalls: 0, offAt: 0
        };
    }
    function kvmAckCount(ka) { return ka.ring.length - ka.head; }
    function kvmAckSend(viewer, msg) { obj.sendToViewer(viewer, JSON.stringify(Object.assign({ ctrlChannel: '102938', type: 'kvmack', v: 1 }, msg))); }
    function kvmAckWindow(ka, now) {
        const c = obj.kvmAck, maxRate = kvmFilterGet(ka.rate, now, 2000, true);
        if (maxRate == null) return c.initialwindow;
        return Math.min(c.maxwindow, Math.max(c.minwindow, Math.round(maxRate * ((ka.minRtt || 0) + c.queuedelay))));
    }

    // kvmack control message from a viewer: request (op "req") or a client side stop (op "off")
    function kvmAckControl(viewer, json, length) {
        if ((obj.kvmAck == null) || (obj.viewers == null) || (obj.viewers.indexOf(viewer) < 0)) return;
        if ((typeof json != 'object') || Array.isArray(json) || (length > KVM_ACK_MAX_REQUEST_LENGTH) || (json.v !== 1)) return;
        var ka = viewer.kvmAck;
        if (ka == null) { ka = viewer.kvmAck = kvmAckState(); }
        if (++ka.requests > KVM_ACK_MAX_REQUESTS) return;
        if (json.op === 'off') { if (ka.state === 1) { kvmAckFallback(viewer, 'client'); } return; }
        if ((json.op !== 'req') || (ka.state === 1)) return; // a second request while active changes nothing
        const now = obj.now();
        if ((ka.activations >= KVM_ACK_MAX_ACTIVATIONS) || ((ka.state === 2) && (ka.permanent || (ka.reason !== 'timeout') || ((now - ka.offAt) < KVM_ACK_COOLDOWN)))) {
            kvmAckSend(viewer, { op: 'off', reason: 'refused' });
            debug('KVM ACK request refused (' + peerIp(viewer) + ')');
            return;
        }
        ka.state = 1; ka.reason = null; ka.activations++;
        ka.epoch = kvmAckNext(ka.lastEpoch); ka.seq = 0;
        ka.ring = []; ka.head = 0; ka.inflightBytes = 0; ka.lastAckE = 0; ka.lastAckS = 0;
        ka.delivered = 0; ka.deliveredTime = now; ka.firstSentTime = now; ka.lastProgress = now; ka.stalled = false;
        ka.minRtt = null; ka.rate = {}; ka.acks = []; ka.win = obj.kvmAck.initialwindow;
        ka.tokens = KVM_ACK_RATE; ka.tokenTime = now; ka.dropped = 0;
        // Counting starts here: any image frame handed to ws.send from now on follows this message on the wire, because sendViewerNext
        // drains sendQueue (where this message waits if the viewer is busy) before it sends the next image.
        kvmAckSend(viewer, { op: 'on', epoch: ka.epoch, seq: 0 });
        stat('kvmAckOn');
        debug('KVM ACK on (' + peerIp(viewer) + '), epoch ' + ka.epoch);
        if (obj.kvmAckTimer == null) { obj.kvmAckTimer = setInterval(kvmAckTick, 1000); if (obj.kvmAckTimer.unref) { obj.kvmAckTimer.unref(); } }
    }

    // Called by sendViewerNext before an image frame goes to a viewer in ACK mode. Returns false if the window is full.
    function kvmAckAdmit(viewer, image) {
        const ka = viewer.kvmAck, len = image.data.length, count = kvmAckCount(ka), now = obj.now();
        if ((count > 0) && ((count >= obj.kvmAck.tiles) || ((ka.inflightBytes + len) > ka.win))) {
            if (!ka.stalled) { ka.stalled = true; ka.stalls++; stat('kvmAckStall'); }
            return false;
        }
        ka.stalled = false;
        if (count === 0) { ka.deliveredTime = now; ka.firstSentTime = now; ka.lastProgress = now; ka.win = kvmAckWindow(ka, now); } // restart after idle
        if (image.data.readUInt16BE(0) === 7) { ka.epoch = kvmAckNext(ka.epoch); ka.seq = 0; } // the screen frame opens a new epoch
        ka.seq = kvmAckNext(ka.seq);
        ka.ring.push({ epoch: ka.epoch, seq: ka.seq, bytes: len, sendTime: now, delivered: ka.delivered, deliveredTime: ka.deliveredTime, firstSentTime: ka.firstSentTime, appLimited: (image.next == null) });
        ka.inflightBytes += len;
        return true;
    }

    // A binary frame in 0x4B40-0x4B4F from a viewer. Nothing in this range is ever forwarded.
    function kvmAckFrame(viewer, command, declared, data) {
        const ka = viewer.kvmAck;
        if ((ka == null) || (ka.state !== 1)) { if (ka != null) { ka.stray++; } return; } // late ACK after off, or never asked: ignored
        const now = obj.now();
        ka.tokens = Math.min(KVM_ACK_RATE, ka.tokens + ((now - ka.tokenTime) * KVM_ACK_RATE / 1000));
        ka.tokenTime = now;
        if (ka.tokens < 1) { if (++ka.dropped > KVM_ACK_FLOOD) { kvmAckFallback(viewer, 'flood'); } return; }
        ka.tokens -= 1;
        if ((command !== KVM_ACK_CMD) || (declared !== 12) || (data.length !== 12)) { kvmAckFallback(viewer, 'violation'); return; }
        const e = data.readUInt32BE(4), s = data.readUInt32BE(8);
        if ((e === 0) || (s === 0)) { kvmAckFallback(viewer, 'violation'); return; }
        var i = -1;
        for (var j = ka.head; j < ka.ring.length; j++) { if ((ka.ring[j].epoch === e) && (ka.ring[j].seq === s)) { i = j; break; } }
        if (i < 0) {
            if ((e === ka.lastAckE) && (s === ka.lastAckS)) return; // duplicate
            kvmAckFallback(viewer, 'violation'); // ahead of what was sent, regressed, or an unknown epoch
            return;
        }
        var freed = 0;
        for (var k = ka.head; k <= i; k++) { freed += ka.ring[k].bytes; }
        const x = ka.ring[i];
        ka.head = i + 1;
        if (ka.head >= ka.ring.length) { ka.ring = []; ka.head = 0; } else if ((ka.head > 256) && ((ka.head * 2) > ka.ring.length)) { ka.ring = ka.ring.slice(ka.head); ka.head = 0; }
        ka.inflightBytes -= freed;
        ka.delivered += freed;
        ka.lastAckE = e; ka.lastAckS = s; ka.lastProgress = now;

        // Delivery rate over an interval that covers every byte credited since x was sent (x is the newest frame freed by this ACK)
        const credited = ka.delivered - x.delivered;
        const interval = Math.max(now - x.deliveredTime, x.sendTime - x.firstSentTime);
        ka.deliveredTime = now; ka.firstSentTime = x.sendTime;
        // The minimum RTT is kept for the whole activation, not over a sliding window: the window keeps a standing queue of about queueDelay,
        // so without a drain phase a sliding minimum would absorb that queue and grow the window by queueDelay every period. An RTT that later
        // rises only makes the window smaller than ideal (less throughput, never more queue).
        const rtt = now - x.sendTime;
        if ((ka.minRtt == null) || (rtt < ka.minRtt)) { ka.minRtt = rtt; }
        // Recent ACK rate: bytes acknowledged since the last ACK at least 500 ms old. A frame sent while the link was faster carries a snapshot
        // from that time, so its delivery-rate sample stays high for seconds after the link slows down; the recent rate follows a drop within
        // 500 ms, and it is not inflated by an ACK burst (the bytes it counts were delivered over at least as long as the span).
        ka.acks.push({ t: now, d: ka.delivered });
        while ((ka.acks.length > 2) && (ka.acks[1].t <= (now - 500))) { ka.acks.shift(); }
        const base = ((ka.acks.length > 1) && (ka.acks[0].t <= (now - 500))) ? ka.acks[0] : null;
        if (interval >= Math.max(5, ka.minRtt)) {
            var rate = credited / interval;
            if (base != null) { rate = Math.min(rate, (ka.delivered - base.d) / (now - base.t)); }
            const maxRate = kvmFilterGet(ka.rate, now, 2000, true);
            if (!x.appLimited || (maxRate == null) || (rate > maxRate)) { kvmFilterAdd(ka.rate, rate, now, 2000, true); } // app-limited samples only raise
        }
        ka.win = kvmAckWindow(ka, now);

        const count = kvmAckCount(ka);
        if (ka.stalled && ((count === 0) || ((count < obj.kvmAck.tiles) && (ka.inflightBytes < ka.win)))) {
            ka.stalled = false;
            if (viewer.sending === false) { sendViewerNext(viewer); }
        }
    }

    // Leave ACK mode for one viewer; its stream continues with the legacy flow control
    function kvmAckFallback(viewer, reason) {
        const ka = viewer.kvmAck;
        if ((ka == null) || (ka.state !== 1)) return;
        const count = kvmAckCount(ka), bytes = ka.inflightBytes;
        ka.state = 2; ka.reason = reason; ka.offAt = obj.now(); ka.lastEpoch = ka.epoch;
        ka.ring = []; ka.head = 0; ka.inflightBytes = 0;
        const wasStalled = ka.stalled;
        ka.stalled = false;
        if (reason !== 'timeout') { ka.permanent = true; ka.activations = KVM_ACK_MAX_ACTIVATIONS; }
        if (reason === 'timeout') { ka.timeouts++; stat('kvmAckTimeout'); }
        else if (reason === 'violation') { ka.violations++; stat('kvmAckViolation'); }
        else if (reason === 'flood') { ka.floods++; stat('kvmAckFlood'); }
        else { stat('kvmAckClient'); }
        if (reason !== 'client') { kvmAckSend(viewer, { op: 'off', reason: reason }); }
        debug('KVM ACK off, ' + reason + ' (' + peerIp(viewer) + '), in flight ' + count + ' / ' + bytes + ' bytes, window ' + ka.win);
        if (wasStalled && (viewer.sending === false) && (obj.viewers != null)) { sendViewerNext(viewer); }
    }

    // Once a second while a viewer is in ACK mode: a viewer without progress for the timeout falls back
    function kvmAckTick() {
        if (obj.viewers == null) { if (obj.kvmAckTimer != null) { clearInterval(obj.kvmAckTimer); obj.kvmAckTimer = null; } return; }
        const now = obj.now(), viewers = obj.viewers.slice();
        var active = 0;
        for (var i = 0; i < viewers.length; i++) {
            const ka = viewers[i].kvmAck;
            if ((ka == null) || (ka.state !== 1)) continue;
            if ((kvmAckCount(ka) > 0) && ((now - ka.lastProgress) > (obj.kvmAck.timeout * 1000))) { kvmAckFallback(viewers[i], 'timeout'); } else { active++; }
        }
        if ((active === 0) && (obj.kvmAckTimer != null)) { clearInterval(obj.kvmAckTimer); obj.kvmAckTimer = null; }
    }
    obj.kvmAckTick = kvmAckTick;

    function startRecording(domain, start, func) {
        if ((obj.pendingRecording == 1) || (obj.recordingFile != null)) { func(true); return; } // Check if already recording
        if (start == false) { func(false); return; } // Just skip this
        obj.pendingRecording = 1;
        var now = new Date(Date.now());
        var recFilename = 'desktopSession' + ((domain.id == '') ? '' : '-') + domain.id + '-' + now.getUTCFullYear() + '-' + parent.common.zeroPad(now.getUTCMonth() + 1, 2) + '-' + parent.common.zeroPad(now.getUTCDate(), 2) + '-' + parent.common.zeroPad(now.getUTCHours(), 2) + '-' + parent.common.zeroPad(now.getUTCMinutes(), 2) + '-' + parent.common.zeroPad(now.getUTCSeconds(), 2) + '-' + obj.nodeid.split('/')[2] + '.mcrec'
        var recFullFilename = null;
        if (domain.sessionrecording.filepath) {
            try { parent.parent.fs.mkdirSync(domain.sessionrecording.filepath); } catch (e) { }
            recFullFilename = parent.parent.path.join(domain.sessionrecording.filepath, recFilename);
        } else {
            try { parent.parent.fs.mkdirSync(parent.parent.recordpath); } catch (e) { }
            recFullFilename = parent.parent.path.join(parent.parent.recordpath, recFilename);
        }
        parent.parent.fs.open(recFullFilename, 'w', function (err, fd) {
            delete obj.pendingRecording;
            if (err != null) {
                parent.parent.debug('relay', 'Relay: Unable to record to file: ' + recFullFilename);
                func(false);
                return;
            }
            // Write the recording file header
            parent.parent.debug('relay', 'Relay: Started recording to file: ' + recFullFilename);
            var metadata = { magic: 'MeshCentralRelaySession', ver: 1, nodeid: obj.nodeid, meshid: obj.meshid, time: new Date().toLocaleString(), protocol: 2, devicename: obj.name, devicegroup: obj.meshname };
            var firstBlock = JSON.stringify(metadata);
            recordingEntry(fd, 1, 0, firstBlock, function () {
                obj.recordingFile = { fd: fd, filename: recFullFilename };
                obj.recordingFileWriting = false;
                func(true);
            });
        });
    }

    // Here, we check if we have to record the device, regardless of what user is looking at it.
    function recordingSetup(domain, func) {
        var record = false;

        // Setup session recording
        if (((domain.sessionrecording == true) || ((typeof domain.sessionrecording == 'object') && ((domain.sessionrecording.protocols == null) || (domain.sessionrecording.protocols.indexOf(2) >= 0))))) {
            record = true;

            // Check again to make sure we need to start recording
            if ((typeof domain.sessionrecording == 'object') && ((domain.sessionrecording.onlyselecteddevicegroups === true) || (domain.sessionrecording.onlyselectedusergroups === true) || (domain.sessionrecording.onlyselectedusers === true))) {
                record = false;

                // Check device group recording
                if (domain.sessionrecording.onlyselecteddevicegroups === true) {
                    var mesh = parent.meshes[obj.meshid];
                    if ((mesh.flags != null) && ((mesh.flags & 4) != 0)) { record = true; }
                }
            }
        }
        startRecording(domain, record, func);
    }

    // Record data to the recording file
    function recordData(isAgent, data, func) {
        try {
            if (obj.recordingFile != null) {
                // Write data to recording file
                recordingEntry(obj.recordingFile.fd, 2, (isAgent ? 0 : 2), data, function () { func(data); });
            } else {
                func(data);
            }
        } catch (ex) { console.log(ex); }
    }

    // Record a new entry in a recording log
    function recordingEntry(fd, type, flags, data, func, tag) {
        try {
            if (typeof data == 'string') {
                // String write
                var blockData = Buffer.from(data), header = Buffer.alloc(16); // Header: Type (2) + Flags (2) + Size(4) + Time(8)
                header.writeInt16BE(type, 0); // Type (1 = Header, 2 = Network Data)
                header.writeInt16BE(flags, 2); // Flags (1 = Binary, 2 = User)
                header.writeInt32BE(blockData.length, 4); // Size
                header.writeIntBE(new Date(), 10, 6); // Time
                var block = Buffer.concat([header, blockData]);
                parent.parent.fs.write(fd, block, 0, block.length, function () { func(fd, tag); });
                obj.recordingFileSize += block.length;
            } else {
                // Binary write
                var header = Buffer.alloc(16); // Header: Type (2) + Flags (2) + Size(4) + Time(8)
                header.writeInt16BE(type, 0); // Type (1 = Header, 2 = Network Data)
                header.writeInt16BE(flags | 1, 2); // Flags (1 = Binary, 2 = User)
                header.writeInt32BE(data.length, 4); // Size
                header.writeIntBE(new Date(), 10, 6); // Time
                var block = Buffer.concat([header, data]);
                parent.parent.fs.write(fd, block, 0, block.length, function () { func(fd, tag); });
                obj.recordingFileSize += block.length;
            }
        } catch (ex) { console.log(ex); func(fd, tag); }
    }

    // If there is a recording quota, remove any old recordings if needed
    function cleanUpRecordings() {
        if ((parent.cleanUpRecordingsActive !== true) && domain.sessionrecording && ((typeof domain.sessionrecording.maxrecordings == 'number') || (typeof domain.sessionrecording.maxrecordingsizemegabytes == 'number') || (typeof domain.sessionrecording.maxrecordingdays == 'number'))) {
            parent.cleanUpRecordingsActive = true;
            setTimeout(function () {
                var recPath = null, fs = require('fs'), now = Date.now();
                if (domain.sessionrecording.filepath) { recPath = domain.sessionrecording.filepath; } else { recPath = parent.parent.recordpath; }
                fs.readdir(recPath, function (err, files) {
                    if ((err != null) || (files == null)) { delete parent.cleanUpRecordingsActive; return; }
                    var recfiles = [];
                    for (var i in files) {
                        if (files[i].endsWith('.mcrec')) {
                            var j = files[i].indexOf('-');
                            if (j > 0) {
                                var stats = null;
                                try { stats = fs.statSync(parent.parent.path.join(recPath, files[i])); } catch (ex) { }
                                if (stats != null) { recfiles.push({ n: files[i], r: files[i].substring(j + 1), s: stats.size, t: stats.mtimeMs }); }
                            }
                        }
                    }
                    recfiles.sort(function (a, b) { if (a.r < b.r) return 1; if (a.r > b.r) return -1; return 0; });
                    var totalFiles = 0, totalSize = 0;
                    for (var i in recfiles) {
                        var overQuota = false;
                        if ((typeof domain.sessionrecording.maxrecordings == 'number') && (domain.sessionrecording.maxrecordings > 0) && (totalFiles >= domain.sessionrecording.maxrecordings)) { overQuota = true; }
                        else if ((typeof domain.sessionrecording.maxrecordingsizemegabytes == 'number') && (domain.sessionrecording.maxrecordingsizemegabytes > 0) && (totalSize >= (domain.sessionrecording.maxrecordingsizemegabytes * 1048576))) { overQuota = true; }
                        else if ((typeof domain.sessionrecording.maxrecordingdays == 'number') && (domain.sessionrecording.maxrecordingdays > 0) && (((now - recfiles[i].t) / 1000 / 60 / 60 / 24) >= domain.sessionrecording.maxrecordingdays)) { overQuota = true; }
                        if (overQuota) { fs.unlinkSync(parent.parent.path.join(recPath, recfiles[i].n)); }
                        totalFiles++;
                        totalSize += recfiles[i].s;
                    }
                    delete parent.cleanUpRecordingsActive;
                });
            }, 500);
        }
    }

    // Get node information
    parent.db.Get(nodeid, function (err, nodes) {
        if ((err != null) || (nodes.length != 1)) { func(null); return; }
        obj.meshid = nodes[0].meshid;
        obj.icon = nodes[0].icon;
        obj.name = nodes[0].name;
        recordingSetup(domain, function () { func(obj); });
    });
    return obj;
}

function checkDeviceSharePublicIdentifier(parent, domain, nodeid, pid, extraKey, func) {
    // Check the public id
    parent.db.GetAllTypeNodeFiltered([nodeid], domain.id, 'deviceshare', null, function (err, docs) {
        if ((err != null) || (docs.length == 0)) { func(false); return; }

        // Search for the device share public identifier
        var found = false;
        for (var i = 0; i < docs.length; i++) { if ((docs[i].publicid == pid) && ((docs[i].extrakey == null) || (docs[i].extrakey === extraKey))) { found = true; } }
        func(found);
    });
}

// Exposed for the unit tests
module.exports.CreateDesktopMultiplexor = CreateDesktopMultiplexor;
module.exports.viewerFrameOk = viewerFrameOk;
module.exports.kvmAckNext = kvmAckNext;
module.exports.kvmAckConfig = kvmAckConfig;

module.exports.CreateMeshRelay = function (parent, ws, req, domain, user, cookie) {
    if ((cookie != null) && (typeof cookie.nid == 'string') && (typeof cookie.pid == 'string')) {
        checkDeviceSharePublicIdentifier(parent, domain, cookie.nid, cookie.pid, cookie.k, function (result) {
            // If the identifier if not found, close the connection
            if (result == false) { try { ws.close(); } catch (e) { } return; }
            // Public device sharing identifier found, continue as normal.
            CreateMeshRelayEx(parent, ws, req, domain, user, cookie);
        });
    } else {
        CreateMeshRelayEx(parent, ws, req, domain, user, cookie);
    }
}

// If we are in multi-server mode, the desktop multiplexor needs to be created on the server with the agent connected to it.
// So, if the agent is connected to a different server, just relay the connection to that server
function CreateMeshRelayEx(parent, ws, req, domain, user, cookie) {
    // Do validation work
    if (cookie) {
        if ((typeof cookie.expire == 'number') && (cookie.expire <= Date.now())) { delete req.query.nodeid; }
        else if (typeof cookie.nid == 'string') { req.query.nodeid = cookie.nid; }
    }
    if ((req.query.nodeid == null) || (req.query.p != '2') || (req.query.id == null) || (domain == null)) { try { ws.close(); } catch (e) { } return; } // Not is not a valid remote desktop connection.

    // Check routing if in multi-server mode
    var nodeid = req.query.nodeid;
    if (parent.parent.multiServer != null) {
        const routing = parent.parent.GetRoutingServerIdNotSelf(nodeid, 1); // 1 = MeshAgent routing type
        if (routing == null) {
            // No need to relay the connection to a different server
            return CreateMeshRelayEx2(parent, ws, req, domain, user, cookie);
        } else {
            // We must relay the connection to a different server
            return parent.parent.multiServer.createPeerRelay(ws, req, routing.serverid, req.session.userid);
        }
    } else {
        // No need to relay the connection to a different server
        return CreateMeshRelayEx2(parent, ws, req, domain, user, cookie);
    }
}

function CreateMeshRelayEx2(parent, ws, req, domain, user, cookie) {
    const currentTime = Date.now();
    var obj = {};
    obj.ws = ws;
    obj.ws.me = obj;
    obj.id = req.query.id;
    obj.nodeid = req.query.nodeid;
    obj.user = user;
    obj.ruserid = null;
    obj.req = req; // Used in multi-server.js
    obj.viewOnly = ((cookie != null) && (cookie.vo == 1)); // set view only mode
    if ((cookie != null) && (cookie.nouser == 1)) { obj.nouser = true; } // This is a relay without user authentication

    // If the domain has remote desktop viewonly set, force everyone to be in viewonly mode.
    if ((typeof domain.desktop == 'object') && (domain.desktop.viewonly == true)) { obj.viewOnly = true; }

    // Setup traffic accounting
    if (parent.trafficStats.desktopMultiplex == null) { parent.trafficStats.desktopMultiplex = { connections: 1, sessions: 0, in: 0, out: 0 }; } else { parent.trafficStats.desktopMultiplex.connections++; }
    ws._socket.bytesReadEx = 0;
    ws._socket.bytesWrittenEx = 0;

    // Setup subscription for desktop sharing public identifier
    // If the identifier is removed, drop the connection
    if ((cookie != null) && (typeof cookie.pid == 'string')) {
        obj.pid = cookie.pid;
        obj.guestName = cookie.gn;
        parent.parent.AddEventDispatch([obj.nodeid], obj);
        obj.HandleEvent = function (source, event, ids, id) { if ((event.action == 'removedDeviceShare') && (obj.pid == event.publicid)) { obj.close(); } }
    }

    // Check relay authentication
    if ((user == null) && (obj.req.query != null) && (obj.req.query.rauth != null)) {
        const rcookie = parent.parent.decodeCookie(obj.req.query.rauth, parent.parent.loginCookieEncryptionKey, 240); // Cookie with 4 hour timeout
        if (rcookie != null) { if (rcookie.ruserid != null) { obj.ruserid = rcookie.ruserid; } else if (rcookie.nouser === 1) { obj.rnouser = true; } }
        if (rcookie != null) { if (rcookie.nodeid != null) { obj.nodeid = rcookie.nodeid; } }
    }

    // If there is no authentication, drop this connection
    if ((obj.id != null) && (obj.user == null) && (obj.ruserid == null) && (obj.nouser !== true) && (obj.rnouser !== true)) { try { ws.close(); parent.parent.debug('relay', 'DesktopRelay: Connection with no authentication (' + obj.req.clientIp + ')'); } catch (e) { console.log(e); } return; }

    // Relay session count (we may remove this in the future)
    obj.relaySessionCounted = true;
    parent.relaySessionCount++;

    // Mesh Rights
    const MESHRIGHT_EDITMESH = 1;
    const MESHRIGHT_MANAGEUSERS = 2;
    const MESHRIGHT_MANAGECOMPUTERS = 4;
    const MESHRIGHT_REMOTECONTROL = 8;
    const MESHRIGHT_AGENTCONSOLE = 16;
    const MESHRIGHT_SERVERFILES = 32;
    const MESHRIGHT_WAKEDEVICE = 64;
    const MESHRIGHT_SETNOTES = 128;
    const MESHRIGHT_REMOTEVIEW = 256;

    // Site rights
    const SITERIGHT_SERVERBACKUP = 1;
    const SITERIGHT_MANAGEUSERS = 2;
    const SITERIGHT_SERVERRESTORE = 4;
    const SITERIGHT_FILEACCESS = 8;
    const SITERIGHT_SERVERUPDATE = 16;
    const SITERIGHT_LOCKED = 32;

    // Clean a IPv6 address that encodes a IPv4 address
    function cleanRemoteAddr(addr) { if (addr.startsWith('::ffff:')) { return addr.substring(7); } else { return addr; } }

    // Disconnect this agent
    obj.close = function (arg) {
        if (obj.ws == null) return; // Already closed.

        // Close the connection
        if ((arg == 1) || (arg == null)) { try { ws.close(); parent.parent.debug('relay', 'DesktopRelay: Soft disconnect (' + obj.req.clientIp + ')'); } catch (e) { console.log(e); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); parent.parent.debug('relay', 'DesktopRelay: Hard disconnect (' + obj.req.clientIp + ')'); } catch (e) { console.log(e); } } // Hard close, close the TCP socket
        if (obj.relaySessionCounted) { parent.relaySessionCount--; delete obj.relaySessionCounted; }
        if ((obj.deskMultiplexor != null) && (typeof obj.deskMultiplexor == 'object') && (obj.deskMultiplexor.removePeer(obj) == true)) { delete parent.desktoprelays[obj.nodeid]; }

        // Aggressive cleanup
        delete obj.id;
        delete obj.ws;
        delete obj.req;
        delete obj.user;
        delete obj.nodeid;
        delete obj.ruserid;
        delete obj.expireTimer;
        delete obj.deskMultiplexor;

        // Clear timers if present
        if (obj.pingtimer != null) { clearInterval(obj.pingtimer); delete obj.pingtimer; }
        if (obj.pongtimer != null) { clearInterval(obj.pongtimer); delete obj.pongtimer; }

        // Unsubscribe
        if (obj.pid != null) { parent.parent.RemoveAllEventDispatch(obj); }
    };

    obj.sendAgentMessage = function (command, userid, domainid) {
        var rights, mesh;
        if (command.nodeid == null) return false;
        var user = null;
        if (userid != null) { user = parent.users[userid]; if (user == null) return false; }
        var splitnodeid = command.nodeid.split('/');
        // Check that we are in the same domain and the user has rights over this node.
        if ((splitnodeid[0] == 'node') && (splitnodeid[1] == domainid)) {
            // Get the user object
            // See if the node is connected
            var agent = parent.wsagents[command.nodeid];
            if (agent != null) {
                // Check if we have permission to send a message to that node
                if (userid == null) { rights = MESHRIGHT_REMOTECONTROL; } else { rights = parent.GetNodeRights(user, agent.dbMeshKey, agent.dbNodeKey); }
                mesh = parent.meshes[agent.dbMeshKey];
                if ((rights != null) && (mesh != null) || ((rights & 16) != 0)) { // TODO: 16 is console permission, may need more gradular permission checking
                    if (ws.sessionId) { command.sessionid = ws.sessionId; }   // Set the session id, required for responses.
                    command.rights = rights;            // Add user rights flags to the message
                    if ((command.rights != 0xFFFFFFFF) && ((command.rights & 0x100) != 0)) { command.rights -= 0x100; } // Since the multiplexor will enforce view-only, remove MESHRIGHT_REMOTEVIEWONLY
                    if (typeof command.consent == 'number') { command.consent = command.consent | mesh.consent; } else { command.consent = mesh.consent; } // Add user consent
                    if (typeof domain.userconsentflags == 'number') { command.consent |= domain.userconsentflags; } // Add server required consent flags
                    if (user != null) {
                        command.username = user.name;       // Add user name
                        command.realname = user.realname;   // Add real name
                    }
                    if (typeof domain.desktopprivacybartext == 'string') { command.privacybartext = domain.desktopprivacybartext; } // Privacy bar text
                    if ((typeof domain.desktopprivacybarmaxwidth == 'number') && (domain.desktopprivacybarmaxwidth > 0)) { command.privacybarmaxwidth = domain.desktopprivacybarmaxwidth; } // Privacy bar maximum width
                    delete command.nodeid;              // Remove the nodeid since it's implyed.
                    agent.send(JSON.stringify(command));
                    return true;
                }
            } else {
                // Check if a peer server is connected to this agent
                var routing = parent.parent.GetRoutingServerIdNotSelf(command.nodeid, 1); // 1 = MeshAgent routing type
                if (routing != null) {
                    // Check if we have permission to send a message to that node
                    if (userid == null) { rights = MESHRIGHT_REMOTECONTROL; } else { rights = parent.GetNodeRights(user, routing.meshid, command.nodeid); }
                    mesh = parent.meshes[routing.meshid];
                    if (rights != null || ((rights & 16) != 0)) { // TODO: 16 is console permission, may need more gradular permission checking
                        if (ws.sessionId) { command.fromSessionid = ws.sessionId; }   // Set the session id, required for responses.
                        command.rights = rights;                // Add user rights flags to the message
                        if ((command.rights != 0xFFFFFFFF) && ((command.rights & 0x00000100) != 0)) { command.rights -= 0x00000100; } // Since the multiplexor will enforce view-only, remove MESHRIGHT_REMOTEVIEWONLY
                        if (typeof command.consent == 'number') { command.consent = command.consent | mesh.consent; } else { command.consent = mesh.consent; } // Add user consent
                        if (typeof domain.userconsentflags == 'number') { command.consent |= domain.userconsentflags; } // Add server required consent flags
                        if (user != null) {
                            command.username = user.name;           // Add user name
                            command.realname = user.realname;       // Add real name
                        }
                        if (typeof domain.desktopprivacybartext == 'string') { command.privacybartext = domain.desktopprivacybartext; } // Privacy bar text
                        if ((typeof domain.desktopprivacybarmaxwidth == 'number') && (domain.desktopprivacybarmaxwidth > 0)) { command.privacybarmaxwidth = domain.desktopprivacybarmaxwidth; } // Privacy bar maximum width
                        parent.parent.multiServer.DispatchMessageSingleServer(command, routing.serverid);
                        return true;
                    }
                }
            }
        }
        return false;
    };

    // Send a PING/PONG message
    function sendPing() {
        try { obj.ws.send('{"ctrlChannel":"102938","type":"ping"}'); } catch (ex) { }
        try { if (obj.peer != null) { obj.peer.ws.send('{"ctrlChannel":"102938","type":"ping"}'); } } catch (ex) { }
    }
    function sendPong() {
        try { obj.ws.send('{"ctrlChannel":"102938","type":"pong"}'); } catch (ex) { }
        try { if (obj.peer != null) { obj.peer.ws.send('{"ctrlChannel":"102938","type":"pong"}'); } } catch (ex) { }
    }

    function performRelay(retryCount) {
        if ((obj.id == null) || (retryCount > 20)) { try { obj.close(); } catch (e) { } return null; } // Attempt to connect without id, drop this.
        if (retryCount == 0) { ws._socket.setKeepAlive(true, 240000); } // Set TCP keep alive

        /*
        // Validate that the id is valid, we only need to do this on non-authenticated sessions.
        // TODO: Figure out when this needs to be done.
        if (user == null) {
            // Check the identifier, if running without TLS, skip this.
            var ids = obj.id.split(':');
            if (ids.length != 3) { ws.close(); delete obj.id; return null; } // Invalid ID, drop this.
            if (parent.crypto.createHmac('SHA384', parent.relayRandom).update(ids[0] + ':' + ids[1]).digest('hex') != ids[2]) { ws.close(); delete obj.id; return null; } // Invalid HMAC, drop this.
            if ((Date.now() - parseInt(ids[1])) > 120000) { ws.close(); delete obj.id; return null; } // Expired time, drop this.
            obj.id = ids[0];
        }
        */

        if (retryCount == 0) {
            // Setup the agent PING/PONG timers
            if ((typeof parent.parent.args.agentping == 'number') && (obj.pingtimer == null)) { obj.pingtimer = setInterval(sendPing, parent.parent.args.agentping * 1000); }
            else if ((typeof parent.parent.args.agentpong == 'number') && (obj.pongtimer == null)) { obj.pongtimer = setInterval(sendPong, parent.parent.args.agentpong * 1000); }

            parent.parent.debug('relay', 'DesktopRelay: Connection (' + obj.req.clientIp + ')');
        }

        // Create if needed and add this peer to the desktop multiplexor
        obj.deskMultiplexor = parent.desktoprelays[obj.nodeid];
        if (obj.deskMultiplexor == null) {
            parent.desktoprelays[obj.nodeid] = 1; // Indicate that the creating of the desktop multiplexor is pending.
            parent.parent.debug('relay', 'DesktopRelay: Creating new desktop multiplexor');
            CreateDesktopMultiplexor(parent, domain, obj.nodeid, obj.id, function (deskMultiplexor) {
                if (deskMultiplexor != null) {
                    // Desktop multiplexor was created, use it.
                    obj.deskMultiplexor = deskMultiplexor;
                    parent.desktoprelays[obj.nodeid] = obj.deskMultiplexor;
                    obj.deskMultiplexor.addPeer(obj);
                    ws._socket.resume(); // Release the traffic
                } else {
                    // An error has occured, close this connection
                    delete parent.desktoprelays[obj.nodeid];
                    ws.close();
                }
            });
        } else {
            if (obj.deskMultiplexor == 1) {
                // The multiplexor is being created, hold a little and try again. This is to prevent a possible race condition.
                setTimeout(function () { performRelay(++retryCount); }, 50);
            } else {
                // Hook up this peer to the multiplexor and release the traffic
                obj.deskMultiplexor.addPeer(obj);
                ws._socket.resume();
            }
        }
    }

    // When data is received from the mesh relay web socket
    ws.on('message', function (data) {
        // Data accounting
        parent.trafficStats.desktopMultiplex.in += (this._socket.bytesRead - this._socket.bytesReadEx);
        parent.trafficStats.desktopMultiplex.out += (this._socket.bytesWritten - this._socket.bytesWrittenEx);
        this._socket.bytesReadEx = this._socket.bytesRead;
        this._socket.bytesWrittenEx = this._socket.bytesWritten;

        // If this data was received by the agent, decode it.
        if (this.me.deskMultiplexor != null) { this.me.deskMultiplexor.processData(this.me, data); }
    });

    // If error, close both sides of the relay.
    ws.on('error', function (err) {
        //console.log('ws-error', err);
        parent.relaySessionErrorCount++;
        console.log('Relay error from ' + obj.req.clientIp + ', ' + err.toString().split('\r')[0] + '.');
        obj.close();
    });

    // If the relay web socket is closed, close both sides.
    ws.on('close', function (req) {
        // Data accounting
        parent.trafficStats.desktopMultiplex.in += (this._socket.bytesRead - this._socket.bytesReadEx);
        parent.trafficStats.desktopMultiplex.out += (this._socket.bytesWritten - this._socket.bytesWrittenEx);
        this._socket.bytesReadEx = this._socket.bytesRead;
        this._socket.bytesWrittenEx = this._socket.bytesWritten;

        //console.log('ws-close', req);
        obj.close();
    });

    // If this session has a expire time, setup the expire timer now.
    setExpireTimer();

    // Mark this relay session as authenticated if this is the user end.
    obj.authenticated = ((user != null) || (obj.nouser === true));
    if (obj.authenticated) {
        // Kick off the routing, if we have agent routing instructions, process them here.
        // Routing instructions can only be given by a authenticated user
        if ((cookie != null) && (cookie.nodeid != null) && (cookie.tcpport != null) && (cookie.domainid != null)) {
            // We have routing instructions in the cookie, but first, check user access for this node.
            parent.db.Get(cookie.nodeid, function (err, docs) {
                if (obj.req == null) return; // This connection was closed.
                if (docs.length == 0) { console.log('ERR: Node not found'); try { obj.close(); } catch (e) { } return; } // Disconnect websocket
                const node = docs[0];

                // Check if this user has permission to manage this computer
                if ((obj.nouser !== true) && ((parent.GetNodeRights(user, node.meshid, node._id) & MESHRIGHT_REMOTECONTROL) == 0)) { console.log('ERR: Access denied (1)'); try { obj.close(); } catch (e) { } return; }

                // Send connection request to agent
                const rcookieData = { nodeid: node._id, sessionExpire: req.session && req.session.expire };
                if (user != null) { rcookieData.ruserid = user._id; } else if (obj.nouser === true) { rcookieData.nouser = 1; }
                const rcookie = parent.parent.encodeCookie(rcookieData, parent.parent.loginCookieEncryptionKey);
                if (obj.id == undefined) { obj.id = ('' + Math.random()).substring(2); } // If there is no connection id, generate one.
                const command = { nodeid: node._id, action: 'msg', type: 'tunnel', value: '*/meshrelay.ashx?id=' + obj.id + '&rauth=' + rcookie, tcpport: cookie.tcpport, tcpaddr: cookie.tcpaddr };
                parent.parent.debug('relay', 'Relay: Sending agent tunnel command: ' + JSON.stringify(command));
                if (obj.sendAgentMessage(command, user ? user._id : null, cookie.domainid) == false) { delete obj.id; parent.parent.debug('relay', 'Relay: Unable to contact this agent (' + obj.req.clientIp + ')'); }
                performRelay(0);
            });
            return obj;
        } else if ((obj.req.query.nodeid != null) && ((obj.req.query.tcpport != null) || (obj.req.query.udpport != null))) {
            // We have routing instructions in the URL arguments, but first, check user access for this node.
            parent.db.Get(obj.req.query.nodeid, function (err, docs) {
                if (obj.req == null) return; // This connection was closed.
                if (docs.length == 0) { console.log('ERR: Node not found'); try { obj.close(); } catch (e) { } return; } // Disconnect websocket
                const node = docs[0];

                // Check if this user has permission to manage this computer
                if ((obj.nouser !== true) && ((parent.GetNodeRights(user, node.meshid, node._id) & MESHRIGHT_REMOTECONTROL) == 0)) { console.log('ERR: Access denied (2)'); try { obj.close(); } catch (e) { } return; }

                // Send connection request to agent
                if (obj.id == null) { obj.id = ('' + Math.random()).substring(2); } // If there is no connection id, generate one.
                const rcookieData = { nodeid: node._id, sessionExpire: req.session && req.session.expire };
                if (user != null) { rcookieData.ruserid = user._id; } else if (obj.nouser === true) { rcookieData.nouser = 1; }
                const rcookie = parent.parent.encodeCookie(rcookieData, parent.parent.loginCookieEncryptionKey);

                if (obj.req.query.tcpport != null) {
                    const command = { nodeid: node._id, action: 'msg', type: 'tunnel', value: '*/meshrelay.ashx?id=' + obj.id + '&rauth=' + rcookie, tcpport: obj.req.query.tcpport, tcpaddr: ((obj.req.query.tcpaddr == null) ? '127.0.0.1' : obj.req.query.tcpaddr) };
                    parent.parent.debug('relay', 'Relay: Sending agent TCP tunnel command: ' + JSON.stringify(command));
                    if (obj.sendAgentMessage(command, user ? user._id : null, domain.id) == false) { delete obj.id; parent.parent.debug('relay', 'Relay: Unable to contact this agent (' + obj.req.clientIp + ')'); }
                } else if (obj.req.query.udpport != null) {
                    const command = { nodeid: node._id, action: 'msg', type: 'tunnel', value: '*/meshrelay.ashx?id=' + obj.id + '&rauth=' + rcookie, udpport: obj.req.query.udpport, udpaddr: ((obj.req.query.udpaddr == null) ? '127.0.0.1' : obj.req.query.udpaddr) };
                    parent.parent.debug('relay', 'Relay: Sending agent UDP tunnel command: ' + JSON.stringify(command));
                    if (obj.sendAgentMessage(command, user ? user._id : null, domain.id) == false) { delete obj.id; parent.parent.debug('relay', 'Relay: Unable to contact this agent (' + obj.req.clientIp + ')'); }
                }
                performRelay(0);
            });
            return obj;
        } else if ((cookie != null) && (cookie.nid != null) && (typeof cookie.r == 'number') && (typeof cookie.cf == 'number') && (typeof cookie.gn == 'string')) {
            // We have routing instructions in the cookie, but first, check user access for this node.
            parent.db.Get(cookie.nid, function (err, docs) {
                if (obj.req == null) return; // This connection was closed.
                if (docs.length == 0) { console.log('ERR: Node not found'); try { obj.close(); } catch (e) { } return; } // Disconnect websocket
                const node = docs[0];

                // Check if this user has permission to manage this computer
                if ((obj.nouser !== true) && ((parent.GetNodeRights(user, node.meshid, node._id) & MESHRIGHT_REMOTECONTROL) == 0)) { console.log('ERR: Access denied (2)'); try { obj.close(); } catch (e) { } return; }

                // Send connection request to agent
                if (obj.id == null) { obj.id = ('' + Math.random()).substring(2); }
                const rcookieData = { nodeid: node._id, sessionExpire: req.session && req.session.expire };
                if (user != null) { rcookieData.ruserid = user._id; } else if (obj.nouser === true) { rcookieData.nouser = 1; }
                const rcookie = parent.parent.encodeCookie(rcookieData, parent.parent.loginCookieEncryptionKey);
                const command = { nodeid: node._id, action: 'msg', type: 'tunnel', value: '*/meshrelay.ashx?p=2&id=' + obj.id + '&rauth=' + rcookie + '&nodeid=' + node._id, soptions: {}, usage: 2, rights: cookie.r, guestuserid: user._id, guestname: cookie.gn, consent: cookie.cf, remoteaddr: cleanRemoteAddr(obj.req.clientIp) };
                if (typeof domain.terminaluservariable == 'string') { command.soptions.terminalUserVariable = domain.terminaluservariable; }
                if (typeof domain.consentmessages == 'object') {
                    if (typeof domain.consentmessages.title == 'string') { command.soptions.consentTitle = domain.consentmessages.title; }
                    if (typeof domain.consentmessages.desktop == 'string') { command.soptions.consentMsgDesktop = domain.consentmessages.desktop; }
                    if (typeof domain.consentmessages.terminal == 'string') { command.soptions.consentMsgTerminal = domain.consentmessages.terminal; }
                    if (typeof domain.consentmessages.files == 'string') { command.soptions.consentMsgFiles = domain.consentmessages.files; }
                    if ((typeof domain.consentmessages.consenttimeout == 'number') && (domain.consentmessages.consenttimeout > 0)) { command.soptions.consentTimeout = domain.consentmessages.consenttimeout; }
                    if (domain.consentmessages.autoacceptontimeout === true) { command.soptions.consentAutoAccept = true; }
                    if (domain.consentmessages.autoacceptifnouser === true) { command.soptions.consentAutoAcceptIfNoUser = true; }
                    if (domain.consentmessages.autoacceptifdesktopnouser === true) { command.soptions.consentAutoAcceptIfDesktopNoUser = true; }
                    if (domain.consentmessages.autoacceptifterminalnouser === true) { command.soptions.consentAutoAcceptIfTerminalNoUser = true; }
                    if (domain.consentmessages.autoacceptiffilenouser === true) { command.soptions.consentAutoAcceptIfFileNoUser = true; }
                    if (domain.consentmessages.autoacceptiflocked === true) { command.soptions.consentAutoAcceptIfLocked = true; }
                    if (domain.consentmessages.autoacceptifdesktoplocked === true) { command.soptions.consentAutoAcceptIfDesktopLocked = true; }
                    if (domain.consentmessages.autoacceptifterminallocked === true) { command.soptions.consentAutoAcceptIfTerminalLocked = true; }
                    if (domain.consentmessages.autoacceptiffilelocked === true) { command.soptions.consentAutoAcceptIfFileLocked = true; }
                    if (domain.consentmessages.oldstyle === true) { command.soptions.oldStyle = true; }
                }
                if (typeof domain.notificationmessages == 'object') {
                    if (typeof domain.notificationmessages.title == 'string') { command.soptions.notifyTitle = domain.notificationmessages.title; }
                    if (typeof domain.notificationmessages.desktop == 'string') { command.soptions.notifyMsgDesktop = domain.notificationmessages.desktop; }
                    if (typeof domain.notificationmessages.terminal == 'string') { command.soptions.notifyMsgTerminal = domain.notificationmessages.terminal; }
                    if (typeof domain.notificationmessages.files == 'string') { command.soptions.notifyMsgFiles = domain.notificationmessages.files; }
                }
                parent.parent.debug('relay', 'Relay: Sending agent tunnel command: ' + JSON.stringify(command));
                if (obj.sendAgentMessage(command, user ? user._id : null, domain.id) == false) { delete obj.id; parent.parent.debug('relay', 'Relay: Unable to contact this agent (' + obj.req.clientIp + ')'); }

                performRelay(0);
            });
            return obj;
        }
    }

    // Set the session expire timer
    function setExpireTimer() {
        if (obj.expireTimer != null) { clearTimeout(obj.expireTimer); delete obj.expireTimer; }
        if (cookie && (typeof cookie.expire == 'number')) {
            const timeToExpire = (cookie.expire - Date.now());
            if (timeToExpire < 1) {
                obj.close();
            } else if (timeToExpire >= 0x7FFFFFFF) {
                obj.expireTimer = setTimeout(setExpireTimer, 0x7FFFFFFF); // Since expire timer can't be larger than 0x7FFFFFFF, reset timer after that time.
            } else {
                obj.expireTimer = setTimeout(obj.close, timeToExpire);
            }
        }
    }


    // Check if this user has input access on the device
    if ((obj.user != null) && (obj.viewOnly == false)) {
        obj.viewOnly = true; // Set a view only for now until we figure out otherwise
        parent.db.Get(obj.nodeid, function (err, docs) {
            if (obj.req == null) return; // This connection was closed.
            if (docs.length == 0) { console.log('ERR: Node not found'); try { obj.close(); } catch (e) { } return; } // Disconnect websocket
            const node = docs[0];

            // Check if this user has permission to manage this computer
            const rights = parent.GetNodeRights(obj.user, node.meshid, node._id);
            if ((rights & 0x00000008) == 0) { try { obj.close(); } catch (e) { } return; } // Check MESHRIGHT_ADMIN or MESHRIGHT_REMOTECONTROL
            if ((rights != 0xFFFFFFFF) && ((rights & 0x00010000) != 0)) { try { obj.close(); } catch (e) { } return; } // Check MESHRIGHT_NODESKTOP
            if ((rights == 0xFFFFFFFF) || ((rights & 0x00000100) == 0)) { obj.viewOnly = false; } // Check MESHRIGHT_REMOTEVIEWONLY
            performRelay(0);
        });
    } else {
        // If this is not an authenticated session, or the session does not have routing instructions, just go ahead an connect to existing session.
        performRelay(0);
    }
    return obj;
};

/*
Relay session recording required that "SessionRecording":true be set in the domain section of the config.json.
Once done, a folder "meshcentral-recordings" will be created next to "meshcentral-data" that will contain all
of the recording files with the .mcrec extension.

The recording files are binary and contain a set of:

    <HEADER><DATABLOCK><HEADER><DATABLOCK><HEADER><DATABLOCK><HEADER><DATABLOCK>...

The header is always 16 bytes long and is encoded like this:

    TYPE   2 bytes, 1 = Header, 2 = Network Data, 3 = EndBlock
    FLAGS  2 bytes, 0x0001 = Binary, 0x0002 = User
    SIZE   4 bytes, Size of the data following this header.
    TIME   8 bytes, Time this record was written, number of milliseconds since 1 January, 1970 UTC.

All values are BigEndian encoded. The first data block is of TYPE 1 and contains a JSON string with information
about this recording. It looks something like this:

{
    magic: 'MeshCentralRelaySession',
    ver: 1,
    userid: "user\domain\userid",
    username: "username",
    sessionid: "RandomValue",
    ipaddr1: 1.2.3.4,
    ipaddr2: 1.2.3.5,
    time: new Date().toLocaleString()
}

The rest of the data blocks are all network traffic that was relayed thru the server. They are of TYPE 2 and have
a given size and timestamp. When looking at network traffic the flags are important:

- If traffic has the first (0x0001) flag set, the data is binary otherwise it's a string.
- If the traffic has the second (0x0002) flag set, traffic is coming from the user's browser, if not, it's coming from the MeshAgent.
*/
