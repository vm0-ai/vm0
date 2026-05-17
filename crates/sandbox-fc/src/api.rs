use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::Path;
use std::time::Duration;

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::config::RateLimiterConfig;

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

/// Statistics returned by Firecracker's balloon device.
///
/// Requires `stats_polling_interval_s > 0` configured pre-boot.
/// Fields beyond `target_mib`/`actual_mib` depend on the guest kernel version.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BalloonStatistics {
    /// Target balloon size in MiB (set by host).
    pub target_mib: u32,
    /// Actual balloon size in MiB (reported by guest driver).
    pub actual_mib: u32,
    /// Target balloon size in 4 KiB pages.
    pub target_pages: u64,
    /// Actual balloon size in 4 KiB pages.
    pub actual_pages: u64,
    /// Memory not used for any purpose (bytes).
    #[serde(default)]
    pub free_memory: Option<i64>,
    /// Estimate of memory available for new applications (bytes).
    #[serde(default)]
    pub available_memory: Option<i64>,
    /// Total memory visible to guest (bytes).
    #[serde(default)]
    pub total_memory: Option<i64>,
    /// Memory swapped in from disk (bytes).
    #[serde(default)]
    pub swap_in: Option<i64>,
    /// Memory swapped out to disk (bytes).
    #[serde(default)]
    pub swap_out: Option<i64>,
    /// Major page fault count.
    #[serde(default)]
    pub major_faults: Option<i64>,
    /// Minor page fault count.
    #[serde(default)]
    pub minor_faults: Option<i64>,
    /// Memory used for disk caching (bytes).
    #[serde(default)]
    pub disk_caches: Option<i64>,
}

