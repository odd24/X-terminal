#define _POSIX_C_SOURCE 200809L
#include <signal.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(void)
{
    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGWINCH);
    if (sigprocmask(SIG_BLOCK, &signals, NULL) != 0)
        return 1;

    if (!isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO) ||
        tcgetpgrp(STDIN_FILENO) != getpgrp())
        return 2;

    struct winsize size;
    if (ioctl(STDIN_FILENO, TIOCGWINSZ, &size) != 0)
        return 3;
    printf("P04_PTY_INITIAL %u %u\n", (unsigned)size.ws_row, (unsigned)size.ws_col);
    if (fflush(stdout) != 0)
        return 4;

    const struct timespec deadline = { .tv_sec = 2 };
    if (sigtimedwait(&signals, NULL, &deadline) != SIGWINCH)
        return 5;
    if (ioctl(STDIN_FILENO, TIOCGWINSZ, &size) != 0)
        return 6;
    printf("P04_PTY_SIGWINCH %u %u\n", (unsigned)size.ws_row, (unsigned)size.ws_col);
    return fflush(stdout) != 0 ? 7 : 0;
}
