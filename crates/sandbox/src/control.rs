use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

/// Result of executing a command inside a running sandbox.
#[derive(Debug)]
pub struct RemoteExecResult {
    /// Process exit code.
    pub exit_code: i32,
    /// Raw stdout bytes.
    pub stdout: Vec<u8>,
    /// Raw stderr bytes.
    pub stderr: Vec<u8>,
    /// True when stdout exceeded the remote capture budget.
    pub stdout_truncated: bool,
    /// True when stderr exceeded the remote capture budget.
    pub stderr_truncated: bool,
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
    /// (full UUID or unique prefix).
    ///
    /// `timeout` is the command timeout; the implementation may add extra
    /// time for connection overhead.
    async fn exec_remote(
        &self,
        sandbox_id: &str,
        command: &str,
        timeout: Duration,
        sudo: bool,
    ) -> Result<RemoteExecResult, SandboxControlError>;

    /// Return the runtime socket directory for a given sandbox ID.
    ///
    /// Used for orphan cleanup — the caller removes this directory after
    /// killing an orphaned sandbox process.
    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf;
}
