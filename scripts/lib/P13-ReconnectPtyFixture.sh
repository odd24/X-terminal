#!/bin/sh
set -eu
case "${P13_RECONNECT_TRIAL-}" in
    first|second) ;;
    *) exit 2 ;;
esac
test -t 0 && test -t 1
umask 077
stty raw -echo
exec 3> "p13-input-${P13_RECONNECT_TRIAL}.bin"
printf 'P13_RECONNECT_READY\r\n'
exec dd bs=1 count=64 status=none >&3
