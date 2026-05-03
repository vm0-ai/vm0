//! Error types for the sandbox-fc network namespace pool.
//!
//! These errors cover host command execution, namespace pool acquisition,
//! prerequisite checks, default-route probing, lock-file access, and lease
//! validation for the Firecracker networking backend.

use crate::command::CommandError;

/// Network subsystem result alias using [`NetworkError`].
pub type Result<T> = std::result::Result<T, NetworkError>;

/// Errors produced while preparing, acquiring, recycling, or cleaning up
/// network namespaces for Firecracker sandboxes.
#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    /// A host command used by the network subsystem failed.
    #[error(transparent)]
    Command(#[from] CommandError),

    /// All pool-index lock slots are currently held by other processes.
    #[error("no pool index available (all slots are locked by other processes)")]
    NoPoolIndexAvailable,

    /// The namespace pool has reserved every namespace index it is allowed to own.
    #[error("namespace limit reached: max {max} namespaces allowed")]
    NamespaceLimitReached { max: u32 },

    /// An acquire or release operation was requested after the pool became inactive.
    #[error("pool is not active")]
    PoolNotActive,

    /// The default outbound network interface could not be detected from route output.
    #[error("failed to detect default network interface from: {0}")]
    NoDefaultInterface(String),

    /// A lock file needed for namespace pool coordination could not be opened.
    #[error("failed to open lock file: {0}")]
    LockOpen(String),

    /// A required host or network prerequisite failed while preparing namespaces.
    #[error("prerequisite check failed: {0}")]
    Prerequisite(String),

    /// A namespace lease failed validation against the pool's current ownership state.
    #[error("invalid namespace lease: {0}")]
    InvalidLease(String),
}
