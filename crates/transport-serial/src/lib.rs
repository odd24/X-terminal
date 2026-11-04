//! P05 byte transport candidate, independent of UI. It has no command exit codes.
pub mod device;
use std::io::{self, Read, Write};
use std::time::Duration;

pub const MAX_CHUNK: usize = 64 * 1024;

pub struct Config {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: serialport::DataBits,
    pub stop_bits: serialport::StopBits,
    pub parity: serialport::Parity,
    pub flow_control: serialport::FlowControl,
    pub dtr_on_open: bool,
    pub rts_on_open: Option<bool>,
}

impl Config {
    pub fn validate(&self) -> io::Result<()> {
        let suffix = self
            .port
            .strip_prefix("COM")
            .ok_or_else(|| invalid("expected explicit COM number"))?;
        if suffix.is_empty()
            || !suffix.bytes().all(|c| c.is_ascii_digit())
            || suffix.parse::<u16>().ok().filter(|n| *n > 0).is_none()
        {
            return Err(invalid("invalid COM identifier"));
        }
        if self.baud_rate == 0 {
            return Err(invalid("baud rate must be positive"));
        }
        if (self.flow_control == serialport::FlowControl::Hardware) != self.rts_on_open.is_none() {
            return Err(invalid(
                "RTS must be driver-owned for hardware flow and explicit otherwise",
            ));
        }
        Ok(())
    }
}

pub fn enumerate() -> serialport::Result<Vec<serialport::SerialPortInfo>> {
    serialport::available_ports()
}

pub struct SerialConnection {
    port: Box<dyn serialport::SerialPort>,
}

impl SerialConnection {
    /// Caller must explicitly select a device and its open-time line states.
    pub fn open(config: &Config) -> Result<Self, Box<dyn std::error::Error>> {
        config.validate()?;
        Ok(Self::open_path(config, &config.port)?)
    }

    /// Service integration must use a freshly verified, immutable device selection.
    /// Opens the OS interface path, never a COM alias obtained after validation.
    pub fn open_selected(config: &Config, selected: &device::Device) -> io::Result<Self> {
        let current = device::inventory()?;
        device::open_verified(config, selected, &current, Self::open_path)
    }

    fn open_path(config: &Config, path: &str) -> io::Result<Self> {
        let mut port = serialport::new(path, config.baud_rate)
            .data_bits(config.data_bits)
            .stop_bits(config.stop_bits)
            .parity(config.parity)
            .flow_control(config.flow_control)
            .timeout(Duration::from_millis(100))
            .dtr_on_open(config.dtr_on_open)
            .open()?;
        // serialport's Windows open applies DTR best-effort and discards its error.
        // Require an explicit successful control call before reporting readiness.
        port.write_data_terminal_ready(config.dtr_on_open)?;
        if let Some(asserted) = config.rts_on_open {
            port.write_request_to_send(asserted)?;
        }
        Ok(Self { port })
    }

    pub fn read(&mut self, buffer: &mut [u8]) -> io::Result<ReadOutcome> {
        read_chunk(&mut self.port, buffer)
    }
    pub fn write(&mut self, bytes: &[u8]) -> io::Result<WriteReceipt> {
        write_chunk(&mut self.port, bytes)
    }
    pub fn set_dtr(&mut self, asserted: bool) -> serialport::Result<()> {
        self.port.write_data_terminal_ready(asserted)
    }
    pub fn set_rts(&mut self, asserted: bool) -> serialport::Result<()> {
        if self.port.flow_control()? == serialport::FlowControl::Hardware {
            return Err(serialport::Error::new(
                serialport::ErrorKind::InvalidInput,
                "RTS owned by hardware flow control",
            ));
        }
        self.port.write_request_to_send(asserted)
    }
    pub fn set_break(&self, enabled: bool) -> serialport::Result<()> {
        if enabled {
            self.port.set_break()
        } else {
            self.port.clear_break()
        }
    }
    // Drop closes the OS handle. No reconnect, command replay, or line toggling loop.
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadOutcome {
    Data(usize),
    Idle,
}

/// Driver-accepted count is not proof the remote device executed anything.
#[derive(Debug, PartialEq, Eq)]
pub struct WriteReceipt {
    pub driver_accepted: usize,
    pub complete: bool,
    pub error: Option<io::ErrorKind>,
}

pub fn read_chunk<R: Read>(source: &mut R, buffer: &mut [u8]) -> io::Result<ReadOutcome> {
    if buffer.is_empty() || buffer.len() > MAX_CHUNK {
        return Err(invalid("invalid serial read bound"));
    }
    match source.read(buffer) {
        Ok(0) => Ok(ReadOutcome::Idle),
        Ok(count) => Ok(ReadOutcome::Data(count)),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(ReadOutcome::Idle)
        }
        Err(error) => Err(error),
    }
}

