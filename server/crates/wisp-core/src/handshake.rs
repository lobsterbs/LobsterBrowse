//! Wisp v2 handshake state machine.
//!
//! Server flow: on WS connect with a Sec-WebSocket-Protocol header present,
//! send INFO(stream 0); client replies with INFO(stream 0); server confirms
//! with CONTINUE(stream 0, initial buffer size) or rejects with CLOSE(stream 0).
//! If the client speaks v1 (no subprotocol header), the first packet the
//! server sends is a CONTINUE on stream 0 instead.

use crate::extension::ExtensionId;

use crate::packet::{CloseReason, Packet, StreamKind};

/// Initial per-stream send-buffer window advertised by the server.
pub const INITIAL_BUFFER_SIZE: u32 = 128;

/// Which protocol version the peer settled on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NegotiatedVersion {
    V1,
    V2,
}

/// Server-side handshake state.
#[derive(Debug)]
pub struct ServerHandshake {
    /// Extension IDs this server supports, with metadata payloads for INFO.
    pub server_extensions: Vec<(ExtensionId, Vec<u8>)>,
    version: Option<NegotiatedVersion>,
    client_info: Option<Packet>,
}

impl ServerHandshake {
    pub fn new(server_extensions: Vec<(ExtensionId, Vec<u8>)>) -> Self {
        Self { server_extensions, version: None, client_info: None }
    }

    /// True when the WS upgrade request carried a subprotocol header => v2.
    pub fn wants_v2(subprotocol_header_present: bool) -> bool {
        subprotocol_header_present
    }

    /// First packet(s) the server must send right after the WS connection opens.
    pub fn opening_packets(&self, use_v2: bool) -> Vec<Packet> {
        if use_v2 {
            vec![Packet::Info {
                stream_id: 0,
                major: 2,
                minor: 1,
                extensions: self
                    .server_extensions
                    .iter()
                    .map(|(id, meta)| (*id as u8, meta.clone()))
                    .collect(),
            }]
        } else {
            // v1: announce the initial buffer 
size with a CONTINUE on stream 0.
            vec![Packet::Continue { stream_id: 0, buffer_remaining: INITIAL_BUFFER_SIZE }]
        }
    }

    /// Feed the next client packet into the handshake.
    /// Ok(Some(Packet)) -> a packet the server must send back.
    /// Ok(None) -> handshake complete, packet consumed.
    /// Err(reason) -> reject with this CLOSE reason.
    pub fn handle(&mut self, packet: &Packet) -> std::result::Result<Option<Packet>, CloseReason> {
        match packet {
            Packet::Info { stream_id: 0, major, .. } => {
                if *major > 2 {
                    return Err(CloseReason::IncompatibleExtensions);
                }
                self.version = Some(NegotiatedVersion::V2);
                self.client_info = Some(packet.clone());
                Ok(Some(Packet::Continue {
                    stream_id: 0,
                    buffer_remaining: INITIAL_BUFFER_SIZE,
                }))
            }
            Packet::Continue { stream_id: 0, .. } => {
                // A CONTINUE as the first client packet indicates v1.
                self.version = Some(NegotiatedVersion::V1);
                Ok(None)
            }
            Packet::Close { .. } => Err(CloseReason::Voluntary),
            _ => Err(CloseReason::IncompatibleExtensions),
        }
    }

    pub fn version(&self) -> Option<NegotiatedVersion> {
        self.version
    }

    /// Extensions both sides declared (v2 only; empty for v1).
    pub fn common_extensions(&self) -> Vec<(ExtensionId, Vec<u8>)> {
        let Some(Packet::Info { extensions, .. }) = &self.client_info else {
            return Vec::new();
        };
        self.server_extensions
            .filter(|(id, _)| extensions.iter().any(|(cid, _)| *cid == *id as u8))
            .filter(|(id, _)| extensions.iter().any(|(cid, _)| cid == *id as u8))
            .cloned()
            .collect()
    }
}

/// Convenience: build a CLOSE packet for stream 0 (handshake rejection).
pub fn handshake_reject(reason: CloseReason) -> Packet {
    Packet::Close {
 stream_id: 0, reason }
}

/// Validate a CONNECT packet destination before opening a socket.
pub fn validate_connect(pkt: &Packet) -> std::result::Result<(), CloseReason> {
    if let Packet::Connect { stream_id, kind, port, hostname } = pkt {
        if *stream_id == 0 {
            return Err(CloseReason::InvalidInfo);
        }
        if hostname.is_empty() || hostname.len() > 255 {
            return Err(CloseReason::InvalidInfo);
        }
        if *port == 0 {
            return Err(CloseReason::InvalidInfo);
        }
        match kind {
            StreamKind::Tcp | StreamKind::Udp => Ok(()),
        }
    } else {
        Err(CloseReason::IncompatibleExtensions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info_packet(major: u8, exts: Vec<(u8, Vec<u8>)>) -> Packet {
        Packet::Info { stream_id: 0, major, minor: 1, extensions: exts }
    }

    #[test]
    fn v2_handshake_accepts() {
        let mut hs = ServerHandshake::new(vec![(ExtensionId::Udp, vec![])]);
        let open = hs.opening_packets(true);
        assert_eq!(open[0].packet_type(), PacketType::Info);
        let reply = hs.handle(&info_packet(2, vec![(0x01, vec![])])).unwrap();
        let Some(Packet::Continue { stream_id, buffer_remaining }) = reply else {
            panic!("expected CONTINUE");
        };
        assert_eq!(stream_id, 0);
        assert_eq!(buffer_remaining, INITIAL_BUFFER_SIZE);
        assert_eq!(hs.version(), Some(NegotiatedVersion::V2));
        assert_eq!(hs.common_extensions().len(), 1);
    }

    #[test]
    fn v1_detected_via_continue() {
        let mut hs = ServerHandshake::new(vec![]);
        let open = hs.opening_packets(false);
        assert!(matches!(open[0], Packet::Continue { .. }));
        let r = hs
            .handle(&Packet::Continue { stream_id: 0, buffer_remaining: 8 })
            .unwrap();
        assert!(r.is_none());
        assert_eq!(hs.version(), Some(NegotiatedVersion::V1));
    }

    #[test]
    fn newer_major_re
jected() {
        let mut hs = ServerHandshake::new(vec![]);
        assert_eq!(
            hs.handle(&info_packet(9, vec![])),
            Err(CloseReason::IncompatibleExtensions)
        );
    }

    #[test]
    fn connect_validation() {
        let good = Packet::Connect {
            stream_id: 7,
            kind: StreamKind::Tcp,
            port: 443,
            hostname: "example.com".into(),
        };
        assert!(validate_connect(&good).is_ok());
        let bad = Packet::Connect {
            stream_id: 0,
            kind: StreamKind::Tcp,
            port: 443,
            hostname: "x".into(),
        };
        assert_eq!(validate_connect(&bad), Err(CloseReason::InvalidInfo));
    }

    #[test]
    fn frames_roundtrip() {
        let pkt = handshake_reject(CloseReason::Blocked);
        let frame = encode_packet(&pkt);
        let mut buf = bytes::BytesMut::new();
        frame.encode_into(&mut buf);
        let parsed = Frame::decode(&mut buf).unwrap().unwrap();
        assert_eq!(parsed.parse_packet().unwrap(), pkt);
    }
}
