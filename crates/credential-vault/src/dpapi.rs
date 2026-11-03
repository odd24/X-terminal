use crate::{Error, Result};
use std::ptr;
use windows_sys::Win32::{
    Foundation::{GetLastError, LocalFree},
    Security::Cryptography::*,
};
use zeroize::{Zeroize, Zeroizing};

struct Output(CRYPT_INTEGER_BLOB);
impl Drop for Output {
    fn drop(&mut self) {
        if !self.0.pbData.is_null() {
            // DPAPI owns this writable LocalAlloc allocation, until LocalFree.
            unsafe {
                std::slice::from_raw_parts_mut(self.0.pbData, self.0.cbData as usize).zeroize();
                LocalFree(self.0.pbData.cast());
            }
        }
    }
}
fn transform(input: &[u8], entropy: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| Error::Invalid)?,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len().try_into().map_err(|_| Error::Invalid)?,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = Output(CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    });
    // No machine scope, prompts or description. Windows manages the wrapping key.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        } else {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        }
    };
    if ok == 0 {
        return Err(Error::Protection(unsafe { GetLastError() }));
    }
    if output.0.pbData.is_null() || output.0.cbData as usize > crate::MAX_BLOB {
        return Err(Error::Corrupt);
    }
    Ok(Zeroizing::new(
        unsafe { std::slice::from_raw_parts(output.0.pbData, output.0.cbData as usize) }.to_vec(),
    ))
}
pub fn protect(input: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    transform(input, entropy, false)
}
pub fn unprotect(input: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    transform(input, entropy, true)
}
