//! Read-only Windows PnP identities. Interface paths stay service-private and cannot
//! be constructed from public request fields. Identity is not a device attestation.
use super::{Config, invalid};
use std::{fmt, io};

#[cfg(windows)]
mod windows;
pub const MAX_DEVICES: usize = 256;

#[derive(Clone, PartialEq, Eq)]
pub struct Device {
    port_name: String,
    instance_id: String,
    interface_path: String,
}
impl Device {
    pub fn port_name(&self) -> &str {
        &self.port_name
    }
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
}
impl fmt::Debug for Device {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Device")
            .field("port_name", &self.port_name)
            .field("identity", &"<redacted>")
            .finish()
    }
}

pub struct Inventory {
    pub devices: Vec<Device>,
    /// Enumerated legacy names without a unique usable interface. Never fall back
    /// to opening these aliases as if their identities had been verified.
    pub unidentified_ports: Vec<String>,
    /// Per-interface metadata failures, including a device disappearing mid-scan.
    pub metadata_failures: usize,
}

#[cfg(windows)]
pub fn inventory() -> io::Result<Inventory> {
    let (devices, metadata_failures) = windows::enumerate()?;
    let names = super::enumerate()?
        .into_iter()
        .map(|item| item.port_name)
        .collect();
    catalogue(devices, names, metadata_failures)
}
#[cfg(not(windows))]
pub fn inventory() -> io::Result<Inventory> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Windows device interfaces required",
    ))
}

fn catalogue(
    mut devices: Vec<Device>,
    names: Vec<String>,
    mut metadata_failures: usize,
) -> io::Result<Inventory> {
    if devices.len() > MAX_DEVICES || names.len() > MAX_DEVICES {
        return Err(invalid("serial inventory exceeds bound"));
    }
    // Conflicting aliases or duplicate interface paths cannot
    // become selectable, even when a driver supplies inconsistent enumeration data.
    let unique: Vec<_> = devices
        .iter()
        .enumerate()
        .filter_map(|(index, device)| {
            let conflict = devices.iter().enumerate().any(|(other_index, other)| {
                index != other_index
                    && (device.port_name.eq_ignore_ascii_case(&other.port_name)
                        || device
                            .interface_path
                            .eq_ignore_ascii_case(&other.interface_path))
            });
            if conflict {
                metadata_failures += 1;
                None
            } else {
                Some(device.clone())
            }
        })
        .collect();
    devices = unique;
    devices.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    let mut unidentified_ports: Vec<_> = names
        .into_iter()
        .filter(|name| {
            !devices
                .iter()
                .any(|device| device.port_name.eq_ignore_ascii_case(name))
        })
        .collect();
    unidentified_ports.sort();
    unidentified_ports.dedup();
    Ok(Inventory {
        devices,
        unidentified_ports,
        metadata_failures,
    })
}

