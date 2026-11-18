/* PuTTY callbacks and the native backend are confined to this Windows thread. */
#include "putty.h"
#include "storage.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>

enum { HOST = 1, PASSWORD, READY, OUTPUT };
enum {
    RUNNING, CLOSED, CONTROL_LOST, INVALID_CONTROL, HOST_DECLINED,
    AUTH_FAILED, TIMED_OUT, PEER_CLOSED, BACKEND_EXIT, BACKEND_FAILED
};

extern bool p13_emit(const void *, int, const void *, size_t, bool);
extern int p13_dispatch(const void *, void *);

const bool share_can_be_downstream = false;
const bool share_can_be_upstream = false;

typedef struct {
    Seat seat;
    const void *context;
    Backend *backend;
    HANDLE handles[2]; /* private input wake and authentication deadline */
    DWORD thread;
    const char *host;
    int port;
    int reason;
    bool host_seen, trusted, answer_ready, auth_used, ready, remote_exit;
    void (*trust)(void *, SeatPromptResult);
    void *trust_context;
    prompts_t *prompt;
} Owner;

static Owner *active;

bool p13_pipes(void)
{
    return GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE &&
        GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) == FILE_TYPE_PIPE;
}

bool p13_managed(void)
{
    BOOL managed = FALSE;
    return IsProcessInJob(GetCurrentProcess(), NULL, &managed) && managed;
}

int check_stored_host_key(const char *host, int port, const char *keytype,
                          const char *key)
{
    (void)key;
    if (!active || active->thread != GetCurrentThreadId() ||
        port != active->port || strcmp(host, active->host) || strcmp(keytype, "rsa"))
        exit(2);
    return 1; /* No helper trust store. Force the Seat challenge. */
}

void store_host_key(Seat *seat, const char *host, int port,
                    const char *keytype, const char *key)
{
    (void)seat; (void)host; (void)port; (void)keytype; (void)key;
    exit(2);
}

static SeatPromptResult host_challenge(
    Seat *seat, const char *host, int port, const char *keytype, char *key,
    SeatDialogText *text, HelpCtx help,
    void (*cb)(void *, SeatPromptResult), void *ctx)
{
    (void)key; (void)help;
    Owner *owner = container_of(seat, Owner, seat);
    if (owner->thread != GetCurrentThreadId() || owner->host_seen ||
        port != owner->port || strcmp(host, owner->host) ||
        strcmp(keytype, "rsa") || !text || !cb)
        return SPR_SW_ABORT("unexpected SSH1 host challenge");
    for (size_t i = 0; i < text->nitems; i++) {
        if (text->items[i].type != SDT_DISPLAY)
            continue;
        const char *fingerprint = text->items[i].text;
        if (!p13_emit(owner->context, HOST, fingerprint, strlen(fingerprint), false))
            continue;
        owner->host_seen = true;
        owner->trust = cb;
        owner->trust_context = ctx;
        return SPR_INCOMPLETE;
    }
    owner->reason = BACKEND_FAILED;
    return SPR_SW_ABORT("unsupported SSH1 host challenge");
}

static SeatPromptResult password_challenge(Seat *seat, prompts_t *prompt)
{
    Owner *owner = container_of(seat, Owner, seat);
    if (owner->thread == GetCurrentThreadId() && owner->trusted &&
        !owner->auth_used && prompt && prompt->name &&
        !strcmp(prompt->name, "SSH password") && prompt->to_server &&
        !prompt->from_server && prompt->n_prompts == 1 &&
        !prompt->prompts[0]->echo && prompt->callback) {
        if (owner->prompt == prompt && owner->answer_ready) {
            owner->prompt = NULL;
            owner->auth_used = true;
            return SPR_OK;
        }
        if (!owner->prompt && p13_emit(owner->context, PASSWORD, NULL, 0, false)) {
            owner->prompt = prompt;
            return SPR_INCOMPLETE;
        }
    }
    owner->reason = AUTH_FAILED;
    return SPR_SW_ABORT("SSH1 password authentication stopped");
}

