use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

/// Terminal state for a remote `runner exec` command.
#[derive(Debug, Clone, Eq, PartialEq)]
pub enum RemoteExecTermination {
    /// The guest process exited and produced an exit code.
    Exited { exit_code: i32 },
    /// The guest process exceeded its requested timeout.
    TimedOut,
    /// The command was cancelled before completion.
    Cancelled,
    /// The guest failed to start the command.
    StartFailed,
    /// The guest failed while waiting for command completion.
    WaitFailed,
}

impl RemoteExecTermination {
    /// Return the process exit code when this status represents a normal exit.
    pub fn exit_code(&self) -> Option<i32> {
        match self {
            Self::Exited { exit_code } => Some(*exit_code),
            Self::TimedOut | Self::Cancelled | Self::StartFailed | Self::WaitFailed => None,
        }
    }
}

/// Final status of a command executed inside a running sandbox.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RemoteExecStatus {
    pub termination: RemoteExecTermination,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub diagnostic: Option<String>,
}

impl RemoteExecStatus {
    /// Convenience constructor for the common successful process-exit case.
    pub fn exited(exit_code: i32) -> Self {
        Self {
            termination: RemoteExecTermination::Exited { exit_code },
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: None,
        }
    }
}

/// Streaming output receiver for [`SandboxControl::exec_remote`].
pub trait RemoteExecOutputSink: Send {
    fn stdout(&mut self, chunk: &[u8]) -> std::io::Result<()>;
    fn stderr(&mut self, chunk: &[u8]) -> std::io::Result<()>;
}

/// Errors from sandbox control operations.
#[derive(Debug, thiserror::Error)]
pub enum SandboxControlError {
    #[error("sandbox not found: {0}")]
    NotFound(String),
    #[error("ambiguous sandbox id: {0}")]
    Ambiguous(String),
    #[error("remote error: {0}")]
    Remote(String),
    #[error("connection failed: {0}")]
    Connection(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Remote control interface for running sandboxes.
///
/// Provides exec and path-resolution capabilities without exposing
/// backend-specific types (sockets, paths, wire protocol).
#[async_trait]
pub trait SandboxControl: Send + Sync {
    /// Execute a command inside a running sandbox identified by sandbox ID
    /// (full UUID or unique prefix), streaming stdout/stderr to `output`.
    ///
    /// `timeout` is the command timeout; the implementation may add extra
    /// time for connection overhead. The returned status contains only the
    /// final command state; stdout/stderr are delivered through `output` as
    /// chunks arrive.
    async fn exec_remote(
        &self,
        sandbox_id: &str,
        command: &str,
        timeout: Duration,
        sudo: bool,
        output: &mut dyn RemoteExecOutputSink,
    ) -> Result<RemoteExecStatus, SandboxControlError>;

    /// Return the runtime socket directory for a given sandbox ID.
    ///
    /// Used for orphan cleanup — the caller removes this directory after
    /// killing an orphaned sandbox process.
    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf;
}
