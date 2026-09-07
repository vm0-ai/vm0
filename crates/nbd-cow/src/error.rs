//! Error and result types for `nbd-cow`.
//!
//! [`NbdCowError`] wraps protocol, I/O, netlink, device allocation, and bounds
//! errors surfaced by the public APIs.

pub use crate::protocol_impl::ProtocolError;

/// Error type returned by `nbd-cow` operations.
#[derive(Debug, thiserror::Error)]
pub enum NbdCowError {
    /// An error while decoding or validating an NBD transmission-protocol
    /// request. The contained [`ProtocolError`] identifies the protocol
    /// violation.
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),

    /// An operating-system I/O failure encountered while using the device,
    /// COW files, sockets, or related resources. The contained
    /// [`std::io::Error`] preserves the underlying error kind and details.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// A requested byte range extends beyond the configured device size.
    ///
    /// The operation starts at `offset`, spans `length` bytes, and is checked
    /// against `device_size`.
    #[error("offset {offset} + length {length} exceeds device size {device_size}")]
    OutOfBounds {
        /// Byte offset at which the requested operation begins.
        offset: u64,
        /// Number of bytes in the requested operation.
        length: u64,
        /// Total device size, in bytes, used for the bounds check.
        device_size: u64,
    },

    /// Malformed or otherwise unusable generic-netlink data encountered while
    /// communicating with the kernel. The string contains a diagnostic for
    /// the userspace parsing or validation failure; unlike
    /// [`Self::NetlinkErrno`], this variant is not a kernel-reported errno.
    #[error("netlink error: {0}")]
    Netlink(String),

    /// A generic-netlink request received a kernel-reported operating-system
    /// errno. The errno and its human-readable message are available for
    /// callers that need to classify a specific kernel response, such as
    /// `EBUSY` from [`crate::netlink::connect_device`].
    #[error("netlink errno {errno}: {message}")]
    NetlinkErrno {
        /// Positive operating-system errno returned by the kernel.
        errno: i32,
        /// Human-readable operating-system error description for `errno`.
        message: String,
    },

    /// No NBD device could be acquired for the operation.
    ///
    /// This can represent an exhausted or unavailable device-pool scan, an
    /// inactive pool, or exhausted retries after devices reported `EBUSY`.
    /// It is a broad availability error and does not by itself guarantee that
    /// retrying is appropriate.
    #[error("no free NBD device found")]
    NoFreeDevice,
}

/// Convenience result type for fallible `nbd-cow` APIs using [`NbdCowError`].
pub type Result<T> = std::result::Result<T, NbdCowError>;
