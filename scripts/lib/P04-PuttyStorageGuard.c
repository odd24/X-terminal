/* Test-only replacements for two deliberately renamed upstream stubs. */
#include "putty.h"
#include "storage.h"
#include <stdio.h>
#include <stdlib.h>

int check_stored_host_key(const char *host, int port,
                          const char *type, const char *key)
{
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
