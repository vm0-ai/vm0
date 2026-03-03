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

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;
use tracing::{info, warn};
use vsock_host::VsockHost;

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
// Tests
// -----------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
}