pub fn write_chunk<W: Write>(target: &mut W, bytes: &[u8]) -> io::Result<WriteReceipt> {
    if bytes.len() > MAX_CHUNK {
        return Err(invalid("serial write exceeds bound"));
    }
    let mut accepted = 0;
    let mut interruptions = 0;
    while accepted < bytes.len() {
        match target.write(&bytes[accepted..]) {
            Ok(0) => {
                return Ok(WriteReceipt {
                    driver_accepted: accepted,
                    complete: false,
                    error: Some(io::ErrorKind::WriteZero),
                });
            }
            Ok(count) => accepted += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted && interruptions < 8 => {
                interruptions += 1;
                continue;
            }
            Err(error) => {
                return Ok(WriteReceipt {
                    driver_accepted: accepted,
                    complete: false,
                    error: Some(error.kind()),
                });
            }
        }
    }
    Ok(WriteReceipt {
        driver_accepted: accepted,
        complete: true,
        error: None,
    })
}

pub fn parse_hex(text: &str) -> io::Result<Vec<u8>> {
    if text.len() > MAX_CHUNK * 3 {
        return Err(invalid("hex input exceeds bound"));
    }
    let digits: Vec<u8> = text.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    if !digits.len().is_multiple_of(2) || digits.len() / 2 > MAX_CHUNK {
        return Err(invalid("invalid hex byte count"));
    }
    digits
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let hi = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| invalid("invalid hex digit"))?;
            let lo = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| invalid("invalid hex digit"))?;
            Ok((hi * 16 + lo) as u8)
        })
        .collect()
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn port_selection_and_rts_ownership_are_explicit() {
        let mut config = Config {
            port: "COM89".into(),
            baud_rate: 115200,
            data_bits: serialport::DataBits::Eight,
            stop_bits: serialport::StopBits::One,
            parity: serialport::Parity::None,
            flow_control: serialport::FlowControl::None,
            dtr_on_open: false,
            rts_on_open: Some(false),
        };
        assert!(config.validate().is_ok());
        config.port = "\\\\.\\pipe\\unexpected".into();
        assert!(config.validate().is_err());
        config.port = "COM0".into();
        assert!(config.validate().is_err());
        config.port = "COM89".into();
        config.flow_control = serialport::FlowControl::Hardware;
        assert!(config.validate().is_err());
        config.rts_on_open = None;
        assert!(config.validate().is_ok());
        config.baud_rate = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn endless_interrupts_cannot_spin_forever() {
        struct Interrupted(usize);
        impl Write for Interrupted {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                self.0 += 1;
                Err(io::ErrorKind::Interrupted.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut target = Interrupted(0);
        assert_eq!(
            write_chunk(&mut target, b"one-attempt").unwrap(),
            WriteReceipt {
                driver_accepted: 0,
                complete: false,
                error: Some(io::ErrorKind::Interrupted)
            }
        );
        assert_eq!(target.0, 9);
    }

    #[test]
    fn raw_bytes_and_crlf_round_trip_without_translation() {
        let raw = [0, 255, 13, 10, 13, 0xd6, 0xd0];
        let mut wire = vec![];
        assert!(write_chunk(&mut wire, &raw).unwrap().complete);
        let mut buffer = [0; 16];
        assert_eq!(
            read_chunk(&mut Cursor::new(wire), &mut buffer).unwrap(),
            ReadOutcome::Data(raw.len())
        );
        assert_eq!(&buffer[..raw.len()], raw);
    }

    #[test]
    fn partial_failure_reports_accepted_bytes_without_replay() {
        struct FailAfterTwo {
            calls: usize,
            accepted: Vec<u8>,
        }
        impl Write for FailAfterTwo {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.calls += 1;
                if self.calls > 1 {
                    return Err(io::ErrorKind::BrokenPipe.into());
                }
                self.accepted.extend_from_slice(&bytes[..2]);
                Ok(2)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut target = FailAfterTwo {
            calls: 0,
            accepted: vec![],
        };
        let receipt = write_chunk(&mut target, b"abcd").unwrap();
        assert_eq!(
            receipt,
            WriteReceipt {
                driver_accepted: 2,
                complete: false,
                error: Some(io::ErrorKind::BrokenPipe)
            }
        );
        assert_eq!(target.accepted, b"ab");
        assert_eq!(target.calls, 2);
    }

    #[test]
    fn idle_is_not_a_command_exit_and_hex_is_strict() {
        struct Timeout;
        impl Read for Timeout {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::ErrorKind::TimedOut.into())
            }
        }
        assert_eq!(
            read_chunk(&mut Timeout, &mut [0; 16]).unwrap(),
            ReadOutcome::Idle
        );
        assert_eq!(parse_hex("00 ff 0D\n0a").unwrap(), [0, 255, 13, 10]);
        assert!(parse_hex("0").is_err());
        assert!(parse_hex("GG").is_err());
        assert!(read_chunk(&mut Timeout, &mut []).is_err());
        assert!(write_chunk(&mut vec![], &vec![0; MAX_CHUNK + 1]).is_err());
    }
}
