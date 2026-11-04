use crate::{Error, Result, Store};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use config_model::{
    HostEndpoint, HostKey, HostKeyReview, HostKeyStatus, HostKeySummary, HostProtocol,
};
use rusqlite::{Connection, TransactionBehavior, params};
use sha2::{Digest, Sha256};

fn protocol(value: HostProtocol) -> &'static str {
    match value {
        HostProtocol::Ssh1 => "ssh1",
        HostProtocol::Ssh2 => "ssh2",
    }
}
fn fingerprint(key: &[u8]) -> String {
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key)))
}
fn summary(key: &HostKey) -> HostKeySummary {
    HostKeySummary {
        endpoint: key.endpoint.clone(),
        algorithm: key.algorithm.clone(),
        fingerprint: fingerprint(&key.key),
    }
}
fn read(connection: &Connection) -> Result<Vec<HostKey>> {
    let mut stmt=connection.prepare("SELECT protocol,host,port,algorithm,length(key),key FROM host_keys ORDER BY protocol,host,port,algorithm LIMIT 1025")?;
    let mut rows = stmt.query([])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        let length: i64 = row.get(4)?;
        if !(1..=16384).contains(&length) {
            return Err(Error::Corrupt);
        }
        let value = HostKey {
            endpoint: HostEndpoint {
                protocol: match row.get::<_, String>(0)?.as_str() {
                    "ssh1" => HostProtocol::Ssh1,
                    "ssh2" => HostProtocol::Ssh2,
                    _ => return Err(Error::Corrupt),
                },
                host: row.get(1)?,
                port: row.get(2)?,
            },
            algorithm: row.get(3)?,
            key: row.get(5)?,
        };
        value.validate().map_err(|_| Error::Corrupt)?;
        if value.endpoint != value.endpoint.canonical()? {
            return Err(Error::Corrupt);
        }
        result.push(value);
    }
    if result.len() > 1024 {
        return Err(Error::Corrupt);
    }
    let mut previous = None;
    let mut endpoint_count = 0;
    for key in &result {
        if previous == Some(&key.endpoint) {
            endpoint_count += 1;
        } else {
            previous = Some(&key.endpoint);
            endpoint_count = 1;
        }
        if endpoint_count > 16 {
            return Err(Error::Corrupt);
        }
    }
    Ok(result)
}
fn review(connection: &Connection, candidate: &HostKey) -> Result<HostKeyReview> {
    candidate.validate()?;
    let endpoint = candidate.endpoint.canonical()?;
    let keys = read(connection)?
        .into_iter()
        .filter(|value| value.endpoint == endpoint)
        .collect::<Vec<_>>();
    if keys.len() > 16 {
        return Err(Error::Corrupt);
    }
    let status = if keys
        .iter()
        .any(|value| value.algorithm == candidate.algorithm && value.key == candidate.key)
    {
        HostKeyStatus::Known
    } else if keys.is_empty() {
        HostKeyStatus::Unknown
    } else {
        HostKeyStatus::Changed
    };
    let known = keys.iter().map(summary).collect::<Vec<_>>();
    let mut revision = Sha256::new();
    revision.update(serde_json::to_vec(&endpoint)?);
    revision.update(serde_json::to_vec(&known)?);
    Ok(HostKeyReview {
        candidate: HostKeySummary {
            endpoint,
            algorithm: candidate.algorithm.clone(),
            fingerprint: fingerprint(&candidate.key),
        },
        known,
        status,
        revision: revision
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}
impl Store {
    pub fn host_keys(&self) -> Result<Vec<HostKeySummary>> {
        Ok(read(&self.connection)?.iter().map(summary).collect())
    }
    /// Read-only assessment: unknown/changed keys never become trusted implicitly.
    pub fn review_host_key(&self, candidate: &HostKey) -> Result<HostKeyReview> {
        review(&self.connection, candidate)
    }
    /// Trusted callers must supply the exact endpoint revision shown during approval.
    pub fn approve_host_key(
        &mut self,
        candidate: HostKey,
        expected_revision: &str,
    ) -> Result<bool> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let before = review(&tx, &candidate)?;
        if before.revision != expected_revision {
            return Err(Error::Conflict);
        }
        if before.status == HostKeyStatus::Known {
            return Ok(false);
        }
        let all = read(&tx)?;
        let replaces = before
            .known
            .iter()
            .any(|value| value.algorithm == candidate.algorithm);
        if !replaces && (all.len() >= 1024 || before.known.len() >= 16) {
            return Err(Error::Invalid("host key limit"));
        }
        let endpoint = before.candidate.endpoint;
        tx.execute("INSERT INTO host_keys(protocol,host,port,algorithm,key) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(protocol,host,port,algorithm) DO UPDATE SET key=excluded.key",params![protocol(endpoint.protocol),endpoint.host,endpoint.port,candidate.algorithm,candidate.key])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn forget_host_key(
        &mut self,
        endpoint: &HostEndpoint,
        algorithm: &str,
        expected_fingerprint: &str,
    ) -> Result<()> {
        let endpoint = endpoint.canonical()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = read(&tx)?
            .into_iter()
            .find(|value| value.endpoint == endpoint && value.algorithm == algorithm)
            .ok_or(Error::NotFound)?;
        if fingerprint(&value.key) != expected_fingerprint {
            return Err(Error::Conflict);
        }
        tx.execute(
            "DELETE FROM host_keys WHERE protocol=?1 AND host=?2 AND port=?3 AND algorithm=?4",
            params![
                protocol(endpoint.protocol),
                endpoint.host,
                endpoint.port,
                algorithm
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
}
