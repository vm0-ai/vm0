//! Control socket protocol for `runner exec`.
//!
//! Provides a Unix domain socket server that runs alongside each sandbox,
//! allowing external processes to execute commands inside the VM via IPC.
//!
//! ## Wire format
//!
//! Length-prefixed JSON frames: `[4-byte big-endian length][JSON payload]`.
//! One request per connection, one response per connection.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sandbox::{RemoteExecResult, SandboxControl, SandboxControlError};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;
use tracing::{info, warn};
use vsock_host::VsockHost;

use crate::paths::{RuntimePaths, SockPaths};

// -----------------------------------------------------------------------
// Protocol types
// -----------------------------------------------------------------------

/// Request from `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecRequest {
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    #[serde(default)]
    pub sudo: bool,
}

fn default_timeout() -> u32 {
    30
}

/// Response to `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExecResponse {
    Success {
        exit_code: i32,
        stdout: String,
        stderr: String,
    },
    Error {
        error: String,
    },
}

// -----------------------------------------------------------------------
// Framing
// -----------------------------------------------------------------------

/// Maximum frame size: 64 MiB (generous for large stdout/stderr).
const MAX_FRAME_SIZE: u32 = 64 * 1024 * 1024;

/// Read a length-prefixed frame from the stream.
async fn read_frame(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
    let len = stream.read_u32().await?;
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len} bytes"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Write a length-prefixed frame to the stream.
async fn write_frame(stream: &mut UnixStream, data: &[u8]) -> io::Result<()> {
    let len = u32::try_from(data.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("payload too large: {} bytes", data.len()),
        )
    })?;
    stream.write_u32(len).await?;
    stream.write_all(data).await?;
    stream.flush().await?;
    Ok(())
}

// -----------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------

/// Spawn the control socket server for a running sandbox.
///
/// The server accepts connections on `sock_path`, reads an [`ExecRequest`],
/// executes it via the shared `VsockHost`, and writes back an [`ExecResponse`].
///
/// Returns a `JoinHandle` that the caller should abort on shutdown.
pub fn spawn_server(
    sock_path: PathBuf,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let listener = match UnixListener::bind(&sock_path) {
            Ok(l) => l,
            Err(e) => {
                warn!(path = %sock_path.display(), error = %e, "failed to bind control socket");
                return;
            }
        };

        info!(path = %sock_path.display(), "control socket listening");

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    warn!(error = %e, "control socket accept error");
                    continue;
                }
            };

            let guest = Arc::clone(&guest);
            tokio::spawn(async move {
                if let Err(e) = handle_connection(stream, guest).await {
                    warn!(error = %e, "control connection handler error");
                }
            });
        }
    })
}

/// Handle a single control socket connection.
async fn handle_connection(
    mut stream: UnixStream,
    guest: Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
) -> io::Result<()> {
    let frame = read_frame(&mut stream).await?;

    let response = match serde_json::from_slice::<ExecRequest>(&frame) {
        Ok(request) => execute(request, &guest).await,
        Err(e) => ExecResponse::Error {
            error: format!("invalid request: {e}"),
        },
    };

    let response_json = serde_json::to_vec(&response)
        .map_err(|e| io::Error::other(format!("serialize response: {e}")))?;
    write_frame(&mut stream, &response_json).await?;

    Ok(())
}

/// Execute an [`ExecRequest`] against the sandbox's VsockHost.
async fn execute(
    request: ExecRequest,
    guest: &Arc<tokio::sync::Mutex<Option<Arc<VsockHost>>>>,
) -> ExecResponse {
    let vsock = {
        let lock = guest.lock().await;
        match lock.as_ref() {
            Some(v) => Arc::clone(v),
            None => {
                return ExecResponse::Error {
                    error: "sandbox not running".into(),
                };
            }
        }
    };

    let timeout_ms = request.timeout_secs.saturating_mul(1000);
    let env: &[(&str, &str)] = &[];

    match vsock
        .exec(&request.command, timeout_ms, env, request.sudo)
        .await
    {
        Ok(result) => ExecResponse::Success {
            exit_code: result.exit_code,
            stdout: BASE64.encode(&result.stdout),
            stderr: BASE64.encode(&result.stderr),
        },
        Err(e) => ExecResponse::Error {
            error: format!("exec failed: {e}"),
        },
    }
}

// -----------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------

/// Send an exec request to a control socket and return the response.
///
/// Used by `runner exec` to communicate with a running sandbox.
pub async fn send_exec(
    sock_path: &Path,
    request: &ExecRequest,
    timeout: Duration,
) -> io::Result<ExecResponse> {
    let deadline = tokio::time::Instant::now() + timeout;

    let mut stream = tokio::time::timeout_at(deadline, UnixStream::connect(sock_path))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connect timed out"))??;

    let request_json = serde_json::to_vec(request)
        .map_err(|e| io::Error::other(format!("serialize request: {e}")))?;

    tokio::time::timeout_at(deadline, async {
        write_frame(&mut stream, &request_json).await?;
        let frame = read_frame(&mut stream).await?;
        let response: ExecResponse = serde_json::from_slice(&frame).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("invalid response: {e}"))
        })?;
        Ok(response)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request timed out"))?
}

