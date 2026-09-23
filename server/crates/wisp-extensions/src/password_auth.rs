//! Password auth extension (0x02).
//!
//! Server INFO metadata: [required u8]. Client INFO metadata:
//! [user_len u8][user][password]. On mismatch, close with 0xc0.
//!
//! Passwords are stored as salted SHA-256 hashes (Wisp auth protects the
//! proxy endpoint itself; users should never reuse real passwords here —
//! the MOTD says so).

use sha2::{Digest, Sha256};
use wisp_core::extension::password_auth_client;
use wisp_core::packet::CloseReason;

/// Store + verifier for password credentials.
#[derive(Debug, Clone)]
pub struct PasswordAuth {
    required: bool,
    /// (username, salted password hash) pairs.
    credentials: Vec<(String, [u8; 32])>,
}

fn hash(salt: &str, password: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(b"\0");
    h.update(password.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

impl PasswordAuth {
    /// No credentials registered; auth optional.
    pub fn disabled() -> Self {
        Self { required: false, credentials: Vec::new() }
    }

    /// Register a user. Salt should be per-user random.
    pub fn register(&mut self, username: &str, salt: &str, password: &str) {
        let h = hash(salt, password);
        // Replace entry if the user exists.
        if let Some(entry) = self.credentials.iter_mut().find(|(u, _)| u == username) {
            entry.1 = h;
        } else {
            self.credentials.push((username.to_string(), h));
        }
    }

    pub fn set_required(&mut self, required: bool) {
        self.required = required;
    }

    pub fn is_required(&self) -> bool {
        self.required
    }

    /// INFO metadata the server advertises: [required u8].
    pub fn server_metadata(&self) -> Vec<u8> {
        wisp_core::extension::password_auth_server(self.required)
    }

    /// Verify a client INFO metadata payload against the store.
    /// Ok(()) on success (or when auth is optional and no creds were sent,
    /// in which case metadata is empty).
    pub fn verify(&self, client_metadata: &[u8]) -> Result<(), CloseReason> {
        if client_metadata.is_empty() {
            return if self.required {
                Err(CloseReason::AuthRequired)
            } else {
                Ok(())
            };
        }
        // Parse: [user_len u8][user][password].
        let user_len = client_metadata[0] as usize;
        if client_metadata.len() < 1 + user_len {
            return Err(CloseReason::AuthBadCredentials);
        }
        let username = std::str::from_utf8(&client_metadata[1..1 + user_len])
            .map_err(|_| CloseReason::AuthBadCredentials)?;
        let password = &client_metadata[1 + user_len..];
        let Some((_, stored)) = self.credentials.iter().find(|(u, _)| u == username) else {
            return Err(CloseReason::AuthBadCredentials);
        };
        // Constant-time compare.
        let candidate = hash(username, std::str::from_utf8(password).unwrap_or(""));
        if constant_time_eq(&candidate, stored) {
            Ok(())
        } else {
            Err(CloseReason::AuthBadCredentials)
        }
    }
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_verify() {
        let mut auth = PasswordAuth::disabled();
        auth.set_required(true);
        auth.register("ada", "s1", "hunter2");
        let meta = password_auth_client("ada", "hunter2").unwrap();
        assert!(auth.verify(&meta).is_ok());
        let bad = password_auth_client("ada", "wrong").unwrap();
        assert_eq!(auth.verify(&bad), Err(CloseReason::AuthBadCredentials));
        let ghost = password_auth_client("nobody", "x").unwrap();
        assert_eq!(auth.verify(&ghost), Err(CloseReason::AuthBadCredentials));
    }

    #[test]
    fn required_without_credentials() {
        let mut auth = PasswordAuth::disabled();
        auth.set_required(true);
        auth.register("ada", "s", "pw");
        assert_eq!(auth.verify(&[]), Err(CloseReason::AuthRequired));
        let mut optional = PasswordAuth::disabled();
        optional.register("ada", "s", "pw");
        assert!(optional.verify(&[]).is_ok());
    }

    #[test]
    fn metadata_shape() {
        let mut auth = PasswordAuth::disabled();
        auth.set_required(true);
        assert_eq!(auth.server_metadata(), vec![1]);
    }
}
