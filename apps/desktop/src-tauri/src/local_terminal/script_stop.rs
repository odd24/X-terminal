#[derive(Default, PartialEq)]
enum State {
    #[default]
    Unconfirmed,
    Interrupt,
    Prompt,
    Yes,
}

/// Tracks observations from one cmd.exe script's own ConPTY.
#[derive(Default)]
pub(super) struct ScriptStop {
    state: State,
    tail: Vec<u8>,
    awaiting_write: bool,
}

impl ScriptStop {
    pub(super) fn begin_input(&mut self, bytes: &[u8], keyboard: bool) {
        self.awaiting_write = match (self.state == State::Prompt, keyboard, bytes) {
            (_, true, [3]) => {
                self.state = State::Interrupt;
                self.tail.clear();
                true
            }
            (true, true, [b'y' | b'Y']) => {
                self.state = State::Yes;
                true
            }
            _ if self.state == State::Yes && keyboard && matches!(bytes, [b'\r' | b'\n']) => false,
            _ => {
                self.state = State::Unconfirmed;
                false
            }
        };
    }

    pub(super) fn finish_input(&mut self, delivered: bool) {
        if self.awaiting_write && !delivered {
            self.state = State::Unconfirmed;
        }
        self.awaiting_write = false;
    }

    pub(super) fn output(&mut self, bytes: &[u8]) {
        if self.state != State::Interrupt {
            return;
        }
        const PROMPTS: [&[u8]; 2] = [
            b"Terminate batch job (Y/N)?",
            "终止批处理操作吗(Y/N)?".as_bytes(),
        ];
        for &byte in bytes {
            if self.tail.len() == 64 {
                self.tail.remove(0);
            }
            self.tail.push(byte);
            if PROMPTS.iter().any(|prompt| self.tail.ends_with(prompt)) {
                self.state = State::Prompt;
                self.tail.clear();
                break;
            }
        }
    }

    pub(super) fn stopped(&self, exit: u32) -> bool {
        if self.awaiting_write {
            return false;
        }
        match self.state {
            State::Yes => matches!(exit, 255 | 130 | 0xc000013a),
            State::Interrupt => matches!(exit, 130 | 0xc000013a),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl ScriptStop {
        fn input(&mut self, bytes: &[u8], keyboard: bool) {
            self.begin_input(bytes, keyboard);
            self.finish_input(true);
        }
    }

    #[test]
    fn only_confirmed_current_interrupt_can_classify_255() {
        let mut stop = ScriptStop::default();
        stop.output(b"Terminate batch job (Y/N)?");
        stop.input(b"Y", true);
        assert!(!stop.stopped(255));
        stop.input(&[3], true);
        stop.output("终止批".as_bytes());
        stop.output("处理操作吗(Y/N)?".as_bytes());
        assert!(!stop.stopped(255));
        stop.input(b"N", true);
        stop.input(b"\r", true);
        assert!(!stop.stopped(255));
        stop.input(&[3], true);
        stop.output(b"Terminate batch job (Y/N)?");
        stop.input(b"Y", false);
        assert!(!stop.stopped(255));
        stop.input(&[3], true);
        stop.output(b"Terminate batch job (Y/N)?");
        stop.input(b"Y", true);
        stop.input(b"\r", true);
        assert!(stop.stopped(255));
        assert!(!stop.stopped(7));
    }

    #[test]
    fn pending_or_failed_console_write_cannot_classify_stop() {
        let mut stop = ScriptStop::default();
        stop.begin_input(&[3], true);
        assert!(!stop.stopped(130));
        stop.finish_input(false);
        assert!(!stop.stopped(130));
        stop.input(&[3], true);
        stop.output(b"Terminate batch job (Y/N)?");
        stop.begin_input(b"Y", true);
        assert!(!stop.stopped(255));
        stop.finish_input(true);
        assert!(stop.stopped(255));
    }
}
