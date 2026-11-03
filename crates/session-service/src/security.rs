//! Current-user-only Pipe security. No administrator/service installation required.
use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub fn user_sid() -> io::Result<String> {
    unsafe {
        let mut raw = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle::from_raw_handle(raw);
        let mut size = 0;
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut size,
        );
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut text = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(io::Error::last_os_error());
        }
        let allocation = LocalAllocation(text.cast());
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16(std::slice::from_raw_parts(text, length))
            .map_err(|_| io::Error::other("invalid SID text"))?;
        drop(allocation);
        Ok(sid)
    }
}

pub fn pipe_name(instance: &str) -> io::Result<String> {
    if instance.is_empty()
        || instance.len() > 64
        || !instance
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid service instance",
        ));
    }
    Ok(format!(
        r"\\.\pipe\SharedTerminal.v1.{}.{}",
        user_sid()?,
        instance
    ))
}

pub fn require_standard_user() -> io::Result<()> {
    use windows_sys::Win32::Security::{TOKEN_ELEVATION, TokenElevation};
    unsafe {
        let mut raw = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle::from_raw_handle(raw);
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0;
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        if elevation.TokenIsElevated != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "session-service requires a non-elevated user process",
            ));
        }
    }
    Ok(())
}

pub struct PipeSecurity {
    descriptor: LocalAllocation,
}
impl PipeSecurity {
    pub fn current_user() -> io::Result<Self> {
        let sid = user_sid()?;
        let sddl: Vec<u16> = format!("O:{sid}D:P(A;;GA;;;{sid})\0")
            .encode_utf16()
            .collect();
        let mut descriptor = ptr::null_mut();
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self {
            descriptor: LocalAllocation(descriptor),
        })
    }
    pub fn create(&self, name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        };
        // Descriptor/attributes stay valid for this synchronous CreateNamedPipe call.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .in_buffer_size(65536)
                .out_buffer_size(65536)
                .create_with_security_attributes_raw(
                    name,
                    (&attributes as *const SECURITY_ATTRIBUTES)
                        .cast_mut()
                        .cast(),
                )
        }
    }
}

/// Check before sending a capability: a squatted endpoint must not receive it.
pub fn verify_server_pid(pipe: &NamedPipeClient, expected: u32) -> io::Result<()> {
    let mut actual = 0;
    unsafe {
        if GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut actual) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unexpected session service process",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, GetLastError, INVALID_HANDLE_VALUE},
        Security::{
            ACCESS_ALLOWED_ACE, ACL,
            Authorization::{ConvertStringSidToSidW, GetSecurityInfo, SE_KERNEL_OBJECT},
            CreateRestrictedToken, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, EqualSid,
            GetAce, ImpersonateLoggedOnUser, RevertToSelf, SID_AND_ATTRIBUTES, TOKEN_DUPLICATE,
            TOKEN_IMPERSONATE,
        },
        Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING},
    };

    #[tokio::test]
    async fn os_dacl_is_single_user_and_restricted_token_is_denied() {
        let security = PipeSecurity::current_user().unwrap();
        let name = pipe_name(&uuid::Uuid::new_v4().to_string()).unwrap();
        let pipe = security.create(&name, true).unwrap();
        unsafe {
            let mut acl: *mut ACL = ptr::null_mut();
            let mut owner = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            assert_eq!(
                GetSecurityInfo(
                    pipe.as_raw_handle(),
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION
                        | windows_sys::Win32::Security::OWNER_SECURITY_INFORMATION,
                    &mut owner,
                    ptr::null_mut(),
                    &mut acl,
                    ptr::null_mut(),
                    &mut descriptor
                ),
                0
            );
            let _descriptor = LocalAllocation(descriptor);
            assert!(!acl.is_null());
            assert_eq!((*acl).AceCount, 1);
            let mut ace = ptr::null_mut();
            assert_ne!(GetAce(acl, 0, &mut ace), 0);
            let allowed = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            assert_eq!(allowed.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
            assert_ne!(
                EqualSid(owner, (&allowed.SidStart as *const u32).cast_mut().cast()),
                0
            );

            let mut process_token = ptr::null_mut();
            assert_ne!(
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
                    &mut process_token
                ),
                0
            );
            let process_token = OwnedHandle::from_raw_handle(process_token);
            let sid_text: Vec<u16> = "S-1-5-21-0-0-0-424242\0".encode_utf16().collect();
            let mut restricted_sid = ptr::null_mut();
            assert_ne!(
                ConvertStringSidToSidW(sid_text.as_ptr(), &mut restricted_sid),
                0
            );
            let _sid = LocalAllocation(restricted_sid);
            let restriction = SID_AND_ATTRIBUTES {
                Sid: restricted_sid,
                Attributes: 0,
            };
            let mut restricted = ptr::null_mut();
            assert_ne!(
                CreateRestrictedToken(
                    process_token.as_raw_handle(),
                    DISABLE_MAX_PRIVILEGE,
                    0,
                    ptr::null(),
                    0,
                    ptr::null(),
                    1,
                    &restriction,
                    &mut restricted
                ),
                0
            );
            let restricted = OwnedHandle::from_raw_handle(restricted);
            let wide_name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            assert_ne!(ImpersonateLoggedOnUser(restricted.as_raw_handle()), 0);
            // No await, assertion or panic while impersonating. Revert before inspecting results.
            let handle = CreateFileW(
                wide_name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                ptr::null_mut(),
            );
            let error = GetLastError();
            if RevertToSelf() == 0 {
                std::process::abort();
            }
            if handle != INVALID_HANDLE_VALUE {
                drop(OwnedHandle::from_raw_handle(handle));
            }
            assert_eq!(handle, INVALID_HANDLE_VALUE);
            assert_eq!(
                error, 5,
                "restricted access must fail in Windows DACL check"
            );
        }
    }
}
