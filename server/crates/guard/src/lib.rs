//! guard: destination policy + per-IP limits + flood detection.
//!
//! This crate exists because of the July 2026 Lucide Proxy campaign
//! (JFrog): 148 npm packages turned browsers into a botnet that spammed
//! valid Wisp CONNECT/CLOSE frames to exhaust file descriptors and crash
//! naive servers. Every Wisp server MUST harden against this.

pub mod destination;
pub mod rate_limit;

pub use destination::DestinationPolicy;
pub use rate_limit::RateLimiter;
