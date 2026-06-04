use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::AsyncBufReadExt;
use tokio::task::JoinHandle;
use tracing::info;

use crate::api::ApiClient;
use crate::config::SnapshotConfig;
use crate::factory::InvariantConfig;
use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::process::kill_process_group;
use sandbox::SnapshotCreateConfig;

use super::SnapshotError;
use super::attempt::SnapshotAttempt;

const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Pre-warm should be quiet; keep diagnostics bounded and explicit.
const PREWARM_EXEC_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;

struct AbortOnDropTask<T> {
    handle: JoinHandle<T>,
}

impl<T> AbortOnDropTask<T> {
    fn new(handle: JoinHandle<T>) -> Self {
        Self { handle }
    }

    fn abort(&self) {
        self.handle.abort();
    }
}

impl<T> Future for AbortOnDropTask<T> {
    type Output = Result<T, tokio::task::JoinError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        Pin::new(&mut this.handle).poll(cx)
    }
}

impl<T> Drop for AbortOnDropTask<T> {
    fn drop(&mut self) {
        if !self.handle.is_finished() {
            self.handle.abort();
        }
    }
}

pub(super) fn spawn_stdout_forwarder(child: &mut tokio::process::Child) -> Option<JoinHandle<()>> {
    child.stdout.take().map(|stdout| {
        // Intentionally detached: stdout has no cleanup decision input, and
        // EOF on the child pipe ends the task after Firecracker exits.
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    info!(target: "firecracker", "{line}");
                }
            }
        })
    })
}

pub(super) fn spawn_stderr_forwarder(
    child: &mut tokio::process::Child,
    stderr_buf: &StderrBuf,
) -> Option<JoinHandle<()>> {
    child.stderr.take().map(|stderr| {
        let buf = Arc::clone(stderr_buf);
        // The caller retains this handle only for the early-exit drain path.
        // Otherwise EOF on the child pipe ends the task after Firecracker exits.
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    tracing::warn!(target: "firecracker", "stderr: {line}");
                    if let Ok(mut g) = buf.lock() {
                        if g.len() == STDERR_BUF_LINES {
                            g.pop_front();
                        }
                        g.push_back(line);
                    }
                }
            }
        })
    })
}

pub(super) async fn drain_stderr_forwarder_after_spawn_exit(
    child_status: &std::io::Result<Option<std::process::ExitStatus>>,
    stderr_handle: Option<JoinHandle<()>>,
) -> Option<JoinHandle<()>> {
    if matches!(child_status, Ok(Some(status)) if !status.success())
        && let Some(handle) = stderr_handle
    {
        // Child's write end of stderr is closed; wait briefly for the
        // forwarder to finish reading so the captured buffer contains
        // the crash's final lines.
        let _ = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, handle).await;
        None
    } else {
        stderr_handle
    }
}

pub(super) async fn kill_and_reap_firecracker(child: &mut tokio::process::Child) {
    kill_process_group(child);
    let _ = child.wait().await;
}

pub(super) async fn kill_and_reap_firecracker_bounded(
    child: &mut tokio::process::Child,
    timeout: Duration,
) -> bool {
    kill_process_group(child);
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(_)) => true,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "failed to wait for snapshot firecracker child during cleanup");
            false
        }
        Err(_) => {
            tracing::warn!(
                timeout_ms = timeout.as_millis() as u64,
                "timed out waiting for snapshot firecracker child during cleanup"
            );
            false
        }
    }
}

pub(super) async fn drain_or_abort_forwarder(
    handle: &mut Option<JoinHandle<()>>,
    pipe: &'static str,
    timeout: Duration,
) -> bool {
    let Some(mut handle) = handle.take() else {
        return true;
    };

    tokio::select! {
        result = &mut handle => {
            match result {
                Ok(()) => true,
                Err(e) if e.is_cancelled() => true,
                Err(e) => {
                    tracing::warn!(pipe, error = %e, "snapshot pipe forwarder failed during cleanup");
                    false
                }
            }
        }
        () = tokio::time::sleep(timeout) => {
            handle.abort();
            if let Err(e) = handle.await
                && !e.is_cancelled()
            {
                tracing::warn!(pipe, error = %e, "snapshot pipe forwarder failed after abort");
                return false;
            }
            true
        }
    }
}

