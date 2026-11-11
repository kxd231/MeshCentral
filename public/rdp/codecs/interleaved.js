/**
* @description Legacy interleaved RLE and raw bitmaps to top-down RGBA
* @license Apache-2.0
*
* MS-RDPBCGR 2.2.9.1.1.3.1.2.2 / .4 and 3.1.9.1.1. RLE order handling follows
* FreeRDP libfreerdp/codec/interleaved.c and include/bitmap.h (Apache-2.0):
* Copyright 2011 Jay Sorg; 2014 Marc-Andre Moreau; 2015 Martin Haimberger;
* 2015-2016 Thincast Technologies GmbH; 2016 Armin Novak.
* Both legacy RLE and bottomUp raw images start at the BOTTOM scanline. Flip the
* entire encoded height before selecting the top-left crop, never just rect.height.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.interleaved = factory(root.RdpShared.limits, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, errors) {
    'use strict';
    const { CodecError, toCodecError } = errors;
    const fail = code => { throw new CodecError(code); };
    const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

    function validate(src, rect, dst, params, raw) {
        if (!(src instanceof Uint8Array) || !rect || !dst || !params) { fail('INVALID'); }
        if (![15, 16, 24, ...(raw ? [32] : [])].includes(params.bpp)) { fail('UNSUPPORTED'); }
        if (raw && typeof params.bottomUp !== 'boolean') { fail('INVALID'); }
        if (!integer(params.bitmapWidth, 1, limits.BITMAP_MAX_DIM) ||
            !integer(params.bitmapHeight, 1, limits.BITMAP_MAX_DIM) ||
            !integer(dst.width, 1, limits.SURFACE_MAX_DIM) || !integer(dst.height, 1, limits.SURFACE_MAX_DIM) ||
            dst.width * dst.height > limits.SURFACES_MAX_PIXELS ||
            !integer(rect.x, 0, dst.width) || !integer(rect.y, 0, dst.height) ||
            !integer(rect.width, 1, params.bitmapWidth) || !integer(rect.height, 1, params.bitmapHeight) ||
            rect.x + rect.width > dst.width || rect.y + rect.height > dst.height ||
            !integer(dst.stride, dst.width * 4, Number.MAX_SAFE_INTEGER / dst.height)) { fail('LIMIT'); }
        if (!(dst.data instanceof Uint8Array) && !(dst.data instanceof Uint8ClampedArray)) { fail('INVALID'); }
        if (dst.data.length < dst.stride * dst.height) { fail('LIMIT'); }
        // Input and output must not alias: raw conversion would overwrite unread pixels.
        if (src.buffer === dst.data.buffer && src.byteOffset < dst.data.byteOffset + dst.data.byteLength &&
            dst.data.byteOffset < src.byteOffset + src.byteLength) { fail('INVALID'); }
    }

    function writePixel(data, offset, value, bpp) {
        if (bpp === 15) {
            const r = (value >>> 10) & 31, g = (value >>> 5) & 31, b = value & 31;
            data[offset] = (r << 3) | (r >>> 2);
            data[offset + 1] = (g << 3) | (g >>> 2);
            data[offset + 2] = (b << 3) | (b >>> 2);
        } else if (bpp === 16) {
            const r = (value >>> 11) & 31, g = (value >>> 5) & 63, b = value & 31;
            data[offset] = (r << 3) | (r >>> 2);
            data[offset + 1] = (g << 2) | (g >>> 4);
            data[offset + 2] = (b << 3) | (b >>> 2);
        } else {
            data[offset] = (value >>> 16) & 255;
            data[offset + 1] = (value >>> 8) & 255;
            data[offset + 2] = value & 255;
        }
        data[offset + 3] = 255; // Raw 32bpp is BGRX, with no alpha-presence field in this API.
    }

    function decodeRaw(src, rect, dst, params) {
        try {
            validate(src, rect, dst, params, true);
            const { bitmapWidth: width, bitmapHeight: height, bpp, bottomUp } = params;
            const bytes = Math.ceil(bpp / 8), stride = Math.ceil(width * bytes / 4) * 4;
            const length = stride * height;
            if (src.length < length) { fail('TRUNCATED'); }
            if (src.length !== length) { fail('INVALID'); }
            for (let y = 0; y < rect.height; y++) {
                let input = (bottomUp ? height - 1 - y : y) * stride;
                let output = (rect.y + y) * dst.stride + rect.x * 4;
                for (let x = 0; x < rect.width; x++, input += bytes, output += 4) {
                    let value = src[input] | (src[input + 1] << 8);
                    if (bytes >= 3) { value |= src[input + 2] << 16; }
                    writePixel(dst.data, output, value, bpp);
                }
            }
        } catch (e) { throw toCodecError(e); }
    }

    function decode(src, rect, dst, params) {
        try {
            validate(src, rect, dst, params, false);
            const { bitmapWidth: width, bitmapHeight: height, bpp } = params;
            if (!src.length) { fail('TRUNCATED'); }
            const count = width * height, bytes = Math.ceil(bpp / 8);
            // Maximum expansion: mega BG/FG emits 65535 pixels from 3 bytes.
            // Dither emits 2*65535 but costs >= 7 bytes; every other order is smaller.
            if (count > src.length * 21845) { fail('INVALID'); }
            // Checked dimensions bound this temporary buffer; nothing is retained between calls.
            const image = new Uint32Array(count);
            let input = 0, output = 0, fg = bpp === 24 ? 0xFFFFFF : 0xFFFF;
            let insertFg = false, firstLine = true;
            const byte = () => { if (input >= src.length) { fail('TRUNCATED'); } return src[input++]; };
            const pixel = () => {
                if (src.length - input < bytes) { fail('TRUNCATED'); }
                let value = src[input++] | (src[input++] << 8);
                if (bytes === 3) { value |= src[input++] << 16; }
                return value;
            };
            const capacity = n => { if (n > count - output) { fail('INVALID'); } };
            const previous = () => firstLine ? 0 : image[output - width];
            while (input < src.length && output < count) {
                // Per the reference pseudocode, leave the special first-line state at an order boundary.
                if (firstLine && output >= width) { firstLine = false; insertFg = false; }
                const header = byte();
                const code = (header & 0xC0) !== 0xC0 ? header >>> 5 : (header & 0xF0) === 0xF0 ? header : header >>> 4;
                let run;
                if (code <= 4 || (code >= 12 && code <= 14)) {
                    run = header & (code <= 4 ? 31 : 15);
                    if (code === 2 || code === 13) { run = run ? run * 8 : byte() + 1; }
                    else if (!run) { run = byte() + (code <= 4 ? 32 : 16); }
                } else if (code >= 0xF0 && code <= 0xF8 && code !== 0xF5) {
                    run = byte(); run |= byte() << 8;
                } else if (code === 0xF9 || code === 0xFA) { run = 8; }
                else if (code === 0xFD || code === 0xFE) { run = 1; }
                else { fail('INVALID'); }
                capacity((code === 14 || code === 0xF8) ? run * 2 : run);
                const bg = code === 0 || code === 0xF0;
                if (bg) {
                    if (insertFg && run) { image[output] = previous() ^ fg; output++; run--; }
                    while (run-- > 0) { image[output] = previous(); output++; }
                    insertFg = true;
                    continue;
                }
                insertFg = false;
                switch (code) {
                    case 12: case 0xF6: fg = pixel(); // falls through
                    case 1: case 0xF1:
                        while (run-- > 0) { image[output] = previous() ^ fg; output++; }
                        break;
                    case 14: case 0xF8: {
                        const a = pixel(), b = pixel();
                        while (run-- > 0) { image[output++] = a; image[output++] = b; }
                        break;
                    }
                    case 3: case 0xF3: image.fill(pixel(), output, output + run); output += run; break;
                    case 13: case 0xF7: fg = pixel(); // falls through
                    case 2: case 0xF2: case 0xF9: case 0xFA: {
                        const special = code === 0xF9 ? 3 : code === 0xFA ? 5 : -1;
                        let mask = 0;
                        for (let i = 0; i < run; i++) {
                            if ((i & 7) === 0) { mask = special >= 0 ? special : byte(); }
                            image[output] = previous() ^ ((mask & (1 << (i & 7))) ? fg : 0);
                            output++;
                        }
                        break;
                    }
                    case 4: case 0xF4:
                        if (src.length - input < run * bytes) { fail('TRUNCATED'); }
                        while (run-- > 0) { image[output++] = pixel(); }
                        break;
                    case 0xFD: image[output++] = bpp === 24 ? 0xFFFFFF : 0xFFFF; break;
                    case 0xFE: image[output++] = 0; break;
                }
            }
            if (output !== count) { fail('TRUNCATED'); }
            for (let y = 0; y < rect.height; y++) {
                let inputPixel = (height - 1 - y) * width;
                let outputByte = (rect.y + y) * dst.stride + rect.x * 4;
                for (let x = 0; x < rect.width; x++, outputByte += 4) {
                    writePixel(dst.data, outputByte, image[inputPixel++], bpp);
                }
            }
        } catch (e) { throw toCodecError(e); }
    }
    return Object.freeze({ decode, decodeRaw });
});
