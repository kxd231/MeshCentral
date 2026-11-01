/*
 * meshfreerdp - headless FreeRDP 3 client used by MeshCentral Web-RDP.
 * Wire format: PROTOCOL.md.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 */
#define _POSIX_C_SOURCE 200809L
#define WITHOUT_FREERDP_3x_DEPRECATED
#define WITHOUT_WINPR_3x_DEPRECATED
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/codec/h264.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/error.h>
#include <freerdp/event.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/graphics.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <winpr/handle.h>
#include <winpr/json.h>
#include <winpr/string.h>
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/wlog.h>
#include <turbojpeg.h>

#define MAX_FRAME (64u * 1024u * 1024u)
#define TILE_SIZE 256
enum { OUT_CONNECTED = 1, OUT_TILE, OUT_POINTER, OUT_CLIPBOARD, OUT_ERROR, OUT_CLOSED };
enum { IN_CONFIG = 0x81, IN_MOUSE, IN_SCANCODE, IN_UNICODE, IN_CLIPBOARD, IN_QUIT };

typedef struct
{
    rdpClientContext client; /* Must be first. */
    tjhandle jpeg;
    unsigned char* jpeg_buffer;
    unsigned long jpeg_capacity;
    int quality;
    int pointer; /* -1 = no previous value, 0 = default, 1 = none */
    BOOL configured, connected, quitting, connect_ok;
    atomic_bool announced, failed;
    BOOL subscribed_connected, subscribed_disconnected, clip_ready, clip_long_names;
    atomic_bool clip_pending;
    atomic_bool cancel_connect;
    HANDLE connect_thread;
    CRITICAL_SECTION output_lock;
    CRITICAL_SECTION clipboard_lock;
    CliprdrClientContext* clip;
    WCHAR* clipboard;
    size_t clipboard_length;
    BYTE header[5];
    size_t header_used, payload_used;
    UINT32 payload_length;
    BYTE* payload;
} MeshContext;

static rdpContext* base(MeshContext* m) { return &m->client.context; }
static UINT16 get16(const BYTE* p) { return (UINT16)(p[0] | ((UINT16)p[1] << 8)); }
static UINT32 get32(const BYTE* p)
{
    return p[0] | ((UINT32)p[1] << 8) | ((UINT32)p[2] << 16) | ((UINT32)p[3] << 24);
}
static void put16(BYTE* p, UINT16 v) { p[0] = (BYTE)v; p[1] = (BYTE)(v >> 8); }
static void put32(BYTE* p, UINT32 v)
{
    p[0] = (BYTE)v; p[1] = (BYTE)(v >> 8); p[2] = (BYTE)(v >> 16); p[3] = (BYTE)(v >> 24);
}

/* Blocking writes deliberately propagate the parent's backpressure. A lost pipe
 * terminates all library threads with the process, even during PostConnect. */
static void write_all(const void* data, size_t length)
{
    const BYTE* p = data;
    while (length)
    {
        ssize_t n = write(STDOUT_FILENO, p, length);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) _exit(1);
        p += n;
        length -= (size_t)n;
    }
}

static void send_parts(MeshContext* m, BYTE type, const void* a, UINT32 alen,
                       const void* b, UINT32 blen)
{
    BYTE h[5];
    h[0] = type;
    put32(h + 1, alen + blen);
    EnterCriticalSection(&m->output_lock);
    write_all(h, sizeof(h));
    write_all(a, alen);
    write_all(b, blen);
    LeaveCriticalSection(&m->output_lock);
}

static void send_frame(MeshContext* m, BYTE type, const void* data, UINT32 length)
{
    send_parts(m, type, data, length, NULL, 0);
}

static BOOL fail(MeshContext* m, const char* reason)
{
    fprintf(stderr, "meshfreerdp: %s\n", reason);
    m->failed = TRUE;
    return FALSE;
}

static void send_error(MeshContext* m)
{
    char json[256];
    UINT32 code = freerdp_get_last_error(base(m));
    if (code == FREERDP_ERROR_SUCCESS) code = FREERDP_ERROR_CONNECT_FAILED;
    const char* name = freerdp_get_last_error_name(code);
    /* FreeRDP 3 returns ERRCONNECT_/ERRINFO_ labels; the wire protocol uses
     * their public FREERDP_ERROR_ aliases. Preserve the numeric error code. */
    const char* prefix = "";
    if (name && strncmp(name, "ERRCONNECT_", 11) == 0) { name += 11; prefix = "FREERDP_ERROR_"; }
    else if (name && strncmp(name, "ERRINFO_", 8) == 0) { name += 8; prefix = "FREERDP_ERROR_"; }
    int n = snprintf(json, sizeof(json), "{\"code\":%" PRIu32 ",\"name\":\"%s%s\"}", code,
                     prefix, name ? name : "FREERDP_ERROR_CONNECT_FAILED");
    if (n > 0 && (size_t)n < sizeof(json)) send_frame(m, OUT_ERROR, json, (UINT32)n);
}

static void reset_invalid(rdpContext* context)
{
    GDI_WND* w = context->gdi->primary->hdc->hwnd;
    w->invalid->null = TRUE;
    w->ninvalid = 0;
}

#define RAW_TILE_PIXELS 1024 /* Tiles smaller than this are sent as raw RGBA. */

static BOOL send_rectangle_locked(MeshContext* m, int left, int top, int right, int bottom);

