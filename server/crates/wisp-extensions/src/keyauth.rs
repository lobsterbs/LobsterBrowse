//! Public/private key authentication extension (0x03).
//!
//! Flow: the server INFO lists the extension with
//! [required u8][algorithms bitmask u8][challenge bytes]. The client signs
//! the challenge with Ed25519 and replies with
//! [user_len u8][user][algorithm u8][pubkey hash 32B][signature].
//! On failure the server sends CLOSE(0xc1).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;

pub const ED25519_MASK: u8 = 0b0000_0001;

/// Server-side key-auth state for one handshake.
pub struct KeyAuth {
    required: bool,
    /// Allowed verifying keys with their owners.
    keys: Vec<(String, VerifyingKey)>,
    /// Active challenge issued to the client.
    challenge: Vec<u8>,
}

impl KeyAuth {
    /// Prepare a handshake: generate a fresh 64-byte challenge.
    pub fn new(required: bool, keys: Vec<(String, VerifyingKey)>) -> Self {
        let mut challenge = vec![0u8; 64];
        rand::thread_rng().fill_bytes(&mut challenge);
        Self { required, keys, challenge }
    }

    pub fn required(&self) -> bool {
        self.required
    }

    pub fn challenge(&self) -> &[u8] {
        &self.challenge
    }

    /// Server INFO metadata for this extension.
    pub fn info_metadata(&self) -> Vec<u8> {
        wisp_core::extension::key_auth_server(self.required, ED25519_MASK, &self.challenge)
    }

    /// Verify the client response payload:
    /// [user_len u8][user][algorithm u8][pubkey_hash 32B][signature (rest)].
    pub fn verify_payload(&self, payload: &[u8]) -> bool {
        let Some((username, algorithm, pubkey_hash, signature)) = decode_client(payload) else {
            return false;
        };
        if algorithm & ED25519_MASK == 0 {
            return false;
        }
        // Find an allowed key whose SHA-256 hash matches, then verify the signature.
        use sha2::Digest;
        for (user, key) in &self.keys {
            let mut h = sha2::Sha256::new();
            h.update(key.as_bytes());
            let hash = h.finalize();
            if hash.as_slice() != pubkey_hash {
                continue;
            }
            if user != username {
                continue;
            }
            let Ok(sig) = Signature::from_slice(signature) else {
                return false;
            };
            return key.verify(&self.challenge, &sig).is_ok();
        }
        false
    }
}

/// Decode the client key-auth message.
pub fn decode_client(payload: &[u8]) -> Option<(String, u8, &[u8], &[u8])> {
    if payload.is_empty() {
        return None;
    }
    let user_len = payload[0] as usize;
    let mut pos = 1;
    if payload.len() - pos < user_len {
        return None;
    }
    let username = std::str::from_utf8(&payload[pos..pos + user_len]).ok()?.to_string();
    pos += user_len;
    if payload.len() - pos < 1 + 32 {
        return None;
    }
    let algorithm = payload[pos];
    let pubkey_hash = &payload[pos + 1..pos + 33];
    let signature = &payload[pos + 33..];
    if signature.len() != 64 {
        return None;
    }
    Some((username, algorithm, pubkey_hash, signature))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Signer, SigningKey};

    #[test]
    fn full_ed25519_flow() {
        let sk = SigningKey::generate(&mut rand::rngs::OsRng);
        let vk = VerifyingKey::from(&sk);
        let auth = KeyAuth::new(false, vec![("ada".into(), vk)]);

        // Build the client response.
        let mut h = sha2::Sha256::new();
        h.update(vk.as_bytes());
        let hash = h.finalize();
        let sig: Signature = sk.sign(auth.challenge());
        let user = b"ada";
        let mut payload = Vec::new();
        payload.push(user.len() as u8);
        payload.extend_from_slice(user);
        payload.push(ED25519_MASK);
        payload.extend_from_slice(&hash);
        payload.extend_from_slice(sig.to_bytes());

        assert!(auth.verify_payload(&payload));

        // Tampered signature fails.
        let mut bad = payload.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0xFF;
        assert!(!auth.verify_payload(&bad));
    }
}