bool p13_host(Owner *owner, bool approve)
{
    if (owner->thread != GetCurrentThreadId() || !owner->trust)
        return false;
    void (*cb)(void *, SeatPromptResult) = owner->trust;
    owner->trust = NULL;
    owner->trusted = approve;
    if (!approve)
        owner->reason = HOST_DECLINED;
    cb(owner->trust_context, approve ? SPR_OK : SPR_USER_ABORT);
    return true;
}

bool p13_password(Owner *owner, const unsigned char *data, size_t len)
{
    char secret[8193];
    if (owner->thread != GetCurrentThreadId() || !owner->prompt ||
        owner->answer_ready || len >= sizeof(secret))
        return false;
    memcpy(secret, data, len);
    secret[len] = '\0';
    prompts_t *prompt = owner->prompt;
    prompt_set_result(prompt->prompts[0], secret);
    smemclr(secret, sizeof(secret));
    owner->answer_ready = true;
    prompt->callback(prompt->callback_ctx);
    return true;
}

bool p13_input(Owner *owner, const char *data, size_t len)
{
    if (owner->thread != GetCurrentThreadId() || !owner->ready ||
        !backend_sendok(owner->backend) || backend_sendbuffer(owner->backend) > 64 * 1024)
        return false;
    backend_send(owner->backend, data, len);
    return true;
}

bool p13_resize(Owner *owner, unsigned short cols, unsigned short rows)
{
    if (owner->thread != GetCurrentThreadId() || !owner->ready ||
        !backend_sendok(owner->backend))
        return false;
    backend_size(owner->backend, cols, rows);
    return true;
}

static bool ensure_ready(Owner *owner)
{
    if (owner->ready)
        return true;
    if (owner->reason != RUNNING || !owner->backend || !owner->auth_used ||
        backend_cfg_info(owner->backend) != 1 || !backend_sendok(owner->backend))
        return false;
    owner->ready = p13_emit(owner->context, READY, NULL, 0, false);
    if (!owner->ready)
        owner->reason = CONTROL_LOST;
    return owner->ready;
}

static size_t output(Seat *seat, SeatOutputType type, const void *data, size_t len)
{
    Owner *owner = container_of(seat, Owner, seat);
    if (owner->thread != GetCurrentThreadId() || !ensure_ready(owner))
        return 0; /* Pre-session notices have no application stream. */
    if (!p13_emit(owner->context, OUTPUT, data, len, type == SEAT_OUTPUT_STDERR))
        owner->reason = CONTROL_LOST;
    return 0;
}

static void remote_exit(Seat *seat)
{
    Owner *owner = container_of(seat, Owner, seat);
    owner->remote_exit = true;
}

static void fatal(Seat *seat, const char *message)
{
    (void)message;
    Owner *owner = container_of(seat, Owner, seat);
    if (owner->reason == RUNNING)
        owner->reason = BACKEND_FAILED;
}

static const struct SeatVtable seat_vt = {
    .output = output,
    .eof = nullseat_eof,
    .sent = nullseat_sent,
    .banner = nullseat_banner,
    .get_userpass_input = password_challenge,
    .confirm_ssh_host_key = host_challenge,
    .notify_session_started = nullseat_notify_session_started,
    .notify_remote_exit = remote_exit,
    .notify_remote_disconnect = nullseat_notify_remote_disconnect,
    .connection_fatal = fatal,
    .nonfatal = nullseat_nonfatal,
    .update_specials_menu = nullseat_update_specials_menu,
    .get_ttymode = nullseat_get_ttymode,
    .prompt_descriptions = nullseat_prompt_descriptions,
    .set_busy_status = nullseat_set_busy_status,
    .confirm_weak_crypto_primitive = nullseat_confirm_weak_crypto_primitive,
    .is_utf8 = nullseat_is_never_utf8,
    .echoedit_update = nullseat_echoedit_update,
    .stripctrl_new = nullseat_stripctrl_new,
    .verbose = nullseat_verbose_no,
    .interactive = nullseat_interactive_no,
    .has_mixed_input_stream = nullseat_has_mixed_input_stream_no,
    .can_set_trust_status = nullseat_can_set_trust_status_no,
    .set_trust_status = nullseat_set_trust_status,
};