// -----------------------------------------------------------------------
// SandboxControl trait implementation
// -----------------------------------------------------------------------

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

/// Find the control socket for a given sandbox ID (full UUID or prefix).
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

    #[tokio::test]
    async fn frame_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");

        let listener = UnixListener::bind(&sock_path).unwrap();

        let payload = b"hello world";
        let sock = sock_path.clone();
        let client = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            write_frame(&mut stream, payload).await.unwrap();
            read_frame(&mut stream).await.unwrap()
        });

        let (mut stream, _) = listener.accept().await.unwrap();
        let received = read_frame(&mut stream).await.unwrap();
        assert_eq!(received, payload);

        write_frame(&mut stream, b"reply").await.unwrap();
        let reply = client.await.unwrap();
        assert_eq!(reply, b"reply");
    }

    #[tokio::test]
    async fn protocol_round_trip() {
        let request = ExecRequest {
            command: "echo hello".into(),
            timeout_secs: 10,
            sudo: false,
        };
        let request_json = serde_json::to_vec(&request).unwrap();

        // Verify request deserializes correctly.
        let decoded: ExecRequest = serde_json::from_slice(&request_json).unwrap();
        assert_eq!(decoded.command, "echo hello");
        assert_eq!(decoded.timeout_secs, 10);
        assert!(!decoded.sudo);

        // Verify success response round-trips.
        let response = ExecResponse::Success {
            exit_code: 0,
            stdout: BASE64.encode(b"hello\n"),
            stderr: BASE64.encode(b""),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponse = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponse::Success {
                exit_code,
                stdout,
                stderr,
            } => {
                assert_eq!(exit_code, 0);
                assert_eq!(BASE64.decode(stdout).unwrap(), b"hello\n");
                assert_eq!(BASE64.decode(stderr).unwrap(), b"");
            }
            ExecResponse::Error { .. } => panic!("expected success"),
        }

        // Verify error response round-trips.
        let response = ExecResponse::Error {
            error: "sandbox not running".into(),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponse = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponse::Error { error } => {
                assert_eq!(error, "sandbox not running");
            }
            ExecResponse::Success { .. } => panic!("expected error"),
        }
    }

    #[tokio::test]
    async fn client_server_no_guest() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");

        // Server with no guest connected.
        let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<VsockHost>>));
        let handle = spawn_server(sock_path.clone(), guest);

        // Give the server a moment to bind.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let request = ExecRequest {
            command: "ps aux".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let response = send_exec(&sock_path, &request, Duration::from_secs(5))
            .await
            .unwrap();

        match response {
            ExecResponse::Error { error } => {
                assert!(error.contains("not running"), "unexpected error: {error}");
            }
            ExecResponse::Success { .. } => panic!("expected error when guest is None"),
        }

        handle.abort();
    }

    #[test]
    fn exec_request_default_timeout() {
        // timeout_secs has a serde default of 30
        let json = r#"{"command":"echo hi"}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "echo hi");
        assert_eq!(req.timeout_secs, 30);
        assert!(!req.sudo);
    }

    #[test]
    fn exec_request_with_sudo() {
        let json = r#"{"command":"apt install curl","timeout_secs":60,"sudo":true}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "apt install curl");
        assert_eq!(req.timeout_secs, 60);
        assert!(req.sudo);
    }

    #[test]
    fn exec_response_success_serialization() {
        let resp = ExecResponse::Success {
            exit_code: 0,
            stdout: BASE64.encode(b"output\n"),
            stderr: BASE64.encode(b""),
        };
        let json = serde_json::to_value(&resp).unwrap();
        // Untagged enum: no "type" field, just the fields directly
        assert_eq!(json["exit_code"], 0);
        assert!(json.get("stdout").is_some());
        assert!(json.get("stderr").is_some());
        assert!(json.get("error").is_none());
    }

    #[test]
    fn exec_response_error_serialization() {
        let resp = ExecResponse::Error {
            error: "sandbox not running".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["error"], "sandbox not running");
        assert!(json.get("exit_code").is_none());
    }

    #[tokio::test]
    async fn send_exec_connect_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("nonexistent.sock");

        let request = ExecRequest {
            command: "echo test".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let result = send_exec(&sock_path, &request, Duration::from_millis(100)).await;
        assert!(result.is_err());
    }

    #[test]
    fn resolve_control_socket_nonexistent_dir() {
        let result = resolve_control_socket("nonexistent-id-12345");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, SandboxControlError::Connection(_)));
    }
}
