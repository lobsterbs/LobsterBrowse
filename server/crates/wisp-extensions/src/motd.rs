//! MOTD extension (0x04): server INFO metadata is a UTF-8 string the client
//! displays to the user. Used to communicate limits, block policy, and
//! the no-logging policy.

#[derive(Debug, Clone)]
pub struct Motd {
    message: String,
}

impl Motd {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    pub fn server_metadata(&self) -> Vec<u8> {
        wisp_core::extension::motd_server(&self.message)
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_utf8() {
        let m = Motd::new("LobsterBrowse: no logging, be kind.");
        assert_eq!(
            String::from_utf8(m.server_metadata()).unwrap(),
            "LobsterBrowse: no logging, be kind."
        );
    }
}
