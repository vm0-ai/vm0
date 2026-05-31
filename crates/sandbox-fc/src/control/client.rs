use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::net::UnixStream;

use super::protocol::{ExecRequest, ExecResponse, read_frame, write_frame};

/// Send an exec request to a control socket and return the wire response.
///
/// Used by `runner exec` to communicate with a running sandbox.
///
/// The returned [`ExecResponse::Success`] still contains base64-encoded stdout
/// and stderr. Use `FirecrackerControl::exec_remote` when the caller wants
/// decoded byte buffers.
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
