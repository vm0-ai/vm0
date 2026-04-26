//! Error and result types for sandbox runtime, factory, and sandbox operations.
//!
//! The variants group failures by the public API phase where they are reported.
//! Backend implementations may include additional detail in the variant payload.

/// Error type returned by the sandbox crate's public APIs.
///
/// These variants describe the current runtime, factory, lifecycle, and
/// operation boundaries exposed by the crate. They intentionally avoid
/// backend-specific details so implementations can share the same public error
/// surface.
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    /// Required backend prerequisites are unavailable.
    ///
    /// This is used when the host environment cannot support the selected
    /// backend before runtime, factory, or sandbox creation can proceed.
    #[error("backend not available: {0}")]
    BackendNotAvailable(String),

    /// Runtime, factory, or sandbox creation failed.
    ///
    /// This covers resource initialization and allocation failures before a
    /// created sandbox is started.
    #[error("sandbox creation failed: {0}")]
    CreationFailed(String),

    /// A created sandbox failed to start.
    ///
    /// This covers failures while booting the backing environment and making the
    /// sandbox ready to serve operations.
    #[error("sandbox start failed: {0}")]
    StartFailed(String),

    /// A running sandbox operation failed.
    ///
    /// Despite the variant name, this covers the current operation surface,
    /// including exec, file writes, process spawning, and wait/exit handling.
    #[error("execution failed: {0}")]
    ExecFailed(String),

    /// Parking or unparking an idle sandbox failed.
    #[error("idle transition failed: {0}")]
    IdleTransition(String),

    /// Runtime, factory, or sandbox configuration was rejected.
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),

    /// An underlying host I/O operation failed.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Convenient result alias for sandbox crate public APIs.
pub type Result<T> = std::result::Result<T, SandboxError>;
