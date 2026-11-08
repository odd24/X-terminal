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
        if self.passive {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if self.bytes.len() + bytes.len() > 65536 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        self.bytes.extend(bytes);
        Ok(bytes.len())
    }
    fn control(&mut self, command: &worker::Command) -> io::Result<()> {
        match command {
            worker::Command::Rts(_) if self.hardware => Err(io::ErrorKind::InvalidInput.into()),
            worker::Command::Dtr(_) | worker::Command::Rts(_) | worker::Command::Break(_) => Ok(()),
            _ => Err(io::ErrorKind::InvalidInput.into()),
        }
    }
}
