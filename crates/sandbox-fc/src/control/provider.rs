use std::io;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sandbox::{RemoteExecResult, RemoteKillResult, SandboxControl, SandboxControlError};

use super::CONTROL_SOCKET_OVERHEAD_MS;
use super::client::{send_exec, send_terminate};
use super::protocol::{
    ExecRequest, ExecResponse, TerminateAction, TerminateRequest, TerminateResponse,
    TerminateStatus,
};
use super::resolver::resolve_control_socket;
use crate::paths::RuntimePaths;

/// Firecracker-backed sandbox control.
///
/// Stateless - can be created with zero cost and used immediately.
pub struct FirecrackerControl;

#[async_trait]
impl SandboxControl for FirecrackerControl {
    async fn exec_remote(
        &self,
        sandbox_id: &str,
        command: &str,
        timeout: Duration,
        sudo: bool,
    ) -> Result<RemoteExecResult, SandboxControlError> {
        if sandbox_id.is_empty() {
            return Err(SandboxControlError::NotFound(
                "sandbox id must not be empty".into(),
            ));
        }

        let sock_path = resolve_control_socket(sandbox_id)?;

        let timeout_secs = request_timeout_secs(timeout);
        let request = ExecRequest {
            command: command.to_owned(),
            timeout_secs,
            sudo,
        };

        // Add 5 seconds for control socket overhead beyond the command timeout.
        let response = send_exec(&sock_path, &request, control_timeout(timeout_secs))
            .await
            .map_err(|e| {
                if e.kind() == io::ErrorKind::InvalidInput {
                    SandboxControlError::Io(e)
                } else {
                    SandboxControlError::Connection(format!("failed to connect to sandbox: {e}"))
                }
            })?;

        match response {
            ExecResponse::Success {
                exit_code,
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
            } => {
                let stdout_bytes = BASE64
                    .decode(&stdout)
                    .map_err(|e| SandboxControlError::Connection(format!("decode stdout: {e}")))?;
                let stderr_bytes = BASE64
                    .decode(&stderr)
                    .map_err(|e| SandboxControlError::Connection(format!("decode stderr: {e}")))?;
                Ok(RemoteExecResult {
                    exit_code,
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                    stdout_truncated,
                    stderr_truncated,
                })
            }
            ExecResponse::Error { error } => Err(SandboxControlError::Remote(error)),
        }
    }

    async fn kill_remote(&self, sandbox_id: &str) -> Result<RemoteKillResult, SandboxControlError> {
        if sandbox_id.is_empty() {
            return Err(SandboxControlError::NotFound(
                "sandbox id must not be empty".into(),
            ));
        }

        let sock_path = resolve_control_socket(sandbox_id)?;
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
        };

        let response = send_terminate(&sock_path, &request, Duration::from_secs(5))
            .await
            .map_err(|e| {
                if e.kind() == io::ErrorKind::InvalidInput {
                    SandboxControlError::Io(e)
                } else {
                    SandboxControlError::Connection(format!("failed to connect to sandbox: {e}"))
                }
            })?;

        match response {
            TerminateResponse::Status {
                status: TerminateStatus::Accepted,
            } => Ok(RemoteKillResult::Accepted),
            TerminateResponse::Status {
                status: TerminateStatus::AlreadyStopped,
            } => Ok(RemoteKillResult::AlreadyStopped),
            TerminateResponse::Status {
                status: TerminateStatus::RefusedIdle,
            } => Ok(RemoteKillResult::RefusedIdle),
            TerminateResponse::Error { error } => Err(SandboxControlError::Remote(error)),
        }
    }

    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf {
        RuntimePaths::new().sock_dir(sandbox_id)
    }
}

fn request_timeout_secs(timeout: Duration) -> u32 {
    u32::try_from(timeout.as_secs()).unwrap_or(u32::MAX)
}

fn control_timeout(timeout_secs: u32) -> Duration {
    // Match control server's timeout_secs -> saturated timeout_ms conversion.
    let timeout_ms = timeout_secs.saturating_mul(1000);
    Duration::from_millis(u64::from(timeout_ms) + CONTROL_SOCKET_OVERHEAD_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exec_remote_empty_id() {
        let control = FirecrackerControl;
        let result = control
            .exec_remote("", "echo hi", Duration::from_secs(5), false)
            .await;
        let Err(e) = result else {
            panic!("expected error");
        };
        assert!(e.to_string().contains("must not be empty"));
    }

    #[tokio::test]
    async fn kill_remote_empty_id() {
        let control = FirecrackerControl;
        let result = control.kill_remote("").await;
        let Err(e) = result else {
            panic!("expected error");
        };
        assert!(e.to_string().contains("must not be empty"));
    }

    #[test]
    fn runtime_dir_returns_sock_dir() {
        let control = FirecrackerControl;
        let dir = control.runtime_dir("test-id");
        assert!(dir.ends_with("test-id"));
    }

    #[test]
    fn normal_timeout_uses_server_wait_budget() {
        let timeout_secs = request_timeout_secs(Duration::from_secs(5));

        assert_eq!(timeout_secs, 5);
        assert_eq!(control_timeout(timeout_secs), Duration::from_secs(10));
    }

    #[test]
    fn oversized_timeout_clamps_to_server_wait_budget() {
        let timeout_secs = request_timeout_secs(Duration::MAX);

        assert_eq!(timeout_secs, u32::MAX);
        assert_eq!(
            control_timeout(timeout_secs),
            Duration::from_millis(u64::from(u32::MAX) + CONTROL_SOCKET_OVERHEAD_MS)
        );
    }
}
