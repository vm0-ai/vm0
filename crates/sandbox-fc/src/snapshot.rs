use std::path::PathBuf;
use std::time::Duration;

use tokio::io::AsyncBufReadExt;
use tracing::info;

use block_cow::{CowDevice, CowDeviceConfig};

use crate::api::{ApiClient, ApiError};
use crate::command;
use crate::config::SnapshotConfig;
use crate::factory::InvariantConfig;
use crate::network::{NetnsPool, NetnsPoolConfig};
use crate::paths::{RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::prerequisites;
use crate::process;
use crate::process::kill_process_group;

/// Timeout for waiting for the Firecracker API socket after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum attempts to destroy a COW device after killing Firecracker.
/// The inner FC process (via `sudo -u` in netns) may still be exiting.
const DESTROY_RETRIES: usize = 5;

/// Delay between COW device destroy retries during snapshot teardown.
/// Longer than factory destroy (500ms vs 200ms) because snapshot teardown
/// also umounts the bind mount, adding another dependency.
const DESTROY_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Configuration for creating a snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotCreateConfig {
    /// Unique identifier for this snapshot (used for runtime socket directory).
    pub id: String,
    /// Path to the Firecracker binary.
    pub binary_path: PathBuf,
    /// Path to the guest kernel image.
    pub kernel_path: PathBuf,
    /// Path to the root filesystem image.
    pub rootfs_path: PathBuf,
    /// Directory where snapshot artifacts will be written.
    pub output_dir: PathBuf,
    /// Number of vCPUs for the VM.
    pub vcpu_count: u32,
    /// Memory size in MiB for the VM.
    pub memory_mb: u32,
}

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
///  2. Create dm-snapshot COW device
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
/// 13. Cleanup (kill Firecracker, destroy netns)
pub async fn create_snapshot(
    config: SnapshotCreateConfig,
) -> Result<SnapshotConfig, SnapshotError> {
    // Check prerequisites (binary, kernel, rootfs, kvm, sudo, runtime dir, etc.).
    prerequisites::check_prerequisites(&prerequisites::PrerequisiteConfig {
        binary_path: &config.binary_path,
        kernel_path: &config.kernel_path,
        rootfs_path: &config.rootfs_path,
        snapshot: None,
    })
    .await
    .map_err(|e| SnapshotError::Setup(e.to_string()))?;

    let output = SnapshotOutputPaths::new(config.output_dir.clone());

    // 1. Clean and create work directory under output_dir.
    //    Paths inside this directory get baked into the snapshot and are used
    //    as bind-mount targets during restore, so they must be deterministic.
    //    Remove any stale work dir from a previous run (leftover sockets,
    //    root-owned files from an accidental sudo invocation, etc.).
    //
    //    Umount any stale bind mount first — a previous failed run may have
    //    left a bind mount on cow-device-bind, causing rm -rf to fail with EBUSY.
    let work = output.work_dir();
    if work.exists() {
        let stale_bind = SandboxPaths::new(work.clone())
            .cow_device_bind()
            .display()
            .to_string();
        command::exec_ignore_errors("umount", &[stale_bind.as_str()], command::Privilege::Sudo)
            .await;

        let work_str = work.display().to_string();
        command::exec("rm", &["-rf", &work_str], command::Privilege::Sudo)
            .await
            .map_err(|e| SnapshotError::Setup(format!("clean stale work dir: {e}")))?;
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

    // 2. Create dm-snapshot COW device backed by the rootfs.
    let cow_config = CowDeviceConfig {
        base_image: config.rootfs_path.clone(),
        cow_dir: paths.workspace().join("cow"),
        chunk_size: None,
    };
    let cow_device = tokio::task::spawn_blocking(move || CowDevice::create(&cow_config))
        .await
        .map_err(|e| SnapshotError::Setup(format!("join: {e}")))?
        .map_err(|e| SnapshotError::Setup(format!("create COW device: {e}")))?;

    info!(device = %cow_device.device_path().display(), "COW device created");

    // 3. Create network namespace (pool of 1, index auto-allocated via flock).
    let mut netns_pool = NetnsPool::create(NetnsPoolConfig { proxy_port: None })
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

    // Always cleanup netns.
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
    mut cow_device: CowDevice,
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
    let username = process::current_username().map_err(|e| SnapshotError::Setup(e.to_string()))?;

    info!(
        netns = %network.name,
        binary = %config.binary_path.display(),
        api_sock = %api_sock.display(),
        user = %username,
        "spawning firecracker"
    );

    // Use `exec` to replace the bash process with firecracker, keeping all
    // descendants in the same process group so `kill_process_group` can
    // reach them.  Without `exec`, `sudo` creates a new process group for
    // the inner `sudo -u` child, which escapes `killpg` and becomes orphan.
    let inner_cmd = r#"exec ip netns exec "$1" sudo -u "$2" "$3" --api-sock "$4""#;

    let mut child = tokio::process::Command::new("sudo")
        .args(["bash", "-c", inner_cmd, "_"])
        .arg(&network.name) // $1
        .arg(&username) // $2
        .arg(&config.binary_path) // $3
        .arg(&api_sock) // $4
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

    // Kill Firecracker first — it holds the dm device fd open.
    kill_process_group(&child);
    let _ = child.wait().await;

    // Tear down: umount bind mount, then remove dm-snapshot.
    //
    // Both steps may fail transiently because kill_process_group + child.wait()
    // only waits for the outer sudo — the inner Firecracker (inside netns via
    // sudo -u) may still be exiting, holding the dm device fd and bind mount
    // reference open. Retry both in a loop until Firecracker fully terminates.
    let drive_bind_str = paths.cow_device_bind().display().to_string();

    if result.is_ok() {
        let cow_file = cow_device.cow_file().to_owned();
        let mut last_err = None;
        for attempt in 0..DESTROY_RETRIES {
            // Umount the bind mount first (may fail if FC still holds a ref).
            command::exec_ignore_errors(
                "umount",
                &[drive_bind_str.as_str()],
                command::Privilege::Sudo,
            )
            .await;

            match cow_device.destroy_keep_cow() {
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
        if let Some(e) = last_err {
            return Err(SnapshotError::Setup(format!("destroy_keep_cow: {e}")));
        }
        tokio::fs::rename(&cow_file, &output.cow()).await?;
    } else {
        // Error path: best-effort umount before Drop cleans up the device.
        command::exec_ignore_errors(
            "umount",
            &[drive_bind_str.as_str()],
            command::Privilege::Sudo,
        )
        .await;
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
    cow_device: &mut CowDevice,
) -> Result<SnapshotConfig, SnapshotError> {
    // 5. Wait for API socket ready.
    let api_sock = sock_paths.api_sock();
    let client = ApiClient::new(&api_sock);
    client.wait_for_ready(API_READY_TIMEOUT).await?;

    info!("firecracker API ready");

    // Bind mount the COW device to a deterministic path so the snapshot
    // records this path (not the ephemeral /dev/mapper/cow-<uuid>).
    // On restore, the same path is used as the bind mount target.
    let drive_bind = paths.cow_device_bind();
    tokio::fs::write(&drive_bind, b"").await?;
    let cow_device_str = cow_device.device_path().display().to_string();
    let drive_bind_str = drive_bind.display().to_string();
    command::exec(
        "mount",
        &["--bind", &cow_device_str, &drive_bind_str],
        command::Privilege::Sudo,
    )
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
