/* PuTTY 0.85 Seat contract probe. This program never creates a backend. */
#include "putty.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const bool share_can_be_downstream = false;
const bool share_can_be_upstream = false;

enum Challenge { NONE, HOST_KEY, PASSWORD };
typedef struct {
    Seat seat;
    DWORD owner;
    unsigned id;
    enum Challenge pending;
    bool ready, closed, approved;
    prompts_t *prompts;
    void (*host_callback)(void *, SeatPromptResult);
    void *host_ctx;
} Probe;

static void require(bool ok, const char *label)
{
    if (!ok) {
        fprintf(stderr, "P04 Seat check failed: %s\n", label);
        exit(1);
    }
}

static void owner(const Probe *p)
{
    require(p->owner == GetCurrentThreadId(), "owner thread");
}

static bool begin(Probe *p, enum Challenge kind)
{
    owner(p);
    if (p->closed || p->pending != NONE || p->id == UINT_MAX)
        return false;
    p->pending = kind;
    ++p->id;
    return true;
}

static void clear_pending(Probe *p)
{
    p->pending = NONE;
    p->ready = false;
    p->approved = false;
    p->prompts = NULL;
    p->host_callback = NULL;
    p->host_ctx = NULL;
}

static SeatPromptResult password(Seat *seat, prompts_t *prompts)
{
    Probe *p = container_of(seat, Probe, seat);
    owner(p);
    if (p->pending == PASSWORD && p->prompts == prompts) {
        if (!p->ready)
            return SPR_INCOMPLETE;
        bool approved = p->approved;
        clear_pending(p);
        return approved ? SPR_OK : SPR_USER_ABORT;
    }
    if (prompts->n_prompts != 1 || prompts->prompts[0]->echo ||
        !prompts->callback || !begin(p, PASSWORD))
        return SPR_SW_ABORT("unsupported or busy password prompt");
    p->prompts = prompts;
    return SPR_INCOMPLETE;
}

static SeatPromptResult host_key(
    Seat *seat, const char *host, int port, const char *type, char *key,
    SeatDialogText *text, HelpCtx help,
    void (*cb)(void *, SeatPromptResult), void *ctx)
{
    (void)host; (void)port; (void)type; (void)key; (void)text; (void)help;
    Probe *p = container_of(seat, Probe, seat);
    if (!cb || !begin(p, HOST_KEY))
        return SPR_SW_ABORT("busy or closed host-key prompt");
    /* Do not retain the caller's temporary dialog text or key pointer. */
    p->host_callback = cb;
    p->host_ctx = ctx;
    return SPR_INCOMPLETE;
}

static const struct SeatVtable seat_vtable = {
    .get_userpass_input = password,
    .confirm_ssh_host_key = host_key,
};

static void resume(void *ctx)
{
    Probe *p = ctx;
    owner(p);
    require(p->ready && !p->closed, "live accepted response");
    if (p->pending == HOST_KEY) {
        void (*cb)(void *, SeatPromptResult) = p->host_callback;
        void *cb_ctx = p->host_ctx;
        SeatPromptResult result = p->approved ? SPR_OK : SPR_USER_ABORT;
        clear_pending(p);
        cb(cb_ctx, result);
    } else {
        require(p->pending == PASSWORD, "password continuation");
        p->prompts->callback(p->prompts->callback_ctx);
    }
}

static bool answer(Probe *p, enum Challenge kind, unsigned id, bool yes,
                   const char *value)
{
    owner(p);
    if (p->closed || kind == NONE || p->pending != kind ||
        p->id != id || p->ready)
        return false;
    if ((value != NULL) != (kind == PASSWORD && yes))
        return false;
    if (value)
        prompt_set_result(p->prompts->prompts[0], value);
    p->approved = yes;
    p->ready = true;
    queue_toplevel_callback(resume, p);
    return true;
}

static void close_seat(Probe *p)
{
    owner(p);
    p->closed = true;
    delete_callbacks_for_context(p);
    if (p->pending == PASSWORD && p->ready && p->approved) {
        strbuf *result = p->prompts->prompts[0]->result;
        smemclr(result->s, result->len);
        prompt_set_result(p->prompts->prompts[0], "");
    }
    clear_pending(p);
}

typedef struct {
    Probe *p;
    prompts_t *prompts;
    unsigned calls;
    SeatPromptResult result;
} Consumer;

static InteractionReadySeat ready_seat(Probe *p)
{
    return (InteractionReadySeat){ .seat = &p->seat };
}

