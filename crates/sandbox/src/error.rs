//! Error and result types for sandbox runtime, factory, and sandbox operations.
//!
//! [`SandboxError`] is the public error boundary for the sandbox crate. The
//! variants keep backend-specific details in human-readable messages while
//! exposing structured categories for initialization phases, lifecycle state
//! errors, running operations, and idle transitions.

use std::fmt;

/// Error type returned by the sandbox crate's public APIs.
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    /// Required backend prerequisites are unavailable.
    #[error("backend unavailable: {message}")]
    BackendUnavailable { message: String },

    /// Runtime, factory, or sandbox configuration was rejected.
    #[error("invalid configuration: {message}")]
    Configuration { message: String },

    /// Runtime, factory, or sandbox allocation initialization failed.
    #[error("sandbox {phase} initialization failed: {message}")]
    Initialization {
        phase: SandboxInitializationPhase,
        message: String,
    },

    /// A created sandbox failed while booting or becoming ready.
    #[error("sandbox start failed: {message}")]
    Start { message: String },

    /// The requested action is invalid for the current runtime, factory, or
    /// sandbox state.
    #[error("invalid state for {context} (state: {state}): {message}")]
    InvalidState {
        context: SandboxInvalidStateContext,
        state: String,
        message: String,
    },

    /// A running sandbox operation failed after state validation.
    #[error("sandbox {operation} failed ({reason}): {message}")]
    Operation {
        operation: SandboxOperation,
        reason: SandboxOperationReason,
        message: String,
    },

    /// Parking or unparking an idle sandbox failed.
    #[error("sandbox {transition} failed: {message}")]
    IdleTransition {
        transition: SandboxIdleTransition,
        message: String,
    },

    /// An underlying host I/O operation failed.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Initialization phase that produced a [`SandboxError::Initialization`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxInitializationPhase {
    /// Runtime-wide shared resource initialization.
    Runtime,
    /// Factory-level initialization.
    Factory,
    /// Per-sandbox allocation before sandbox start.
    SandboxAllocation,
}

impl fmt::Display for SandboxInitializationPhase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime => f.write_str("runtime"),
            Self::Factory => f.write_str("factory"),
            Self::SandboxAllocation => f.write_str("sandbox allocation"),
        }
    }
}

/// Public sandbox operation associated with an operation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxOperation {
    /// [`Sandbox::exec`](crate::Sandbox::exec).
    Exec,
    /// [`Sandbox::bounded_exec`](crate::Sandbox::bounded_exec).
    BoundedExec,
    /// [`Sandbox::write_file`](crate::Sandbox::write_file).
    WriteFile,
    /// [`Sandbox::spawn_watch`](crate::Sandbox::spawn_watch).
    SpawnWatch,
    /// [`Sandbox::wait_exit`](crate::Sandbox::wait_exit).
    WaitExit,
}

impl fmt::Display for SandboxOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exec => f.write_str("exec"),
            Self::BoundedExec => f.write_str("bounded exec"),
            Self::WriteFile => f.write_str("write file"),
            Self::SpawnWatch => f.write_str("spawn watch"),
            Self::WaitExit => f.write_str("wait exit"),
        }
    }
}

/// Root-cause category for a running sandbox operation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxOperationReason {
    /// The guest-side operation or IPC call returned an error.
    Guest,
    /// The backend process crashed while the operation was in flight.
    BackendCrashed,
    /// The operation timed out.
    Timeout,
    /// The operation failed for another reason.
    Other,
}

impl fmt::Display for SandboxOperationReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Guest => f.write_str("guest"),
            Self::BackendCrashed => f.write_str("backend crashed"),
            Self::Timeout => f.write_str("timeout"),
            Self::Other => f.write_str("other"),
        }
    }
}

/// Idle transition associated with an idle-transition failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxIdleTransition {
    /// Parking an active sandbox for idle reuse.
    Park,
    /// Unparking an idle sandbox before reuse.
    Unpark,
}

impl fmt::Display for SandboxIdleTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Park => f.write_str("park"),
            Self::Unpark => f.write_str("unpark"),
        }
    }
}

/// API context where an invalid state was observed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxInvalidStateContext {
    /// Runtime-level state.
    Runtime,
    /// Factory-level state.
    Factory,
    /// Sandbox lifecycle state.
    Sandbox,
    /// State required for a specific running sandbox operation.
    Operation(SandboxOperation),
}

impl fmt::Display for SandboxInvalidStateContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime => f.write_str("runtime"),
            Self::Factory => f.write_str("factory"),
            Self::Sandbox => f.write_str("sandbox"),
            Self::Operation(operation) => write!(f, "{operation} operation"),
        }
    }
}

/// Convenient result alias for sandbox crate public APIs.
pub type Result<T> = std::result::Result<T, SandboxError>;
