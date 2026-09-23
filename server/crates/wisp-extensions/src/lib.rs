//! wisp-extensions: implementations of the Wisp v2 protocol extensions
//! negotiated during the INFO handshake.
//!
//! - password auth (ext 0x02)
//! - Ed25519 public/private key auth (ext 0x03)
//! - MOTD (ext 0x04)
//! - stream-open confirmation (ext 0x05)
//!
//! UDP support (ext 0x01) is signaled in INFO only; its data path lives in
//! the server stream manager (bin/server), not here.

pub mod password_auth;
pub mod key_auth;
pub mod motd;

pub use password_auth::PasswordAuth;
pub use key_auth::KeyAuth;
pub use motd::Motd;
