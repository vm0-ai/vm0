use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

use sandbox::{RemoteExecResult, SandboxControl, SandboxControlError};

use crate::control::{ExecRequest, ExecResponse, send_exec};
use crate::paths::{RuntimePaths, SockPaths};

/// Firecracker-backed sandbox control.
///
/// Stateless — can be created with zero cost and used immediately.
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
                })
            }
            ExecResponse::Error { error } => Err(SandboxControlError::Remote(error)),
        }
    }

    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf {
        RuntimePaths::new().sock_dir(sandbox_id)
    }
}

/// Find the control socket for a given run ID (full UUID or prefix).
///
/// Scans the runtime socket directory for directories matching the prefix
/// that contain a `control.sock` file.
fn resolve_control_socket(input: &str) -> Result<PathBuf, SandboxControlError> {
    let runtime = RuntimePaths::new();
    let sock_parent = runtime.sock_base();

    let entries = std::fs::read_dir(&sock_parent).map_err(|e| {
        SandboxControlError::Connection(format!(
            "cannot read {}: {e} (is a sandbox running?)",
            sock_parent.display()
        ))
    })?;

    let mut matches: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(input) {
            continue;
        }
        let control_sock = SockPaths::new(entry.path()).control_sock();
        if control_sock.exists() {
            matches.push((name_str.to_owned(), control_sock));
        }
    }

    match matches.as_slice() {
        [] => Err(SandboxControlError::NotFound(format!(
            "no running sandbox matches '{input}' (no control.sock found)"
        ))),
        [single] => Ok(single.1.clone()),
        _ => {
            let ids: Vec<&str> = matches.iter().map(|(id, _)| id.as_str()).collect();
            Err(SandboxControlError::Ambiguous(format!(
                "prefix '{input}' matches: {}",
                ids.join(", ")
            )))
        }
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