static void host_done(void *ctx, SeatPromptResult result)
{
    Consumer *c = ctx;
    owner(c->p);
    c->calls++;
    c->result = result;
}

static void password_done(void *ctx)
{
    Consumer *c = ctx;
    owner(c->p);
    c->calls++;
    c->result = seat_get_userpass_input(ready_seat(c->p), c->prompts);
}

static SeatPromptResult ask_host(Probe *p, Consumer *c)
{
    char key[] = "synthetic-public-key";
    return seat_confirm_ssh_host_key(ready_seat(p), "synthetic", 22, "rsa",
                                     key, NULL, (HelpCtx){0}, host_done, c);
}

static prompts_t *ask_password(Consumer *c)
{
    prompts_t *prompts = new_prompts();
    add_prompt(prompts, dupstr("synthetic password"), false);
    prompts->callback = password_done;
    prompts->callback_ctx = c;
    c->prompts = prompts;
    return prompts;
}

int main(void)
{
    Probe p = { .seat = { .vt = &seat_vtable }, .owner = GetCurrentThreadId() };
    Consumer c = { .p = &p };
    const char synthetic[] = "p04-seat-synthetic-value";

    for (unsigned yes = 0; yes < 2; yes++) {
        c.calls = 0;
        require(ask_host(&p, &c).kind == SPRK_INCOMPLETE, "host defers");
        require(!answer(&p, HOST_KEY, p.id - 1, true, NULL) &&
                !answer(&p, PASSWORD, p.id, true, synthetic), "host mismatch");
        run_toplevel_callbacks();
        require(c.calls == 0, "host mismatch does not resume");
        require(answer(&p, HOST_KEY, p.id, yes != 0, NULL), "host answer");
        require(c.calls == 0 && !answer(&p, HOST_KEY, p.id, true, NULL),
                "host callback queued once");
        run_toplevel_callbacks();
        require(c.calls == 1 &&
                c.result.kind == (yes ? SPRK_OK : SPRK_USER_ABORT) &&
                !answer(&p, HOST_KEY, p.id, true, NULL), "host consumed");

        c.calls = 0;
        prompts_t *prompts = ask_password(&c);
        require(seat_get_userpass_input(ready_seat(&p), prompts).kind ==
                SPRK_INCOMPLETE, "password defers");
        unsigned id = p.id;
        require(seat_get_userpass_input(ready_seat(&p), prompts).kind ==
                SPRK_INCOMPLETE && p.id == id, "password pending reentry");
        require(ask_host(&p, &c).kind == SPRK_SW_ABORT, "second prompt refused");
        require(!answer(&p, PASSWORD, id - 1, true, synthetic) &&
                !answer(&p, HOST_KEY, id, true, NULL), "password mismatch");
        run_toplevel_callbacks();
        require(c.calls == 0 && !*prompt_get_result_ref(prompts->prompts[0]),
                "password mismatch does not restore or write");
        require(answer(&p, PASSWORD, id, yes != 0, yes ? synthetic : NULL) &&
                c.calls == 0, "password queued");
        run_toplevel_callbacks();
        require(c.calls == 1 &&
                c.result.kind == (yes ? SPRK_OK : SPRK_USER_ABORT) &&
                !strcmp(prompt_get_result_ref(prompts->prompts[0]), yes ? synthetic : "") &&
                !answer(&p, PASSWORD, id, true, synthetic), "password consumed");
        free_prompts(prompts);
    }

    for (enum Challenge kind = HOST_KEY; kind <= PASSWORD; kind++) {
        Probe closing = { .seat = { .vt = &seat_vtable }, .owner = GetCurrentThreadId() };
        Consumer cancelled = { .p = &closing };
        prompts_t *prompts = kind == PASSWORD ? ask_password(&cancelled) : NULL;
        SeatPromptResult first = prompts ?
            seat_get_userpass_input(ready_seat(&closing), prompts) :
            ask_host(&closing, &cancelled);
        require(first.kind == SPRK_INCOMPLETE &&
                answer(&closing, kind, closing.id, true, prompts ? synthetic : NULL),
                "queued before close");
        close_seat(&closing);
        if (prompts) {
            require(!*prompt_get_result_ref(prompts->prompts[0]), "close clears answer");
            free_prompts(prompts);
        }
        require(!answer(&closing, kind, closing.id, true,
                        kind == PASSWORD ? synthetic : NULL), "late answer refused");
        run_toplevel_callbacks();
        require(cancelled.calls == 0, "no callback after close");
    }

    puts("PASS P04 Seat deferred host/password, owner resume and close cancellation");
    return 0;
}