pub(super) const SPAWN_INNER_CMD: &str = r#"mount --bind "$1" "$2" && mount --bind "$3" "$4" && exec ip netns exec "$5" "$6" --api-sock "$7""#;
pub(super) const UNSHARE_MOUNT_ARGS: &[&str] = &["--mount", "--propagation", "private"];

/// Number of recent stderr lines retained from the spawn chain, used to
/// surface the underlying cause when the chain (`unshare → bash → ip netns
/// exec → firecracker`) exits before the API socket appears. 32 is enough
/// for a typical mount/unshare/netns error plus a few lines of bash/kernel
/// noise, far less than the memory cost warrants worrying about.
pub(super) const STDERR_BUF_LINES: usize = 32;

/// Time granted to the stderr forwarder task to drain buffered lines after
/// the spawn chain has been observed to exit. Kept small: if the forwarder
/// hasn't caught up in 100ms after the pipe's write end closed, the buffer
/// we have is what the operator sees.
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Cancellation finalizer child reap budget after SIGKILL. This is a fallback
/// path: keep it bounded so a cancelled snapshot cannot pin cleanup forever.
pub(super) const SNAPSHOT_FINALIZER_CHILD_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Short grace period for stdout/stderr log forwarders after child cleanup.
pub(super) const SNAPSHOT_FINALIZER_PIPE_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Shared bounded ring buffer of recent stderr lines from the spawn chain.
pub(super) type StderrBuf = Arc<Mutex<VecDeque<String>>>;

/// Drain the captured stderr lines into a single newline-joined string.
/// Used in error reporting when the spawn chain exits prematurely; always
/// returns a non-empty string so the operator never sees a bare error.
fn drain_stderr_buf(buf: &StderrBuf) -> String {
    match buf.lock() {
        Ok(g) => {
            if g.is_empty() {
                "<no stderr captured>".to_string()
            } else {
                g.iter().cloned().collect::<Vec<_>>().join("\n")
            }
        }
        Err(_) => {
            // Poisoning means the stderr forwarder task panicked while
            // holding the lock — a real bug signal worth surfacing
            // independently of the error message that carries this sentinel.
            tracing::warn!("stderr buffer mutex poisoned during forwarder task");
            "<stderr buffer poisoned>".to_string()
        }
    }
}

/// If the snapshot workflow returned an API error AND the firecracker
/// spawn chain (unshare → bash → ip netns exec → firecracker) has
/// already exited with a non-zero status, re-wrap the error with the
/// captured stderr so the operator sees the underlying cause (e.g.
/// `mount: bind failed`) instead of a generic API timeout.
///
/// In every other case the original result is returned unchanged:
/// - `Ok(_)`: success — no rewrap.
/// - `Err(non-Api)`: the error is already specific (Setup / Vsock / Io /
///   Process) and shouldn't be replaced.
/// - `Ok(None)` child status: firecracker is still running, so the API
///   error is about API behavior, not a crashed spawn chain.
/// - `Ok(Some(success))` child status: firecracker exited cleanly (rare
///   at this point), not a mount/setup failure.
/// - `Err(_)` child status: `try_wait` failed for an unrelated reason
///   (EINTR, etc.); stay conservative and keep the original error.
pub(super) fn rewrap_spawn_chain_exit(
    result: Result<SnapshotConfig, SnapshotError>,
    child_status: std::io::Result<Option<std::process::ExitStatus>>,
    stderr_buf: &StderrBuf,
) -> Result<SnapshotConfig, SnapshotError> {
    match (result, child_status) {
        (Err(SnapshotError::Api(api_err)), Ok(Some(status))) if !status.success() => {
            let stderr = drain_stderr_buf(stderr_buf);
            Err(SnapshotError::Process(format!(
                "firecracker spawn chain exited (status={status}): {stderr} \
                 (original API error: {api_err})"
            )))
        }
        (other, _) => other,
    }
}

pub(super) async fn run_snapshot_workflow(
    config: &SnapshotCreateConfig,
    attempt: &mut SnapshotAttempt,
) -> Result<SnapshotConfig, SnapshotError> {
    attempt.prepare_firecracker_files(config).await?;
    attempt.acquire_network().await?;
    attempt.spawn_firecracker(config).await?;

    // Guard: ensure Firecracker and netns cleanup on any explicit exit path.
    let result = run_with_firecracker(
        config,
        attempt.paths(),
        attempt.sock_paths()?,
        attempt.output(),
    )
    .await;
    attempt.finish_runtime_after_workflow(result).await
}

