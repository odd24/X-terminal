/* Exercise linked storage entry points without opening a socket. */
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

static const struct SeatVtable probe_seat = {
    .output = nullseat_output,
    .eof = nullseat_eof,
    .sent = nullseat_sent,
    .banner = nullseat_banner,
    .get_userpass_input = nullseat_get_userpass_input,
    .notify_session_started = nullseat_notify_session_started,
    .notify_remote_exit = nullseat_notify_remote_exit,
    .notify_remote_disconnect = nullseat_notify_remote_disconnect,
    .connection_fatal = nullseat_connection_fatal,
    .update_specials_menu = nullseat_update_specials_menu,
    .confirm_ssh_host_key = nullseat_confirm_ssh_host_key,
    .prompt_descriptions = nullseat_prompt_descriptions,
    .set_busy_status = nullseat_set_busy_status,
    .verbose = nullseat_verbose_no,
    .interactive = nullseat_interactive_no,
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
    if (probe.backend)
        backend_free(probe.backend);
    sfree(error);
    sfree(realhost);
    conf_free(conf);
    sk_cleanup();
    CloseHandle(probe.deadline);
    if (!initialized || !probe.resized || probe.timed_out)
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
