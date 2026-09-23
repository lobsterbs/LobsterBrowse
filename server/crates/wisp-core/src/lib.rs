//! wisp-core: clean-room implementation of the Wisp v2.1 protocol.
//!
//! Wisp multiplexes many TCP/UDP sockets over a single WebSocket connection.
//! Spec (CC BY 4.0) by ading2210 / Mercury Workshop:
//! https://github.com/MercuryWorkshop/wisp-protocol

pub mod error;
pub mod frame;
pub mod packet;
pub mod extension;
pub mod handshake;

pub use error::{Result, WispError};
pub use frame::{encode_packet, Frame};
pub use handshake::ServerHandshake;
pub use packet::{CloseReason, Packet, PacketType, StreamKind};