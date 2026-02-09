use std::fmt;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::Path;
use std::time::Duration;

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Error from Firecracker API calls.
#[derive(Debug)]
pub struct ApiError {
    status: u16,
    body: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "HTTP {}: {}", self.status, self.body)
    }
}

impl std::error::Error for ApiError {}

/// Wait for the Firecracker API socket to accept connections.
///
/// Uses inotify to wait for the socket file, then polls GET / until 200.
pub async fn wait_for_ready(socket_path: &Path, timeout: Duration) -> Result<(), ApiError> {
    let deadline = tokio::time::Instant::now() + timeout;

    // Phase 1: wait for socket file via inotify.
    if !tokio::fs::try_exists(socket_path).await.unwrap_or(false) {
        tokio::time::timeout_at(deadline, wait_for_socket_file(socket_path))
            .await
            .map_err(|_| ApiError {
                status: 0,
                body: format!("timed out after {timeout:?} waiting for socket file"),
            })??;
    }

    // Phase 2: poll GET / until the API responds with success.
    loop {
        match tokio::time::timeout_at(deadline, request(socket_path, "GET", "/", None)).await {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(_)) => tokio::time::sleep(Duration::from_millis(10)).await,
            Err(_) => {
                return Err(ApiError {
                    status: 0,
                    body: format!("timed out after {timeout:?} waiting for API ready"),
                });
            }
        }
    }
}

/// Wait for a file to appear using inotify (event-driven, no polling).
async fn wait_for_socket_file(socket_path: &Path) -> Result<(), ApiError> {
    let dir = socket_path.parent().ok_or_else(|| ApiError {
        status: 0,
        body: "socket path has no parent directory".into(),
    })?;

    let inotify = Inotify::init(InitFlags::IN_NONBLOCK).map_err(|e| ApiError {
        status: 0,
        body: format!("inotify init: {e}"),
    })?;

    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|e| ApiError {
            status: 0,
            body: format!("inotify watch: {e}"),
        })?;

    // Re-check after watch is set (race: file may have appeared between the
    // caller's try_exists and our add_watch — same pattern as TS client).
    if tokio::fs::try_exists(socket_path).await.unwrap_or(false) {
        return Ok(());
    }

    // Inotify implements AsFd but not AsRawFd; convert to OwnedFd for AsyncFd.
    let fd: OwnedFd = inotify.into();
    let async_fd = AsyncFd::new(fd).map_err(|e| ApiError {
        status: 0,
        body: format!("AsyncFd: {e}"),
    })?;

    loop {
        let mut guard = async_fd.readable().await.map_err(|e| ApiError {
            status: 0,
            body: format!("inotify readable: {e}"),
        })?;

        // Drain inotify events to avoid a busy-loop on level-triggered epoll.
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();

        // Check if our target file exists now (same as TS `checkAndResolve`).
        if tokio::fs::try_exists(socket_path).await.unwrap_or(false) {
            return Ok(());
        }
    }
}

/// Drain all pending bytes from a non-blocking inotify fd.
fn drain_inotify_fd(fd: std::os::fd::BorrowedFd<'_>) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: `fd` is a valid non-blocking inotify file descriptor borrowed
        // from AsyncFd. `buf` is a stack-allocated array with known length.
        // Non-blocking mode guarantees read returns immediately with EAGAIN when empty.
        let rc = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if rc <= 0 {
            break;
        }
    }
}

/// Per-request timeout matching the TS client (30s).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Load a snapshot and resume the VM via PUT /snapshot/load.
pub async fn load_snapshot(
    socket_path: &Path,
    snapshot_path: &str,
    mem_path: &str,
) -> Result<(), ApiError> {
    let body = serde_json::to_string(&serde_json::json!({
        "snapshot_path": snapshot_path,
        "mem_backend": {
            "backend_type": "File",
            "backend_path": mem_path,
        },
        "resume_vm": true,
    }))
    .map_err(|e| ApiError {
        status: 0,
        body: format!("serialize request: {e}"),
    })?;

    tokio::time::timeout(
        REQUEST_TIMEOUT,
        request(socket_path, "PUT", "/snapshot/load", Some(body.as_bytes())),
    )
    .await
    .map_err(|_| ApiError {
        status: 0,
        body: format!("request timed out after {REQUEST_TIMEOUT:?}"),
    })??;

    Ok(())
}

