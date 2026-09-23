//! wisp-extensions: server-side flows for the Wisp v2 extensions.

pub mod password;
pub mod keyauth;

pub use password::PasswordAuth;
pub use keyauth::KeyAuth;
