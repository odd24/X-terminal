//! Each write uses a fresh 256-bit key and 96-bit nonce; only DPAPI wraps the key.
use crate::{Error, MAGIC, MAX_SECRET, Result, dpapi};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::Zeroizing;

pub fn seal(plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>> {
    let mut key = Zeroizing::new([0u8; 32]);
    getrandom::fill(key.as_mut_slice()).map_err(|_| Error::Entropy)?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut nonce_bytes).map_err(|_| Error::Entropy)?;
    let nonce = Nonce::from(nonce_bytes);
    let wrapped = dpapi::protect(key.as_slice(), entropy)?;
    if !(1..=8192).contains(&wrapped.len()) {
        return Err(Error::Corrupt);
    }
    let mut record = Vec::with_capacity(MAGIC.len() + 4 + wrapped.len() + 12 + plain.len() + 16);
    record.extend_from_slice(MAGIC);
    record.extend_from_slice(&(wrapped.len() as u32).to_le_bytes());
    record.extend_from_slice(&wrapped);
    record.extend_from_slice(&nonce);
    let cipher = Aes256Gcm::new_from_slice(key.as_slice()).map_err(|_| Error::Corrupt)?;
    // Authenticate the complete header, including otherwise-ignored DPAPI metadata.
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plain,
                aad: &record,
            },
        )
        .map_err(|_| Error::Corrupt)?;
    record.extend_from_slice(&ciphertext);
    Ok(record)
}
pub fn open(record: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let start = MAGIC.len() + 4;
    if record.len() < start || !record.starts_with(MAGIC) {
        return Err(Error::Corrupt);
    }
    let length = u32::from_le_bytes(
        record[MAGIC.len()..start]
            .try_into()
            .map_err(|_| Error::Corrupt)?,
    ) as usize;
    if !(1..=8192).contains(&length) {
        return Err(Error::Corrupt);
    }
    let end = start + length;
    let prefix = end + 12;
    if record.len() < prefix + 16 || record.len() > prefix + MAX_SECRET + 16 {
        return Err(Error::Corrupt);
    }
    let key = dpapi::unprotect(&record[start..end], entropy)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| Error::Corrupt)?;
    let nonce = Nonce::try_from(&record[end..prefix]).map_err(|_| Error::Corrupt)?;
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &record[prefix..],
                aad: &record[..prefix],
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| Error::Corrupt)
}