/* GFX paints from the dynamic channel thread, legacy GDI from the main thread. Serialize the
 * shared JPEG encoder and keep tiles of one update together. output_lock is recursive. */
static BOOL send_rectangle(MeshContext* m, int left, int top, int right, int bottom)
{
    EnterCriticalSection(&m->output_lock);
    BOOL ok = send_rectangle_locked(m, left, top, right, bottom);
    LeaveCriticalSection(&m->output_lock);
    return ok;
}

static BOOL send_rectangle_locked(MeshContext* m, int left, int top, int right, int bottom)
{
    rdpGdi* gdi = base(m)->gdi;
    /* Small on purpose: channel threads get a 128 KiB stack on musl (Alpine). */
    BYTE rgba[RAW_TILE_PIXELS * 4];
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (right > gdi->width) right = gdi->width;
    if (bottom > gdi->height) bottom = gdi->height;
    for (int y = top; y < bottom; y += TILE_SIZE)
    {
        int h = bottom - y < TILE_SIZE ? bottom - y : TILE_SIZE;
        for (int x = left; x < right; x += TILE_SIZE)
        {
            int w = right - x < TILE_SIZE ? right - x : TILE_SIZE;
            BYTE header[9];
            put16(header, (UINT16)x); put16(header + 2, (UINT16)y);
            put16(header + 4, (UINT16)w); put16(header + 6, (UINT16)h);
            if (w * h < RAW_TILE_PIXELS)
            {
                for (int row = 0; row < h; ++row)
                {
                    BYTE* dst = rgba + (size_t)row * w * 4;
                    memcpy(dst, gdi->primary_buffer + (size_t)(y + row) * gdi->stride + x * 4,
                           (size_t)w * 4);
                    for (int col = 0; col < w; ++col) dst[col * 4 + 3] = 255;
                }
                header[8] = 0;
                send_parts(m, OUT_TILE, header, sizeof(header), rgba, (UINT32)(w * h * 4));
            }
            else
            {
                unsigned long length = m->jpeg_capacity;
                const BYTE* pixels = gdi->primary_buffer + (size_t)y * gdi->stride + x * 4;
                if (tjCompress2(m->jpeg, pixels, w, (int)gdi->stride, h, TJPF_RGBA,
                                &m->jpeg_buffer, &length, TJSAMP_420, m->quality,
                                TJFLAG_NOREALLOC) != 0)
                    return fail(m, "JPEG compression failed");
                header[8] = 1;
                send_parts(m, OUT_TILE, header, sizeof(header), m->jpeg_buffer, (UINT32)length);
            }
        }
    }
    return TRUE;
}

static BOOL announce_screen(MeshContext* m)
{
    rdpGdi* gdi = base(m)->gdi;
    char json[80];
    if (gdi->width <= 0 || gdi->height <= 0 || gdi->width > UINT16_MAX ||
        gdi->height > UINT16_MAX || gdi->stride > INT_MAX)
        return fail(m, "unsupported desktop dimensions");
    int n = snprintf(json, sizeof(json), "{\"width\":%d,\"height\":%d}", gdi->width, gdi->height);
    send_frame(m, OUT_CONNECTED, json, (UINT32)n);
    m->announced = TRUE;
    return send_rectangle(m, 0, 0, gdi->width, gdi->height);
}

static BOOL begin_paint(rdpContext* context)
{
    reset_invalid(context);
    return TRUE;
}

static BOOL end_paint(rdpContext* context)
{
    MeshContext* m = (MeshContext*)context;
    GDI_WND* w = context->gdi->primary->hdc->hwnd;
    BOOL ok = TRUE;
    /* GDI's aggregate invalid region merges all cinvalid rectangles. */
    if (m->announced && !w->invalid->null)
    {
        const GDI_RGN* r = w->invalid;
        int64_t right = (int64_t)r->x + r->w;
        int64_t bottom = (int64_t)r->y + r->h;
        if (right > context->gdi->width) right = context->gdi->width;
        if (bottom > context->gdi->height) bottom = context->gdi->height;
        if (right > 0 && bottom > 0)
            ok = send_rectangle(m, r->x, r->y, (int)right, (int)bottom);
    }
    reset_invalid(context);
    return ok;
}

static BOOL desktop_resize(rdpContext* context)
{
    MeshContext* m = (MeshContext*)context;
    UINT32 w = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    if (!w || !h || w > UINT16_MAX || h > UINT16_MAX || !gdi_resize(context->gdi, w, h))
        return fail(m, "desktop resize failed");
    reset_invalid(context);
    return announce_screen(m);
}

static BOOL pointer_value(rdpContext* context, int value)
{
    MeshContext* m = (MeshContext*)context;
    if (m->announced && m->pointer != value)
    {
        const char* css = value ? "none" : "default";
        send_frame(m, OUT_POINTER, css, (UINT32)strlen(css));
        m->pointer = value;
    }
    return TRUE;
}
static BOOL pointer_new(rdpContext* context, rdpPointer* pointer)
{ (void)context; (void)pointer; return TRUE; }
static void pointer_free(rdpContext* context, rdpPointer* pointer)
{ (void)context; (void)pointer; }
static BOOL pointer_set(rdpContext* context, rdpPointer* pointer)
{ (void)pointer; return pointer_value(context, 0); }
static BOOL pointer_null(rdpContext* context) { return pointer_value(context, 1); }
static BOOL pointer_default(rdpContext* context) { return pointer_value(context, 0); }

