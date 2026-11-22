//! Which machine this is, to an engine: enrolled once, with a key that never leaves it.
//!
//! The daemon's folder holds `machine.json`, the engine's address and this machine's ID, and
//! `key`, the machine's private key.

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

use crate::protocol::proof_text;

/// What comes before an Ed25519 public key in the form every program reads one in: its
/// SubjectPublicKeyInfo, in DER.
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// The engine a machine is enrolled with, and the machine's ID there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub server: String,
    pub id: String,
}

/// A machine that has enrolled: who it is, and the key it proves that with.
pub struct Enrolled {
    pub identity: Identity,
    key: SigningKey,
}

impl Enrolled {
    /// Reads who this machine is from the daemon's folder. None for one that has not enrolled.
    pub fn read(dir: &Path) -> Option<Self> {
        let identity = serde_json::from_slice(&fs::read(dir.join("machine.json")).ok()?).ok()?;
        let seed = STANDARD
            .decode(fs::read_to_string(dir.join("key")).ok()?.trim())
            .ok()?;
        let seed: [u8; 32] = seed.try_into().ok()?;
        Some(Self {
            identity,
            key: SigningKey::from_bytes(&seed),
        })
    }

    /// The proof that this is the machine: the engine's nonce, signed with the machine's key.
    pub fn proof(&self, nonce: &str) -> String {
        STANDARD.encode(
            self.key
                .sign(proof_text(&self.identity.id, nonce).as_bytes())
                .to_bytes(),
        )
    }
}

/// The public half of a key, as the engine is given it.
fn public_key(key: &SigningKey) -> String {
    let mut der = SPKI_PREFIX.to_vec();
    der.extend_from_slice(key.verifying_key().as_bytes());
    STANDARD.encode(der)
}

/// An engine's address without what a person may leave at its end.
pub fn server_of(given: &str) -> String {
    given.trim_end_matches('/').to_string()
}

/// Enrols this machine: makes its key, gives the engine the public half with the token, and
/// writes down who it now is. The private half stays here.
pub fn enrol(dir: &Path, server: &str, id: &str, token: &str) -> Result<(), String> {
    let server = server_of(server);
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|error| format!("no key could be made: {error}"))?;
    let key = SigningKey::from_bytes(&seed);
    let body = serde_json::json!({ "token": token, "publicKey": public_key(&key) }).to_string();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut answer = agent
        .post(format!("{server}/v1/machines/{id}/enrol"))
        .header("content-type", "application/json")
        .send(body.as_str())
        .map_err(|error| format!("The engine at {server} could not be reached: {error}"))?;
    if !answer.status().is_success() {
        let status = answer.status().as_u16();
        let said = answer.body_mut().read_to_string().unwrap_or_default();
        let why = serde_json::from_str::<serde_json::Value>(&said)
            .ok()
            .and_then(|body| body["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("status {status}"));
        return Err(format!("The engine refused to enrol this machine: {why}"));
    }

    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    // The key first: a machine that says who it is has the key to prove it.
    let key_file = dir.join("key");
    let _ = fs::remove_file(&key_file);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&key_file)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{}", STANDARD.encode(seed)).map_err(|error| error.to_string())?;
    let identity = Identity {
        server,
        id: id.to_string(),
    };
    let written = serde_json::to_string_pretty(&identity).map_err(|error| error.to_string())?;
    fs::write(dir.join("machine.json"), format!("{written}\n")).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn a_machine_proves_itself_with_the_key_whose_public_half_it_gave() {
        let dir =
            std::env::temp_dir().join(format!("acentric-machine-identity-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(Enrolled::read(&dir).is_none());

        let key = SigningKey::from_bytes(&[7u8; 32]);
        fs::write(dir.join("key"), format!("{}\n", STANDARD.encode([7u8; 32]))).unwrap();
        fs::write(
            dir.join("machine.json"),
            r#"{"server":"https://engine.example.com","id":"mch_1"}"#,
        )
        .unwrap();
        let enrolled = Enrolled::read(&dir).unwrap();
        assert_eq!(enrolled.identity.id, "mch_1");

        // The public half is the 44 bytes every program reads an Ed25519 key in.
        let der = STANDARD.decode(public_key(&key)).unwrap();
        assert_eq!(der.len(), 44);
        let public = VerifyingKey::from_bytes(der[12..].try_into().unwrap()).unwrap();
        let signature = STANDARD.decode(enrolled.proof("n1")).unwrap();
        let signature = Signature::from_slice(&signature).unwrap();
        assert!(public.verify(b"machine mch_1\nn1", &signature).is_ok());
        assert!(public.verify(b"machine mch_2\nn1", &signature).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_address_is_kept_without_the_slash_at_its_end() {
        assert_eq!(
            server_of("https://engine.example.com//"),
            "https://engine.example.com"
        );
    }
}