pub(super) fn open_verified<T>(
    config: &Config,
    selected: &Device,
    current: &Inventory,
    open: impl FnOnce(&Config, &str) -> io::Result<T>,
) -> io::Result<T> {
    config.validate()?;
    if !selected.port_name.eq_ignore_ascii_case(&config.port) {
        return Err(invalid("selected device does not match configured port"));
    }
    let matches = current
        .devices
        .iter()
        .filter(|device| {
            device.port_name.eq_ignore_ascii_case(&selected.port_name)
                && device
                    .instance_id
                    .eq_ignore_ascii_case(&selected.instance_id)
                && device
                    .interface_path
                    .eq_ignore_ascii_case(&selected.interface_path)
        })
        .count();
    if matches != 1 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "selected device changed or disappeared; select again",
        ));
    }
    open(config, &selected.interface_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn selected() -> Device {
        Device {
            port_name: "COM7".into(),
            instance_id: r"USB\SYNTHETIC\INSTANCE_A".into(),
            interface_path: r"\\?\synthetic#interface_a".into(),
        }
    }
    fn config() -> Config {
        Config {
            port: "COM7".into(),
            baud_rate: 115200,
            data_bits: serialport::DataBits::Eight,
            stop_bits: serialport::StopBits::One,
            parity: serialport::Parity::None,
            flow_control: serialport::FlowControl::None,
            dtr_on_open: false,
            rts_on_open: Some(false),
        }
    }
    fn inventory(devices: Vec<Device>) -> Inventory {
        catalogue(devices, vec!["COM7".into()], 0).unwrap()
    }

    #[test]
    fn replacement_changed_interface_renumbering_and_removal_never_open() {
        let chosen = selected();
        let mut replacement = chosen.clone();
        replacement.instance_id = "REPLACEMENT".into();
        let mut new_path = chosen.clone();
        new_path.interface_path = r"\\?\synthetic#interface_b".into();
        let mut renumbered = chosen.clone();
        renumbered.port_name = "COM8".into();
        let calls = Cell::new(0);
        for devices in [vec![replacement], vec![new_path], vec![renumbered], vec![]] {
            let error = open_verified(&config(), &chosen, &inventory(devices), |_, _| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::NotFound);
        }
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn verified_open_uses_the_interface_path_and_never_resolves_a_com_alias_again() {
        let chosen = selected();
        let current = inventory(vec![chosen.clone()]);
        let path = open_verified(&config(), &chosen, &current, |parameters, native_path| {
            assert_eq!(parameters.port, "COM7");
            assert_eq!(native_path, chosen.interface_path);
            assert_ne!(native_path, parameters.port);
            assert_ne!(native_path, r"\\.\COM7");
            Ok(native_path.to_owned())
        })
        .unwrap();
        assert_eq!(path, chosen.interface_path);
    }

    #[test]
    fn configuration_mismatch_and_invalid_control_ownership_fail_before_open() {
        let chosen = selected();
        let current = inventory(vec![chosen.clone()]);
        let mut cases = Vec::new();
        for port in ["COM8", "COM07", r"\\.\pipe\synthetic", "COM0"] {
            let mut parameters = config();
            parameters.port = port.into();
            cases.push(parameters);
        }
        let mut hardware = config();
        hardware.flow_control = serialport::FlowControl::Hardware;
        cases.push(hardware);
        for parameters in cases {
            assert_eq!(
                open_verified(&parameters, &chosen, &current, |_, _| -> io::Result<()> {
                    panic!("invalid selection must not open a native device")
                })
                .unwrap_err()
                .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn unknown_legacy_names_and_partial_metadata_are_explicit_without_fallback() {
        let current =
            catalogue(vec![], vec!["COM9".into(), "COM7".into(), "COM9".into()], 1).unwrap();
        assert!(current.devices.is_empty());
        assert_eq!(current.unidentified_ports, ["COM7", "COM9"]);
        assert_eq!(current.metadata_failures, 1);
        assert!(
            open_verified(&config(), &selected(), &current, |_, _| -> io::Result<()> {
                panic!("an unidentified alias is never an opening fallback")
            })
            .is_err()
        );
    }

    #[test]
    fn conflicting_aliases_or_paths_are_not_selectable() {
        let chosen = selected();
        let mut same_alias = chosen.clone();
        same_alias.interface_path = r"\\?\synthetic#other".into();
        same_alias.instance_id = "OTHER".into();
        let mut same_path = chosen.clone();
        same_path.port_name = "COM8".into();
        for other in [same_alias, same_path] {
            let current = catalogue(vec![chosen.clone(), other], vec!["COM7".into()], 1).unwrap();
            assert!(current.devices.is_empty());
            assert_eq!(current.metadata_failures, 3);
            assert_eq!(current.unidentified_ports, ["COM7"]);
        }
    }

    #[test]
    fn distinct_interfaces_of_one_instance_remain_distinct_targets() {
        let chosen = selected();
        let mut other = chosen.clone();
        other.port_name = "COM8".into();
        other.interface_path = r"\\?\synthetic#second".into();
        let current = catalogue(
            vec![chosen.clone(), other],
            vec!["COM7".into(), "COM8".into()],
            0,
        )
        .unwrap();
        assert_eq!(current.devices.len(), 2);
        assert!(current.unidentified_ports.is_empty());
        open_verified(&config(), &chosen, &current, |_, path| {
            assert_eq!(path, chosen.interface_path);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn inventory_is_bounded_and_device_debug_omits_hardware_identifiers() {
        assert!(catalogue(vec![selected(); MAX_DEVICES + 1], vec![], 0).is_err());
        assert!(catalogue(vec![], vec!["COM7".into(); MAX_DEVICES + 1], 0).is_err());
        let chosen = selected();
        let debug = format!("{chosen:?}");
        assert!(!debug.contains(&chosen.instance_id));
        assert!(!debug.contains(&chosen.interface_path));
        assert!(debug.contains("<redacted>"));
    }
}
