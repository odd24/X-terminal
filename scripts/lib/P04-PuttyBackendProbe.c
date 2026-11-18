/* Local PuTTY 0.85 link probe. No backend instance is created. */
#include "putty.h"
#include <stdio.h>
#include <string.h>

/* Required by Windows sharing.c when the original Plink entry is absent. */
const bool share_can_be_downstream = false;
const bool share_can_be_upstream = false;

int main(void)
{
    const BackendVtable *backend = backend_vt_from_proto(PROT_SSH);
    if (backend != &ssh_backend || strcmp(backend->id, "ssh") != 0 ||
        !backend->init || !backend->size || !backend->free)
        return 1;

    puts("PASS PuTTY SSH backend lookup returns ssh_backend with init/size/free");
    return 0;
}
