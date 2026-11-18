/* Exercise nonpersistent storage and the locked SSH1 backend in owned probes. */
#include "putty.h"
#include "storage.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const bool share_can_be_downstream = false;
const bool share_can_be_upstream = false;

static void unexpected_seed(void *data, int len)
{
    (void)data; (void)len;
    exit(25);
}

typedef struct {
    Backend *backend;
    HANDLE deadline;
    DWORD owner;
    bool resized;
    bool timed_out;
} Probe;

#ifdef P04_TRUST_PROBE
int p04_trust_port;
static const char *fixture_fingerprint;
static unsigned trust_calls, auth_calls;
static void (*trust_continuation)(void *, SeatPromptResult);
static void *trust_ctx;
static DWORD trust_owner;
static bool approve_fixture, resize_fixture, approved, password_ready, auth_completed;
static bool session_started, remote_exit, bad_output;
static prompts_t *pending_password;
static char fixture_secret[64];
static const char expected_output[] = "P04_PTY_OK\r\n";
static size_t output_received;

static void finish_trust(void *unused)
{
    (void)unused;
    if (GetCurrentThreadId() != trust_owner || !trust_continuation)
        exit(28);
    void (*cb)(void *, SeatPromptResult) = trust_continuation;
    trust_continuation = NULL;
    approved = approve_fixture;
    puts(approved ? "P04_HOST_APPROVED_ONCE" : "P04_HOST_REJECTED");
    cb(trust_ctx, approved ? SPR_OK : SPR_USER_ABORT);
}

static SeatPromptResult fixture_host_key(
    Seat *seat, const char *host, int port, const char *type, char *key,
    SeatDialogText *text, HelpCtx help,
    void (*cb)(void *, SeatPromptResult), void *ctx)
{
    (void)seat; (void)key; (void)help;
    if (!fixture_fingerprint || GetCurrentThreadId() != trust_owner ||
        ++trust_calls != 1 || port != p04_trust_port ||
        strcmp(host, "127.0.0.1") || strcmp(type, "rsa") || !cb || !text)
        return SPR_SW_ABORT("unexpected test host challenge");
    for (size_t i = 0; i < text->nitems; i++) {
        if (text->items[i].type == SDT_DISPLAY &&
            !strcmp(text->items[i].text, fixture_fingerprint)) {
            trust_continuation = cb;
            trust_ctx = ctx;
            queue_toplevel_callback(finish_trust, &trust_ctx);
            puts("P04_HOST_CHALLENGE_MATCHED");
            return SPR_INCOMPLETE;
        }
    }
    return SPR_SW_ABORT("test host fingerprint mismatch");
}

static void finish_password(void *unused)
{
    (void)unused;
    if (GetCurrentThreadId() != trust_owner || !pending_password || password_ready)
        exit(28);
    prompts_t *p = pending_password;
    prompt_set_result(p->prompts[0], fixture_secret);
    smemclr(fixture_secret, sizeof(fixture_secret));
    password_ready = true;
    p->callback(p->callback_ctx);
}

static SeatPromptResult fixture_password(Seat *seat, prompts_t *p)
{
    (void)seat;
    if (!approved || GetCurrentThreadId() != trust_owner || auth_completed ||
        !p || !p->name || strcmp(p->name, "SSH password") || !p->to_server ||
        p->from_server || p->n_prompts != 1 || p->prompts[0]->echo || !p->callback) {
        ++auth_calls;
        return SPR_SW_ABORT("unexpected test password prompt");
    }
    if (p == pending_password && password_ready) {
        pending_password = NULL;
        auth_completed = true;
        puts("P04_PASSWORD_SUBMITTED_ONCE");
        return SPR_OK;
    }
    ++auth_calls;
    if (pending_password || auth_calls != 1)
        return SPR_SW_ABORT("duplicate test password prompt");
    pending_password = p;
    queue_toplevel_callback(finish_password, &pending_password);
    return SPR_INCOMPLETE;
}

static void fixture_session_started(Seat *seat)
{
    (void)seat;
    if (approve_fixture) {
        if (GetCurrentThreadId() != trust_owner || !auth_completed || session_started)
            exit(28);
        session_started = true;
        puts("P04_SESSION_STARTED");
    }
}

