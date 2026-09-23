//! Wisp v2 protocol extension IDs and metadata encoding.

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

/// Encode a MOTD server message: raw UTF-8 string bytes.
pub fn motd_server(message: &str) -> Vec<u8> {
    message.as_bytes().to_vec()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_client_roundtrip_shape() {
        let msg = password_auth_client("ada", "hunter2").unwrap();
        assert_eq!(msg[0], 3);
        assert_eq!(&msg[1..4], b"ada");
        assert_eq!(&msg[4..], b"hunter2");
    }

    #[test]
    fn key_auth_server_shape() {
        let msg = key_auth_server(true, sig_algorithms::ED25519, &[1, 2, 3]);
        assert_eq!(msg, vec![1, 1, 1, 2, 3]);
    }
}
