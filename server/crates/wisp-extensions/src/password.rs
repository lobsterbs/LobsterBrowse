//! Password authentication extension (0x02).
//!
//! Flow: the server lists the extension in its INFO with a [required u8]
//! payload. The client replies with
//! [user_len u8][user][password]. On mismatch the server must send
//! CLOSE(0xc0) and drop the websocket.

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Server-side password store.
///
/// Passwords are stored as salted SHA-256 hashes. This is a deliberately
/// simple scheme matching the protocol-level use case (gatekeeping a proxy
/// endpoint, not protecting crown jewels); deployments wanting stronger KDFs
/// can implement their own checks on top of `verify_hashed`.

pub struct PasswordAuth {
    required: bool,
    /// username -> salted hash
    users: Vec<(String, [u8; 32])>,
}

impl PasswordAuth {
    /// Create with a set of (username, password) pairs; hashes them now.
    pub fn new(required: bool, users: Vec<(String, String)>) -> Self {
        Self {
            required,
            users: users
                .into_iter()
                .map(|(u, p)| (u, Self::hash(&u, &p)))
                .collect(),
        }
    }

    pub fn required(&self) -> bool {
        self.required
    }

    /// Salted hash for storage.
    fn hash(username: &str, password: &str) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(username.as_bytes());
        h.update(&[0]);
        h.update(password.as_bytes());
        let out = h.finalize();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&out);
        arr
    }

    /// Verify a client INFO payload:
    /// [user_len u8][user bytes][password bytes (rest)].
    pub fn verify_payload(&self, payload: &[u8]) -> bool {
        let Some(msg) = wisp_core::extension::password_auth_client_decode(payload) else {
            return false;
        };
        self.verify(&msg.0, &msg.1)
    }

    /// Constant-time verification against the store.
    pub fn verify(&self, username: &str, password: &str) -> bool {
        // Compare against every entry to avoid username-enumeration timing.
        let mut ok = false;
        for (user, stored) in &self.users {
            let candidate = Self::hash(user, password);
            let user_match = user.as_bytes().ct_eq(username.as_bytes());
            let hash_match = candidate.ct_eq(stored);
            // Only when both match do we set ok; timing stays uniform.
            if bool::from(user_match) && bool::from(hash_match) {
                ok = true;
            }
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_correct_credentials() {
        let auth = PasswordAuth::new(true, vec![("ada".into(), "hunter2".into())]);
        assert!(auth.verify("ada", "hunter2"));
        assert!(!auth.verify("ada", "wrong"));
        assert!(!auth.verify("eve", "hunter2"));
    }

    #[test]
    fn verifies_wire_payload() {
        let auth = PasswordAuth::new(true, vec![("ada".into(), "pw".into())]);
        let good = wisp_core::extension::password_auth_client("ada", "pw").unwrap();
        assert!(auth.verify_payload(&good));
        let bad = wisp_core::extension::password_auth_client("ada", "nope").unwrap();
        assert!(!auth.verify_payload(&bad));
        assert!(!auth.verify_payload(&[99, 1, 2])); // malformed
    }
}
