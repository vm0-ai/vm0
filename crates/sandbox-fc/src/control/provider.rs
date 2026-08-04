use std::io;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    RemoteExecResult, RemoteKillResult, SandboxControl, SandboxControlError, SandboxControlTarget,
};

use super::CONTROL_SOCKET_OVERHEAD_MS;
use super::client::{send_exec, send_terminate};
use super::exec_response::ExecResult;
use super::protocol::{
    ExecRequest, TerminateAction, TerminateRequest, TerminateResponse, TerminateStatus,
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
        target: SandboxControlTarget,
        command: &str,
        timeout: Duration,
        sudo: bool,
    ) -> Result<RemoteExecResult, SandboxControlError> {
        let sandbox_id = target.sandbox_id();
        if sandbox_id.is_empty() {
            return Err(SandboxControlError::NotFound(
                "sandbox id must not be empty".into(),
            ));
        }

        let sock_path = resolve_control_socket(sandbox_id)?;

        let timeout_secs = request_timeout_secs(timeout);
        let request = ExecRequest {
            expected_run_id: target.expected_run_id().map(str::to_owned),
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

        remote_exec_result_from_result(response)
    }

    async fn kill_remote(
        &self,
        target: SandboxControlTarget,
    ) -> Result<RemoteKillResult, SandboxControlError> {
        let sandbox_id = target.sandbox_id();
        if sandbox_id.is_empty() {
            return Err(SandboxControlError::NotFound(
                "sandbox id must not be empty".into(),
            ));
        }

        let sock_path = resolve_control_socket(sandbox_id)?;
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
            expected_run_id: target.expected_run_id().map(str::to_owned),
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

fn remote_exec_result_from_result(
    result: ExecResult,
) -> Result<RemoteExecResult, SandboxControlError> {
    match result {
        ExecResult::Success {
            termination,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            diagnostic,
        } => Ok(RemoteExecResult {
            termination,
            stdout,
            stderr,
            diagnostic,
            stdout_truncated,
            stderr_truncated,
        }),
        ExecResult::Error { error } => Err(SandboxControlError::Remote(error)),
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
    use sandbox::ExecTermination;

    use super::*;

    #[test]
    fn remote_exec_result_maps_structured_result() {
        let result = remote_exec_result_from_result(ExecResult::Success {
            termination: ExecTermination::Exited { exit_code: 7 },
            stdout: b"out".to_vec(),
            stderr: b"err".to_vec(),
            stdout_truncated: true,
            stderr_truncated: false,
            diagnostic: "diagnostic".into(),
        })
        .unwrap();

        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        assert!(result.stdout_truncated);
        assert!(!result.stderr_truncated);
        assert_eq!(result.diagnostic, "diagnostic");
    }

    #[test]
    fn remote_exec_result_error_maps_to_remote_error() {
        let result = remote_exec_result_from_result(ExecResult::Error {
            error: "sandbox not running".into(),
        });

        let Err(SandboxControlError::Remote(message)) = result else {
            panic!("expected remote error");
        };
        assert_eq!(message, "sandbox not running");
    }

    #[tokio::test]
    async fn exec_remote_empty_id() {
        let control = FirecrackerControl;
        let result = control
            .exec_remote(
                SandboxControlTarget::sandbox(""),
                "echo hi",
                Duration::from_secs(5),
                false,
            )
            .await;
        let Err(e) = result else {
            panic!("expected error");
        };
        assert!(e.to_string().contains("must not be empty"));
    }

    #[tokio::test]
    async fn kill_remote_empty_id() {
        let control = FirecrackerControl;
        let result = control.kill_remote(SandboxControlTarget::sandbox("")).await;
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
