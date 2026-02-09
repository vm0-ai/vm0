use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::Path;
use std::time::Duration;

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Error from Firecracker API calls.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// Failed to connect to the Unix domain socket.
    #[error("connect: {0}")]
    Connect(std::io::Error),
    /// Firecracker returned a non-2xx HTTP response.
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    /// Other failure (I/O during request, timeout, setup).
    #[error("{0}")]
    Other(String),
}

impl ApiError {
    /// Whether this error is transient and worth retrying during readiness polling.
    fn is_retryable(&self) -> bool {
        match self {
            Self::Connect(e) => e.kind() == std::io::ErrorKind::ConnectionRefused,
            Self::Http { .. } | Self::Other(_) => true,
        }
    }
}

/// Per-request timeout matching the TS client (30s).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Minimal HTTP-over-Unix-socket client for the Firecracker API.
pub struct ApiClient<'a> {
    socket_path: &'a Path,
}

impl<'a> ApiClient<'a> {
    pub fn new(socket_path: &'a Path) -> Self {
        Self { socket_path }
    }

    /// Wait for the Firecracker API socket to accept connections.
    ///
    /// Uses inotify to wait for the socket file, then polls GET / until 200.
    pub async fn wait_for_ready(&self, timeout: Duration) -> Result<(), ApiError> {
        let deadline = tokio::time::Instant::now() + timeout;

        // Phase 1: wait for socket file via inotify.
        if !tokio::fs::try_exists(self.socket_path)
            .await
            .unwrap_or(false)
        {
            tokio::time::timeout_at(deadline, wait_for_socket_file(self.socket_path))
                .await
                .map_err(|_| {
                    ApiError::Other(format!(
                        "timed out after {timeout:?} waiting for socket file"
                    ))
                })??;
        }

        // Phase 2: poll GET / until the API responds with success.
        // Non-retryable errors (e.g. PermissionDenied on connect) fail immediately
        // instead of spinning until timeout.
        loop {
            match tokio::time::timeout_at(deadline, self.request("GET", "/", None)).await {
                Ok(Ok(_)) => return Ok(()),
                Ok(Err(e)) if e.is_retryable() => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    return Err(ApiError::Other(format!(
                        "timed out after {timeout:?} waiting for API ready"
                    )));
                }
            }
        }
    }

    /// Load a snapshot and resume the VM via PUT /snapshot/load.
    pub async fn load_snapshot(&self, snapshot_path: &str, mem_path: &str) -> Result<(), ApiError> {
        self.put_json(
            "/snapshot/load",
            &serde_json::json!({
                "snapshot_path": snapshot_path,
                "mem_backend": {
                    "backend_type": "File",
                    "backend_path": mem_path,
                },
                "resume_vm": true,
            }),
        )
        .await
    }

    /// Pause the VM via PATCH /vm.
    ///
    /// The VM must be paused before creating a snapshot.
    pub async fn pause(&self) -> Result<(), ApiError> {
        self.request_with_timeout("PATCH", "/vm", Some(br#"{"state":"Paused"}"#))
            .await
    }

    /// Create a snapshot via PUT /snapshot/create.
    ///
    /// The VM must be paused first (see [`Self::pause`]).
    pub async fn create_snapshot(
        &self,
        snapshot_path: &str,
        mem_path: &str,
    ) -> Result<(), ApiError> {
        self.put_json(
            "/snapshot/create",
            &serde_json::json!({
                "snapshot_type": "Full",
                "snapshot_path": snapshot_path,
                "mem_file_path": mem_path,
            }),
        )
        .await
    }

    /// Configure the machine (vCPU count and memory) via PUT /machine-config.
    pub async fn configure_machine(
        &self,
        vcpu_count: u32,
        mem_size_mib: u32,
    ) -> Result<(), ApiError> {
        self.put_json(
            "/machine-config",
            &serde_json::json!({
                "vcpu_count": vcpu_count,
                "mem_size_mib": mem_size_mib,
            }),
        )
        .await
    }

    /// Configure the boot source via PUT /boot-source.
    pub async fn configure_boot_source(
        &self,
        kernel_image_path: &str,
        boot_args: &str,
    ) -> Result<(), ApiError> {
        self.put_json(
            "/boot-source",
            &serde_json::json!({
                "kernel_image_path": kernel_image_path,
                "boot_args": boot_args,
            }),
        )
        .await
    }

    /// Configure a drive via PUT /drives/{drive_id}.
    pub async fn configure_drive(
        &self,
        drive_id: &str,
        path_on_host: &str,
        is_root_device: bool,
        is_read_only: bool,
    ) -> Result<(), ApiError> {
        let path = format!("/drives/{drive_id}");
        self.put_json(
            &path,
            &serde_json::json!({
                "drive_id": drive_id,
                "path_on_host": path_on_host,
                "is_root_device": is_root_device,
                "is_read_only": is_read_only,
            }),
        )
        .await
    }

    /// Configure a network interface via PUT /network-interfaces/{iface_id}.
    pub async fn configure_network_interface(
        &self,
        iface_id: &str,
        guest_mac: &str,
        host_dev_name: &str,
    ) -> Result<(), ApiError> {
        let path = format!("/network-interfaces/{iface_id}");
        self.put_json(
            &path,
            &serde_json::json!({
                "iface_id": iface_id,
                "guest_mac": guest_mac,
                "host_dev_name": host_dev_name,
            }),
        )
        .await
    }

    /// Configure the vsock device via PUT /vsock.
    pub async fn configure_vsock(&self, guest_cid: u32, uds_path: &str) -> Result<(), ApiError> {
        self.put_json(
            "/vsock",
            &serde_json::json!({
                "guest_cid": guest_cid,
                "uds_path": uds_path,
            }),
        )
        .await
    }

    /// Start the VM instance via PUT /actions.
    pub async fn start_instance(&self) -> Result<(), ApiError> {
        self.request_with_timeout(
            "PUT",
            "/actions",
            Some(br#"{"action_type":"InstanceStart"}"#),
        )
        .await
    }

    /// Send a request with the standard timeout, discarding the response body.
    async fn request_with_timeout(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<(), ApiError> {
        tokio::time::timeout(REQUEST_TIMEOUT, self.request(method, path, body))
            .await
            .map_err(|_| {
                ApiError::Other(format!("request timed out after {REQUEST_TIMEOUT:?}"))
            })??;
        Ok(())
    }

    /// Serialize a JSON value and PUT it to the given path.
    async fn put_json(&self, path: &str, value: &serde_json::Value) -> Result<(), ApiError> {
        let body =
            serde_json::to_string(value).map_err(|e| ApiError::Other(format!("json: {e}")))?;
        self.request_with_timeout("PUT", path, Some(body.as_bytes()))
            .await
    }

    /// Send a raw HTTP/1.1 request over a Unix domain socket.
    ///
    /// Returns the response body on 2xx success, or an `ApiError` containing the
    /// status code and Firecracker `fault_message` on failure.
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<String, ApiError> {
        let mut stream = UnixStream::connect(self.socket_path)
            .await
            .map_err(ApiError::Connect)?;

        let header = if let Some(b) = body {
            format!(
                "{method} {path} HTTP/1.1\r\n\
                 Host: localhost\r\n\
                 Accept: application/json\r\n\
                 Content-Type: application/json\r\n\
                 Content-Length: {}\r\n\
                 \r\n",
                b.len(),
            )
        } else {
            format!(
                "{method} {path} HTTP/1.1\r\n\
                 Host: localhost\r\n\
                 Accept: application/json\r\n\
                 \r\n"
            )
        };

        stream
            .write_all(header.as_bytes())
            .await
            .map_err(|e| ApiError::Other(format!("write header: {e}")))?;

        if let Some(b) = body {
            stream
                .write_all(b)
                .await
                .map_err(|e| ApiError::Other(format!("write body: {e}")))?;
        }

        // Read response into a buffer. Firecracker uses keep-alive so we
        // cannot rely on connection close; instead we read until we find the
        // header/body boundary (\r\n\r\n), parse Content-Length, then read
        // exactly that many remaining body bytes.
        let mut reader = tokio::io::BufReader::new(stream);
        let mut buf = Vec::with_capacity(4096);

        // Phase 1: read until we have the full header block.
        loop {
            let n = reader
                .read_buf(&mut buf)
                .await
                .map_err(|e| ApiError::Other(format!("read response: {e}")))?;
            if n == 0 || buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }

        let response = String::from_utf8_lossy(&buf);

        // Find where headers end.
        let header_end = response.find("\r\n\r\n").unwrap_or(response.len());

        // Parse status code from "HTTP/1.1 204 No Content\r\n..."
        let status = response
            .get(9..12)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);

        // Parse Content-Length from headers.
        let content_length = response
            .get(..header_end)
            .unwrap_or_default()
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                if key.trim().eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);

        // Body bytes already read (past the \r\n\r\n separator).
        let body_start = header_end + 4;
        let already_read = buf.len().saturating_sub(body_start);
        let body_str = if content_length > 0 {
            if already_read < content_length {
                // Need to read remaining body bytes from the stream.
                let remaining = content_length - already_read;
                let mut tail = vec![0u8; remaining];
                reader
                    .read_exact(&mut tail)
                    .await
                    .map_err(|e| ApiError::Other(format!("read body: {e}")))?;
                buf.extend_from_slice(&tail);
            }
            let end = body_start + content_length;
            String::from_utf8_lossy(buf.get(body_start..end).unwrap_or_default()).to_string()
        } else {
            String::new()
        };

        if (200..300).contains(&status) {
            Ok(body_str)
        } else {
            // Try to extract fault_message from Firecracker error JSON.
            let message = serde_json::from_str::<serde_json::Value>(&body_str)
                .ok()
                .and_then(|v| v.get("fault_message")?.as_str().map(String::from))
                .unwrap_or(body_str);
            Err(ApiError::Http {
                status,
                body: message,
            })
        }
    }
}

/// Wait for a file to appear using inotify (event-driven, no polling).
async fn wait_for_socket_file(socket_path: &Path) -> Result<(), ApiError> {
    let dir = socket_path
        .parent()
        .ok_or_else(|| ApiError::Other("socket path has no parent directory".into()))?;

    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|e| ApiError::Other(format!("inotify init: {e}")))?;

    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|e| ApiError::Other(format!("inotify watch: {e}")))?;

    // Re-check after watch is set (race: file may have appeared between the
    // caller's try_exists and our add_watch — same pattern as TS client).
    if tokio::fs::try_exists(socket_path).await.unwrap_or(false) {
        return Ok(());
    }

    // Inotify implements AsFd but not AsRawFd; convert to OwnedFd for AsyncFd.
    let fd: OwnedFd = inotify.into();
    let async_fd = AsyncFd::new(fd).map_err(|e| ApiError::Other(format!("AsyncFd: {e}")))?;

    loop {
        let mut guard = async_fd
            .readable()
            .await
            .map_err(|e| ApiError::Other(format!("inotify readable: {e}")))?;

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

        let client = ApiClient::new(&sock_path);
        let result = client.wait_for_ready(Duration::from_secs(2)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn wait_for_ready_times_out_on_missing_socket() {
        let path = PathBuf::from("/tmp/nonexistent-test-socket.sock");
        let client = ApiClient::new(&path);
        let result = client.wait_for_ready(Duration::from_millis(50)).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
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

        let client = ApiClient::new(&sock_path);
        let result = client.load_snapshot("/snap/state", "/snap/memory").await;
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

        let client = ApiClient::new(&sock_path);
        let result = client.wait_for_ready(Duration::from_secs(2)).await;
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

        let client = ApiClient::new(&sock_path);
        let result = client.wait_for_ready(Duration::from_secs(2)).await;
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

        let client = ApiClient::new(&sock_path);
        let result = client.load_snapshot("/snap/state", "/snap/memory").await;
        let ApiError::Http { status, body } = result.unwrap_err() else {
            panic!("expected Http error");
        };
        assert_eq!(status, 500);
        assert_eq!(body, "plain text error");
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

        let client = ApiClient::new(&sock_path);
        let result = client.load_snapshot("/snap/state", "/snap/memory").await;
        let ApiError::Http { status, body } = result.unwrap_err() else {
            panic!("expected Http error");
        };
        assert_eq!(status, 400);
        // fault_message is extracted from JSON response (matches TS behavior).
        assert_eq!(body, "bad snapshot");
    }

    #[tokio::test]
    async fn pause_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-pause.sock");

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
            assert!(req.starts_with("PATCH /vm"), "got: {req}");
            assert!(
                req.contains(r#""state":"Paused""#),
                "missing Paused in: {req}"
            );

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client.pause().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn create_snapshot_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-create-snap.sock");

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
            assert!(req.starts_with("PUT /snapshot/create"), "got: {req}");
            assert!(
                req.contains("snapshot_type"),
                "missing snapshot_type in: {req}"
            );
            assert!(
                req.contains("mem_file_path"),
                "missing mem_file_path in: {req}"
            );

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client.create_snapshot("/snap/state", "/snap/memory").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn pause_returns_error_on_failure() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-pause-err.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf).await;

            let body = r#"{"fault_message":"cannot pause"}"#;
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let ApiError::Http { status, body } = client.pause().await.unwrap_err() else {
            panic!("expected Http error");
        };
        assert_eq!(status, 400);
        assert_eq!(body, "cannot pause");
    }

    #[tokio::test]
    async fn configure_machine_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-machine.sock");

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
            assert!(req.starts_with("PUT /machine-config"), "got: {req}");
            assert!(req.contains("vcpu_count"), "missing vcpu_count in: {req}");
            assert!(
                req.contains("mem_size_mib"),
                "missing mem_size_mib in: {req}"
            );

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client.configure_machine(2, 256).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn configure_boot_source_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-boot.sock");

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
            assert!(req.starts_with("PUT /boot-source"), "got: {req}");
            assert!(
                req.contains("kernel_image_path"),
                "missing kernel_image_path in: {req}"
            );
            assert!(req.contains("boot_args"), "missing boot_args in: {req}");

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client
            .configure_boot_source("/path/to/kernel", "console=ttyS0")
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn configure_drive_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-drive.sock");

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
            assert!(req.starts_with("PUT /drives/rootfs"), "got: {req}");
            assert!(req.contains("drive_id"), "missing drive_id in: {req}");
            assert!(
                req.contains("path_on_host"),
                "missing path_on_host in: {req}"
            );

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client
            .configure_drive("rootfs", "/path/to/rootfs", true, true)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn configure_network_interface_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-netif.sock");

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
            assert!(
                req.starts_with("PUT /network-interfaces/eth0"),
                "got: {req}"
            );
            assert!(req.contains("guest_mac"), "missing guest_mac in: {req}");
            assert!(
                req.contains("host_dev_name"),
                "missing host_dev_name in: {req}"
            );

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client
            .configure_network_interface("eth0", "02:00:00:00:00:01", "vm0-tap")
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn configure_vsock_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-vsock.sock");

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
            assert!(req.starts_with("PUT /vsock"), "got: {req}");
            assert!(req.contains("guest_cid"), "missing guest_cid in: {req}");
            assert!(req.contains("uds_path"), "missing uds_path in: {req}");

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client.configure_vsock(3, "/tmp/vsock.sock").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn start_instance_succeeds_on_204() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-start.sock");

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
            assert!(req.starts_with("PUT /actions"), "got: {req}");
            assert!(
                req.contains("InstanceStart"),
                "missing InstanceStart in: {req}"
            );

            let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        let result = client.start_instance().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn wait_for_ready_fails_fast_on_permission_denied() {
        // Root bypasses file permissions; skip this test.
        if nix::unistd::getuid().is_root() {
            return;
        }

        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("test-perm.sock");

        // Create a socket then remove all permissions so connect gets PermissionDenied.
        let _listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o000))
            .unwrap_or_else(|e| panic!("set_permissions: {e}"));

        let client = ApiClient::new(&sock_path);
        let start = std::time::Instant::now();
        let result = client.wait_for_ready(Duration::from_secs(5)).await;
        let elapsed = start.elapsed();

        // Should fail immediately, not spin for 5 seconds.
        assert!(result.is_err(), "expected error");
        assert!(
            elapsed < Duration::from_secs(1),
            "should fail fast, took {elapsed:?}"
        );
        let ApiError::Connect(ref io_err) = result.unwrap_err() else {
            panic!("expected Connect error");
        };
        assert_eq!(io_err.kind(), std::io::ErrorKind::PermissionDenied);
    }
}
