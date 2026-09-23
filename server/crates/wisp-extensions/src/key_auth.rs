//! Ed25519 public/private key auth extension (0x03).
//!
//! Server INFO metadata: [required u8][algorithms u8][challenge bytes].
//! Client INFO metadata:
//! [user_len u8][user][algorithm u8][pubkey_hash 32B][signature].
//! On verification failure, close with 0xc1.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand_core::{CryptoRng, RngCore};
use sha2::{Digest, Sha256};
use wisp_core::extension::sig_algorithms;
use wisp_core::packet::CloseReason;

/// Challenge length in bytes (spec: ~512 bits).
pub const CHALLENGE_LEN: usize = 64;

#[derive(Debug, Clone)]
pub struct KeyAuth {
    required: bool,
    /// (username, Ed25519 verifying key).
    keys: Vec<(String, VerifyingKey)>
}

impl KeyAuth {
    pub fn disabled() -> Self {
        Self { required: false, keys: Vec::new() }
    }

    pub fn register(&mut self, username: &str, verifying_key: VerifyingKey) {
        if let Some(entry) = self.keys.iter_mut().find(|(u, _)| u == username) {
            entry.1 = verifying_key;
        } else {
            self.keys.push((username.to_string(), verifying_key));
        }
    }

    pub fn set_required(&mut self, required: bool) {
        self.required = required;
    }

    pub fn is_required(&self) -> bool {
        self.required
    }

    /// Mint a fresh server challenge with a CSPRNG.
    pub fn new_challenge(&self, rng: &mut (impl RngCore + CryptoRng)) -> [u8; CHALLENGE_LEN] {
        let mut c = [0u8; CHALLENGE_LEN];
        rng.fill_bytes(&mut c);
        c
    }

    /// INFO metadata the server advertises for this connection.
    pub fn server_metadata(&self, challenge: &[u8]) -> Vec<u8> {
        wisp_core::extension::key_auth_server(
            self.required,
            sig_algorithms::ED25519,
            challenge,
        )
    }

    /// Verify a client metadata payload:
    /// [user_len u8][user][algorithm u8][pubkey_hash 32B][signature].
    pub fn verify(&self, challenge: &[u8], client_metadata: &[u8]) -> Result<(), CloseReason> {
        if client_metadata.is_empty() {
            return if self.required {
                Err(CloseReason::AuthRequired)
            } else {
                Ok(())
            };
        }
        if client_metadata.len() < 2 {
            return Err(CloseReason::AuthBadSignature);
        }
        let user_len = client_metadata[0] as usize;
        if client_metadata.len() < 1 + user_len + 1 + 32 + 64 {
            return Err(CloseReason::AuthBadSignature);
        }
        let username = std::str::from_utf8(&client_metadata[1..1 + user_len])
            .map_err(|_| CloseReason::AuthBadSignature)?;
        let pos = 1 + user_len;
        let algorithm = client_metadata[pos];
        if algorithm != sig_algorithms::ED25519 {
            return Err(CloseReason::IncompatibleExtensions);
        }
        let pubkey_hash: [u8; 32] = client_metadata[pos + 1..pos + 33]
            .try_into()
            .map_err(|_| CloseReason::AuthBadSignature)?;
        let sig_bytes: [u8; 64] = client_metadata[pos + 33..pos + 97]
            .try_into()
            .map_err(|_| CloseReason::AuthBadSignature)?;

        // Look up the user, verify the pubkey hash matches, then the signature.
        let Some((_, vk)) = self.keys.iter().find(|(u, _)| u == username) else {
            return Err(CloseReason::AuthBadSignature);
        };
        let stored_hash: [u8; 32] = Sha256::digest(vk.as_bytes())
            .try_into()
            .map_err(|_| CloseReason::AuthBadSignature)?;
        if !super::password_auth::ct_eq(&pubkey_hash, &stored_hash) {
            return Err(CloseReason::AuthBadSignature);
        }
        let sig = Signature::from_bytes(&sig_bytes);
        vk.verify(challenge, &sig)
            .map_err(|_| CloseReason::AuthBadSignature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{SigningKey, Signer};
    use rand_core::OsRng;

    fn client_meta(user: &str, sk: &SigningKey, challenge: &[u8]) -> Vec<u8> {
        let vk = sk.verifying_key();
        let hash: [u8; 32] = Sha256::digest(vk.as_bytes()).try_into().unwrap();
        let sig = sk.sign(challenge);
        let u = user.as_bytes();
        let mut out = Vec::with_capacity(1 + u.len() + 1 + 32 + 64);
        out.push(u.len() as u8);
        out.extend_from_slice(u);
        out.push(sig_algorithms::ED25519);
        out.extend_from_slice(&hash);
        out.extend_from_slice(&sig.to_bytes());
        out
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let mut auth = KeyAuth::disabled();
        let sk = SigningKey::generate(&mut OsRng);
        auth.register("ada", sk.verifying_key());
        let challenge = auth.new_challenge(&mut OsRng);
        let meta = client_meta("ada", &sk, &challenge);
        assert!(auth.verify(&challenge, &meta).is_ok());

        // Wrong challenge -> signature fails.
        let other = auth.new_challenge(&mut OsRng);
        assert_eq!(auth.verify(&other, &meta), Err(CloseReason::AuthBadSignature));

        // Unknown user.
        let ghost = SigningKey::generate(&mut OsRng);
        let ghost_meta = client_meta("nobody", &ghost, &challenge);
        assert_eq!(auth.verify(&challenge, &ghost_meta), Err(CloseReason::AuthBadSignature));
    }

    #[test]
    fn optional_without_credentials() {
        let auth = KeyAuth::disabled();
        let c = auth.new_challenge(&mut OsRng);
        assert!(auth.verify(&c, &[]).is_ok());
    }
}
