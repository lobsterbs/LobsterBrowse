//! Wisp v2 protocol extension IDs and metadata encoding/decoding.

use crate::error::{Result, WispError};

/// Extension IDs negotiated in INFO packets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ExtensionId {
    Udp = 0x01,
    PasswordAuth = 0x02,
    KeyAuth = 0x03,
    Motd = 0x04,
    StreamConfirm = 0x05,
}

impl ExtensionId {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0x01 => Ok(Self::Udp),
            0x02 => Ok(Self::PasswordAuth),
            0x03 => Ok(Self::KeyAuth),
            0x04 => Ok(Self::Motd),
            0x05 => Ok(Self::StreamConfirm),
            other => Err(WispError::InvalidExtensionId(other)),
        }
    }
}

/// Signature algorithm bit masks for the key-auth extension.
pub mod sig_algorithms {
    pub const ED25519: u8 = 0b0000_0001;
}

/// Encode a PasswordAuth server message: [required u8].
pub fn password_auth_server(required: bool) -> Vec<u8> {
    vec![u8::from(required)]
}

/// Encode a PasswordAuth client message:
/// [user_len u8][user bytes][password bytes (rest)].
pub fn password_auth_client(username: &str, password: &str) -> Result<Vec<u8>> {
    let user = username.as_bytes();
    if user.len() > 255 {
        return Err(WispError::ProtocolViolation("username exceeds 255 bytes"));
    }
    let mut out = Vec::with_capacity(1 + user.len() + password.len());
    out.push(user.len() as u8);
    out.extend_from_slice(user);
    out.extend_from_slice(password.as_bytes());
    Ok(out)
}

/// Decode a PasswordAuth client message into (username, password).
pub fn password_auth_client_decode(payload: &[u8]) -> Option<(String, String)> {
    if payload.is_empty() {
        return None;
    }
    let user_len = payload[0] as usize;
    if payload.len() - 1 < user_len {
        return None;
    }
    let username = std::str::from_utf8(&payload[1..1 + user_len]).ok()?.to_string();
    let password = String::from_utf8_lossy(&payload[1 + user_len..]).into_owned();
    Some((username, password))
}

/// Encode a MOTD server message: raw UTF-8 string bytes.
pub fn motd_server(message: &str) -> Vec<u8> {
    message.as_bytes().to_vec()
}

/// Decode a MOTD server message.
pub fn motd_decode(payload: &[u8]) -> String {
    String::from_utf8_lossy(payload).into_owned()
}

/// Encode a KeyAuth server message:
/// [required u8][algorithms bitmask u8][challenge bytes (rest)].
pub fn key_auth_server(required: bool, algorithms: u8, challenge: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + challenge.len());
    out.push(u8::from(required));
    out.push(algorithms);
    out.extend_from_slice(challenge);
    out
}

/// Decode a KeyAuth server message.
pub fn key_auth_server_decode(payload: &[u8]) -> Option<(bool, u8, Vec<u8>)> {
    if payload.len() < 2 {
        return None;
    }
    Some((payload[0] != 0, payload[1], payload[2..].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_client_roundtrip() {
        let msg = password_auth_client("ada", "hunter2").unwrap();
        let (u, p) = password_auth_client_decode(&msg).unwrap();
        assert_eq!(u, "ada");
        assert_eq!(p, "hunter2");
    }

    #[test]
    fn malformed_password_payloads_rejected() {
        assert!(password_auth_client_decode(&[]).is_none());
        assert!(password_auth_client_decode(&[9, 97]).is_none()); // claims 9-byte user, has 1
    }

    #[test]
    fn key_auth_server_roundtrip() {
        let msg = key_auth_server(true, sig_algorithms::ED25519, &[1, 2, 3]);
        let (req, alg, chal) = key_auth_server_decode(&msg).unwrap();
        assert!(req);
        assert_eq!(alg, sig_algorithms::ED25519);
        assert_eq!(chal, vec![1, 2, 3]);
    }
}
