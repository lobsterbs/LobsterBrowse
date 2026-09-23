//! Wisp packet types and payloads (v2.1 spec).

use crate::error::{Result, WispError};

/// Packet type byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PacketType {
    Connect = 0x01,
    Data = 0x02,
    Continue = 0x03,
    Close = 0x04,
    Info = 0x05,
}

impl PacketType {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0x01 => Ok(Self::Connect),
            0x02 => Ok(Self::Data),
            0x03 => Ok(Self::Continue),
            0x04 => Ok(Self::Close),
            0x05 => Ok(Self::Info),
            other => Err(WispError::InvalidPacketType(other)),
        }
    }
}

/// Stream kind for CONNECT packets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum StreamKind {
    Tcp = 0x01,
    Udp = 0x02,
}

impl StreamKind {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0x01 => Ok(Self::Tcp),
            0x02 => Ok(Self::Udp),
            other => Err(WispError::InvalidStreamType(other)),
        }
    }
}

/// Close reasons (client/server/shared + extension-defined).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CloseReason {
    Unspecified = 0x01,
    Voluntary = 0x02,
    NetworkError = 0x03,
    IncompatibleExtensions = 0x04,
    // server-only
    InvalidInfo = 0x41,
    UnreachableHost = 0x42,
    ConnectTimedOut = 0x43,
    ConnectionRefused = 0x44,
    TcpTimedOut = 0x47,
    Blocked = 0x48,
    Throttled = 0x49,
    // client-only
    ClientError = 0x81,
    // auth extensions
    AuthBadCredentials = 0xc0,
    AuthBadSignature = 0xc1,
    AuthRequired = 0xc2,
}

impl CloseReason {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0x01 => Ok(Self::Unspecified),
            0x02 => Ok(Self::Voluntary),
            0x03 => Ok(Self::NetworkError),
            0x04 => Ok(Self::IncompatibleExtensions),
            0x41 => Ok(Self::InvalidInfo),
            0x42 => Ok(Self::UnreachableHost),
            0x43 => Ok(Self::ConnectTimedOut),
            0x44 => Ok(Self::ConnectionRefused),
            0x47 => Ok(Self::TcpTimedOut),
            0x48 => Ok(Self::Blocked),
            0x49 => Ok(Self::Throttled),
            0x81 => Ok(Self::ClientError),
            0xc0 => Ok(Self::AuthBadCredentials),
            0xc1 => Ok(Self::AuthBadSignature),
            0xc2 => Ok(Self::AuthRequired),
            other => Err(WispError::InvalidCloseReason(other)),
        }
    }
}

/// Fully parsed Wisp packet (header + decoded payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    /// Stream ID + kind + destination port + UTF-8 hostname.
    Connect {
        stream_id: u32,
        kind: StreamKind,
        port: u16,
        hostname: String,
    },
    /// Stream ID + payload bytes to relay.
    Data { stream_id: u32, payload: Vec<u8> },
    /// Stream ID + remaining buffer slots the peer may use.
    Continue { stream_id: u32, buffer_remaining: u32 },
    /// Stream ID + close reason. Stream ID 0 = whole connection (handshake).
    Close { stream_id: u32, reason: CloseReason },
    /// Wisp version (major, minor) + negotiated extension metadata.
    Info {
        stream_id: u32,
        major: u8,
        minor: u8,
        extensions: Vec<(u8, Vec<u8>)>,
    },
}

impl Packet {
    pub fn packet_type(&self) -> PacketType {
        match self {
            Self::Connect { .. } => PacketType::Connect,
            Self::Data { .. } => PacketType::Data,
            Self::Continue { .. } => PacketType::Continue,
            Self::Close { .. } => PacketType::Close,
            Self::Info { .. } => PacketType::Info,
        }
    }

    pub fn stream_id(&self) -> u32 {
        match self {
            Self::Connect { stream_id, .. }
            | Self::Data { stream_id, .. }
            | Self::Continue { stream_id, .. }
            | Self::Close { stream_id, .. }
            | Self::Info { stream_id, .. } => *stream_id,
        }
    }
}