static UINT clip_announce(MeshContext* m)
{
    CLIPRDR_FORMAT format = { .formatId = CF_UNICODETEXT };
    CLIPRDR_FORMAT_LIST list = { .common.msgType = CB_FORMAT_LIST };
    /* Callers hold clipboard_lock; channel callbacks can run on channel workers. */
    if (!m->clip || !m->clip_ready) return CHANNEL_RC_OK;
    list.numFormats = m->clipboard ? 1 : 0;
    list.formats = m->clipboard ? &format : NULL;
    return m->clip->ClientFormatList(m->clip, &list);
}

static UINT clip_capabilities(CliprdrClientContext* clip, const CLIPRDR_CAPABILITIES* caps)
{
    MeshContext* m = clip->custom;
    const BYTE* p = (const BYTE*)caps->capabilitySets;
    BOOL long_names = FALSE;
    /* FreeRDP has already validated the channel PDU and converted these fields
     * to native endianness. Capability sets can have different lengths. */
    for (UINT32 i = 0; i < caps->cCapabilitiesSets; ++i)
    {
        if (!p) return ERROR_INVALID_DATA;
        const CLIPRDR_CAPABILITY_SET* set = (const CLIPRDR_CAPABILITY_SET*)p;
        if (set->capabilitySetLength < sizeof(*set)) return ERROR_INVALID_DATA;
        if (set->capabilitySetType == CB_CAPSTYPE_GENERAL)
        {
            if (set->capabilitySetLength < CB_CAPSTYPE_GENERAL_LEN) return ERROR_INVALID_DATA;
            const CLIPRDR_GENERAL_CAPABILITY_SET* general = (const CLIPRDR_GENERAL_CAPABILITY_SET*)p;
            long_names = (general->generalFlags & CB_USE_LONG_FORMAT_NAMES) != 0;
        }
        p += set->capabilitySetLength;
    }
    EnterCriticalSection(&m->clipboard_lock);
    m->clip_long_names = long_names;
    LeaveCriticalSection(&m->clipboard_lock);
    return CHANNEL_RC_OK;
}

static UINT clip_monitor_ready(CliprdrClientContext* clip, const CLIPRDR_MONITOR_READY* ready)
{
    MeshContext* m = clip->custom;
    CLIPRDR_GENERAL_CAPABILITY_SET general = {
        .capabilitySetType = CB_CAPSTYPE_GENERAL,
        .capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN,
        .version = CB_CAPS_VERSION_2
    };
    CLIPRDR_CAPABILITIES caps = { .common.msgType = CB_CLIP_CAPS,
        .cCapabilitiesSets = 1, .capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general };
    (void)ready;
    EnterCriticalSection(&m->clipboard_lock);
    general.generalFlags = m->clip_long_names ? CB_USE_LONG_FORMAT_NAMES : 0;
    UINT rc = clip->ClientCapabilities(clip, &caps);
    if (rc == CHANNEL_RC_OK)
    {
        m->clip_ready = TRUE;
        rc = clip_announce(m);
    }
    LeaveCriticalSection(&m->clipboard_lock);
    return rc;
}

static UINT clip_format_list(CliprdrClientContext* clip, const CLIPRDR_FORMAT_LIST* list)
{
    MeshContext* m = clip->custom;
    CLIPRDR_FORMAT_LIST_RESPONSE response = {
        .common = { .msgType = CB_FORMAT_LIST_RESPONSE, .msgFlags = CB_RESPONSE_OK }
    };
    UINT rc = clip->ClientFormatListResponse(clip, &response);
    if (rc != CHANNEL_RC_OK) return rc;
    m->clip_pending = FALSE;
    for (UINT32 i = 0; i < list->numFormats; ++i)
    {
        if (list->formats[i].formatId == CF_UNICODETEXT)
        {
            CLIPRDR_FORMAT_DATA_REQUEST request = { .common.msgType = CB_FORMAT_DATA_REQUEST,
                                                   .requestedFormatId = CF_UNICODETEXT };
            m->clip_pending = TRUE;
            return clip->ClientFormatDataRequest(clip, &request);
        }
    }
    return CHANNEL_RC_OK;
}

static UINT clip_data_response(CliprdrClientContext* clip, const CLIPRDR_FORMAT_DATA_RESPONSE* data)
{
    MeshContext* m = clip->custom;
    if (!m->clip_pending) return CHANNEL_RC_OK;
    m->clip_pending = FALSE;
    if (!(data->common.msgFlags & CB_RESPONSE_OK)) return CHANNEL_RC_OK;
    size_t bytes = data->common.dataLen;
    if (bytes > MAX_FRAME || (bytes & 1) || (bytes && !data->requestedFormatData))
        return ERROR_INVALID_DATA;
    /* Decode explicitly from LE, including on non-little-endian machines. */
    WCHAR* wide = calloc(bytes / 2 + 1, sizeof(WCHAR));
    if (!wide) return ERROR_NOT_ENOUGH_MEMORY;
    for (size_t i = 0; i < bytes / 2; ++i) wide[i] = get16(data->requestedFormatData + i * 2);
    size_t length = 0;
    char* utf8 = ConvertWCharNToUtf8Alloc(wide, bytes / 2 + 1, &length);
    free(wide);
    if (!utf8) return ERROR_INVALID_DATA;
    if (length > MAX_FRAME) { free(utf8); return ERROR_INVALID_DATA; }
    if (m->announced) send_frame(m, OUT_CLIPBOARD, utf8, (UINT32)length);
    free(utf8);
    return CHANNEL_RC_OK;
}

