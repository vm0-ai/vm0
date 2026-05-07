//! Error and result types for `nbd-cow`.
//!
//! [`NbdCowError`] wraps protocol, I/O, netlink, device allocation, and bounds
//! errors surfaced by the public APIs.

use crate::protocol::ProtocolError;

/// Error type returned by `nbd-cow` operations.
#[derive(Debug, thiserror::Error)]
pub enum NbdCowError {
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("offset {offset} + length {length} exceeds device size {device_size}")]
    OutOfBounds {
        offset: u64,
        length: u64,
        device_size: u64,
    },

    #[error("netlink error: {0}")]
    Netlink(String),

    #[error("netlink errno {errno}: {message}")]
    NetlinkErrno { errno: i32, message: String },

    #[error("no free NBD device found")]
    NoFreeDevice,
}

/// Convenience result type for fallible `nbd-cow` APIs using [`NbdCowError`].
pub type Result<T> = std::result::Result<T, NbdCowError>;
