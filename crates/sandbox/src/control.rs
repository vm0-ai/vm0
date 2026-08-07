use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

use crate::types::ExecTermination;

/// Identity scope for a remote sandbox control operation.
///
/// Sandbox-scoped targets intentionally follow the current owner of a sandbox.
/// Run-scoped targets additionally require the sandbox to still be assigned to
/// the full run ID resolved by the caller.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxControlTarget {
    /// Control whichever active workload currently owns this sandbox.
    Sandbox {
        /// Sandbox identifier (full UUID or unique prefix).
        sandbox_id: String,
    },
    /// Control this sandbox only while it remains assigned to the expected run.
    Run {
        /// Full run identifier resolved before dispatch.
        run_id: String,
        /// Sandbox identifier (full UUID or unique prefix).
        sandbox_id: String,
    },
}

impl SandboxControlTarget {
    /// Construct an explicitly sandbox-scoped target.
    pub fn sandbox(sandbox_id: impl Into<String>) -> Self {
        Self::Sandbox {
            sandbox_id: sandbox_id.into(),
        }
    }

    /// Construct a run-scoped target with its full resolved run identity.
    pub fn run(run_id: impl Into<String>, sandbox_id: impl Into<String>) -> Self {
        Self::Run {
            run_id: run_id.into(),
            sandbox_id: sandbox_id.into(),
        }
    }

    /// Return the sandbox identifier used for backend endpoint resolution.
    pub fn sandbox_id(&self) -> &str {
        match self {
            Self::Sandbox { sandbox_id } | Self::Run { sandbox_id, .. } => sandbox_id,
        }
    }

    /// Return the expected full run identity for guarded targets.
    pub fn expected_run_id(&self) -> Option<&str> {
        match self {
            Self::Sandbox { .. } => None,
            Self::Run { run_id, .. } => Some(run_id),
        }
    }
}

/// Result of executing a command inside a running sandbox.
#[derive(Debug)]
pub struct RemoteExecResult {
    /// Structured terminal state reported by the provider.
    pub termination: ExecTermination,
    /// Raw stdout bytes.
    pub stdout: Vec<u8>,
    /// Raw stderr bytes.
    pub stderr: Vec<u8>,
    /// Provider diagnostic text associated with the terminal state.
    pub diagnostic: String,
    /// True when stdout exceeded the remote capture budget.
    pub stdout_truncated: bool,
    /// True when stderr exceeded the remote capture budget.
    pub stderr_truncated: bool,
}

/// Result of requesting host-side sandbox termination.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteKillResult {
    /// The owning sandbox runtime accepted the termination request.
    Accepted,
    /// The owning sandbox runtime is already stopping or stopped.
    AlreadyStopped,
    /// The owning sandbox is parked in idle ownership, so direct process
    /// termination would leave idle-pool resources retained.
    RefusedIdle,
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
/// Provides exec, host-side termination, and path-resolution capabilities
/// without exposing backend-specific types (sockets, paths, wire protocol).
#[async_trait]
pub trait SandboxControl: Send + Sync {
    /// Execute a command inside a running sandbox using the requested identity
    /// scope.
    ///
    /// `timeout` is the requested command timeout. Implementations may
    /// normalize it to backend-specific granularity and limits, and may add
    /// extra time for control or connection overhead. Consult the concrete
    /// backend's documentation for its normalization rules.
    async fn exec_remote(
        &self,
        target: SandboxControlTarget,
        command: &str,
        timeout: Duration,
        sudo: bool,
    ) -> Result<RemoteExecResult, SandboxControlError>;

    /// Request host-side termination using the requested identity scope.
    async fn kill_remote(
        &self,
        target: SandboxControlTarget,
    ) -> Result<RemoteKillResult, SandboxControlError>;

    /// Return the runtime socket directory for a given sandbox ID.
    ///
    /// Used for orphan cleanup — the caller removes this directory after
    /// killing an orphaned sandbox process.
    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf;
}
