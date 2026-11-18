/* Test-only replacements for two deliberately renamed upstream stubs. */
#include "putty.h"
#include "storage.h"
#include <stdio.h>
#include <stdlib.h>
#ifdef P04_TRUST_PROBE
#include <string.h>
extern int p04_trust_port;
#endif

int check_stored_host_key(const char *host, int port,
                          const char *type, const char *key)
{
#ifdef P04_TRUST_PROBE
    if (p04_trust_port > 0 && port == p04_trust_port &&
        !strcmp(host, "127.0.0.1") && !strcmp(type, "rsa"))
        return 1; /* Absent, so the real backend must consult Seat. */
#endif
    (void)host; (void)port; (void)type; (void)key;
    fputs("P04_STORAGE_GUARD: host-key lookup refused\n", stderr);
    exit(23);
}

void store_host_key(Seat *seat, const char *host, int port,
                    const char *type, const char *key)
{
    (void)seat; (void)host; (void)port; (void)type; (void)key;
    fputs("P04_STORAGE_GUARD: host-key write refused\n", stderr);
    exit(24);
}