/// Inner workflow that runs while Firecracker is alive.
async fn run_with_firecracker(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    output: &SnapshotOutputPaths,
) -> Result<SnapshotConfig, SnapshotError> {
    // 5. Wait for API socket ready.
    let api_sock = sock_paths.api_sock();
    let client = ApiClient::new(&api_sock);
    client.wait_for_ready(API_READY_TIMEOUT).await?;

    info!("firecracker API ready");

    let inv = InvariantConfig::new();
    let vsock_uds_str = configure_snapshot_vm(&client, config, paths, sock_paths, &inv).await?;

    info!("VM configured");

    // 7. Bind vsock listener BEFORE starting the instance (race: guest connects ~300ms after boot).
    let vsock_path_for_listen = vsock_uds_str.clone();
    let vsock_task = AbortOnDropTask::new(tokio::spawn(async move {
        vsock_host::VsockHost::wait_for_connection(&vsock_path_for_listen, VSOCK_CONNECT_TIMEOUT)
            .await
    }));

    // 8. Start instance.
    let start_result = client.start_instance().await;
    if let Err(e) = start_result {
        vsock_task.abort();
        let _ = vsock_task.await;
        return Err(e.into());
    }

    info!("instance started, waiting for guest vsock connection");

    // 9. Wait for guest to connect via vsock.
    let guest = match vsock_task.await {
        Ok(Ok(g)) => g,
        Ok(Err(e)) => return Err(SnapshotError::Vsock(e.to_string())),
        Err(e) => return Err(SnapshotError::Vsock(format!("vsock task: {e}"))),
    };

    info!("guest connected");

    // 9.5. Pre-warm caches (PAM/nsswitch, CLI modules) so post-restore calls
    //      are fast. The snapshot captures memory + disk state, so caches
    //      populated here persist across restores.
    let prewarm_result = guest
        .exec_capture(vsock_host::ExecCaptureRequest {
            command: inv.prewarm_script,
            timeout_ms: 30_000,
            env: &[],
            sudo: false,
            label: "snapshot-prewarm",
            stdout_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(35_000),
        })
        .await
        .map_err(|e| SnapshotError::Setup(format!("pre-warm exec: {e}")))?;
    if prewarm_result.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&prewarm_result.stderr);
        return Err(SnapshotError::Setup(format!(
            "pre-warm failed (exit code {}): {}",
            prewarm_result.exit_code,
            stderr.trim(),
        )));
    }
    info!("pre-warm complete");

    // 10. Pause VM.
    client.pause().await?;

    info!("VM paused");

    // 11. Create snapshot — Firecracker writes directly to output_dir.
    //
    // File content durability is guaranteed upstream: as of Firecracker
    // v1.15.1 (see `FIRECRACKER_VERSION` in `runner/src/deps.rs`), both
    // snapshot.bin and memory.bin are flushed and fsynced before the API
    // response returns. References (pinned to the v1.15.1 tag):
    //   - `snapshot_state_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.15.1/src/vmm/src/persist.rs
    //   - `snapshot_memory_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.15.1/src/vmm/src/vstate/vm.rs
    // Re-verify this guarantee whenever `FIRECRACKER_VERSION` is bumped;
    // if it ever regresses, add a host-side `sync_all` on both files here.
    // Directory-entry durability (persisting the `name → inode` mapping)
    // is handled separately; see #9825.
    let snapshot_str = output.snapshot().display().to_string();
    let memory_str = output.memory().display().to_string();
    client.create_snapshot(&snapshot_str, &memory_str).await?;

    info!("snapshot created");

    info!(output_dir = %config.output_dir.display(), "snapshot creation complete");

    Ok(output.snapshot_config(&config.id))
}