/// Send a raw HTTP/1.1 request over a Unix domain socket.
///
/// Returns the response body on 2xx success, or an `ApiError` containing the
/// status code and Firecracker `fault_message` on failure.
async fn request(
    socket_path: &Path,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<String, ApiError> {
    let mut stream = UnixStream::connect(socket_path)
        .await
        .map_err(|e| ApiError {
            status: 0,
            body: format!("connect: {e}"),
        })?;

    let header = if let Some(b) = body {
        format!(
            "{method} {path} HTTP/1.1\r\n\
             Host: localhost\r\n\
             Accept: application/json\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n",
            b.len(),
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\n\
             Host: localhost\r\n\
             Accept: application/json\r\n\
             Connection: close\r\n\
             \r\n"
        )
    };

    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|e| ApiError {
            status: 0,
            body: format!("write header: {e}"),
        })?;

    if let Some(b) = body {
        stream.write_all(b).await.map_err(|e| ApiError {
            status: 0,
            body: format!("write body: {e}"),
        })?;
    }

    let mut buf = Vec::with_capacity(4096);
    stream.read_to_end(&mut buf).await.map_err(|e| ApiError {
        status: 0,
        body: format!("read response: {e}"),
    })?;

    let response = String::from_utf8_lossy(&buf);

    // Parse status code from "HTTP/1.1 204 No Content\r\n..."
    let status = response
        .get(9..12)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    // Extract body after the \r\n\r\n header separator.
    let body_str = response
        .find("\r\n\r\n")
        .and_then(|i| response.get(i + 4..))
        .unwrap_or_default()
        .to_string();

    if (200..300).contains(&status) {
        Ok(body_str)
    } else {
        // Try to extract fault_message from Firecracker error JSON.
        let message = serde_json::from_str::<serde_json::Value>(&body_str)
            .ok()
            .and_then(|v| v.get("fault_message")?.as_str().map(String::from))
            .unwrap_or(body_str);
        Err(ApiError {
            status,
            body: message,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn wait_for_ready_succeeds_on_200() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-ready.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        // Spawn a mock server that returns 200.
        let path = sock_path.clone();
        tokio::spawn(async move {
            let _ = &path; // keep path alive
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        let result = wait_for_ready(&sock_path, Duration::from_secs(2)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn wait_for_ready_times_out_on_missing_socket() {
        let path = PathBuf::from("/tmp/nonexistent-test-socket.sock");
        let result = wait_for_ready(&path, Duration::from_millis(50)).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.body.contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn load_snapshot_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-snapshot.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf).await;

            let req = String::from_utf8_lossy(&buf);
            // Verify it's a PUT to /snapshot/load with expected JSON body.
            assert!(req.starts_with("PUT /snapshot/load"), "got: {req}");
            assert!(req.contains("resume_vm"), "missing resume_vm in: {req}");

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let result = load_snapshot(&sock_path, "/snap/state", "/snap/memory").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn wait_for_ready_detects_delayed_socket_via_inotify() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("delayed.sock");

        // Socket doesn't exist yet — spawn a task that creates it after 50ms.
        let delayed_path = sock_path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let listener = UnixListener::bind(&delayed_path).unwrap_or_else(|e| {
                panic!("bind {}: {e}", delayed_path.display());
            });
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        let result = wait_for_ready(&sock_path, Duration::from_secs(2)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn wait_for_ready_retries_until_success() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-retry.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        // First 3 requests return 500, then 200.
        tokio::spawn(async move {
            let mut count = 0u32;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let response = if count < 3 {
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
                };
                let _ = stream.write_all(response.as_bytes()).await;
                count += 1;
            }
        });

        let result = wait_for_ready(&sock_path, Duration::from_secs(2)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn load_snapshot_error_falls_back_to_raw_body() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-raw-err.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        // Return non-JSON error body.
        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf).await;

            let body = "plain text error";
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let result = load_snapshot(&sock_path, "/snap/state", "/snap/memory").await;
        let err = result.unwrap_err();
        assert_eq!(err.status, 500);
        assert_eq!(err.body, "plain text error");
    }

    #[tokio::test]
    async fn load_snapshot_returns_error_on_non_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-snapshot-err.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf).await;

            let body = r#"{"fault_message":"bad snapshot"}"#;
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let result = load_snapshot(&sock_path, "/snap/state", "/snap/memory").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.status, 400);
        // fault_message is extracted from JSON response (matches TS behavior).
        assert_eq!(err.body, "bad snapshot");
    }
}
