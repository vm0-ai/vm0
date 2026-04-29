use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncBufReadExt;
use tracing::info;

use nbd_cow::NbdCowDevice;
use sandbox::{SnapshotCreateConfig, SnapshotOutput, SnapshotProvider};

use crate::api::{ApiClient, ApiError};
use crate::config::SnapshotConfig;
use crate::factory::{InvariantConfig, config_hash};
use crate::network::{NetnsPool, NetnsPoolConfig};
use crate::paths::{RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::prerequisites;
use crate::process::kill_process_group;

/// Timeout for waiting for the Firecracker API socket after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

use crate::factory::{DESTROY_RETRIES, DESTROY_RETRY_DELAY};

/// Errors that can occur during snapshot creation.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("setup failed: {0}")]
    Setup(String),
    #[error("firecracker process failed: {0}")]
    Process(String),
    #[error("teardown failed: {0}")]
    Teardown(String),
    #[error("api error: {0}")]
    Api(#[from] ApiError),
    #[error("vsock connection failed: {0}")]
    Vsock(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl SnapshotError {
    fn into_sandbox_error(self) -> sandbox::SnapshotError {
        match self {
            Self::Setup(msg) => sandbox::SnapshotError::Setup(msg),
            Self::Process(msg) => sandbox::SnapshotError::Process(msg),
            Self::Teardown(msg) => sandbox::SnapshotError::Teardown(msg),
            Self::Api(api_err) => sandbox::SnapshotError::Api(api_err.to_string()),
            Self::Vsock(msg) => sandbox::SnapshotError::Vsock(msg),
            Self::Io(io_err) => sandbox::SnapshotError::Io(io_err),
        }
    }
}

/// Create a snapshot by booting a fresh VM, configuring it, and capturing state.
///
/// This is the Rust equivalent of the TS `commands/snapshot.ts` workflow:
///  1. Create work directory
///  2. Create NBD COW device backed by the rootfs image
///  3. Create network namespace
///  4. Spawn Firecracker with `--api-sock`
///  5. Wait for API socket ready
///  6. Configure VM via API (6 parallel PUT calls)
///  7. Bind vsock listener
///  8. Start instance
///  9. Wait for guest vsock connection
/// 10. Pre-warm guest caches (PAM/nsswitch, CLI modules)
/// 11. Pause VM
/// 12. Create snapshot
/// 13. Move COW file + bitmap to output dir
/// 14. Cleanup (kill Firecracker, destroy netns, release base image)
pub async fn create_snapshot(
    config: SnapshotCreateConfig,
) -> Result<SnapshotConfig, SnapshotError> {
    // Check prerequisites (binary, kernel, rootfs, kvm, runtime dir, etc.).
    prerequisites::check_prerequisites(&prerequisites::PrerequisiteConfig {
        binary_path: &config.binary_path,
        kernel_path: &config.kernel_path,
        rootfs_path: &config.rootfs_path,
        mode: prerequisites::PrerequisiteMode::SnapshotCreate,
    })
    .await
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    let output = SnapshotOutputPaths::new(config.output_dir.clone());

    // 1. Clean stale snapshot output from a previous failed attempt and create work dir.
    //    Paths inside work_dir get baked into the snapshot and are used
    //    as bind-mount targets during restore, so they must be deterministic.
    //
    //    Only remove snapshot-specific artifacts (work/, snapshot.bin, memory.bin,
    //    cow.img) — not the entire output directory.
    let work = output.work_dir();

    // Remove stale snapshot artifacts individually (not rm -rf on the
    // entire output directory) — work dir tree first, then individual files.
    let _ = tokio::fs::remove_dir_all(&output.work_dir()).await;
    for stale in [
        output.snapshot(),
        output.memory(),
        output.cow(),
        output.cow_bitmap(),
    ] {
        let _ = tokio::fs::remove_file(&stale).await;
    }
    tokio::fs::create_dir_all(&work).await?;

    // Socket directory under /run, keyed by config id so concurrent builds don't collide.
    let runtime_paths = RuntimePaths::new();
    let sock_dir = runtime_paths.sock_dir(&config.id);
    if sock_dir.exists()
        && let Err(e) = tokio::fs::remove_dir_all(&sock_dir).await
    {
        tracing::warn!(error = %e, "failed to clean stale sock dir");
    }

    let paths = SandboxPaths::new(work);
    let sock_paths = SockPaths::new(sock_dir.clone());

    info!(work_dir = %paths.workspace().display(), "starting snapshot creation");

    // Validate network prerequisites before allocating an NBD device. The
    // actual namespace pool is still created after the device so the workflow
    // order stays the same, but this keeps pure host-command failures from
    // falling onto the NBD best-effort Drop path.
    let netns_config = NetnsPoolConfig {
        proxy_port: None,
        dns_port: None,
    }
    .into_checked()
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    // 2. Create NBD COW device backed by the rootfs image.
    let cow_file = paths.workspace().join("cow.img");
    let base_size = tokio::fs::metadata(&config.rootfs_path)
        .await
        .map_err(|e| SnapshotError::Setup(format!("base image metadata: {e}")))?
        .len();

    // Create sparse COW file.
    {
        let f = std::fs::File::create(&cow_file)
            .map_err(|e| SnapshotError::Setup(format!("create COW file: {e}")))?;
        f.set_len(base_size)
            .map_err(|e| SnapshotError::Setup(format!("set COW file size: {e}")))?;
    }

    let device_pool = tokio::sync::Mutex::new(nbd_cow::pool::DevicePool::new(
        nbd_cow::pool::DevicePoolConfig::default(),
    ));
    device_pool.lock().await.warmup().await;
    let cow_device = NbdCowDevice::create(&config.rootfs_path, &cow_file, base_size, &device_pool)
        .await
        .map_err(|e| SnapshotError::Setup(format!("create NBD COW device: {e}")))?;

    let device_index = cow_device.device_index();
    info!(device = %cow_device.device_path().display(), "NBD COW device created");

    // 3. Create network namespace (pool of 1, index auto-allocated via flock).
    let mut netns_pool = match NetnsPool::create_checked(netns_config).await {
        Ok(pool) => pool,
        Err(e) => {
            drop(cow_device);
            let mut pool = device_pool.lock().await;
            pool.release(device_index);
            pool.cleanup().await;
            drop(pool);
            if let Err(cleanup_err) = tokio::fs::remove_dir_all(&sock_dir).await {
                tracing::warn!(
                    error = %cleanup_err,
                    "failed to cleanup sock dir after netns pool failure"
                );
            }
            return Err(SnapshotError::Setup(format!("netns pool: {e}")));
        }
    };

    // Guard: ensure netns cleanup on any exit path.
    let result = run_snapshot_workflow(
        &config,
        &paths,
        &sock_paths,
        &output,
        &mut netns_pool,
        cow_device,
    )
    .await;

    // Release device index back to pool before cleanup.
    let mut pool = device_pool.lock().await;
    pool.release(device_index);
    pool.cleanup().await;
    drop(pool);
    if let Err(e) = netns_pool.cleanup().await {
        tracing::warn!(error = %e, "failed to cleanup netns pool");
    }

    // Cleanup runtime socket directory.
    if let Err(e) = tokio::fs::remove_dir_all(&sock_dir).await {
        tracing::warn!(error = %e, "failed to cleanup sock dir");
    }

    result
}

/// Bash command run inside `unshare --mount` to bind the COW device into a
/// private mount namespace and exec Firecracker. Positional args are:
///   $1 = cow device path (e.g. /dev/nbdN)
///   $2 = bind target path (cow-device-bind regular file)
///   $3 = network namespace name
///   $4 = firecracker binary path
///   $5 = api socket path
///
/// The `&&` is load-bearing: if `mount --bind` fails, the chain short-circuits
/// and bash exits with a non-zero status. This is what lets us detect spawn
/// failures via `child.try_wait()` instead of an opaque API-ready timeout.
const SPAWN_INNER_CMD: &str =
    r#"mount --bind "$1" "$2" && exec ip netns exec "$3" "$4" --api-sock "$5""#;
const UNSHARE_MOUNT_ARGS: &[&str] = &["--mount", "--propagation", "private"];

/// Number of recent stderr lines retained from the spawn chain, used to
/// surface the underlying cause when the chain (`unshare → bash → ip netns
/// exec → firecracker`) exits before the API socket appears. 32 is enough
/// for a typical mount/unshare/netns error plus a few lines of bash/kernel
/// noise, far less than the memory cost warrants worrying about.
const STDERR_BUF_LINES: usize = 32;

/// Time granted to the stderr forwarder task to drain buffered lines after
/// the spawn chain has been observed to exit. Kept small: if the forwarder
/// hasn't caught up in 100ms after the pipe's write end closed, the buffer
/// we have is what the operator sees.
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Shared bounded ring buffer of recent stderr lines from the spawn chain.
type StderrBuf = Arc<Mutex<VecDeque<String>>>;

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
fn rewrap_spawn_chain_exit(
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

/// Inner workflow, separated so the caller can always run cleanup.
async fn run_snapshot_workflow(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    output: &SnapshotOutputPaths,
    netns_pool: &mut NetnsPool,
    mut cow_device: NbdCowDevice,
) -> Result<SnapshotConfig, SnapshotError> {
    // Filesystem pre-requisites that don't require the netns: do these
    // *before* `netns_pool.acquire()` so that a transient fs error
    // (mkdir, write) doesn't leak an acquired netns. `PooledNetns` has
    // no Drop impl — release must be explicit, and `netns_pool.cleanup()`
    // only drains queued (not acquired) entries.
    //
    // The empty bind target file is consumed by `mount --bind` inside
    // `unshare --mount` at spawn time; file content is irrelevant
    // because the bind overlay is what FC reads.
    tokio::fs::create_dir_all(sock_paths.dir())
        .await
        .map_err(|e| SnapshotError::Setup(format!("mkdir sock dir: {e}")))?;
    let api_sock = sock_paths.api_sock();

    let drive_bind = paths.cow_device_bind();
    tokio::fs::write(&drive_bind, b"")
        .await
        .map_err(|e| SnapshotError::Setup(format!("create bind target: {e}")))?;

    // 4. Acquire the network namespace and spawn Firecracker into it.
    let network = netns_pool
        .acquire()
        .await
        .map_err(|e| SnapshotError::Setup(format!("acquire netns: {e}")))?;

    info!(netns = %network.name, "namespace acquired");

    info!(
        netns = %network.name,
        binary = %config.binary_path.display(),
        api_sock = %api_sock.display(),
        "spawning firecracker"
    );

    // Spawn Firecracker inside `unshare --mount` so the COW-device bind
    // mount lives in a private mount namespace and dies with the process.
    // Mirrors the spawn pattern in `sandbox.rs::start_from_snapshot`.
    // Inner command is [`SPAWN_INNER_CMD`].
    let cow_device_path = cow_device.device_path().to_path_buf();
    let spawn_result = tokio::process::Command::new("unshare")
        .args(UNSHARE_MOUNT_ARGS)
        .args(["bash", "-c", SPAWN_INNER_CMD, "_"])
        .arg(&cow_device_path) // $1
        .arg(&drive_bind) // $2
        .arg(&network.name) // $3
        .arg(&config.binary_path) // $4
        .arg(&api_sock) // $5
        .current_dir(paths.workspace())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            // Release the netns before returning — `PooledNetns` has no
            // Drop impl, and `netns_pool.cleanup()` (called by the outer
            // `create_snapshot`) only drains queued entries, not
            // already-acquired ones.
            if let Err(re) = netns_pool.release(network).await {
                tracing::warn!(error = %re, "failed to release netns after spawn failure");
            }
            return Err(SnapshotError::Process(format!("spawn firecracker: {e}")));
        }
    };

    // Stream stdout/stderr lines to tracing (same pattern as sandbox.rs).
    // Stderr is also retained in a bounded ring buffer so that an early
    // spawn-chain exit (mount failure inside unshare bash, etc.) can be
    // reported with its real cause instead of just an API timeout.
    let stderr_buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    info!(target: "firecracker", "{line}");
                }
            }
        });
    }
    // The stderr forwarder handle is retained so that, on detected early
    // exit, we can wait a bounded time for it to drain buffered lines
    // before snapshotting the ring buffer for the error message. Without
    // this join, the most informative lines (mount: bind failed, etc.)
    // can race the `try_wait` observation and be missed.
    let stderr_handle = child.stderr.take().map(|stderr| {
        let buf = Arc::clone(&stderr_buf);
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
    });

    // Guard: ensure process and NBD cleanup on any exit path.
    let result = run_with_firecracker(config, paths, sock_paths, output).await;

    // Probe for early spawn-chain exit *before* killing the process. This
    // distinguishes "firecracker is still running, error was an API/setup
    // issue" (try_wait → None) from "firecracker already died, error is
    // the downstream symptom of that" (try_wait → Some(non-zero)).
    let child_status = child.try_wait();
    if matches!(&child_status, Ok(Some(status)) if !status.success())
        && let Some(handle) = stderr_handle
    {
        // Child's write end of stderr is closed; wait briefly for the
        // forwarder to finish reading so the captured buffer contains
        // the crash's final lines.
        let _ = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, handle).await;
    }
    let result = rewrap_spawn_chain_exit(result, child_status, &stderr_buf);

    // Kill Firecracker first — it holds the NBD device fd open.
    kill_process_group(&child);
    let _ = child.wait().await;

    // Release network namespace back to the pool before teardown.
    // Without this, the namespace resources (veth, iptables) leak
    // because cleanup() only drains queued (unused) namespaces.
    if let Err(e) = netns_pool.release(network).await {
        tracing::warn!(error = %e, "failed to release netns");
    }

    // Tear down NBD COW device.
    //
    // After kill_process_group + child.wait(), the kernel may still be
    // releasing the NBD device fd. Retry destroy until all references are
    // released. The COW-device bind mount lived inside the FC process's
    // private mount namespace and was auto-cleaned when the process exited.
    if result.is_ok() {
        let mut last_err = None;
        for attempt in 0..DESTROY_RETRIES {
            match cow_device.destroy_keep_cow().await {
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    if attempt + 1 < DESTROY_RETRIES {
                        tokio::time::sleep(DESTROY_RETRY_DELAY).await;
                    }
                }
            }
        }
        if let Some(e) = last_err {
            // Last resort: abandon the device so Drop is a no-op. It persists
            // in the kernel until `runner gc` cleans it up; the COW file is
            // left in the work dir and will be cleaned up by the next
            // `create_snapshot` run.
            //
            // Fail the snapshot instead of finalizing it: without a successful
            // `destroy_keep_cow` we cannot rely on `save_bitmap` having
            // persisted the dirty bitmap, and renaming the COW file into the
            // output dir without a matching bitmap would produce a snapshot
            // that `is_complete()` reports as valid but silently corrupts
            // restore reads (dirty blocks shadowed by base image). See #9843.
            cow_device.abandon();
            return Err(SnapshotError::Teardown(format!(
                "destroy_keep_cow exhausted retries; device abandoned, snapshot aborted (last error: {e})"
            )));
        }
        // destroy_keep_cow succeeded, so save_bitmap succeeded — the bitmap
        // sidecar is on disk. Rename is unconditional: if the sidecar is
        // missing we want to fail loudly, not silently produce a
        // bitmap-less snapshot.
        let cow_file = cow_device.cow_file();
        let bitmap_src = nbd_cow::cow::bitmap_path_for(cow_file);
        tokio::fs::rename(&bitmap_src, &output.cow_bitmap()).await?;
        tokio::fs::rename(cow_file, &output.cow()).await?;
        // Persist the output directory so all four final dir entries
        // (snapshot.bin and memory.bin written by Firecracker via the API,
        // cow.img and cow.img.bitmap just renamed in) are durable. Without
        // this fsync, rename(2) and Firecracker's creates return once the
        // update is journaled but the entry may not hit disk until the FS's
        // next commit (~5s on ext4 data=ordered). A crash in that window can
        // leave is_complete() returning true while one or more files are
        // missing or rolled back — worst case, cow.img present but
        // cow.img.bitmap absent, which silently corrupts restore reads
        // (same failure class as #9794, one layer up).
        let dir = tokio::fs::File::open(output.dir()).await?;
        dir.sync_all().await?;
    }
    // On error, cow_device is dropped → Drop calls destroy() (best-effort).

    result
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

    // The COW-device bind mount was established inside `unshare --mount`
    // at spawn time; `configure_drive` only needs the path string FC will
    // open inside its private mount namespace.
    let drive_bind_str = paths.cow_device_bind().display().to_string();

    // 6. Configure VM via API (6 parallel PUT calls).
    let inv = InvariantConfig::new();
    let kernel_path = config.kernel_path.display().to_string();
    tokio::fs::create_dir_all(&sock_paths.vsock_dir()).await?;
    let vsock_uds_str = sock_paths.vsock().display().to_string();

    tokio::try_join!(
        client.configure_machine(config.vcpu_count, config.memory_mb),
        client.configure_boot_source(&kernel_path, &inv.boot_args),
        client.configure_drive("rootfs", &drive_bind_str, true, false),
        client.configure_network_interface(inv.iface_id, inv.guest_mac, inv.tap_name),
        client.configure_vsock(inv.guest_cid, &vsock_uds_str),
        client.configure_balloon(
            inv.balloon.amount_mib,
            inv.balloon.deflate_on_oom,
            inv.balloon.stats_polling_interval_s
        ),
    )?;

    info!("VM configured");

    // 7. Bind vsock listener BEFORE starting the instance (race: guest connects ~300ms after boot).
    let vsock_path_for_listen = vsock_uds_str.clone();
    let vsock_task = tokio::spawn(async move {
        vsock_host::VsockHost::wait_for_connection(&vsock_path_for_listen, VSOCK_CONNECT_TIMEOUT)
            .await
    });

    // 8. Start instance.
    let start_result = client.start_instance().await;
    if let Err(e) = start_result {
        vsock_task.abort();
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
        .exec(inv.prewarm_script, 30_000, &[], false)
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
    // v1.14.1 (see `FIRECRACKER_VERSION` in `runner/src/deps.rs`), both
    // snapshot.bin and memory.bin are flushed and fsynced before the API
    // response returns. References (pinned to the v1.14.1 tag):
    //   - `snapshot_state_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.14.1/src/vmm/src/persist.rs
    //   - `snapshot_memory_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.14.1/src/vmm/src/vstate/vm.rs
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

// ---------------------------------------------------------------------------
// SnapshotProvider trait implementation
// ---------------------------------------------------------------------------

/// Firecracker-backed snapshot provider.
///
/// Stateless — can be created with zero cost and used immediately.
pub struct FirecrackerSnapshotProvider;

#[async_trait]
impl SnapshotProvider for FirecrackerSnapshotProvider {
    async fn create_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<SnapshotOutput, sandbox::SnapshotError> {
        let sc = create_snapshot(config)
            .await
            .map_err(SnapshotError::into_sandbox_error)?;
        Ok(SnapshotOutput {
            snapshot_path: sc.snapshot_path,
            memory_path: sc.memory_path,
            cow_path: sc.cow_path,
        })
    }

    fn config_hash(&self) -> String {
        config_hash()
    }

    async fn is_complete(&self, output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
        let output = SnapshotOutputPaths::new(output_dir.to_path_buf());
        for path in [output.snapshot(), output.memory(), output.cow()] {
            let exists = tokio::fs::try_exists(&path).await?;
            if !exists {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for arg in ["$1", "$2", "$3", "$4", "$5"] {
            let quoted = format!(r#""{arg}""#);
            assert!(
                SPAWN_INNER_CMD.contains(&quoted),
                "expected quoted positional {arg} in inner_cmd: {SPAWN_INNER_CMD}"
            );
        }
        // Strictly 5 positional args — if someone adds a `$6`..`$9` without
        // updating the spawn site's `.arg(...)` count, the bash call
        // silently expands to empty strings and fails at runtime.
        for unexpected in ["$6", "$7", "$8", "$9"] {
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
