use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sandbox::{RemoteExecResult, SandboxControl, SandboxControlError};

use super::client::send_exec;
use super::protocol::{ExecRequest, ExecResponse};
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

        let timeout_secs = u32::try_from(timeout.as_secs()).unwrap_or(u32::MAX);
        let request = ExecRequest {
            command: command.to_owned(),
            timeout_secs,
            sudo,
        };

        // Add 5 seconds buffer for connection overhead beyond the command timeout.
        let connect_timeout = timeout + Duration::from_secs(5);
        let response = send_exec(&sock_path, &request, connect_timeout)
            .await
            .map_err(|e| {
                SandboxControlError::Connection(format!("failed to connect to sandbox: {e}"))
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

    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf {
        RuntimePaths::new().sock_dir(sandbox_id)
    }
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

    #[test]
    fn runtime_dir_returns_sock_dir() {
        let control = FirecrackerControl;
        let dir = control.runtime_dir("test-id");
        assert!(dir.ends_with("test-id"));
    }
}