static size_t fixture_output(Seat *seat, SeatOutputType type,
                             const void *data, size_t len)
{
    if (!approve_fixture)
        return nullseat_output(seat, type, data, len);
    if (GetCurrentThreadId() != trust_owner || !session_started ||
        type != SEAT_OUTPUT_STDOUT ||
        len > sizeof(expected_output) - 1 - output_received ||
        memcmp(expected_output + output_received, data, len)) {
        bad_output = true;
    } else {
        output_received += len;
    }
    return 0;
}

static void fixture_remote_exit(Seat *seat)
{
    (void)seat;
    if (approve_fixture && GetCurrentThreadId() != trust_owner)
        exit(28);
    remote_exit = true;
}
#endif

static const struct SeatVtable probe_seat = {
#ifdef P04_TRUST_PROBE
    .output = fixture_output,
    .notify_session_started = fixture_session_started,
    .notify_remote_exit = fixture_remote_exit,
#else
    .output = nullseat_output,
    .notify_session_started = nullseat_notify_session_started,
    .notify_remote_exit = nullseat_notify_remote_exit,
#endif
    .eof = nullseat_eof,
    .sent = nullseat_sent,
    .banner = nullseat_banner,
#ifdef P04_TRUST_PROBE
    .get_userpass_input = fixture_password,
    .confirm_ssh_host_key = fixture_host_key,
#else
    .get_userpass_input = nullseat_get_userpass_input,
    .confirm_ssh_host_key = nullseat_confirm_ssh_host_key,
#endif
    .notify_remote_disconnect = nullseat_notify_remote_disconnect,
    .connection_fatal = nullseat_connection_fatal,
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
    Probe *probe = ctx;
    *handles = &probe->deadline;
    *count = 1;
    return true;
}

static bool after_wait(void *ctx, size_t index)
{
    Probe *probe = ctx;
    if (GetCurrentThreadId() != probe->owner)
        exit(27);
    if (index == 0) {
        probe->timed_out = true;
        return false;
    }
    if (!backend_connected(probe->backend))
        return false;
#ifdef P04_TRUST_PROBE
    if (approve_fixture) {
        /* The fixed TTY command emits the marker before waiting for a line. */
        if (resize_fixture && !probe->resized && !bad_output &&
            output_received == sizeof(expected_output) - 1 &&
            backend_sendok(probe->backend)) {
            backend_size(probe->backend, 137, 41);
            probe->resized = true;
            puts("P04_OWNER_RESIZE_AFTER_PTY 137x41");
            backend_send(probe->backend, "\n", 1);
        }
        return true;
    }
#endif
    if (!probe->resized) {
        backend_size(probe->backend, 137, 41);
        probe->resized = true;
        puts("P04_OWNER_RESIZE 137x41");
        fflush(stdout);
    }
    return true;
}

