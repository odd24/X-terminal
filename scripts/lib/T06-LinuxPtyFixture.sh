#!/bin/sh
set -eu
export TERM=xterm-256color LC_ALL=C.UTF-8
printf '%s\n' T06_PRIMARY
IFS= read -r start
test -z "$start"

case "$T06_PROGRAM" in
    top)
        "$HOME/t06-own-process" 40 &
        child=$!
        trap 'kill "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :' EXIT
        /usr/bin/tput smcup
        code=0
        /usr/bin/top -d 30 -p "$child" || code=$?
        /usr/bin/tput rmcup
        ;;
    tmux)
        code=0
        /usr/bin/tmux -u -f "$HOME/tmux.conf" -S "$HOME/t06.sock" new-session \
            '/bin/sh -c "echo T06_TMUX_INNER; read line"' || code=$?
        ;;
    *) exit 2 ;;
esac

printf 'T06_AFTER exit=%s\n' "$code"
IFS= read -r finish
test -z "$finish"