static bool before_wait(void *ctx, const HANDLE **handles, size_t *count)
{
    Owner *owner = ctx;
    *handles = owner->handles;
    *count = owner->ready ? 1 : 2;
    return true;
}

static bool after_wait(void *ctx, size_t index)
{
    Owner *owner = ctx;
    if (!backend_connected(owner->backend))
        return false;
    if (owner->reason == RUNNING && !owner->ready &&
        WaitForSingleObject(owner->handles[1], 0) == WAIT_OBJECT_0)
        owner->reason = TIMED_OUT;
    if (owner->reason == RUNNING)
        ensure_ready(owner);
    if (owner->reason == RUNNING && index == 0) {
        int reason = p13_dispatch(owner->context, owner);
        if (reason != RUNNING)
            owner->reason = reason;
    }
    return owner->reason == RUNNING && backend_connected(owner->backend);
}

int p13_owner(const void *context, HANDLE wake, const char *host,
              unsigned short port, const char *username, unsigned short cols,
              unsigned short rows, int *status)
{
    Owner owner = {
        .seat = { .vt = &seat_vt }, .context = context, .host = host, .port = port,
        .thread = GetCurrentThreadId(),
    };
    owner.handles[0] = wake;
    HANDLE deadline = CreateWaitableTimerW(NULL, TRUE, NULL);
    if (!deadline)
        return BACKEND_FAILED;
    owner.handles[1] = deadline;
    LARGE_INTEGER due = { .QuadPart = -300000000 }; /* 30 seconds before Ready. */
    if (!SetWaitableTimer(deadline, &due, 0, NULL, NULL, FALSE)) {
        CloseHandle(deadline);
        return BACKEND_FAILED;
    }

    Conf *conf = conf_new();
    do_defaults(NULL, conf);
    conf_set_int(conf, CONF_protocol, PROT_SSH);
    conf_set_int(conf, CONF_sshprot, 0); /* SSH1 only. */
    conf_set_int(conf, CONF_proxy_type, PROXY_NONE);
    conf_set_int(conf, CONF_logtype, LGTYP_NONE);
    conf_set_bool(conf, CONF_ssh_connection_sharing, false);
    conf_set_bool(conf, CONF_tryagent, false);
    conf_set_bool(conf, CONF_try_tis_auth, false);
    conf_set_bool(conf, CONF_ssh_no_trivial_userauth, true);
    conf_set_bool(conf, CONF_agentfwd, false);
    conf_set_bool(conf, CONF_x11_forward, false);
    conf_set_bool(conf, CONF_nopty, false);
    conf_set_int(conf, CONF_width, cols);
    conf_set_int(conf, CONF_height, rows);
    conf_set_str(conf, CONF_username, username);
    conf_set_str(conf, CONF_remote_cmd, "");
    conf_set_str(conf, CONF_ssh_nc_host, "");

    char *realhost = NULL;
    active = &owner;
    sk_init();
    winselcli_setup();
    char *error = backend_init(&ssh_backend, &owner.seat, &owner.backend, NULL,
                               conf, host, port, &realhost, false, false);
    if (error || !owner.backend) {
        owner.reason = BACKEND_FAILED;
    } else {
        cli_main_loop(before_wait, after_wait, &owner);
        if (owner.reason == RUNNING) {
            *status = backend_exitcode(owner.backend);
            owner.reason = owner.ready && owner.remote_exit && *status >= 0 && *status < INT_MAX ?
                BACKEND_EXIT : PEER_CLOSED;
        }
    }

    if (owner.backend)
        backend_free(owner.backend);
    sk_cleanup();
    active = NULL;
    conf_free(conf);
    sfree(error);
    sfree(realhost);
    CloseHandle(deadline);
    return owner.reason;
}
