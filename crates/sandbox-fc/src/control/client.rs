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
    async fn send_exec_missing_socket_returns_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("nonexistent.sock");

        let request = ExecRequest {
            command: "echo test".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let result = send_exec(&sock_path, &request, Duration::from_millis(100)).await;
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[tokio::test(start_paused = true)]
    async fn send_exec_times_out_waiting_for_response() {
        use tokio::net::UnixListener;
        use tokio::sync::oneshot;

        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        let (request_seen_tx, request_seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request_json = read_frame(&mut stream).await.unwrap();
            let request: ExecRequest = serde_json::from_slice(&request_json).unwrap();
            assert_eq!(request.command, "echo test");
            request_seen_tx.send(()).unwrap();
            let _stream = stream;
            let _ = release_rx.await;
        });

        let client = tokio::spawn(async move {
            let request = ExecRequest {
                command: "echo test".into(),
                timeout_secs: 5,
                sudo: false,
            };
            send_exec(&sock_path, &request, Duration::from_secs(5)).await
        });

        request_seen_rx.await.unwrap();
        tokio::time::advance(Duration::from_secs(5)).await;

        let error = client.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(error.to_string(), "request timed out");

        release_tx.send(()).unwrap();
        server.await.unwrap();
    }
}