async fn configure_snapshot_vm(
    client: &ApiClient<'_>,
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    inv: &InvariantConfig,
) -> Result<String, SnapshotError> {
    // The COW-device bind mount was established inside `unshare --mount`
    // at spawn time; `configure_drive` only needs the path string FC will
    // open inside its private mount namespace.
    let drive_bind_str = paths.cow_device_bind().display().to_string();
    let workspace_drive_bind_str = paths.workspace_device_bind().display().to_string();

    // 6. Configure VM via API. Keep drive requests ordered so snapshot creation
    // matches the fresh-boot config path: rootfs first, workspace second.
    let kernel_path = config.kernel_path.display().to_string();
    tokio::fs::create_dir_all(&sock_paths.vsock_dir()).await?;
    let vsock_uds_str = sock_paths.vsock().display().to_string();

    client
        .configure_drive("rootfs", &drive_bind_str, true, false, None)
        .await?;
    client
        .configure_drive("workspace", &workspace_drive_bind_str, false, false, None)
        .await?;

    tokio::try_join!(
        client.configure_machine(config.vcpu_count, config.memory_mb),
        client.configure_boot_source(&kernel_path, &inv.boot_args),
        client.configure_network_interface(inv.iface_id, inv.guest_mac, inv.tap_name, None, None),
        client.configure_vsock(inv.guest_cid, &vsock_uds_str),
        client.configure_balloon(
            inv.balloon.amount_mib,
            inv.balloon.deflate_on_oom,
            inv.balloon.stats_polling_interval_s
        ),
    )?;

    Ok(vsock_uds_str)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use crate::api::ApiError;
    use crate::config::SnapshotConfig;
    use crate::snapshot::SnapshotError;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{UnixListener, UnixStream};
    use tokio::sync::mpsc;

    use super::*;

    const MOCK_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

    #[derive(Debug)]
    struct RecordedRequest {
        method: String,
        path: String,
    }

    struct RecordingFirecrackerApi {
        _dir: tempfile::TempDir,
        socket_path: PathBuf,
        requests: mpsc::UnboundedReceiver<RecordedRequest>,
        server: tokio::task::JoinHandle<()>,
    }

    impl RecordingFirecrackerApi {
        fn spawn() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let socket_path = dir.path().join("fc.sock");
            let listener = UnixListener::bind(&socket_path).expect("bind mock Firecracker API");
            let (tx, requests) = mpsc::unbounded_channel();
            let server = tokio::spawn(async move {
                serve_recording_api(listener, tx).await;
            });

            Self {
                _dir: dir,
                socket_path,
                requests,
                server,
            }
        }

        fn socket_path(&self) -> &std::path::Path {
            &self.socket_path
        }

        async fn next_request(&mut self) -> RecordedRequest {
            tokio::time::timeout(MOCK_REQUEST_TIMEOUT, self.requests.recv())
                .await
                .expect("timed out waiting for Firecracker API request")
                .expect("mock Firecracker API stopped before request")
        }
    }

    impl Drop for RecordingFirecrackerApi {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    async fn serve_recording_api(
        listener: UnixListener,
        tx: mpsc::UnboundedSender<RecordedRequest>,
    ) {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let Ok(request) = read_recorded_request(&mut stream).await else {
                continue;
            };
            if tx.send(request).is_err() {
                break;
            }
            let _ = stream
                .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .await;
        }
    }

    async fn read_recorded_request(stream: &mut UnixStream) -> std::io::Result<RecordedRequest> {
        let mut buf = Vec::with_capacity(4096);
        while header_end(&buf).is_none() {
            let read = stream.read_buf(&mut buf).await?;
            if read == 0 {
                break;
            }
        }
        let header_end = header_end(&buf).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request missing header terminator",
            )
        })?;
        let headers = String::from_utf8_lossy(&buf[..header_end.saturating_sub(4)]);
        let request_line = headers.lines().next().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request missing request line",
            )
        })?;
        let mut parts = request_line.split_whitespace();
        let method = parts
            .next()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "missing method"))?
            .to_owned();
        let path = parts
            .next()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "missing path"))?
            .to_owned();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.trim()
                    .eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let body_start = header_end;
        let target_len = body_start + content_length;
        while buf.len() < target_len {
            let read = stream.read_buf(&mut buf).await?;
            if read == 0 {
                break;
            }
        }

        Ok(RecordedRequest { method, path })
    }

    fn header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|idx| idx + 4)
    }

    fn snapshot_create_config(output_dir: PathBuf) -> SnapshotCreateConfig {
        SnapshotCreateConfig {
            id: "snapshot-test".into(),
            binary_path: PathBuf::from("/tmp/firecracker"),
            kernel_path: PathBuf::from("/tmp/vmlinux"),
            rootfs_path: PathBuf::from("/tmp/rootfs.ext4"),
            output_dir,
            vcpu_count: 2,
            memory_mb: 512,
            workspace_disk_mb: 1024,
        }
    }

    #[tokio::test]
    async fn configure_snapshot_vm_orders_rootfs_before_workspace_drive() {
        let mut api = RecordingFirecrackerApi::spawn();
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = SandboxPaths::new(dir.path().join("work"));
        let sock_paths = SockPaths::new(dir.path().join("sock"));
        let client = ApiClient::new(api.socket_path());
        let config = snapshot_create_config(dir.path().join("snapshot-output"));
        let inv = InvariantConfig::new();

        tokio::time::timeout(
            MOCK_REQUEST_TIMEOUT,
            configure_snapshot_vm(&client, &config, &paths, &sock_paths, &inv),
        )
        .await
        .expect("snapshot VM configuration should finish")
        .expect("snapshot VM configuration should succeed");

        let mut requests = Vec::new();
        for _ in 0..7 {
            requests.push(api.next_request().await);
        }

        assert_eq!(requests[0].method, "PUT");
        assert_eq!(requests[0].path, "/drives/rootfs");
        assert_eq!(requests[1].method, "PUT");
        assert_eq!(requests[1].path, "/drives/workspace");

        let mut paths: Vec<&str> = requests
            .iter()
            .map(|request| request.path.as_str())
            .collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            [
                "/balloon",
                "/boot-source",
                "/drives/rootfs",
                "/drives/workspace",
                "/machine-config",
                "/network-interfaces/eth0",
                "/vsock",
            ]
        );
    }

    #[tokio::test]
    async fn abort_on_drop_task_aborts_vsock_listener() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = dir.path().join("snapshot-vsock");
        let listener =
            std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
        let base = base.display().to_string();

        let task = AbortOnDropTask::new(tokio::spawn(async move {
            vsock_host::VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
        }));

        tokio::time::timeout(Duration::from_secs(1), async {
            while !listener.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("vsock listener should bind");

        drop(task);

        tokio::time::timeout(Duration::from_secs(1), async {
            while listener.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped task should abort and remove vsock listener");
    }

    #[tokio::test]
    async fn abort_on_drop_task_explicit_abort_removes_vsock_listener() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = dir.path().join("snapshot-vsock-explicit-abort");
        let listener =
            std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
        let base = base.display().to_string();

        let task = AbortOnDropTask::new(tokio::spawn(async move {
            vsock_host::VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
        }));

        tokio::time::timeout(Duration::from_secs(1), async {
            while !listener.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("vsock listener should bind");

        task.abort();
        let join = task.await;
        assert!(
            join.is_err_and(|e| e.is_cancelled()),
            "explicit abort should cancel the listener task"
        );

        assert!(
            !listener.exists(),
            "explicit abort should remove the vsock listener socket"
        );
    }

    #[tokio::test]
    async fn drain_stderr_forwarder_after_spawn_exit_waits_for_failed_status() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let drained = Arc::new(AtomicBool::new(false));
        let drained_for_task = Arc::clone(&drained);
        let handle = tokio::spawn(async move {
            drained_for_task.store(true, Ordering::SeqCst);
        });

        let returned =
            drain_stderr_forwarder_after_spawn_exit(&Ok(Some(exit_status_nonzero())), Some(handle))
                .await;

        assert!(returned.is_none());
        assert!(drained.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn drain_stderr_forwarder_after_spawn_exit_preserves_other_handles() {
        async fn assert_handle_preserved(
            child_status: std::io::Result<Option<std::process::ExitStatus>>,
        ) {
            let handle = tokio::spawn(std::future::pending::<()>());

            let returned = drain_stderr_forwarder_after_spawn_exit(&child_status, Some(handle))
                .await
                .expect("handle should be preserved");

            assert!(
                !returned.is_finished(),
                "helper should not join or abort the forwarder"
            );
            returned.abort();
            let _ = returned.await;
        }

        assert_handle_preserved(Ok(None)).await;
        assert_handle_preserved(Ok(Some(exit_status_zero()))).await;
        assert_handle_preserved(Err(std::io::Error::from(std::io::ErrorKind::Interrupted))).await;
    }

    /// Empty stderr buffer should produce a sentinel string rather than
    /// an empty error body. Verifies the early-exit error path is
    /// always informative even with no captured output.
    #[test]
    fn drain_stderr_buf_reports_empty_with_sentinel() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        let s = drain_stderr_buf(&buf);
        assert!(s.contains("no stderr"), "got: {s}");
    }

    /// Captured lines are joined with newlines in insertion order.
    #[test]
    fn drain_stderr_buf_joins_lines() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            g.push_back("mount: bind failed".into());
            g.push_back("exit code 32".into());
        }
        assert_eq!(drain_stderr_buf(&buf), "mount: bind failed\nexit code 32");
    }

    /// Boundary: exactly `STDERR_BUF_LINES` entries — no eviction should
    /// have happened, and all lines (including `line 0`) must be present.
    /// Guards against off-by-one in the `if len == N { pop_front }` check.
    #[test]
    fn drain_stderr_buf_handles_exact_capacity() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            for i in 0..STDERR_BUF_LINES {
                if g.len() == STDERR_BUF_LINES {
                    g.pop_front();
                }
                g.push_back(format!("line {i}"));
            }
        }
        let joined = drain_stderr_buf(&buf);
        assert!(
            joined.contains("line 0"),
            "line 0 should survive at exact capacity: {joined}"
        );
        assert!(
            joined.contains(&format!("line {}", STDERR_BUF_LINES - 1)),
            "last line should be present: {joined}"
        );
    }

    /// Ring buffer drops oldest entries past the bound, keeping only the
    /// most recent N lines — the relevant ones for diagnosing a recent crash.
    #[test]
    fn drain_stderr_buf_keeps_only_recent_lines_when_overflowing() {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            // Simulate the same eviction policy used by the stderr forwarder.
            for i in 0..(STDERR_BUF_LINES + 5) {
                if g.len() == STDERR_BUF_LINES {
                    g.pop_front();
                }
                g.push_back(format!("line {i}"));
            }
        }
        let joined = drain_stderr_buf(&buf);
        assert!(
            !joined.contains("line 0"),
            "oldest line should be evicted: {joined}"
        );
        assert!(
            joined.contains(&format!("line {}", STDERR_BUF_LINES + 4)),
            "newest line should be retained: {joined}"
        );
    }

    /// Build a placeholder `SnapshotConfig` for `Ok(_)` rewrap cases.
    /// Values are irrelevant — the rewrap helper never inspects them.
    fn placeholder_snapshot_config() -> SnapshotConfig {
        SnapshotConfig {
            snapshot_path: "/tmp/snapshot.bin".into(),
            memory_path: "/tmp/memory.bin".into(),
            cow_path: "/tmp/cow.img".into(),
            drive_bind_path: "/tmp/cow-device-bind".into(),
            workspace_drive_bind_path: "/tmp/workspace-device-bind".into(),
            vsock_bind_dir: "/tmp/vsock".into(),
        }
    }

    /// Build a `std::process::ExitStatus` with a given raw value. On Unix
    /// this encodes: `raw = (exit_code << 8) | signal`. Using
    /// `ExitStatus::from_raw(0x100)` yields exit code 1 / success=false.
    fn exit_status_nonzero() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0x100)
    }

    fn exit_status_zero() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }

    fn stderr_buf_with_lines(lines: &[&str]) -> StderrBuf {
        let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
        {
            let mut g = buf.lock().expect("lock");
            for line in lines {
                g.push_back((*line).to_string());
            }
        }
        buf
    }

    /// The target case: API error + child already exited non-zero → rewrap
    /// into a Process error that names the captured stderr.
    #[test]
    fn rewrap_replaces_api_error_when_child_exited_nonzero() {
        let api_err = ApiError::Other("timeout".into());
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(api_err)),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&["mount: bind failed", "exit 32"]),
        )
        .unwrap_err();
        match err {
            SnapshotError::Process(msg) => {
                assert!(msg.contains("mount: bind failed"), "got: {msg}");
                assert!(msg.contains("exit 32"), "got: {msg}");
                assert!(msg.contains("original API error"), "got: {msg}");
                // Exit status must appear in the message — operators need it
                // to distinguish `exit 1` (mount denied) from `signal 9`
                // (OOM kill) from `exit 32` (mount target missing).
                assert!(msg.contains("status="), "should include exit status: {msg}");
            }
            other => panic!("expected Process error, got {other:?}"),
        }
    }

    /// Even when the stderr buffer is empty, the rewrapped message should
    /// still be informative — falling back to the `<no stderr captured>`
    /// sentinel rather than a bare `status=...:  (original ...)` string.
    #[test]
    fn rewrap_uses_sentinel_when_stderr_empty() {
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&[]),
        )
        .unwrap_err();
        match err {
            SnapshotError::Process(msg) => {
                assert!(
                    msg.contains("no stderr"),
                    "should fall back to sentinel when buffer is empty: {msg}"
                );
                assert!(msg.contains("status="), "got: {msg}");
            }
            other => panic!("expected Process error, got {other:?}"),
        }
    }

    /// `try_wait` itself returning `Err` (EINTR or similar) must not be
    /// mistaken for "spawn chain exited" — stay conservative and keep the
    /// original error instead of asserting something we couldn't observe.
    #[test]
    fn rewrap_preserves_api_error_when_try_wait_fails() {
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
            Err(std::io::Error::from(std::io::ErrorKind::Interrupted)),
            &stderr_buf_with_lines(&["would-be-rewrapped"]),
        )
        .unwrap_err();
        assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
    }

    /// FC is still running (try_wait → None) → API error is genuine, keep it.
    #[test]
    fn rewrap_preserves_api_error_when_child_still_running() {
        let api_err = ApiError::Other("misconfigured".into());
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(api_err)),
            Ok(None),
            &stderr_buf_with_lines(&[]),
        )
        .unwrap_err();
        assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
    }

    /// FC exited with code 0 (rare but possible) → not a mount-style crash.
    #[test]
    fn rewrap_preserves_api_error_when_child_exited_zero() {
        let api_err = ApiError::Other("timeout".into());
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Api(api_err)),
            Ok(Some(exit_status_zero())),
            &stderr_buf_with_lines(&["noise"]),
        )
        .unwrap_err();
        assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
    }

    /// Non-API errors already carry their specific cause and should not
    /// be replaced by a generic "spawn chain exited" message.
    #[test]
    fn rewrap_preserves_non_api_errors() {
        let err = rewrap_spawn_chain_exit(
            Err(SnapshotError::Setup("pre-warm failed".into())),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&["stderr junk"]),
        )
        .unwrap_err();
        match err {
            SnapshotError::Setup(msg) => assert_eq!(msg, "pre-warm failed"),
            other => panic!("expected Setup error, got {other:?}"),
        }
    }

    /// `Ok(_)` passes through untouched.
    #[test]
    fn rewrap_passes_ok_through() {
        let result = rewrap_spawn_chain_exit(
            Ok(placeholder_snapshot_config()),
            Ok(Some(exit_status_nonzero())),
            &stderr_buf_with_lines(&["noise"]),
        );
        assert!(result.is_ok(), "ok should pass through");
    }

    /// Structural assertion that the unshare inner_cmd uses positional
    /// parameters (no path interpolation that could shell-inject) and
    /// performs the bind-then-exec sequence.
    ///
    /// The bind mount must run inside `unshare --mount` so it auto-cleans
    /// when the FC process dies — see issue #9494. This test guards against
    /// refactor regressions before the kernel-interaction CI job runs.
    #[test]
    fn spawn_inner_cmd_uses_positional_args() {
        // Only positional args, no $0 or unquoted vars.
        assert!(!SPAWN_INNER_CMD.contains("$0"));
        for arg in ["$1", "$2", "$3", "$4", "$5", "$6", "$7"] {
            let quoted = format!(r#""{arg}""#);
            assert!(
                SPAWN_INNER_CMD.contains(&quoted),
                "expected quoted positional {arg} in inner_cmd: {SPAWN_INNER_CMD}"
            );
        }
        // Strictly 7 positional args — if someone adds a `$8`..`$9` without
        // updating the spawn site's `.arg(...)` count, the bash call
        // silently expands to empty strings and fails at runtime.
        for unexpected in ["$8", "$9"] {
            assert!(
                !SPAWN_INNER_CMD.contains(unexpected),
                "unexpected positional {unexpected} in inner_cmd: {SPAWN_INNER_CMD}"
            );
        }

        // Flow: bind the device, then exec into ip netns exec firecracker.
        // `exec` is critical so signals reach FC directly without an extra
        // bash layer holding a process slot.
        assert!(
            SPAWN_INNER_CMD.starts_with("mount --bind"),
            "inner_cmd must establish bind mount first: {SPAWN_INNER_CMD}"
        );
        assert!(
            SPAWN_INNER_CMD.contains("&& exec ip netns exec"),
            "inner_cmd must exec ip netns exec firecracker: {SPAWN_INNER_CMD}"
        );
    }

    #[test]
    fn snapshot_create_unshare_uses_private_mount_propagation() {
        assert_eq!(UNSHARE_MOUNT_ARGS, ["--mount", "--propagation", "private"]);
    }
}
