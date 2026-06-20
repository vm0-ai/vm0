use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Serialize};

/// Terminal state for a sandbox exec command.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SandboxExecTermination {
    /// The process exited with an ordinary exit code.
    Exited {
        /// Signed process exit code reported by the sandbox provider.
        exit_code: i32,
    },
    /// The provider timed the process out.
    TimedOut,
    /// The provider cancelled the process.
    Cancelled,
    /// The provider failed to start the process.
    StartFailed,
    /// The provider failed while waiting for the process.
    WaitFailed,
}

impl<'de> Deserialize<'de> for SandboxExecTermination {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Internally tagged unit variants ignore unknown fields by default, so
        // parse the map manually to keep terminal states mutually exclusive.
        const FIELDS: &[&str] = &["kind", "exit_code"];

        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum TerminationKind {
            Exited,
            TimedOut,
            Cancelled,
            StartFailed,
            WaitFailed,
        }

        enum Field {
            Kind,
            ExitCode,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct FieldVisitor;

                impl Visitor<'_> for FieldVisitor {
                    type Value = Field;

                    fn expecting(
                        &self,
                        formatter: &mut std::fmt::Formatter<'_>,
                    ) -> std::fmt::Result {
                        formatter.write_str("a sandbox exec termination field")
                    }

                    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
                    where
                        E: de::Error,
                    {
                        match value {
                            "kind" => Ok(Field::Kind),
                            "exit_code" => Ok(Field::ExitCode),
                            _ => Err(de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }

                deserializer.deserialize_identifier(FieldVisitor)
            }
        }

        struct TerminationVisitor;

        impl<'de> Visitor<'de> for TerminationVisitor {
            type Value = SandboxExecTermination;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a sandbox exec termination object")
            }

            fn visit_map<M>(self, mut map: M) -> std::result::Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut kind = None;
                let mut exit_code = None;

                while let Some(field) = map.next_key()? {
                    match field {
                        Field::Kind => {
                            if kind.is_some() {
                                return Err(de::Error::duplicate_field("kind"));
                            }
                            kind = Some(map.next_value()?);
                        }
                        Field::ExitCode => {
                            if exit_code.is_some() {
                                return Err(de::Error::duplicate_field("exit_code"));
                            }
                            exit_code = Some(map.next_value::<Option<i32>>()?);
                        }
                    }
                }

                let kind = kind.ok_or_else(|| de::Error::missing_field("kind"))?;
                match kind {
                    TerminationKind::Exited => match exit_code {
                        Some(Some(exit_code)) => Ok(SandboxExecTermination::Exited { exit_code }),
                        Some(None) | None => Err(de::Error::missing_field("exit_code")),
                    },
                    TerminationKind::TimedOut => {
                        non_exited_termination(exit_code, SandboxExecTermination::TimedOut)
                    }
                    TerminationKind::Cancelled => {
                        non_exited_termination(exit_code, SandboxExecTermination::Cancelled)
                    }
                    TerminationKind::StartFailed => {
                        non_exited_termination(exit_code, SandboxExecTermination::StartFailed)
                    }
                    TerminationKind::WaitFailed => {
                        non_exited_termination(exit_code, SandboxExecTermination::WaitFailed)
                    }
                }
            }
        }

        deserializer.deserialize_map(TerminationVisitor)
    }
}

fn non_exited_termination<E>(
    exit_code: Option<Option<i32>>,
    termination: SandboxExecTermination,
) -> std::result::Result<SandboxExecTermination, E>
where
    E: de::Error,
{
    if exit_code.is_some() {
        return Err(E::custom("exit_code is only valid for exited termination"));
    }

    Ok(termination)
}

/// Result of executing a command inside a running sandbox.
#[derive(Debug)]
pub struct RemoteExecResult {
    /// Structured terminal state reported by the provider.
    pub termination: SandboxExecTermination,
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

    /// Request host-side termination of a running sandbox identified by
    /// sandbox ID (full UUID or unique prefix).
    async fn kill_remote(&self, sandbox_id: &str) -> Result<RemoteKillResult, SandboxControlError>;

    /// Return the runtime socket directory for a given sandbox ID.
    ///
    /// Used for orphan cleanup — the caller removes this directory after
    /// killing an orphaned sandbox process.
    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf;
}
