use super::*;
use std::{
    mem::{offset_of, size_of},
    ptr,
};
use windows_sys::Win32::{
    Devices::DeviceAndDriverInstallation::*,
    Foundation::{ERROR_NO_MORE_ITEMS, INVALID_HANDLE_VALUE},
    System::{Ioctl::GUID_DEVINTERFACE_COMPORT, Registry::*},
};

struct DeviceSet(HDEVINFO);
impl Drop for DeviceSet {
    fn drop(&mut self) {
        unsafe {
            SetupDiDestroyDeviceInfoList(self.0);
        }
    }
}
struct DeviceKey(HKEY);
impl Drop for DeviceKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn text(buffer: &[u16]) -> io::Result<String> {
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .ok_or_else(|| invalid("unterminated device metadata"))?;
    let text =
        String::from_utf16(&buffer[..end]).map_err(|_| invalid("invalid device metadata"))?;
    if text.is_empty() || text.chars().any(char::is_control) {
        return Err(invalid("invalid device metadata"));
    }
    Ok(text)
}

fn friendly_name(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> Option<String> {
    let mut buffer = [0u16; 256];
    let mut bytes = 0;
    let mut kind = 0;
    let found = unsafe {
        SetupDiGetDeviceRegistryPropertyW(
            set.0,
            info,
            SPDRP_FRIENDLYNAME,
            &mut kind,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut bytes,
        )
    };
    if found == 0
        || kind != REG_SZ
        || !bytes.is_multiple_of(2)
        || bytes as usize > size_of_val(&buffer)
    {
        return None;
    }
    text(&buffer[..bytes as usize / 2]).ok()
}

fn port_name(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> io::Result<String> {
    let key =
        unsafe { SetupDiOpenDevRegKey(set.0, info, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ) };
    if key == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let key = DeviceKey(key);
    let mut buffer = [0u16; 256];
    let mut bytes = size_of_val(&buffer) as u32;
    let mut kind = 0;
    let name: Vec<_> = "PortName\0".encode_utf16().collect();
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            ptr::null(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if kind != REG_SZ
        || bytes == 0
        || !bytes.is_multiple_of(2)
        || bytes as usize > size_of_val(&buffer)
    {
        return Err(invalid("invalid port name metadata"));
    }
    let name = text(&buffer[..bytes as usize / 2])?;
    let suffix = name
        .strip_prefix("COM")
        .ok_or_else(|| invalid("not a COM port"))?;
    if suffix.is_empty()
        || !suffix.bytes().all(|b| b.is_ascii_digit())
        || !matches!(suffix.parse::<u16>(), Ok(1..))
    {
        return Err(invalid("invalid COM port"));
    }
    Ok(name)
}

fn describe(set: &DeviceSet, interface: &SP_DEVICE_INTERFACE_DATA) -> io::Result<Device> {
    // u64 storage guarantees the alignment of the variable-sized detail structure.
    // No struct reference spans beyond storage; returned size bounds all UTF-16 reads.
    let mut storage = [0u64; 1024];
    let detail = storage
        .as_mut_ptr()
        .cast::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>();
    unsafe {
        (*detail).cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
    }
    let mut required = 0;
    let mut info = SP_DEVINFO_DATA {
        cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
        ..Default::default()
    };
    let success = unsafe {
        SetupDiGetDeviceInterfaceDetailW(
            set.0,
            interface,
            detail,
            size_of_val(&storage) as u32,
            &mut required,
            &mut info,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let offset = offset_of!(SP_DEVICE_INTERFACE_DETAIL_DATA_W, DevicePath);
    if required as usize > size_of_val(&storage)
        || (required as usize) < offset + 2
        || !(required as usize - offset).is_multiple_of(2)
    {
        return Err(invalid("invalid interface path size"));
    }
    let path = unsafe {
        std::slice::from_raw_parts(
            ptr::addr_of!((*detail).DevicePath).cast::<u16>(),
            (required as usize - offset) / 2,
        )
    };
    let interface_path = text(path)?;
    if !interface_path.starts_with(r"\\?\") {
        return Err(invalid("invalid device interface path"));
    }
    let mut instance = [0u16; 1024];
    let mut length = 0;
    let success = unsafe {
        SetupDiGetDeviceInstanceIdW(
            set.0,
            &info,
            instance.as_mut_ptr(),
            instance.len() as u32,
            &mut length,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    if length == 0 || length as usize > instance.len() {
        return Err(invalid("invalid instance identity size"));
    }
    Ok(Device {
        port_name: port_name(set, &info)?,
        instance_id: text(&instance[..length as usize])?,
        interface_path,
        friendly_name: friendly_name(set, &info),
    })
}

pub(super) fn enumerate() -> io::Result<(Vec<Device>, usize)> {
    let raw = unsafe {
        SetupDiGetClassDevsW(
            &GUID_DEVINTERFACE_COMPORT,
            ptr::null(),
            ptr::null_mut(),
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
        )
    };
    if raw == -1 {
        return Err(io::Error::last_os_error());
    }
    let set = DeviceSet(raw);
    let mut devices = Vec::new();
    let mut failures = 0;
    for index in 0..=MAX_DEVICES {
        let mut interface = SP_DEVICE_INTERFACE_DATA {
            cbSize: size_of::<SP_DEVICE_INTERFACE_DATA>() as u32,
            ..Default::default()
        };
        let success = unsafe {
            SetupDiEnumDeviceInterfaces(
                set.0,
                ptr::null(),
                &GUID_DEVINTERFACE_COMPORT,
                index as u32,
                &mut interface,
            )
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_ITEMS as i32) {
                return Ok((devices, failures));
            }
            return Err(error);
        }
        if index == MAX_DEVICES {
            return Err(invalid("serial interface inventory exceeds bound"));
        }
        match describe(&set, &interface) {
            Ok(device) => devices.push(device),
            Err(_) => failures += 1,
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_text_requires_a_bounded_terminator_valid_utf16_and_no_controls() {
        assert_eq!(text(&[67, 79, 77, 49, 0]).unwrap(), "COM1");
        for invalid in [&[65u16][..], &[0], &[0xd800, 0], &[65, 10, 0]] {
            assert!(text(invalid).is_err());
        }
    }
}
