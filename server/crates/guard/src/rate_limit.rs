//! Per-IP rate limiting + CONNECT/CLOSE flood detection.
//!
//! The Lucide Proxy attack: each browser opened up to 1,024 WebSockets and
//! sent CONNECT+CLOSE pairs every 100ms, forcing ~10k socket allocations/sec
//! and 20k+ log writes/sec. This module stops that at the control-plane level.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardLimit {
    TooManyConnections,
    TooManyStreams,
    Flood,
}

/// Per-client quota tracker. Synchronous by design; wrap in a lock in the
/// async connection handler.
#[derive(Debug)]
pub struct RateLimiter {
    pub max_connections_per_ip: usize,
    pub max_streams_per_connection: usize,
    pub max_connects_per_sec: u32,
    window: Duration,
    connect_windows: HashMap<u64, Vec<Instant>>,
    connections_per_ip: HashMap<IpAddr, usize>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            max_connections_per_ip: 8,
            max_streams_per_connection: 64,
            max_connects_per_sec: 10,
            window: Duration::from_secs(1),
            connect_windows: HashMap::new(),
            connections_per_ip: HashMap::new(),
        }
    }
}

impl RateLimiter {
    pub fn new(
        max_connections_per_ip: usize,
        max_streams_per_connection: usize,
        max_connects_per_sec: u32,
    ) -> Self {
        Self {
            max_connections_per_ip,
            max_streams_per_connection,
            max_connects_per_sec,
            ..Self::default()
        }
    }

    /// Register a new connection. Err => reject the upgrade entirely.
    pub fn connection_opened(&mut self, ip: IpAddr) -> Result<(), GuardLimit> {
        let n = self.connections_per_ip.entry(ip).or_insert(0);
        if *n >= self.max_connections_per_ip {
            return Err(GuardLimit::TooManyConnections);
        }
        *n += 1;
        Ok(())
    }

    pub fn connection_closed(&mut self, ip: IpAddr) {
        if let Some(n) = self.connections_per_ip.get_mut(&ip) {
            *n = n.saturating_sub(1);
        }
    }

    /// Check the per-stream cap before accepting a CONNECT.
    pub fn can_open_stream(&self, current_streams: usize) -> Result<(), GuardLimit> {
        if current_streams >= self.max_streams_per_connection {
            return Err(GuardLimit::TooManyStreams);
        }
        Ok(())
    }

    /// Count a CONNECT for this connection; throttle if the rate is exceeded.
    pub fn connect_attempt(&mut self, conn_id: u64, now: Instant) -> Result<(), GuardLimit> {
        let window_start = now.checked_sub(self.window).unwrap_or(now);
        let timestamps = self.connect_windows.entry(conn_id).or_default();
        timestamps.retain(|t| *t > window_start);
        if timestamps.len() >= self.max_connects_per_sec as usize {
            return Err(GuardLimit::Flood);
        }
        timestamps.push(now);
        Ok(())
    }

    /// Drop state for a finished connection.
    pub fn forget_connection(&mut self, conn_id: u64, ip: Option<IpAddr>) {
        self.connect_windows.remove(&conn_id);
        if let Some(ip) = ip {
            self.connection_closed(ip);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn connection_cap() {
        let mut rl = RateLimiter::new(2, 10, 10);
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        assert!(rl.connection_opened(ip).is_ok());
        assert!(rl.connection_opened(ip).is_ok());
        assert_eq!(rl.connection_opened(ip), Err(GuardLimit::TooManyConnections));
        rl.connection_closed(ip);
        assert!(rl.connection_opened(ip).is_ok());
    }

    #[test]
    fn flood_detected() {
        let mut rl = RateLimiter::new(10, 10, 3);
        let t0 = Instant::now();
        let mut now = t0;
        for _ in 0..3 {
            assert!(rl.connect_attempt(1, now).is_ok());
            now += Duration::from_millis(50);
        }
        assert_eq!(rl.connect_attempt(1, now), Err(GuardLimit::Flood));
        // After the window passes, allowed again.
        let later = t0 + Duration::from_secs(2);
        assert!(rl.connect_attempt(1, later).is_ok());
    }
}