static int loopback(const BackendVtable *vt, const char *port_text)
{
    char *end;
    long port = strtol(port_text, &end, 10);
    if (*end || port < 1 || port > 65535)
        return 5;
    Probe probe = { .owner = GetCurrentThreadId() };
#ifdef P04_TRUST_PROBE
    p04_trust_port = fixture_fingerprint ? (int)port : 0;
    trust_owner = probe.owner;
#endif
    probe.deadline = CreateWaitableTimerW(NULL, TRUE, NULL);
    if (!probe.deadline)
        return 6;
    LARGE_INTEGER due;
    due.QuadPart = -40000000; /* Four seconds, in 100 ns units. */
    if (!SetWaitableTimer(probe.deadline, &due, 0, NULL, NULL, FALSE)) {
        CloseHandle(probe.deadline);
        return 6;
    }

    Conf *conf = conf_new();
    do_defaults(NULL, conf); /* The linked profile lookup always returns NULL. */
    conf_set_int(conf, CONF_protocol, PROT_SSH);
    conf_set_int(conf, CONF_sshprot, 0); /* SSH1 only. */
    conf_set_int(conf, CONF_proxy_type, PROXY_NONE);
    conf_set_int(conf, CONF_logtype, LGTYP_NONE);
    conf_set_bool(conf, CONF_ssh_connection_sharing, false);
    conf_set_bool(conf, CONF_tryagent, false);
    conf_set_bool(conf, CONF_agentfwd, false);
    conf_set_bool(conf, CONF_x11_forward, false);
    conf_set_str(conf, CONF_remote_cmd, "");
    conf_set_str(conf, CONF_ssh_nc_host, "");
#ifdef P04_TRUST_PROBE
    if (approve_fixture) {
        conf_set_str(conf, CONF_username, "p04-fixture");
        conf_set_bool(conf, CONF_nopty, false);
        if (resize_fixture) {
            conf_set_str_str(conf, CONF_ttymodes, "ECHO", "V0");
            conf_set_str(conf, CONF_remote_cmd,
                         "test -t 0 && test -t 1 && printf 'P04_PTY_OK\\n' "
                         "&& IFS= read -r p04_resize_gate");
        } else {
            conf_set_str(conf, CONF_remote_cmd,
                         "test -t 0 && test -t 1 && printf 'P04_PTY_OK\\n'");
        }
    }
#endif
    /* Port forwarding and local proxy commands have no source in this Conf. */

    Seat seat = { .vt = &probe_seat };
    char *realhost = NULL;
    sk_init();
    winselcli_setup();
    char *error = backend_init(vt, &seat, &probe.backend, NULL, conf,
                               "127.0.0.1", (int)port, &realhost, false, false);
    bool initialized = error == NULL && backend_cfg_info(probe.backend) == 1;
    if (initialized)
        cli_main_loop(before_wait, after_wait, &probe);
    if (GetCurrentThreadId() != probe.owner)
        exit(27);
    bool verified = probe.resized;
#ifdef P04_TRUST_PROBE
    delete_callbacks_for_context(&trust_ctx);
    delete_callbacks_for_context(&pending_password);
    smemclr(fixture_secret, sizeof(fixture_secret));
    if (fixture_fingerprint)
        verified = verified && trust_calls == 1 && auth_calls == 0 && !trust_continuation;
    if (approve_fixture) {
        int status = initialized ? backend_exitcode(probe.backend) : -1;
        verified = approved && trust_calls == 1 && !trust_continuation &&
            auth_completed && auth_calls == 1 && !pending_password &&
            session_started && !bad_output && output_received == sizeof(expected_output) - 1 &&
            (!resize_fixture || probe.resized) && remote_exit && status == 0;
        if (verified)
            puts("P04_PTY_OUTPUT_MATCHED_AND_REMOTE_EXIT_0");
        else
            fprintf(stderr, "P04_SESSION_CHECK bytes=%zu mismatch=%d exit=%d status=%d timeout=%d\n",
                    output_received, bad_output, remote_exit, status, probe.timed_out);
    }
#endif
    if (probe.backend)
        backend_free(probe.backend);
    sfree(error);
    sfree(realhost);
    conf_free(conf);
    sk_cleanup();
    CloseHandle(probe.deadline);
    if (!initialized || !verified || probe.timed_out)
        return 7;
    puts("P04_OWNER_FREE");
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "lookup") == 0)
        return check_stored_host_key("synthetic", 22, "rsa", "synthetic");
    if (argc == 2 && strcmp(argv[1], "write") == 0) {
        store_host_key(NULL, "synthetic", 22, "rsa", "synthetic");
        return 26;
    }
    const BackendVtable *backend = backend_vt_from_proto(PROT_SSH);
    if (backend != &ssh_backend || !backend->init || !backend->size || !backend->free)
        return 3;
    if (argc == 3 && strcmp(argv[1], "loopback") == 0)
        return loopback(backend, argv[2]);
#ifdef P04_TRUST_PROBE
    if (argc == 4 && strcmp(argv[1], "trust") == 0) {
        fixture_fingerprint = argv[3];
        return loopback(backend, argv[2]);
    }
    if (argc == 4 && (strcmp(argv[1], "approve-fixture") == 0 ||
                      strcmp(argv[1], "resize-fixture") == 0)) {
        fixture_fingerprint = argv[3];
        resize_fixture = strcmp(argv[1], "resize-fixture") == 0;
        setvbuf(stdout, NULL, _IONBF, 0);
        if (!fgets(fixture_secret, sizeof(fixture_secret), stdin))
            return 8;
        size_t length = strcspn(fixture_secret, "\r\n");
        approve_fixture = length > 0 && fixture_secret[length] != '\0';
        fixture_secret[length] = '\0';
        int status = approve_fixture ? loopback(backend, argv[2]) : 8;
        smemclr(fixture_secret, sizeof(fixture_secret));
        return status;
    }
#endif
    if (argc != 1)
        return 2;
    if (open_settings_r("synthetic") != NULL)
        return 4;
    read_random_seed(unexpected_seed);
    unsigned char seed = 42;
    write_random_seed(&seed, sizeof(seed));
    puts("PASS backend linked with empty profile and nonpersistent seed hooks");
    return 0;
}