static UINT clip_data_request(CliprdrClientContext* clip, const CLIPRDR_FORMAT_DATA_REQUEST* request)
{
    MeshContext* m = clip->custom;
    CLIPRDR_FORMAT_DATA_RESPONSE response = {
        .common = { .msgType = CB_FORMAT_DATA_RESPONSE, .msgFlags = CB_RESPONSE_FAIL }
    };
    BYTE* data = NULL;
    EnterCriticalSection(&m->clipboard_lock);
    if (request->requestedFormatId == CF_UNICODETEXT && m->clipboard)
    {
        size_t length = (m->clipboard_length + 1) * 2;
        data = malloc(length);
        if (!data)
        {
            LeaveCriticalSection(&m->clipboard_lock);
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        for (size_t i = 0; i <= m->clipboard_length; ++i) put16(data + i * 2, m->clipboard[i]);
        response.common.msgFlags = CB_RESPONSE_OK;
        response.common.dataLen = (UINT32)length;
        response.requestedFormatData = data;
    }
    LeaveCriticalSection(&m->clipboard_lock);
    UINT rc = clip->ClientFormatDataResponse(clip, &response);
    free(data);
    return rc;
}

static void channel_connected(void* context, const ChannelConnectedEventArgs* event)
{
    MeshContext* m = context;
    if (strcmp(event->name, RDPGFX_DVC_CHANNEL_NAME) == 0)
    {
        /* GFX surfaces are composed into the GDI primary buffer, so end_paint keeps working. */
        if (!gdi_graphics_pipeline_init(base(m)->gdi, (RdpgfxClientContext*)event->pInterface))
            fprintf(stderr, "meshfreerdp: graphics pipeline initialization failed\n");
        return;
    }
    if (strcmp(event->name, CLIPRDR_SVC_CHANNEL_NAME) != 0) return;
    EnterCriticalSection(&m->clipboard_lock);
    m->clip = event->pInterface;
    if (!m->clip) { LeaveCriticalSection(&m->clipboard_lock); return; }
    m->clip->custom = m;
    m->clip->ServerCapabilities = clip_capabilities;
    m->clip->MonitorReady = clip_monitor_ready;
    m->clip->ServerFormatList = clip_format_list;
    m->clip->ServerFormatDataRequest = clip_data_request;
    m->clip->ServerFormatDataResponse = clip_data_response;
    LeaveCriticalSection(&m->clipboard_lock);
}

static void channel_disconnected(void* context, const ChannelDisconnectedEventArgs* event)
{
    MeshContext* m = context;
    if (strcmp(event->name, RDPGFX_DVC_CHANNEL_NAME) == 0)
    {
        gdi_graphics_pipeline_uninit(base(m)->gdi, (RdpgfxClientContext*)event->pInterface);
        return;
    }
    if (strcmp(event->name, CLIPRDR_SVC_CHANNEL_NAME) == 0)
    {
        EnterCriticalSection(&m->clipboard_lock);
        m->clip = NULL;
        m->clip_ready = m->clip_pending = FALSE;
        m->clip_long_names = FALSE;
        LeaveCriticalSection(&m->clipboard_lock);
    }
}

static BOOL pre_connect(freerdp* instance)
{
    MeshContext* m = (MeshContext*)instance->context;
    rdpContext* context = instance->context;
    if (PubSub_SubscribeChannelConnected(context->pubSub, channel_connected) < 0) return FALSE;
    m->subscribed_connected = TRUE;
    if (PubSub_SubscribeChannelDisconnected(context->pubSub, channel_disconnected) < 0) return FALSE;
    m->subscribed_disconnected = TRUE;
    return freerdp_client_load_addins(context->channels, context->settings);
}

static BOOL post_connect(freerdp* instance)
{
    rdpContext* context = instance->context;
    MeshContext* m = (MeshContext*)context;
    rdpPointer pointer = { .size = sizeof(rdpPointer), .New = pointer_new, .Free = pointer_free,
        .Set = pointer_set, .SetNull = pointer_null, .SetDefault = pointer_default };
    if (!gdi_init(instance, PIXEL_FORMAT_RGBA32)) return fail(m, "GDI initialization failed");
    graphics_register_pointer(context->graphics, &pointer);
    context->update->BeginPaint = begin_paint;
    context->update->EndPaint = end_paint;
    context->update->DesktopResize = desktop_resize;
    reset_invalid(context);
    return announce_screen(m);
}

static BOOL authenticate(freerdp* instance, char** username, char** password, char** domain,
                         rdp_auth_reason reason)
{
    (void)instance; (void)domain; (void)reason;
    return username && *username && **username && password && *password && **password;
}

static DWORD verify_certificate(freerdp* instance, const char* host, UINT16 port,
                                const char* common_name, const char* subject, const char* issuer,
                                const char* fingerprint, DWORD flags)
{
    (void)instance; (void)host; (void)port; (void)common_name; (void)subject;
    (void)issuer; (void)fingerprint; (void)flags;
    return 2; /* Accept for this session only. */
}

static DWORD verify_changed_certificate(freerdp* instance, const char* host, UINT16 port,
    const char* common_name, const char* subject, const char* issuer, const char* fingerprint,
    const char* old_subject, const char* old_issuer, const char* old_fingerprint, DWORD flags)
{
    (void)old_subject; (void)old_issuer; (void)old_fingerprint;
    return verify_certificate(instance, host, port, common_name, subject, issuer, fingerprint, flags);
}

static BOOL client_new(freerdp* instance, rdpContext* context)
{
    MeshContext* m = (MeshContext*)context;
    InitializeCriticalSection(&m->output_lock);
    InitializeCriticalSection(&m->clipboard_lock);
    atomic_init(&m->cancel_connect, FALSE);
    atomic_init(&m->failed, FALSE);
    atomic_init(&m->announced, FALSE);
    atomic_init(&m->clip_pending, FALSE);
    m->quality = 75;
    m->pointer = -1;
    instance->PreConnect = pre_connect;
    instance->PostConnect = post_connect;
    instance->AuthenticateEx = authenticate;
    instance->VerifyCertificateEx = verify_certificate;
    instance->VerifyChangedCertificateEx = verify_changed_certificate;
    return TRUE;
}

static void client_free(freerdp* instance, rdpContext* context)
{
    MeshContext* m = (MeshContext*)context;
    if (m->subscribed_connected)
        PubSub_UnsubscribeChannelConnected(context->pubSub, channel_connected);
    if (m->subscribed_disconnected)
        PubSub_UnsubscribeChannelDisconnected(context->pubSub, channel_disconnected);
    if (context->gdi) gdi_free(instance);
    if (m->jpeg) tjDestroy(m->jpeg);
    tjFree(m->jpeg_buffer);
    free(m->clipboard);
    if (m->payload) memset(m->payload, 0, m->payload_length);
    free(m->payload);
    DeleteCriticalSection(&m->output_lock);
    DeleteCriticalSection(&m->clipboard_lock);
}

static BOOL json_number(WINPR_JSON* json, const char* key, UINT32* result,
                         UINT32 fallback, UINT32 min, UINT32 max, BOOL required)
{
    WINPR_JSON* item = WINPR_JSON_GetObjectItemCaseSensitive(json, key);
    *result = fallback;
    if (!item) return !required;
    if (!WINPR_JSON_IsNumber(item)) return FALSE;
    double value = WINPR_JSON_GetNumberValue(item);
    if (!(value >= min && value <= max) || value != (UINT32)value) return FALSE;
    *result = (UINT32)value;
    return TRUE;
}

static BOOL json_bool(WINPR_JSON* json, const char* key, BOOL fallback, BOOL* result)
{
    WINPR_JSON* item = WINPR_JSON_GetObjectItemCaseSensitive(json, key);
    *result = fallback;
    if (!item) return TRUE;
    if (!WINPR_JSON_IsBool(item)) return FALSE;
    *result = WINPR_JSON_IsTrue(item);
    return TRUE;
}

/* H.264 depends on how FreeRDP was built (FFmpeg, OpenH264, ...). Advertising it without a
 * decoder would leave the screen black, so check that a decoder can actually be created. */
static BOOL h264_available(void)
{
    H264_CONTEXT* h264 = h264_context_new(FALSE);
    if (!h264) return FALSE;
    BOOL ok = h264_context_reset(h264, 64, 64);
    h264_context_free(h264);
    return ok;
}

static BOOL json_string(rdpSettings* settings, WINPR_JSON* json, const char* key, size_t id,
                         const char* fallback)
{
    WINPR_JSON* item = WINPR_JSON_GetObjectItemCaseSensitive(json, key);
    const char* value = item ? WINPR_JSON_GetStringValue(item) : fallback;
    return value && freerdp_settings_set_string(settings, id, value);
}

/* WINPR_JSON_ParseWithLength accepts trailing text. Locate the end of the
 * outer object as well, so a CONFIG contains exactly one JSON document. */
static BOOL json_document(const BYTE* data, size_t length)
{
    size_t depth = 0;
    BOOL quoted = FALSE, escaped = FALSE, started = FALSE, ended = FALSE;
    for (size_t i = 0; i < length; ++i)
    {
        BYTE ch = data[i];
        if (!ch) return FALSE;
        if (quoted)
        {
            if (escaped) escaped = FALSE;
            else if (ch == '\\') escaped = TRUE;
            else if (ch == '"') quoted = FALSE;
            continue;
        }
        if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') continue;
        if (ended) return FALSE;
        if (!started)
        {
            if (ch != '{') return FALSE;
            started = TRUE;
        }
        if (ch == '"') quoted = TRUE;
        else if (ch == '{' || ch == '[') ++depth;
        else if (ch == '}' || ch == ']')
        {
            if (!depth) return FALSE;
            if (!--depth) ended = TRUE;
        }
    }
    return ended && !quoted;
}

static BOOL configure(MeshContext* m, const BYTE* data, UINT32 length)
{
    rdpSettings* s = base(m)->settings;
    WINPR_JSON* json = NULL;
    UINT32 port, width, height, perf, layout, quality, depth;
    BOOL gfx, h264, ok = FALSE;
    if (!json_document(data, length)) return fail(m, "invalid CONFIG JSON");
    json = WINPR_JSON_ParseWithLength((const char*)data, (size_t)length + 1);
    if (!json || !WINPR_JSON_IsObject(json)) goto out;
    if (!json_number(json, "port", &port, 0, 1, 65535, TRUE) ||
        !json_number(json, "width", &width, 1024, 1, 65535, FALSE) ||
        !json_number(json, "height", &height, 768, 1, 65535, FALSE) ||
        !json_number(json, "perfFlags", &perf, 0, 0, UINT32_MAX, FALSE) ||
        !json_number(json, "keyboardLayout", &layout, 0, 0, UINT32_MAX, FALSE) ||
        !json_number(json, "jpegQuality", &quality, 75, 1, 100, FALSE) ||
        !json_number(json, "colorDepth", &depth, 32, 15, 32, FALSE) ||
        !json_bool(json, "gfx", TRUE, &gfx) ||
        !json_bool(json, "h264", TRUE, &h264)) goto out;
    if (depth != 15 && depth != 16 && depth != 24 && depth != 32) goto out;
    if (gfx) depth = 32; /* The graphics pipeline always uses 32 bpp. */
    if (gfx && h264 && !h264_available())
    {
        fprintf(stderr, "meshfreerdp: H.264 decoder not available, using GFX without H.264\n");
        h264 = FALSE;
    }
    if (!json_string(s, json, "host", FreeRDP_ServerHostname, NULL) ||
        !*freerdp_settings_get_string(s, FreeRDP_ServerHostname) ||
        !json_string(s, json, "domain", FreeRDP_Domain, "") ||
        !json_string(s, json, "username", FreeRDP_Username, "") ||
        !json_string(s, json, "password", FreeRDP_Password, "") ||
        !json_string(s, json, "workingDir", FreeRDP_ShellWorkingDirectory, "") ||
        !json_string(s, json, "alternateShell", FreeRDP_AlternateShell, "")) goto out;
    if (!freerdp_settings_set_uint32(s, FreeRDP_ServerPort, port) ||
        !freerdp_settings_set_uint32(s, FreeRDP_DesktopWidth, width) ||
        !freerdp_settings_set_uint32(s, FreeRDP_DesktopHeight, height) ||
        !freerdp_settings_set_bool(s, FreeRDP_IgnoreCertificate, TRUE) ||
        !freerdp_settings_set_string(s, FreeRDP_AuthenticationPackageList, "!kerberos") ||
        !freerdp_settings_set_bool(s, FreeRDP_SoftwareGdi, TRUE) ||
        !freerdp_settings_set_uint32(s, FreeRDP_ColorDepth, depth) ||
        !freerdp_settings_set_bool(s, FreeRDP_SupportGraphicsPipeline, gfx) ||
        !freerdp_settings_set_bool(s, FreeRDP_GfxH264, gfx && h264) ||
        !freerdp_settings_set_bool(s, FreeRDP_GfxAVC444, gfx && h264) ||
        !freerdp_settings_set_bool(s, FreeRDP_GfxAVC444v2, gfx && h264) ||
        !freerdp_settings_set_bool(s, FreeRDP_GfxProgressive, gfx) ||
        !freerdp_settings_set_bool(s, FreeRDP_GfxProgressiveV2, gfx) ||
        !freerdp_settings_set_bool(s, FreeRDP_RemoteFxCodec, gfx) ||
        !freerdp_settings_set_bool(s, FreeRDP_RedirectClipboard, TRUE) ||
        !freerdp_settings_set_bool(s, FreeRDP_AutoLogonEnabled, TRUE) ||
        !freerdp_settings_set_bool(s, FreeRDP_AutoReconnectionEnabled, FALSE)) goto out;
    /* With CONNECTION_TYPE_AUTODETECT (the FreeRDP default) Windows picks the visual experience itself
     * and ignores PerformanceFlags, so the wallpaper/theming/font smoothing options would have no effect.
     * Network auto-detect support stays on: with GFX Windows sends RTT measure requests anyway, and
     * FreeRDP drops the session (STATE_RUN_FAILED) if they arrive while support is disabled. */
    if (!freerdp_settings_set_uint32(s, FreeRDP_ConnectionType, CONNECTION_TYPE_LAN) ||
        !freerdp_settings_set_bool(s, FreeRDP_NetworkAutoDetect, TRUE)) goto out;
    if (WINPR_JSON_HasObjectItem(json, "perfFlags"))
    {
        if (!freerdp_settings_set_uint32(s, FreeRDP_PerformanceFlags, perf)) goto out;
        freerdp_performance_flags_split(s);
    }
    if (layout && !freerdp_settings_set_uint32(s, FreeRDP_KeyboardLayout, layout)) goto out;
    m->quality = (int)quality;
    m->jpeg = tjInitCompress();
    m->jpeg_capacity = tjBufSize(TILE_SIZE, TILE_SIZE, TJSAMP_420);
    m->jpeg_buffer = tjAlloc((int)m->jpeg_capacity);
    if (!m->jpeg || !m->jpeg_buffer) goto out;
    m->configured = TRUE;
    ok = TRUE;
out:
    WINPR_JSON_Delete(json);
    if (!ok) fail(m, "invalid CONFIG or initialization failure");
    return ok;
}

static BOOL dispatch(MeshContext* m)
{
    BYTE type = m->header[0];
    const BYTE* p = m->payload;
    UINT32 n = m->payload_length;
    if (!m->configured)
    {
        if (type != IN_CONFIG) return fail(m, "CONFIG must be the first frame");
        return configure(m, p, n);
    }
    if (type == IN_CONFIG) return fail(m, "duplicate CONFIG");
    if (type == IN_QUIT)
    {
        if (n) return fail(m, "invalid QUIT length");
        m->quitting = TRUE;
        return TRUE;
    }
    if (!m->connected) return TRUE; /* Inputs before CONNECTED are ignored. */
    rdpInput* input = base(m)->input;
    switch (type)
    {
        case IN_MOUSE:
            if (n != 6) break;
            return freerdp_input_send_mouse_event(input, get16(p), get16(p + 2), get16(p + 4)) ||
                   fail(m, "mouse event failed");
        case IN_SCANCODE:
            if (n != 3 || p[1] > 1 || p[2] > 1) break;
            return freerdp_input_send_keyboard_event_ex(input, p[1], FALSE,
                       MAKE_RDP_SCANCODE(p[0], p[2])) || fail(m, "keyboard event failed");
        case IN_UNICODE:
            if (n != 3 || p[2] > 1) break;
            return freerdp_input_send_unicode_keyboard_event(input, p[2] ? 0 : KBD_FLAGS_RELEASE,
                       get16(p)) || fail(m, "Unicode event failed");
        case IN_CLIPBOARD:
        {
            size_t length = 0;
            WCHAR* text = ConvertUtf8NToWCharAlloc((const char*)p, (size_t)n + 1, &length);
            if (!text) return fail(m, "invalid clipboard UTF-8");
            if (length > (MAX_FRAME / 2 - 1)) { free(text); return fail(m, "clipboard too large"); }
            EnterCriticalSection(&m->clipboard_lock);
            free(m->clipboard);
            m->clipboard = text;
            m->clipboard_length = length;
            UINT rc = clip_announce(m);
            LeaveCriticalSection(&m->clipboard_lock);
            return rc == CHANNEL_RC_OK || fail(m, "clipboard announce failed");
        }
        default: break;
    }
    return fail(m, "invalid input frame");
}

/* Bounded streaming parser: never assumes that a read contains a whole frame. */
static BOOL feed(MeshContext* m, const BYTE* p, size_t length)
{
    while (length && !m->quitting && !m->failed)
    {
        if (m->header_used < 5)
        {
            size_t take = 5 - m->header_used;
            if (take > length) take = length;
            memcpy(m->header + m->header_used, p, take);
            m->header_used += take; p += take; length -= take;
            if (m->header_used < 5) continue;
            m->payload_length = get32(m->header + 1);
            if (m->payload_length > MAX_FRAME) return fail(m, "frame exceeds 64 MiB");
            m->payload = malloc((size_t)m->payload_length + 1);
            if (!m->payload) return fail(m, "input allocation failed");
            m->payload[m->payload_length] = 0;
        }
        size_t take = m->payload_length - m->payload_used;
        if (take > length) take = length;
        memcpy(m->payload + m->payload_used, p, take);
        m->payload_used += take; p += take; length -= take;
        if (m->payload_used == m->payload_length)
        {
            BOOL ok = dispatch(m);
            memset(m->payload, 0, m->payload_length);
            free(m->payload); m->payload = NULL;
            m->header_used = m->payload_used = m->payload_length = 0;
            if (!ok) return FALSE;
        }
    }
    return TRUE;
}

static BOOL read_stdin(MeshContext* m)
{
    BYTE buffer[16384];
    /* Bound work per turn so a busy producer cannot starve network processing. */
    for (int i = 0; i < 64; ++i)
    {
        ssize_t n = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (n > 0)
        {
            if (!feed(m, buffer, (size_t)n)) return FALSE;
            if (m->quitting) return TRUE;
        }
        else if (!n) { m->quitting = TRUE; return TRUE; }
        else if (errno == EINTR) continue;
        else if (errno == EAGAIN || errno == EWOULDBLOCK) return TRUE;
        else return fail(m, "stdin read failed");
    }
    return TRUE;
}

static DWORD WINAPI connect_worker(LPVOID arg)
{
    MeshContext* m = arg;
    if (!atomic_load(&m->cancel_connect)) m->connect_ok = freerdp_connect(base(m)->instance);
    return 0;
}

static BOOL normal_disconnect(UINT32 code)
{
    switch (code)
    {
        case FREERDP_ERROR_SUCCESS:
        case FREERDP_ERROR_RPC_INITIATED_DISCONNECT:
        case FREERDP_ERROR_RPC_INITIATED_LOGOFF:
        case FREERDP_ERROR_IDLE_TIMEOUT:
        case FREERDP_ERROR_LOGON_TIMEOUT:
        case FREERDP_ERROR_DISCONNECTED_BY_OTHER_CONNECTION:
        case FREERDP_ERROR_RPC_INITIATED_DISCONNECT_BY_USER:
        case FREERDP_ERROR_LOGOFF_BY_USER:
            return TRUE;
        default: return FALSE;
    }
}

int main(int argc, char** argv)
{
    (void)argv;
    signal(SIGPIPE, SIG_IGN);
    /* Force OFF before any FreeRDP/WinPR initialization. Environment overrides
     * must never allow a console appender to contaminate the framed stdout. */
    if (setenv("WLOG_LEVEL", "OFF", 1) != 0 || setenv("WLOG_APPENDER", "CONSOLE", 1) != 0 ||
        unsetenv("WLOG_FILTER") != 0) return 1;
    wLog* logger = WLog_GetRoot();
    if (!logger || !WLog_SetLogAppenderType(logger, WLOG_APPENDER_CONSOLE) ||
        !WLog_ConfigureAppender(WLog_GetLogAppender(logger), "outputstream", "stderr")) return 1;
    /* Only now that everything goes to stderr, let FreeRDP warnings through. Node logs stderr
     * in the 'relay' debug output, which is the only way to see why a connection failed. */
    if (!WLog_SetLogLevel(logger, WLOG_WARN)) return 1;
    /* Known per-session noise: build option banner, ignored RDP certificate (we connect through the
     * MeshCentral loopback tunnel), Kerberos probe before NTLM, missing thread priorities on musl. */
    if (!WLog_AddStringLogFilters("com.freerdp.core.rdp:ERROR,com.freerdp.crypto:ERROR,"
                                  "com.winpr.sspi.Kerberos:OFF,com.winpr.thread:ERROR")) return 1;
    RDP_CLIENT_ENTRY_POINTS entry = { .Size = sizeof(entry), .Version = RDP_CLIENT_INTERFACE_VERSION,
        .ContextSize = sizeof(MeshContext), .ClientNew = client_new, .ClientFree = client_free };
    MeshContext* m = (MeshContext*)freerdp_client_context_new(&entry);
    if (!m)
    {
        static const char error[] = "{\"code\":131078,\"name\":\"FREERDP_ERROR_CONNECT_FAILED\"}";
        const BYTE h[] = { OUT_ERROR, sizeof(error) - 1, 0, 0, 0 };
        const BYTE closed[] = { OUT_CLOSED, 0, 0, 0, 0 };
        write_all(h, sizeof(h)); write_all(error, sizeof(error) - 1); write_all(closed, sizeof(closed));
        return 1;
    }
    int in_flags = fcntl(STDIN_FILENO, F_GETFL);
    int out_flags = fcntl(STDOUT_FILENO, F_GETFL);
    HANDLE stdin_event = NULL;
    if (argc != 1) fail(m, "arguments are not supported; send CONFIG on stdin");
    if (in_flags < 0 || out_flags < 0 ||
        fcntl(STDIN_FILENO, F_SETFL, in_flags | O_NONBLOCK) < 0 ||
        fcntl(STDOUT_FILENO, F_SETFL, out_flags & ~O_NONBLOCK) < 0)
        fail(m, "cannot configure stdio descriptors");
    if (!m->failed)
    {
        stdin_event = CreateFileDescriptorEvent(NULL, TRUE, FALSE, STDIN_FILENO, WINPR_FD_READ);
        if (!stdin_event) fail(m, "cannot create stdin event");
    }
    while (!m->failed && !m->quitting)
    {
        HANDLE handles[MAXIMUM_WAIT_OBJECTS];
        DWORD count = 1;
        handles[0] = stdin_event;
        if (m->connect_thread) handles[count++] = m->connect_thread;
        else if (m->connected)
        {
            DWORD n = freerdp_get_event_handles(base(m), handles + count, MAXIMUM_WAIT_OBJECTS - count);
            if (!n || n > MAXIMUM_WAIT_OBJECTS - count) { fail(m, "RDP event handles failed"); break; }
            count += n;
        }
        DWORD wait = WaitForMultipleObjects(count, handles, FALSE, 100);
        if (wait == WAIT_FAILED) { fail(m, "event wait failed"); break; }
        /* Read first: EOF/QUIT takes precedence over a simultaneous connect failure. */
        if (!read_stdin(m) || m->quitting) break;
        if (!m->configured) continue;
        if (!m->connected && !m->connect_thread)
        {
            m->connect_thread = CreateThread(NULL, 0, connect_worker, m, 0, NULL);
            if (!m->connect_thread) fail(m, "cannot create connection thread");
        }
        if (m->connect_thread && WaitForSingleObject(m->connect_thread, 0) == WAIT_OBJECT_0)
        {
            CloseHandle(m->connect_thread); m->connect_thread = NULL;
            if (!m->connect_ok) { m->failed = TRUE; break; }
            m->connected = TRUE;
        }
        if (m->connected)
        {
            BOOL ok = freerdp_check_event_handles(base(m));
            UINT32 code = freerdp_get_last_error(base(m));
            if (freerdp_shall_disconnect_context(base(m)))
            {
                if (!normal_disconnect(code)) m->failed = TRUE;
                break;
            }
            if (!ok) { m->failed = TRUE; break; }
        }
    }
    if (m->connect_thread)
    {
        atomic_store(&m->cancel_connect, TRUE);
        /* Retry abort to cover cancellation just before freerdp_connect starts. */
        while (WaitForSingleObject(m->connect_thread, 0) != WAIT_OBJECT_0)
        {
            (void)freerdp_abort_connect_context(base(m));
            WaitForSingleObject(m->connect_thread, 25);
        }
        CloseHandle(m->connect_thread); m->connect_thread = NULL;
    }
    /* Disconnect drains channel workers before ERROR/CLOSED, so CLOSED is last. */
    UINT32 error = freerdp_get_last_error(base(m));
    m->announced = FALSE;
    if (m->configured) (void)freerdp_disconnect(base(m)->instance);
    freerdp_set_last_error(base(m), error);
    if (m->failed) send_error(m);
    send_frame(m, OUT_CLOSED, NULL, 0);
    int result = m->failed ? 1 : 0;
    if (stdin_event) CloseHandle(stdin_event);
    freerdp_client_context_free(base(m));
    return result;
}
