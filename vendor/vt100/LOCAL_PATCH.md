# vt100 0.18.1 local patch

Source: locked registry archive vt100-0.18.1.crate, SHA-256
`eb05cdd19ae8707bf6a0a269972c07e6358103a7079faec749dec318a5b3dc23`.
License: MIT, original LICENSE and copyright retained.

Build sources, README, CHANGELOG and original manifest are copied from the archive.
The normalized build manifest omits dev dependencies because upstream integration
tests/examples are not copied or run. Production dependencies and default-features
are unchanged. The workspace keeps default features disabled (bounded vte OSC).

Only production change: in src/perform.rs, printable U+FFFD goes through the same
text path as other printable characters. Original code sent it to a no-op
unhandled_char callback, losing literal or decoder replacement glyphs and cursor
width. C1 control filtering is unchanged. Local parser identity is reported as
vt100-0.18.1+local.1. This patch does not fix resize/reflow (BUG-001).

Regression: P11.2 terminal EOF replacement test fails on upstream, passes with
this patch; shared P02 xterm differential fixture covers bytewise A�中�B and
cursor width. Service tests cover raw/text/screen separation and EOF.
No claim of running the full upstream suite. See docs/decisions/ADR-028.md.
