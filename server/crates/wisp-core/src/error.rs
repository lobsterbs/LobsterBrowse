use thiserror::Error;

#[derive(Debug, Error)]
pub enum WispError {
    #[error("buffer too short: need {need} bytes, have {have}")]
    BufferTooShort { need: usize, have: usize },
    #[error("invalid packet type: 0x{0:02X}")]
    InvalidPacketType(u8),
    #[error("invalid stream type: 0x{0:02X}")]
    InvalidStreamType(u8),
    #[error("invalid extension id: 0x{0:02X}")]
    InvalidExtensionId(u8),
    #[error("invalid close reason: 0x{0:02X}")]
    InvalidCloseReason(u8),
    #[error("invalid utf-8 in string field")]
    InvalidUtf8(#[from] std::str::Utf8Error),
    #[error("stream id 0 is reserved for the handshake")]
    ReservedStreamId,
    #[error("unknown stream id: {0}")]
    UnknownStream(u32),
    #[error("protocol violation: {0}")]
    ProtocolViolation(&'static str),
}

pub type Result<T> = std::result::Result<T, WispError>;
