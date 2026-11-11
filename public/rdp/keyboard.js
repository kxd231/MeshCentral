/**
* @description Web-RDP browser keyboard: KeyboardEvent.code → RDP scancode (set 1) and unicode fallback
* @license Apache-2.0
*
* Scancodes are the IBM PC set 1 make codes. An extended key (0xE0 prefix) is sent as 0xE0xx, the
* range accepted by ['scancode', code, down] in rdp/WIRE.md is 0x01..0x7F and 0xE001..0xE07F.
* No DOM access: every function takes plain event-like objects so it runs under Node tests.
* Usable from Node (require) and from a page (self.RdpClient.keyboard).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(); }
    else { root.RdpClient = root.RdpClient || {}; root.RdpClient.keyboard = factory(); }
})((typeof self !== 'undefined') ? self : this, function () {
    'use strict';

    const E = 0xE000;

    // KeyboardEvent.code → scancode
    const CODE_TO_SCANCODE = {
        Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
        Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B, Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E,
        Tab: 0x0F, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
        KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C,
        ControlLeft: 0x1D, KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
        KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
        ShiftLeft: 0x2A, Backslash: 0x2B, KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30,
        KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
        NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3A,
        F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
        NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A,
        Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E, Numpad1: 0x4F, Numpad2: 0x50,
        Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
        NumpadEqual: 0x59, F13: 0x64, F14: 0x65, F15: 0x66, F16: 0x67, F17: 0x68, F18: 0x69, F19: 0x6A,
        F20: 0x6B, F21: 0x6C, F22: 0x6D, F23: 0x6E, F24: 0x76,
        KanaMode: 0x70, IntlRo: 0x73, Convert: 0x79, NonConvert: 0x7B, IntlYen: 0x7D, NumpadComma: 0x7E,
        // Extended keys (0xE0 prefix)
        MediaTrackPrevious: E | 0x10, MediaTrackNext: E | 0x19, NumpadEnter: E | 0x1C, ControlRight: E | 0x1D,
        AudioVolumeMute: E | 0x20, LaunchApp2: E | 0x21, MediaPlayPause: E | 0x22, MediaStop: E | 0x24,
        AudioVolumeDown: E | 0x2E, AudioVolumeUp: E | 0x30, BrowserHome: E | 0x32, NumpadDivide: E | 0x35,
        PrintScreen: E | 0x37, AltRight: E | 0x38, Home: E | 0x47, ArrowUp: E | 0x48, PageUp: E | 0x49,
        ArrowLeft: E | 0x4B, ArrowRight: E | 0x4D, End: E | 0x4F, ArrowDown: E | 0x50, PageDown: E | 0x51,
        Insert: E | 0x52, Delete: E | 0x53, MetaLeft: E | 0x5B, MetaRight: E | 0x5C, ContextMenu: E | 0x5D,
        BrowserSearch: E | 0x65, BrowserFavorites: E | 0x66, BrowserRefresh: E | 0x67, BrowserForward: E | 0x69,
        BrowserBack: E | 0x6A, LaunchApp1: E | 0x6B, LaunchMail: E | 0x6C, MediaSelect: E | 0x6D
    };

    // Legacy KeyboardEvent.keyCode (Windows virtual-key numbers) → scancode, for browsers that give no
    // `code` and for the toolbar buttons of the page (SendKeyMsgKC). Keys that exist twice
    // (Ctrl, Alt, Shift) map to the left one.
    const KEYCODE_TO_SCANCODE = {
        8: 0x0E, 9: 0x0F, 13: 0x1C, 16: 0x2A, 17: 0x1D, 18: 0x38, 20: 0x3A, 27: 0x01, 32: 0x39,
        33: E | 0x49, 34: E | 0x51, 35: E | 0x4F, 36: E | 0x47, 37: E | 0x4B, 38: E | 0x48, 39: E | 0x4D,
        40: E | 0x50, 44: E | 0x37, 45: E | 0x52, 46: E | 0x53,
        48: 0x0B, 49: 0x02, 50: 0x03, 51: 0x04, 52: 0x05, 53: 0x06, 54: 0x07, 55: 0x08, 56: 0x09, 57: 0x0A,
        65: 0x1E, 66: 0x30, 67: 0x2E, 68: 0x20, 69: 0x12, 70: 0x21, 71: 0x22, 72: 0x23, 73: 0x17, 74: 0x24,
        75: 0x25, 76: 0x26, 77: 0x32, 78: 0x31, 79: 0x18, 80: 0x19, 81: 0x10, 82: 0x13, 83: 0x1F, 84: 0x14,
        85: 0x16, 86: 0x2F, 87: 0x11, 88: 0x2D, 89: 0x15, 90: 0x2C,
        91: E | 0x5B, 92: E | 0x5C, 93: E | 0x5D,
        96: 0x52, 97: 0x4F, 98: 0x50, 99: 0x51, 100: 0x4B, 101: 0x4C, 102: 0x4D, 103: 0x47, 104: 0x48, 105: 0x49,
        106: 0x37, 107: 0x4E, 109: 0x4A, 110: 0x53, 111: E | 0x35,
        112: 0x3B, 113: 0x3C, 114: 0x3D, 115: 0x3E, 116: 0x3F, 117: 0x40, 118: 0x41, 119: 0x42, 120: 0x43,
        121: 0x44, 122: 0x57, 123: 0x58, 144: 0x45, 145: 0x46,
        186: 0x27, 187: 0x0D, 188: 0x33, 189: 0x0C, 190: 0x34, 191: 0x35, 192: 0x29, 219: 0x1A, 220: 0x2B,
        221: 0x1B, 222: 0x28
    };

    // Modifier scancodes: Shift, Ctrl, Alt (both sides), Windows (both sides)
    const MODIFIER_SCANCODES = Object.freeze([0x2A, 0x36, 0x1D, E | 0x1D, 0x38, E | 0x38, E | 0x5B, E | 0x5C]);

    const LOCK_BITS = Object.freeze({ SCROLL: 1, NUM: 2, CAPS: 4, KANA: 8 });

    function isValidScancode(code) {
        return Number.isInteger(code) && (((code >= 0x01) && (code <= 0x7F)) || ((code >= 0xE001) && (code <= 0xE07F)));
    }

    function scancodeFromCode(code) {
        if (typeof code !== 'string') { return undefined; }
        return Object.prototype.hasOwnProperty.call(CODE_TO_SCANCODE, code) ? CODE_TO_SCANCODE[code] : undefined;
    }

    function scancodeFromKeyCode(keyCode) {
        if (!Number.isInteger(keyCode)) { return undefined; }
        return Object.prototype.hasOwnProperty.call(KEYCODE_TO_SCANCODE, keyCode) ? KEYCODE_TO_SCANCODE[keyCode] : undefined;
    }

    // UTF-16 code units of a key value that is exactly one character, or null (named keys such as
    // "Enter", "Dead", "Unidentified", "Process" have a longer name)
    function unitsFromKey(key) {
        if ((typeof key !== 'string') || (key.length === 0) || (key.length > 2)) { return null; }
        const cp = key.codePointAt(0);
        if (String.fromCodePoint(cp).length !== key.length) { return null; }
        if ((cp < 0x20) || (cp === 0x7F)) { return null; }
        const units = [];
        for (let i = 0; i < key.length; i++) { units.push(key.charCodeAt(i)); }
        return units;
    }

    // Decide what to send for a keyboard event (event-like object with code, key, keyCode, isComposing).
    // → { kind: 'scancode', code } | { kind: 'unicode', units: [..] } | null (nothing to send)
    function eventToInput(e, isDown) {
        if (e == null) { return null; }
        if ((e.isComposing === true) || (e.keyCode === 229)) { return null; } // IME in progress: the text arrives as unicode on commit
        let code = scancodeFromCode(e.code);
        if ((code === undefined) && ((e.code === undefined) || (e.code === '') || (e.code === 'Unidentified'))) { code = scancodeFromKeyCode(e.keyCode); }
        if (code !== undefined) { return { kind: 'scancode', code: code }; }
        if (!isDown) { return null; } // the unicode fallback types the character on key down only
        const units = unitsFromKey(e.key);
        if (units !== null) { return { kind: 'unicode', units: units }; }
        return null;
    }

    // Lock state bits for ['sync', locks] from an event that has getModifierState
    function lockBits(e) {
        if ((e == null) || (typeof e.getModifierState !== 'function')) { return 0; }
        let bits = 0;
        try {
            if (e.getModifierState('ScrollLock')) { bits |= LOCK_BITS.SCROLL; }
            if (e.getModifierState('NumLock')) { bits |= LOCK_BITS.NUM; }
            if (e.getModifierState('CapsLock')) { bits |= LOCK_BITS.CAPS; }
            if (e.getModifierState('KanaLock')) { bits |= LOCK_BITS.KANA; }
        } catch (ex) { return 0; }
        return bits;
    }

    // Tracks the keys the remote side believes are down, so they can be released on blur
    class HeldKeys {
        constructor() { this.held = []; }
        down(code) { if (this.held.indexOf(code) < 0) { this.held.push(code); } }
        up(code) { const i = this.held.indexOf(code); if (i >= 0) { this.held.splice(i, 1); } }
        // Codes to send as key-up, most recently pressed first; forgets all of them
        releaseAll() { const r = this.held.reverse(); this.held = []; return r; }
        get size() { return this.held.length; }
    }

    return Object.freeze({
        CODE_TO_SCANCODE: Object.freeze(CODE_TO_SCANCODE),
        KEYCODE_TO_SCANCODE: Object.freeze(KEYCODE_TO_SCANCODE),
        MODIFIER_SCANCODES: MODIFIER_SCANCODES,
        LOCK_BITS: LOCK_BITS,
        isValidScancode: isValidScancode,
        scancodeFromCode: scancodeFromCode,
        scancodeFromKeyCode: scancodeFromKeyCode,
        unitsFromKey: unitsFromKey,
        eventToInput: eventToInput,
        lockBits: lockBits,
        HeldKeys: HeldKeys
    });
});
