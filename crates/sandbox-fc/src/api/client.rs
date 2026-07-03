use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::Path;
use std::time::Duration;

use crate::config::RateLimiterConfig;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use tokio::io::unix::AsyncFd;

use super::http;

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
    pub(super) fn is_retryable(&self) -> bool {
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
            match tokio::time::timeout_at(
                deadline,
                http::send_request(self.socket_path, "GET", "/", None),
            )
            .await
            {
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
        tokio::time::timeout(
            timeout,
            http::send_request(self.socket_path, method, path, body),
        )
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
