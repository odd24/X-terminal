//! Inspect attacker-controlled KDF costs before entering a blocking decryption worker.
use crate::session::{Error, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use russh::keys::{PrivateKey, ssh_key::Kdf};
use zeroize::Zeroizing;
pub fn check(pem: &str) -> Result<()> {
    if pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        let key = PrivateKey::from_openssh(pem).map_err(|_| Error::InvalidKey)?;
        match key.kdf() {
            Kdf::None => {}
            Kdf::Bcrypt { salt, rounds } if (1..=64).contains(rounds) && salt.len() <= 64 => {}
            _ => return Err(Error::Limit),
        }
    } else if pem.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        let text = Zeroizing::new(
            pem.lines()
                .skip(1)
                .take_while(|line| !line.starts_with("-----END "))
                .collect::<String>(),
        );
        let der = Zeroizing::new(
            STANDARD
                .decode(text.as_bytes())
                .map_err(|_| Error::InvalidKey)?,
        );
        let info = pkcs8::EncryptedPrivateKeyInfoRef::try_from(der.as_slice())
            .map_err(|_| Error::InvalidKey)?;
        let params = info.encryption_algorithm.pbes2().ok_or(Error::Limit)?;
        match &params.kdf {
            pkcs5::pbes2::Kdf::Pbkdf2(params)
                if (1..=1_000_000).contains(&params.iteration_count)
                    && params.key_length.is_none_or(|len| len <= 64) => {}
            pkcs5::pbes2::Kdf::Scrypt(params) => {
                let n = params.cost_parameter;
                let r = u64::from(params.block_size);
                let p = u64::from(params.parallelization);
                if n < 2
                    || !n.is_power_of_two()
                    || r == 0
                    || p == 0
                    || n.checked_mul(r)
                        .and_then(|v| v.checked_mul(128))
                        .is_none_or(|v| v > 64 * 1024 * 1024)
                    || n.checked_mul(r)
                        .and_then(|v| v.checked_mul(p))
                        .is_none_or(|v| v > 8_388_608)
                    || params.key_length.is_some_and(|len| len > 64)
                {
                    return Err(Error::Limit);
                }
            }
            _ => return Err(Error::Limit),
        }
    } else if ![
        "-----BEGIN PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----",
        "-----BEGIN EC PRIVATE KEY-----",
    ]
    .iter()
    .any(|header| pem.starts_with(header))
    {
        return Err(Error::InvalidKey);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pkcs8::der::{Encode, asn1::OctetStringRef};
    fn encrypted(params: pkcs5::pbes2::Parameters) -> String {
        let bytes = [0u8; 16];
        let info = pkcs8::EncryptedPrivateKeyInfoRef {
            encryption_algorithm: params.into(),
            encrypted_data: OctetStringRef::new(&bytes).unwrap(),
        };
        format!(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\n{}\n-----END ENCRYPTED PRIVATE KEY-----",
            STANDARD.encode(info.to_der().unwrap())
        )
    }
    #[test]
    fn encrypted_pkcs8_costs_are_checked_without_deriving_any_key() {
        let params = pkcs5::pbes2::Parameters::generate_pbkdf2_sha256_aes256cbc(
            2048,
            b"synthetic salt",
            [0; 16],
        )
        .unwrap();
        assert_eq!(check(&encrypted(params.clone())), Ok(()));
        let mut expensive = params.clone();
        let pkcs5::pbes2::Kdf::Pbkdf2(kdf) = &mut expensive.kdf else {
            panic!()
        };
        kdf.iteration_count = 1_000_001;
        assert_eq!(check(&encrypted(expensive)), Err(Error::Limit));
        let mut scrypt = params;
        scrypt.kdf = pkcs5::pbes2::Kdf::Scrypt(pkcs5::pbes2::ScryptParams {
            salt: b"synthetic salt".as_slice().try_into().unwrap(),
            cost_parameter: 16384,
            block_size: 8,
            parallelization: 1,
            key_length: None,
        });
        assert_eq!(check(&encrypted(scrypt.clone())), Ok(()));
        let pkcs5::pbes2::Kdf::Scrypt(kdf) = &mut scrypt.kdf else {
            panic!()
        };
        kdf.cost_parameter = 1 << 31;
        assert_eq!(check(&encrypted(scrypt)), Err(Error::Limit));
    }
    #[test]
    fn openssh_bcrypt_cost_is_checked_before_decryption() {
        let key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
        let encrypted = key
            .encrypt(&mut rand::rng(), b"synthetic cost test")
            .unwrap();
        let mut bytes = encrypted.to_bytes().unwrap();
        // Parse only the three length-prefixed OpenSSH header strings; never decrypt.
        let mut offset = b"openssh-key-v1\0".len();
        for _ in 0..2 {
            let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4 + len;
        }
        let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let rounds = offset + 4 + len - 4;
        bytes[rounds..rounds + 4].copy_from_slice(&u32::MAX.to_be_bytes());
        let encoded = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----",
            STANDARD.encode(bytes.as_slice())
        );
        assert_eq!(check(&encoded), Err(Error::Limit));
        assert_eq!(
            check("PuTTY-User-Key-File-3: ssh-rsa"),
            Err(Error::InvalidKey)
        );
    }
}
