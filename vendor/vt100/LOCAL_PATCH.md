# vt100 0.18.1 local patch

Source: locked registry archive vt100-0.18.1.crate, SHA-256
`eb05cdd19ae8707bf6a0a269972c07e6358103a7079faec749dec318a5b3dc23`.
License: MIT, original LICENSE and copyright retained.

Build sources, README, CHANGELOG and original manifest are copied from the archive.
The normalized build manifest omits dev dependencies because upstream integration
tests/examples are not copied or run. Production dependencies and default-features
are unchanged. The workspace keeps default features disabled (bounded vte OSC).

Initial production change (local.1): in src/perform.rs, printable U+FFFD goes through the same
text path as other printable characters. Original code sent it to a no-op
unhandled_char callback, losing literal or decoder replacement glyphs and cursor
width. C1 control filtering is unchanged. Local parser identity is reported as
vt100-0.18.1+local.1. That initial patch did not fix resize/reflow (BUG-001).

Regression: P11.2 terminal EOF replacement test fails on upstream, passes with
this patch; shared P02 xterm differential fixture covers bytewise A�中�B and
cursor width. Service tests cover raw/text/screen separation and EOF.
No claim of running the full upstream suite. See docs/decisions/ADR-028.md.

P11.7 adds local.2 in src/grid.rs: bounded normal-buffer cell reflow on width
changes, keeping hard-newline groups separate, wide pairs/combining text and
cell attributes intact. The current cursor's logical group is excluded, matching
xterm 6 default reflowCursorLine=false. Alternate-buffer hidden columns are kept
for expansion without reflow; reads remain limited to the current viewport.
Height adjustment still precedes width adjustment. Scrollback is capped at the
configured capacity; the output deque retains at most capacity + two viewports
while repacking and evicts from the head through the existing scroll callback.
No output bytes are reprocessed and no decoder or ANSI parser is reset.
Saved cursor offsets use viewport movement, not the total number of inserted or
removed history rows (covered by the two additional differential regressions).

Tests are hosted in session-core (attributes, continuation cells, hard newline,
OSC across resize, bounded/inspectable scrollback, parser metadata and independent
raw/text views) and the P02/P11.7 headless differential suite. Windows IPC and
actual WebView font/fit resize evidence is recorded in docs/records/P11.7.md.
The upstream full test suite is still not bundled/run. This is not a claim of full
VT compatibility or identical Unicode width tables. The original MIT license and
all source copyrights are unchanged; no xterm implementation was copied.