/// Per-request timeout matching the TS client (30s).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Extended timeout for snapshot creation. Writing a full memory dump
/// (up to 4 GiB for browser profile) can exceed the default 30s timeout.
const SNAPSHOT_CREATE_TIMEOUT: Duration = Duration::from_secs(120);

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

    /// Load a snapshot via PUT /snapshot/load.
    pub async fn load_snapshot(
        &self,
        snapshot_path: &str,
        mem_path: &str,
        resume_vm: bool,
    ) -> Result<(), ApiError> {
        self.send_json(
            "PUT",
            "/snapshot/load",
            &serde_json::json!({
                "snapshot_path": snapshot_path,
                "mem_backend": {
                    "backend_type": "File",
                    "backend_path": mem_path,
                },
                "resume_vm": resume_vm,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Pause the VM via PATCH /vm.
    ///
    /// The VM must be paused before creating a snapshot.
    pub async fn pause(&self) -> Result<(), ApiError> {
        self.send(
            "PATCH",
            "/vm",
            Some(br#"{"state":"Paused"}"#),
            REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    /// Resume a paused VM via PATCH /vm.
    ///
    /// Must be called before any guest interaction after a [`Self::pause`].
    pub async fn resume(&self) -> Result<(), ApiError> {
        self.send(
            "PATCH",
            "/vm",
            Some(br#"{"state":"Resumed"}"#),
            REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    /// Create a snapshot via PUT /snapshot/create.
    ///
    /// The VM must be paused first (see [`Self::pause`]).
    /// Uses an extended timeout because writing a full memory dump to disk
    /// can take well over 30s for large VMs (e.g. 4 GiB for browser profile).
    pub async fn create_snapshot(
        &self,
        snapshot_path: &str,
        mem_path: &str,
    ) -> Result<(), ApiError> {
        self.send_json(
            "PUT",
            "/snapshot/create",
            &serde_json::json!({
                "snapshot_type": "Full",
                "snapshot_path": snapshot_path,
                "mem_file_path": mem_path,
            }),
            SNAPSHOT_CREATE_TIMEOUT,
        )
        .await
    }

    /// Configure the machine (vCPU count and memory) via PUT /machine-config.
    pub async fn configure_machine(
        &self,
        vcpu_count: u32,
        mem_size_mib: u32,
    ) -> Result<(), ApiError> {
        self.send_json(
            "PUT",
            "/machine-config",
            &serde_json::json!({
                "vcpu_count": vcpu_count,
                "mem_size_mib": mem_size_mib,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Configure the boot source via PUT /boot-source.
    pub async fn configure_boot_source(
        &self,
        kernel_image_path: &str,
        boot_args: &str,
    ) -> Result<(), ApiError> {
        self.send_json(
            "PUT",
            "/boot-source",
            &serde_json::json!({
                "kernel_image_path": kernel_image_path,
                "boot_args": boot_args,
            }),
            REQUEST_TIMEOUT,
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
        rate_limiter: Option<&RateLimiterConfig>,
    ) -> Result<(), ApiError> {
        let path = format!("/drives/{drive_id}");
        let mut body = serde_json::Map::from_iter([
            ("drive_id".to_string(), serde_json::json!(drive_id)),
            ("path_on_host".to_string(), serde_json::json!(path_on_host)),
            (
                "is_root_device".to_string(),
                serde_json::json!(is_root_device),
            ),
            ("is_read_only".to_string(), serde_json::json!(is_read_only)),
        ]);
        if let Some(rate_limiter) = rate_limiter {
            body.insert(
                "rate_limiter".to_string(),
                serde_json::to_value(rate_limiter)
                    .map_err(|e| ApiError::Other(format!("json: {e}")))?,
            );
        }
        self.send_json(
            "PUT",
            &path,
            &serde_json::Value::Object(body),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Update a drive rate limiter via PATCH /drives/{drive_id}.
    pub async fn patch_drive_rate_limiter(
        &self,
        drive_id: &str,
        rate_limiter: &RateLimiterConfig,
    ) -> Result<(), ApiError> {
        let path = format!("/drives/{drive_id}");
        self.send_json(
            "PATCH",
            &path,
            &serde_json::json!({
                "drive_id": drive_id,
                "rate_limiter": rate_limiter,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Configure a network interface via PUT /network-interfaces/{iface_id}.
    pub async fn configure_network_interface(
        &self,
        iface_id: &str,
        guest_mac: &str,
        host_dev_name: &str,
        rx_rate_limiter: Option<&RateLimiterConfig>,
        tx_rate_limiter: Option<&RateLimiterConfig>,
    ) -> Result<(), ApiError> {
        let path = format!("/network-interfaces/{iface_id}");
        let mut body = serde_json::Map::from_iter([
            ("iface_id".to_string(), serde_json::json!(iface_id)),
            ("guest_mac".to_string(), serde_json::json!(guest_mac)),
            (
                "host_dev_name".to_string(),
                serde_json::json!(host_dev_name),
            ),
        ]);
        if let Some(rx_rate_limiter) = rx_rate_limiter {
            body.insert(
                "rx_rate_limiter".to_string(),
                serde_json::to_value(rx_rate_limiter)
                    .map_err(|e| ApiError::Other(format!("json: {e}")))?,
            );
        }
        if let Some(tx_rate_limiter) = tx_rate_limiter {
            body.insert(
                "tx_rate_limiter".to_string(),
                serde_json::to_value(tx_rate_limiter)
                    .map_err(|e| ApiError::Other(format!("json: {e}")))?,
            );
        }
        self.send_json(
            "PUT",
            &path,
            &serde_json::Value::Object(body),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Update network interface rate limiters via PATCH /network-interfaces/{iface_id}.
    pub async fn patch_network_rate_limiters(
        &self,
        iface_id: &str,
        rx_rate_limiter: &RateLimiterConfig,
        tx_rate_limiter: &RateLimiterConfig,
    ) -> Result<(), ApiError> {
        let path = format!("/network-interfaces/{iface_id}");
        self.send_json(
            "PATCH",
            &path,
            &serde_json::json!({
                "iface_id": iface_id,
                "rx_rate_limiter": rx_rate_limiter,
                "tx_rate_limiter": tx_rate_limiter,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Configure the vsock device via PUT /vsock.
    pub async fn configure_vsock(&self, guest_cid: u32, uds_path: &str) -> Result<(), ApiError> {
        self.send_json(
            "PUT",
            "/vsock",
            &serde_json::json!({
                "guest_cid": guest_cid,
                "uds_path": uds_path,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Update balloon target size at runtime via PATCH /balloon.
    ///
    /// Unlike [`Self::configure_balloon`] (PUT, pre-boot only), this can be called
    /// while the VM is running to dynamically inflate or deflate the balloon.
    pub async fn patch_balloon(&self, amount_mib: u32) -> Result<(), ApiError> {
        self.send_json(
            "PATCH",
            "/balloon",
            &serde_json::json!({ "amount_mib": amount_mib }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Retrieve balloon device statistics via GET /balloon/statistics.
    ///
    /// Requires `stats_polling_interval_s > 0` configured pre-boot via
    /// [`Self::configure_balloon`]. Returns an error if statistics were not enabled.
    pub async fn get_balloon_statistics(&self) -> Result<BalloonStatistics, ApiError> {
        let body = self
            .send("GET", "/balloon/statistics", None, REQUEST_TIMEOUT)
            .await?;
        serde_json::from_str(&body)
            .map_err(|e| ApiError::Other(format!("parse balloon statistics: {e}")))
    }

    /// Configure the balloon device via PUT /balloon.
    ///
    /// Must be called before starting the instance. With `deflate_on_oom` enabled,
    /// the balloon automatically deflates to return memory to the guest when it
    /// faces OOM pressure, preventing the OOM killer from terminating processes.
    pub async fn configure_balloon(
        &self,
        amount_mib: u32,
        deflate_on_oom: bool,
        stats_polling_interval_s: u32,
    ) -> Result<(), ApiError> {
        self.send_json(
            "PUT",
            "/balloon",
            &serde_json::json!({
                "amount_mib": amount_mib,
                "deflate_on_oom": deflate_on_oom,
                "stats_polling_interval_s": stats_polling_interval_s,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Start the VM instance via PUT /actions.
    pub async fn start_instance(&self) -> Result<(), ApiError> {
        self.send(
            "PUT",
            "/actions",
            Some(br#"{"action_type":"InstanceStart"}"#),
            REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    /// Send a request with a timeout and return the response body.
    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<String, ApiError> {
        tokio::time::timeout(timeout, self.request(method, path, body))
            .await
            .map_err(|_| ApiError::Other(format!("request timed out after {timeout:?}")))?
    }

    /// Serialize a JSON value and send it with the given method and timeout.
    async fn send_json(
        &self,
        method: &str,
        path: &str,
        value: &serde_json::Value,
        timeout: Duration,
    ) -> Result<(), ApiError> {
        let body =
            serde_json::to_string(value).map_err(|e| ApiError::Other(format!("json: {e}")))?;
        self.send(method, path, Some(body.as_bytes()), timeout)
            .await?;
        Ok(())
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
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use tokio::net::{UnixListener, UnixStream};
    use tokio::sync::{mpsc, oneshot};
    use tokio::task::JoinHandle;

    const MOCK_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);
    const MAX_MOCK_REQUEST_HEADER_BYTES: usize = 16 * 1024;
    const MAX_MOCK_REQUEST_BODY_BYTES: usize = 1024 * 1024;

    #[derive(Debug)]
    struct MockRequest {
        raw: String,
        method: String,
        path: String,
        body: String,
    }

    #[derive(Clone, Debug)]
    struct MockResponse {
        status: u16,
        reason: &'static str,
        body: String,
    }

    impl MockResponse {
        fn ok() -> Self {
            Self::new(200, "OK", "")
        }

        fn ok_body(body: impl Into<String>) -> Self {
            Self::new(200, "OK", body)
        }

        fn no_content() -> Self {
            Self::new(204, "No Content", "")
        }

        fn bad_request_fault(message: &str) -> Self {
            Self::new(
                400,
                "Bad Request",
                serde_json::json!({ "fault_message": message }).to_string(),
            )
        }

        fn internal_error_raw(body: impl Into<String>) -> Self {
            Self::new(500, "Internal Server Error", body)
        }

        fn new(status: u16, reason: &'static str, body: impl Into<String>) -> Self {
            Self {
                status,
                reason,
                body: body.into(),
            }
        }

        fn to_http(&self) -> String {
            format!(
                "HTTP/1.1 {} {}\r\nContent-Length: {}\r\n\r\n{}",
                self.status,
                self.reason,
                self.body.len(),
                self.body
            )
        }
    }

    enum MockResponseMode {
        Queue(VecDeque<MockResponse>),
        Repeat(MockResponse),
    }

    impl MockResponseMode {
        fn next_response(&mut self) -> MockResponse {
            match self {
                Self::Queue(responses) => responses.pop_front().unwrap_or_else(|| {
                    MockResponse::internal_error_raw("unexpected extra Firecracker API request")
                }),
                Self::Repeat(response) => response.clone(),
            }
        }
    }

    struct MockFirecrackerApi {
        _dir: tempfile::TempDir,
        sock_path: PathBuf,
        requests: mpsc::UnboundedReceiver<MockRequest>,
        server: JoinHandle<()>,
    }

    impl MockFirecrackerApi {
        fn with_responses(responses: impl IntoIterator<Item = MockResponse>) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let sock_path = dir.path().join("fc.sock");
            let listener = UnixListener::bind(&sock_path).unwrap();
            Self::spawn(
                dir,
                sock_path,
                async move { listener },
                MockResponseMode::Queue(responses.into_iter().collect()),
            )
        }

        fn repeating(response: MockResponse) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let sock_path = dir.path().join("fc.sock");
            let listener = UnixListener::bind(&sock_path).unwrap();
            Self::spawn(
                dir,
                sock_path,
                async move { listener },
                MockResponseMode::Repeat(response),
            )
        }

        fn deferred_repeating(response: MockResponse) -> (Self, oneshot::Sender<()>) {
            let dir = tempfile::tempdir().unwrap();
            let sock_path = dir.path().join("deferred.sock");
            let bind_path = sock_path.clone();
            let (bind_tx, bind_rx) = oneshot::channel();
            let (tx, requests) = mpsc::unbounded_channel();
            let server = tokio::spawn(async move {
                if bind_rx.await.is_err() {
                    return;
                }

                let listener = UnixListener::bind(&bind_path).unwrap();
                serve_mock_api(listener, MockResponseMode::Repeat(response), tx).await;
            });

            (
                Self {
                    _dir: dir,
                    sock_path,
                    requests,
                    server,
                },
                bind_tx,
            )
        }

        fn spawn(
            dir: tempfile::TempDir,
            sock_path: PathBuf,
            bind: impl std::future::Future<Output = UnixListener> + Send + 'static,
            responses: MockResponseMode,
        ) -> Self {
            let (tx, requests) = mpsc::unbounded_channel();
            let server = tokio::spawn(async move {
                let listener = bind.await;
                serve_mock_api(listener, responses, tx).await;
            });

            Self {
                _dir: dir,
                sock_path,
                requests,
                server,
            }
        }

        fn socket_path(&self) -> &std::path::Path {
            &self.sock_path
        }

        async fn next_request(&mut self) -> MockRequest {
            tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, self.requests.recv())
                .await
                .expect("timed out waiting for Firecracker API request")
                .expect("mock Firecracker API server stopped before capturing request")
        }
    }

    impl Drop for MockFirecrackerApi {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    async fn serve_mock_api(
        listener: UnixListener,
        mut responses: MockResponseMode,
        tx: mpsc::UnboundedSender<MockRequest>,
    ) {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };

            let request = match tokio::time::timeout(
                MOCK_REQUEST_READ_TIMEOUT,
                read_mock_request(&mut stream),
            )
            .await
            {
                Ok(Ok(request)) => request,
                Ok(Err(error)) => {
                    let response =
                        MockResponse::internal_error_raw(format!("read request: {error}"));
                    let _ = stream.write_all(response.to_http().as_bytes()).await;
                    continue;
                }
                Err(_) => {
                    let response = MockResponse::internal_error_raw("read request timed out");
                    let _ = stream.write_all(response.to_http().as_bytes()).await;
                    continue;
                }
            };

            if tx.send(request).is_err() {
                break;
            }

            let response = responses.next_response();
            let _ = stream.write_all(response.to_http().as_bytes()).await;
        }
    }

    async fn read_mock_request(stream: &mut UnixStream) -> std::io::Result<MockRequest> {
        let mut buf = Vec::with_capacity(4096);
        loop {
            if header_end(&buf).is_some() {
                break;
            }
            if buf.len() > MAX_MOCK_REQUEST_HEADER_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("request headers too large: {} bytes", buf.len()),
                ));
            }

            let read = stream.read_buf(&mut buf).await?;
            if read == 0 {
                break;
            }
        }

        let header_end = header_end(&buf).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request missing HTTP header terminator",
            )
        })?;
        if header_end > MAX_MOCK_REQUEST_HEADER_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("request headers too large: {header_end} bytes"),
            ));
        }
        let headers = String::from_utf8_lossy(&buf[..header_end.saturating_sub(4)]).to_string();
        let content_length = headers
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
        if content_length > MAX_MOCK_REQUEST_BODY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("request body too large: {content_length} bytes"),
            ));
        }

        let already_read = buf.len().saturating_sub(header_end);
        if already_read < content_length {
            let mut tail = vec![0u8; content_length - already_read];
            stream.read_exact(&mut tail).await?;
            buf.extend_from_slice(&tail);
        }

        let body_end = header_end.saturating_add(content_length);
        let body =
            String::from_utf8_lossy(buf.get(header_end..body_end).unwrap_or_default()).to_string();
        let raw = String::from_utf8_lossy(&buf).to_string();
        let first_line = headers.lines().next().unwrap_or_default();
        let mut request_line = first_line.split_whitespace();
        let method = request_line.next().unwrap_or_default().to_string();
        let path = request_line.next().unwrap_or_default().to_string();

        Ok(MockRequest {
            raw,
            method,
            path,
            body,
        })
    }

    fn header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }

    fn assert_request(request: &MockRequest, method: &str, path: &str) {
        assert_eq!(request.method, method, "raw request: {}", request.raw);
        assert_eq!(request.path, path, "raw request: {}", request.raw);
    }

    fn request_body_json(request: &MockRequest) -> serde_json::Value {
        serde_json::from_str(&request.body).unwrap_or_else(|error| {
            panic!("invalid JSON body: {error}; raw request: {}", request.raw)
        })
    }

    fn test_rate_limiter(size: u64) -> RateLimiterConfig {
        RateLimiterConfig {
            bandwidth: Some(crate::config::TokenBucketConfig {
                size,
                refill_time: crate::config::RATE_LIMITER_REFILL_TIME_MS,
            }),
            ops: None,
        }
    }

    async fn run_with_split_response<T, Fut>(
        response: MockResponse,
        call: impl FnOnce(PathBuf) -> Fut,
    ) -> (T, MockRequest)
    where
        Fut: std::future::Future<Output = T>,
    {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("fc.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        let (request_tx, request_rx) = oneshot::channel();
        let (header_written_tx, header_written_rx) = oneshot::channel();
        let (write_body_tx, write_body_rx) = oneshot::channel();
        let server = async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_mock_request(&mut stream).await.unwrap();
            request_tx.send(request).unwrap();

            let header = format!(
                "HTTP/1.1 {} {}\r\nContent-Length: {}\r\n\r\n",
                response.status,
                response.reason,
                response.body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            header_written_tx.send(()).unwrap();

            write_body_rx.await.unwrap();
            stream.write_all(response.body.as_bytes()).await.unwrap();
        };
        tokio::pin!(server);

        let client = call(sock_path);
        tokio::pin!(client);

        tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, async {
            tokio::select! {
                result = header_written_rx => result.unwrap(),
                _ = &mut client => panic!("client completed before split response header"),
                result = &mut server => panic!("mock server exited before split response header: {result:?}"),
            }
        })
        .await
        .expect("timed out waiting for split response header");
        write_body_tx.send(()).unwrap();

        let (output, ()) = tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, async {
            tokio::join!(&mut client, &mut server)
        })
        .await
        .expect("timed out waiting for split response completion");
        let request = request_rx.await.unwrap();
        (output, request)
    }

    #[tokio::test]
    async fn mock_firecracker_api_reads_split_request_body() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let mut stream = UnixStream::connect(api.socket_path()).await.unwrap();

        stream
            .write_all(
                b"PUT /split HTTP/1.1\r\n\
                  Host: localhost\r\n\
                  Content-Length: 14\r\n\
                  \r\n",
            )
            .await
            .unwrap();
        stream.write_all(br#"{"split":true}"#).await.unwrap();

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/split");
        assert_eq!(request.body, r#"{"split":true}"#);
    }

    #[test]
    fn api_error_is_retryable_connection_refused() {
        let err = ApiError::Connect(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "connection refused",
        ));
        assert!(err.is_retryable());
    }

    #[test]
    fn api_error_is_not_retryable_permission_denied() {
        let err = ApiError::Connect(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "permission denied",
        ));
        assert!(!err.is_retryable());
    }

    #[test]
    fn api_error_is_retryable_http_server_error() {
        let err = ApiError::Http {
            status: 500,
            body: "internal error".to_string(),
        };
        assert!(err.is_retryable());
    }

    #[test]
    fn api_error_is_retryable_http_client_error() {
        // Client errors (4xx) are also retryable — the implementation treats
        // all Http variants as retryable (e.g. Firecracker may return 400
        // during startup before the VM is ready).
        let err = ApiError::Http {
            status: 400,
            body: "bad request".to_string(),
        };
        assert!(err.is_retryable());
    }

    #[test]
    fn api_error_is_retryable_other() {
        let err = ApiError::Other("timeout".to_string());
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn wait_for_ready_succeeds_on_200() {
        let mut api = MockFirecrackerApi::repeating(MockResponse::ok());
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.wait_for_ready(Duration::from_secs(2)).await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "GET", "/");
    }

    #[tokio::test]
    async fn wait_for_ready_times_out_on_missing_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.sock");
        let client = ApiClient::new(&path);
        let result = client.wait_for_ready(Duration::ZERO).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn load_snapshot_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client
            .load_snapshot("/snap/state", "/snap/memory", true)
            .await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/snapshot/load");
        let body = request_body_json(&request);
        assert_eq!(body["snapshot_path"], "/snap/state");
        assert_eq!(body["mem_backend"]["backend_type"], "File");
        assert_eq!(body["mem_backend"]["backend_path"], "/snap/memory");
        assert_eq!(body["resume_vm"], true);
    }

    #[tokio::test]
    async fn load_snapshot_can_leave_vm_paused() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client
            .load_snapshot("/snap/state", "/snap/memory", false)
            .await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/snapshot/load");
        let body = request_body_json(&request);
        assert_eq!(body["resume_vm"], false);
    }

    #[tokio::test]
    async fn wait_for_ready_detects_deferred_socket() {
        let (mut api, bind_socket) = MockFirecrackerApi::deferred_repeating(MockResponse::ok());
        let sock_path = api.socket_path().to_path_buf();
        let waiter = tokio::spawn(async move {
            let client = ApiClient::new(&sock_path);
            client.wait_for_ready(Duration::from_secs(2)).await
        });

        bind_socket.send(()).unwrap();
        let result = waiter.await.unwrap();
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "GET", "/");
    }

    #[tokio::test]
    async fn wait_for_ready_retries_until_success() {
        let mut api = MockFirecrackerApi::with_responses([
            MockResponse::internal_error_raw(""),
            MockResponse::internal_error_raw(""),
            MockResponse::internal_error_raw(""),
            MockResponse::ok(),
        ]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.wait_for_ready(Duration::from_secs(2)).await;
        assert!(result.is_ok());

        for _ in 0..4 {
            let request = api.next_request().await;
            assert_request(&request, "GET", "/");
        }
    }

    #[tokio::test]
    async fn load_snapshot_error_falls_back_to_raw_body() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::internal_error_raw(
            "plain text error",
        )]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client
            .load_snapshot("/snap/state", "/snap/memory", true)
            .await;
        let ApiError::Http { status, body } = result.unwrap_err() else {
            panic!("expected Http error");
        };
        assert_eq!(status, 500);
        assert_eq!(body, "plain text error");

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/snapshot/load");
    }

    #[tokio::test]
    async fn load_snapshot_returns_error_on_non_204() {
        let fault_message = r#"bad "snapshot" \ path"#;
        let mut api =
            MockFirecrackerApi::with_responses([MockResponse::bad_request_fault(fault_message)]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client
            .load_snapshot("/snap/state", "/snap/memory", true)
            .await;
        let ApiError::Http { status, body } = result.unwrap_err() else {
            panic!("expected Http error");
        };
        assert_eq!(status, 400);
        // fault_message is extracted from JSON response (matches TS behavior).
        assert_eq!(body, fault_message);

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/snapshot/load");
    }

    #[tokio::test]
    async fn pause_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.pause().await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PATCH", "/vm");
        let body = request_body_json(&request);
        assert_eq!(body["state"], "Paused");
    }

    #[tokio::test]
    async fn resume_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.resume().await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PATCH", "/vm");
        let body = request_body_json(&request);
        assert_eq!(body["state"], "Resumed");
    }

    #[tokio::test]
    async fn create_snapshot_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.create_snapshot("/snap/state", "/snap/memory").await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/snapshot/create");
        let body = request_body_json(&request);
        assert_eq!(body["snapshot_type"], "Full");
        assert_eq!(body["snapshot_path"], "/snap/state");
        assert_eq!(body["mem_file_path"], "/snap/memory");
    }

    #[tokio::test]
    async fn pause_returns_error_on_failure() {
        let mut api =
            MockFirecrackerApi::with_responses([MockResponse::bad_request_fault("cannot pause")]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let ApiError::Http { status, body } = client.pause().await.unwrap_err() else {
            panic!("expected Http error");
        };
        assert_eq!(status, 400);
        assert_eq!(body, "cannot pause");

        let request = api.next_request().await;
        assert_request(&request, "PATCH", "/vm");
    }

    #[tokio::test]
    async fn configure_machine_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.configure_machine(2, 256).await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/machine-config");
        let body = request_body_json(&request);
        assert_eq!(body["vcpu_count"], 2);
        assert_eq!(body["mem_size_mib"], 256);
    }

    #[tokio::test]
    async fn configure_boot_source_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client
            .configure_boot_source("/path/to/kernel", "console=ttyS0")
            .await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/boot-source");
        let body = request_body_json(&request);
        assert_eq!(body["kernel_image_path"], "/path/to/kernel");
        assert_eq!(body["boot_args"], "console=ttyS0");
    }

    #[tokio::test]
    async fn configure_drive_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client
            .configure_drive("rootfs", "/path/to/rootfs", true, true, None)
            .await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/drives/rootfs");
        let body = request_body_json(&request);
        assert_eq!(body["drive_id"], "rootfs");
        assert_eq!(body["path_on_host"], "/path/to/rootfs");
        assert_eq!(body["is_root_device"], true);
        assert_eq!(body["is_read_only"], true);
        assert!(body.get("rate_limiter").is_none());
    }

    #[tokio::test]
    async fn configure_drive_with_rate_limiter_serializes_limiter() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let limiter = RateLimiterConfig {
            bandwidth: Some(crate::config::TokenBucketConfig {
                size: 1024,
                refill_time: 100,
            }),
            ops: Some(crate::config::TokenBucketConfig {
                size: 10,
                refill_time: 100,
            }),
        };
        let result = client
            .configure_drive("rootfs", "/path/to/rootfs", true, true, Some(&limiter))
            .await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/drives/rootfs");
        let body = request_body_json(&request);
        assert_eq!(body["drive_id"], "rootfs");
        assert_eq!(body["path_on_host"], "/path/to/rootfs");
        assert_eq!(body["is_root_device"], true);
        assert_eq!(body["is_read_only"], true);
        assert_eq!(body["rate_limiter"]["bandwidth"]["size"], 1024);
        assert_eq!(body["rate_limiter"]["bandwidth"]["refill_time"], 100);
        assert_eq!(body["rate_limiter"]["ops"]["size"], 10);
    }

    #[tokio::test]
    async fn patch_drive_rate_limiter_serializes_partial_drive() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let limiter = test_rate_limiter(2048);

        let result = client.patch_drive_rate_limiter("rootfs", &limiter).await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PATCH", "/drives/rootfs");
        let body = request_body_json(&request);
        assert_eq!(body["drive_id"], "rootfs");
        assert_eq!(body["rate_limiter"]["bandwidth"]["size"], 2048);
    }

    #[tokio::test]
    async fn configure_network_interface_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client
            .configure_network_interface("eth0", "02:00:00:00:00:01", "vm0-tap", None, None)
            .await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/network-interfaces/eth0");
        let body = request_body_json(&request);
        assert_eq!(body["iface_id"], "eth0");
        assert_eq!(body["guest_mac"], "02:00:00:00:00:01");
        assert_eq!(body["host_dev_name"], "vm0-tap");
        assert!(body.get("rx_rate_limiter").is_none());
        assert!(body.get("tx_rate_limiter").is_none());
    }

    #[tokio::test]
    async fn configure_network_interface_with_rate_limiters_serializes_limiters() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let rx = test_rate_limiter(4096);
        let tx = test_rate_limiter(8192);
        let result = client
            .configure_network_interface(
                "eth0",
                "02:00:00:00:00:01",
                "vm0-tap",
                Some(&rx),
                Some(&tx),
            )
            .await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/network-interfaces/eth0");
        let body = request_body_json(&request);
        assert_eq!(body["iface_id"], "eth0");
        assert_eq!(body["guest_mac"], "02:00:00:00:00:01");
        assert_eq!(body["host_dev_name"], "vm0-tap");
        assert_eq!(body["rx_rate_limiter"]["bandwidth"]["size"], 4096);
        assert_eq!(body["tx_rate_limiter"]["bandwidth"]["size"], 8192);
    }

    #[tokio::test]
    async fn patch_network_rate_limiters_serializes_partial_network_interface() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let rx = test_rate_limiter(4096);
        let tx = test_rate_limiter(8192);

        let result = client.patch_network_rate_limiters("eth0", &rx, &tx).await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PATCH", "/network-interfaces/eth0");
        let body = request_body_json(&request);
        assert_eq!(body["iface_id"], "eth0");
        assert_eq!(body["rx_rate_limiter"]["bandwidth"]["size"], 4096);
        assert_eq!(body["tx_rate_limiter"]["bandwidth"]["size"], 8192);
    }

    #[tokio::test]
    async fn configure_vsock_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.configure_vsock(3, "/tmp/vsock.sock").await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/vsock");
        let body = request_body_json(&request);
        assert_eq!(body["guest_cid"], 3);
        assert_eq!(body["uds_path"], "/tmp/vsock.sock");
    }

    #[tokio::test]
    async fn start_instance_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.start_instance().await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/actions");
        let body = request_body_json(&request);
        assert_eq!(body["action_type"], "InstanceStart");
    }

    #[tokio::test]
    async fn patch_balloon_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.patch_balloon(512).await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PATCH", "/balloon");
        let body = request_body_json(&request);
        assert_eq!(body["amount_mib"], 512);
    }

    #[tokio::test]
    async fn get_balloon_statistics_parses_response() {
        let body = r#"{"target_mib":512,"actual_mib":256,"target_pages":131072,"actual_pages":65536,"free_memory":1073741824,"available_memory":1610612736,"total_memory":2147483648}"#;
        let mut api = MockFirecrackerApi::with_responses([MockResponse::ok_body(body)]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let stats = client.get_balloon_statistics().await.unwrap();
        assert_eq!(stats.target_mib, 512);
        assert_eq!(stats.actual_mib, 256);
        assert_eq!(stats.target_pages, 131072);
        assert_eq!(stats.actual_pages, 65536);
        assert_eq!(stats.free_memory, Some(1_073_741_824));
        assert_eq!(stats.available_memory, Some(1_610_612_736));
        assert_eq!(stats.total_memory, Some(2_147_483_648));
        // Optional fields not in response should be None.
        assert_eq!(stats.swap_in, None);
        assert_eq!(stats.major_faults, None);

        let request = api.next_request().await;
        assert_request(&request, "GET", "/balloon/statistics");
    }

    #[tokio::test]
    async fn get_balloon_statistics_reads_split_response_body() {
        let body =
            r#"{"target_mib":768,"actual_mib":384,"target_pages":196608,"actual_pages":98304}"#;
        let (result, request) =
            run_with_split_response(MockResponse::ok_body(body), |sock_path| async move {
                let client = ApiClient::new(&sock_path);
                client.get_balloon_statistics().await
            })
            .await;

        let stats = result.unwrap();
        assert_eq!(stats.target_mib, 768);
        assert_eq!(stats.actual_mib, 384);
        assert_eq!(stats.target_pages, 196_608);
        assert_eq!(stats.actual_pages, 98_304);

        assert_request(&request, "GET", "/balloon/statistics");
    }

    #[tokio::test]
    async fn load_snapshot_error_reads_split_response_body() {
        let fault_message = "snapshot body arrived after headers";
        let (result, request) = run_with_split_response(
            MockResponse::bad_request_fault(fault_message),
            |sock_path| async move {
                let client = ApiClient::new(&sock_path);
                client
                    .load_snapshot("/snap/state", "/snap/memory", true)
                    .await
            },
        )
        .await;

        let ApiError::Http { status, body } = result.unwrap_err() else {
            panic!("expected Http error");
        };
        assert_eq!(status, 400);
        assert_eq!(body, fault_message);
        assert_request(&request, "PUT", "/snapshot/load");
    }

    #[tokio::test]
    async fn get_balloon_statistics_handles_minimal_response() {
        let body = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0}"#;
        let mut api = MockFirecrackerApi::with_responses([MockResponse::ok_body(body)]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let stats = client.get_balloon_statistics().await.unwrap();
        assert_eq!(stats.target_mib, 0);
        assert_eq!(stats.actual_mib, 0);
        assert_eq!(stats.free_memory, None);
        assert_eq!(stats.available_memory, None);

        let request = api.next_request().await;
        assert_request(&request, "GET", "/balloon/statistics");
    }

    #[tokio::test]
    async fn get_balloon_statistics_returns_error_on_malformed_response() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::ok_body("{not json")]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let ApiError::Other(message) = client.get_balloon_statistics().await.unwrap_err() else {
            panic!("expected parse error");
        };
        assert!(
            message.contains("parse balloon statistics"),
            "got: {message}"
        );

        let request = api.next_request().await;
        assert_request(&request, "GET", "/balloon/statistics");
    }

    #[tokio::test]
    async fn configure_balloon_succeeds_on_204() {
        let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path);
        let result = client.configure_balloon(0, true, 0).await;
        assert!(result.is_ok());

        let request = api.next_request().await;
        assert_request(&request, "PUT", "/balloon");
        let body = request_body_json(&request);
        assert_eq!(body["amount_mib"], 0);
        assert_eq!(body["deflate_on_oom"], true);
        assert_eq!(body["stats_polling_interval_s"], 0);
    }

    #[tokio::test]
    async fn wait_for_ready_fails_fast_on_permission_denied() {
        // Root bypasses file permissions; skip this test.
        if nix::unistd::getuid().is_root() {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("fc.sock");

        // Create a socket then remove all permissions so connect gets PermissionDenied.
        let _listener = UnixListener::bind(&sock_path).unwrap();

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o000)).unwrap();

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
