//! Opt-in test executable only. Never enumerates or opens a native device.
use super::*;
use std::collections::VecDeque;
pub(super) struct MemoryFactory;
impl Factory for MemoryFactory {
    fn inventory(&self) -> io::Result<Inventory> {
        Ok(Inventory {
            devices: vec![Device::synthetic()],
            unidentified_ports: vec!["COM99".into()],
            metadata_failures: 0,
        })
    }
    fn open(
        &self,
        config: Config,
        _: Device,
        dispatch: Option<worker::DispatchGuard>,
    ) -> io::Result<Worker> {
        Worker::test_backend_guarded(
            move || {
                Ok(Echo {
                    bytes: VecDeque::new(),
                    hardware: config.flow_control == serialport::FlowControl::Hardware,
                    passive: config.baud_rate == 57600,
                    next: Instant::now(),
                    sequence: 0,
                    #[cfg(feature = "serial-mcp-fixture")]
                    trace: crate::serial_mcp_fixture::opened(
                        config.dtr_on_open,
                        config.rts_on_open,
                    )?,
                    dtr: config.dtr_on_open,
                    rts: config.rts_on_open,
                    break_asserted: false,
                })
            },
            dispatch,
        )
    }
}
struct Echo {
    bytes: VecDeque<u8>,
    hardware: bool,
    passive: bool,
    next: Instant,
    sequence: u32,
    dtr: bool,
    rts: Option<bool>,
    break_asserted: bool,
    #[cfg(feature = "serial-mcp-fixture")]
    trace: Option<crate::serial_mcp_fixture::Trace>,
}
#[cfg(feature = "serial-mcp-fixture")]
impl Drop for Echo {
    fn drop(&mut self) {
        if let Some(trace) = &self.trace {
            let _ = trace.observe_close();
        }
    }
}
impl worker::Port for Echo {
    fn bytes_to_read(&self) -> io::Result<u32> {
        Ok(self.bytes.len() as u32)
    }
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<transport_serial::ReadOutcome> {
        if self.passive && self.next.elapsed() >= Duration::from_millis(80) {
            self.sequence += 1;
            self.bytes
                .extend(format!("UART synthetic Android启动 log {}\r\n", self.sequence).bytes());
            self.next = Instant::now();
        }
        if self.bytes.is_empty() {
            std::thread::sleep(Duration::from_millis(1));
            return Ok(transport_serial::ReadOutcome::Idle);
        }
        let count = buffer.len().min(self.bytes.len());
        for byte in &mut buffer[..count] {
            *byte = self.bytes.pop_front().unwrap();
        }
        Ok(transport_serial::ReadOutcome::Data(count))
    }
    fn write_once(&mut self, bytes: &[u8]) -> io::Result<usize> {
        #[cfg(feature = "serial-mcp-fixture")]
        if let Some(trace) = &self.trace {
            trace.begin_write()?;
            trace.gate_before_write()?;
        }
        if self.passive {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if self.bytes.len() + bytes.len() > 65536 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        self.bytes.extend(bytes);
        #[cfg(feature = "serial-mcp-fixture")]
        if let Some(trace) = &self.trace {
            trace.wrote(bytes.len())?;
        }
        Ok(bytes.len())
    }
    fn control(&mut self, command: &worker::Command) -> io::Result<()> {
        #[cfg(feature = "serial-mcp-fixture")]
        if let Some(trace) = &self.trace {
            trace.begin_control()?;
        }
        match command {
            worker::Command::Dtr(v) => self.dtr = *v,
            worker::Command::Rts(v) if !self.hardware => self.rts = Some(*v),
            worker::Command::Break(v) => self.break_asserted = *v,
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        }
        #[cfg(feature = "serial-mcp-fixture")]
        if let Some(trace) = &self.trace {
            match command {
                worker::Command::Dtr(v) => trace.controlled("DTR", *v)?,
                worker::Command::Rts(v) if !self.hardware => trace.controlled("RTS", *v)?,
                worker::Command::Break(v) => trace.controlled("BREAK", *v)?,
                _ => {}
            }
        }
        match command {
            worker::Command::Rts(_) if self.hardware => Err(io::ErrorKind::InvalidInput.into()),
            worker::Command::Dtr(v) if self.dtr == *v => Ok(()),
            worker::Command::Rts(v) if self.rts == Some(*v) => Ok(()),
            worker::Command::Break(v) if self.break_asserted == *v => Ok(()),
            _ => Err(io::ErrorKind::InvalidInput.into()),
        }
    }
}
