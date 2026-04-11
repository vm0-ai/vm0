use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncBufReadExt;
use tracing::info;

use nbd_cow::NbdCowDevice;
use sandbox::{SnapshotCreateConfig, SnapshotOutput, SnapshotProvider};

use crate::api::{ApiClient, ApiError};
use crate::command;
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
    #[error("api error: {0}")]
    Api(#[from] ApiError),
    #[error("vsock connection failed: {0}")]
    Vsock(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
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
/// 10. Pause VM
/// 11. Create snapshot
/// 12. Move COW file to output dir
/// 13. Cleanup (kill Firecracker, destroy netns, release base image)
pub async fn create_snapshot(
    config: SnapshotCreateConfig,
) -> Result<SnapshotConfig, SnapshotError> {
    // Check prerequisites (binary, kernel, rootfs, kvm, runtime dir, etc.).
    prerequisites::check_prerequisites(&prerequisites::PrerequisiteConfig {
        binary_path: &config.binary_path,
        kernel_path: &config.kernel_path,
        rootfs_path: &config.rootfs_path,
        snapshot: None,
    })
    .await
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    let output = SnapshotOutputPaths::new(config.output_dir.clone());

    // 1. Clean stale snapshot output from a previous failed attempt and create work dir.
    //    Paths inside work_dir get baked into the snapshot and are used
    //    as bind-mount targets during restore, so they must be deterministic.
    //
    //    Only remove snapshot-specific artifacts (work/, snapshot.bin, memory.bin,
    //    cow.img) — the output directory may contain other files (e.g. rootfs.ext4
    //    in unified image builds) that must not be deleted.
    //
    //    A failed run may leave stale bind mounts (cow-device-bind) that
    //    cause rm to fail with EBUSY — umount them first.
    let work = output.work_dir();
    let stale_bind = SandboxPaths::new(work.clone())
        .cow_device_bind()
        .display()
        .to_string();
    command::exec_ignore_errors("umount", &[stale_bind.as_str()]).await;

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
    let mut netns_pool = NetnsPool::create(NetnsPoolConfig {
        proxy_port: None,
        dns_port: None,
    })
    .await
    .map_err(|e| SnapshotError::Setup(format!("netns pool: {e}")))?;

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

/// Inner workflow, separated so the caller can always run cleanup.
async fn run_snapshot_workflow(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    output: &SnapshotOutputPaths,
    netns_pool: &mut NetnsPool,
    mut cow_device: NbdCowDevice,
) -> Result<SnapshotConfig, SnapshotError> {
    let network = netns_pool
        .acquire()
        .await
        .map_err(|e| SnapshotError::Setup(format!("acquire netns: {e}")))?;

    info!(netns = %network.name, "namespace acquired");

    // 4. Create socket directory and spawn Firecracker with --api-sock in the namespace.
    tokio::fs::create_dir_all(sock_paths.dir())
        .await
        .map_err(|e| SnapshotError::Setup(format!("mkdir sock dir: {e}")))?;
    let api_sock = sock_paths.api_sock();
    info!(
        netns = %network.name,
        binary = %config.binary_path.display(),
        api_sock = %api_sock.display(),
        "spawning firecracker"
    );

    let mut child = tokio::process::Command::new("ip")
        .args(["netns", "exec"])
        .arg(&network.name)
        .arg(&config.binary_path)
        .args(["--api-sock"])
        .arg(&api_sock)
        .current_dir(paths.workspace())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| SnapshotError::Process(format!("spawn firecracker: {e}")))?;

    // Stream stdout/stderr lines to tracing (same pattern as sandbox.rs).
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
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    tracing::warn!(target: "firecracker", "stderr: {line}");
                }
            }
        });
    }

    // Guard: ensure process and bind mount cleanup on any exit path.
    let result = run_with_firecracker(config, paths, sock_paths, output, &mut cow_device).await;

    // Kill Firecracker first — it holds the NBD device fd open.
    kill_process_group(&child);
    let _ = child.wait().await;

    // Release network namespace back to the pool before teardown.
    // Without this, the namespace resources (veth, iptables) leak
    // because cleanup() only drains queued (unused) namespaces.
    if let Err(e) = netns_pool.release(network).await {
        tracing::warn!(error = %e, "failed to release netns");
    }

    // Tear down: umount bind mount, then destroy NBD COW device.
    //
    // Both steps may fail transiently — after kill_process_group + child.wait(),
    // the kernel may still be releasing the NBD device fd and bind mount
    // reference. Retry both in a loop until all references are released.
    let drive_bind_str = paths.cow_device_bind().display().to_string();

    if result.is_ok() {
        let cow_file = cow_device.cow_file().to_owned();
        let mut last_err = None;
        for attempt in 0..DESTROY_RETRIES {
            // Umount the bind mount first (may fail if FC still holds a ref).
            command::exec_ignore_errors("umount", &[drive_bind_str.as_str()]).await;

            match cow_device.destroy_keep_cow().await {
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    if attempt + 1 < DESTROY_RETRIES {
                        last_err = Some(e);
                        tokio::time::sleep(DESTROY_RETRY_DELAY).await;
                    } else {
                        tracing::warn!(
                            error = %e,
                            "destroy_keep_cow failed after {DESTROY_RETRIES} attempts"
                        );
                        last_err = Some(e);
                    }
                }
            }
        }
        if last_err.is_some() {
            // Last resort: abandon the device. It persists in the kernel
            // until `runner gc` cleans it up. Does NOT delete the COW file.
            cow_device.abandon();
        }
        tokio::fs::rename(&cow_file, &output.cow()).await?;
        // Also move the bitmap sidecar if it exists (for snapshot restore).
        let bitmap_src = std::path::PathBuf::from(format!("{}.bitmap", cow_file.display()));
        if tokio::fs::try_exists(&bitmap_src).await.unwrap_or(false) {
            let bitmap_dst = output.cow_bitmap();
            tokio::fs::rename(&bitmap_src, &bitmap_dst).await?;
        }
    } else {
        // Error path: best-effort umount before Drop cleans up the device.
        command::exec_ignore_errors("umount", &[drive_bind_str.as_str()]).await;
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
    cow_device: &mut NbdCowDevice,
) -> Result<SnapshotConfig, SnapshotError> {
    // 5. Wait for API socket ready.
    let api_sock = sock_paths.api_sock();
    let client = ApiClient::new(&api_sock);
    client.wait_for_ready(API_READY_TIMEOUT).await?;

    info!("firecracker API ready");

    // Bind mount the COW device to a deterministic path so the snapshot
    // records this path (not the ephemeral /dev/nbdN).
    // On restore, the same path is used as the bind mount target.
    let drive_bind = paths.cow_device_bind();
    tokio::fs::write(&drive_bind, b"").await?;
    let cow_device_str = cow_device.device_path().display().to_string();
    let drive_bind_str = drive_bind.display().to_string();
    command::exec("mount", &["--bind", &cow_device_str, &drive_bind_str])
        .await
        .map_err(|e| SnapshotError::Setup(format!("bind mount COW device: {e}")))?;

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
        let sc = create_snapshot(config).await.map_err(|e| match e {
            SnapshotError::Setup(msg) => sandbox::SnapshotError::Setup(msg),
            SnapshotError::Process(msg) => sandbox::SnapshotError::Process(msg),
            SnapshotError::Api(api_err) => sandbox::SnapshotError::Api(api_err.to_string()),
            SnapshotError::Vsock(msg) => sandbox::SnapshotError::Vsock(msg),
            SnapshotError::Io(io_err) => sandbox::SnapshotError::Io(io_err),
        })?;
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
