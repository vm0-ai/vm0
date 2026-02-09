use std::path::PathBuf;
use std::time::Duration;

use tokio::io::AsyncBufReadExt;
use tracing::info;

use crate::api::ApiClient;
use crate::config::SnapshotConfig;
use crate::network::{GUEST_NETWORK, NetnsPool, NetnsPoolConfig, generate_boot_args};
use crate::overlay::{Ext4Creator, OverlayCreator as _};
use crate::paths::{SandboxPaths, SnapshotOutputPaths};
use crate::process;

/// Timeout for waiting for the Firecracker API socket after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Network namespace pool index used for snapshot creation (63 = last slot,
/// avoids collision with running sandbox instances that use lower indices).
const SNAPSHOT_POOL_INDEX: u32 = 63;

/// Configuration for creating a snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotCreateConfig {
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
    Api(#[from] crate::api::ApiError),
    #[error("vsock connection failed: {0}")]
    Vsock(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Create a snapshot by booting a fresh VM, configuring it, and capturing state.
///
/// This is the Rust equivalent of the TS `commands/snapshot.ts` workflow:
///  1. Create work directory
///  2. Create ext4 overlay
///  3. Create network namespace
///  4. Spawn Firecracker with `--api-sock`
///  5. Wait for API socket ready
///  6. Configure VM via API (6 parallel PUT calls)
///  7. Bind vsock listener
///  8. Start instance
///  9. Wait for guest vsock connection
/// 10. Pause VM
/// 11. Create snapshot
/// 12. Move overlay to output dir
/// 13. Cleanup (kill Firecracker, destroy netns)
pub async fn create_snapshot(
    config: SnapshotCreateConfig,
) -> Result<SnapshotConfig, SnapshotError> {
    // 1. Create work directory under output_dir.
    //    Paths inside this directory get baked into the snapshot and are used
    //    as bind-mount targets during restore, so they must be deterministic.
    let work = config.output_dir.join("work");
    tokio::fs::create_dir_all(&work).await?;

    let paths = SandboxPaths::new(work);

    info!(work_dir = %paths.workspace().display(), "starting snapshot creation");

    // 2. Create ext4 overlay in work dir.
    Ext4Creator
        .create(&paths.overlay())
        .await
        .map_err(|e| SnapshotError::Setup(format!("create overlay: {e}")))?;

    info!("overlay created");

    // 3. Create network namespace (pool of 1, index 63 to avoid collision).
    let mut netns_pool = NetnsPool::create(NetnsPoolConfig {
        index: SNAPSHOT_POOL_INDEX,
        size: 1,
        proxy_port: None,
    })
    .await
    .map_err(|e| SnapshotError::Setup(format!("netns pool: {e}")))?;

    // Guard: ensure netns cleanup on any exit path.
    let result = run_snapshot_workflow(&config, &paths, &mut netns_pool).await;

    // Always cleanup netns.
    if let Err(e) = netns_pool.cleanup().await {
        tracing::warn!(error = %e, "failed to cleanup netns pool");
    }

    result
}

/// Inner workflow, separated so the caller can always run cleanup.
async fn run_snapshot_workflow(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    netns_pool: &mut NetnsPool,
) -> Result<SnapshotConfig, SnapshotError> {
    let network = netns_pool
        .acquire()
        .await
        .map_err(|e| SnapshotError::Setup(format!("acquire netns: {e}")))?;

    info!(netns = %network.name, "namespace acquired");

    // 4. Spawn Firecracker with --api-sock in the namespace.
    let api_sock = paths.api_sock();
    let username = process::current_username().map_err(|e| SnapshotError::Setup(e.to_string()))?;

    info!(
        netns = %network.name,
        binary = %config.binary_path.display(),
        api_sock = %api_sock.display(),
        user = %username,
        "spawning firecracker"
    );

    let mut child = tokio::process::Command::new("sudo")
        .arg("ip")
        .arg("netns")
        .arg("exec")
        .arg(&network.name)
        .arg("sudo")
        .arg("-u")
        .arg(&username)
        .arg(&config.binary_path)
        .arg("--api-sock")
        .arg(&api_sock)
        .current_dir(paths.workspace())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
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

    // Guard: ensure process cleanup on any exit path.
    let result = run_with_firecracker(config, paths).await;

    // Always kill the process tree.
    if let Some(pid) = child.id() {
        process::kill_process_tree(pid).await;
    }
    let _ = child.wait().await;

    result
}

/// Inner workflow that runs while Firecracker is alive.
async fn run_with_firecracker(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
) -> Result<SnapshotConfig, SnapshotError> {
    // 5. Wait for API socket ready.
    let api_sock = paths.api_sock();
    let client = ApiClient::new(&api_sock);
    client.wait_for_ready(API_READY_TIMEOUT).await?;

    info!("firecracker API ready");

    // 6. Configure VM via API (6 parallel PUT calls).
    let kernel_path = config.kernel_path.display().to_string();
    let rootfs_path = config.rootfs_path.display().to_string();
    let overlay_path = paths.overlay().display().to_string();
    tokio::fs::create_dir_all(&paths.vsock_dir()).await?;
    let vsock_uds_str = paths.vsock().display().to_string();

    let boot_args = generate_boot_args();

    tokio::try_join!(
        client.configure_machine(config.vcpu_count, config.memory_mb),
        client.configure_boot_source(&kernel_path, &boot_args),
        client.configure_drive("rootfs", &rootfs_path, true, true),
        client.configure_drive("overlay", &overlay_path, false, false),
        client.configure_network_interface("eth0", GUEST_NETWORK.guest_mac, GUEST_NETWORK.tap_name),
        client.configure_vsock(3, &vsock_uds_str),
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
    let _guest = match vsock_task.await {
        Ok(Ok(g)) => g,
        Ok(Err(e)) => return Err(SnapshotError::Vsock(e.to_string())),
        Err(e) => return Err(SnapshotError::Vsock(format!("vsock task: {e}"))),
    };

    info!("guest connected");

    // 10. Pause VM.
    client.pause().await?;

    info!("VM paused");

    // 11. Create snapshot — Firecracker writes directly to output_dir.
    let output = SnapshotOutputPaths::new(config.output_dir.clone());
    let snapshot_str = output.snapshot().display().to_string();
    let memory_str = output.memory().display().to_string();
    client.create_snapshot(&snapshot_str, &memory_str).await?;

    info!("snapshot created");

    // 12. Move overlay to output dir (same filesystem, so rename is instant).
    //     Keep the work dir structure — it serves as bind-mount targets on restore.
    tokio::fs::rename(&paths.overlay(), &output.overlay()).await?;

    info!(output_dir = %config.output_dir.display(), "snapshot creation complete");

    Ok(SnapshotConfig {
        snapshot_path: output.snapshot(),
        memory_path: output.memory(),
        overlay_path: output.overlay(),
        overlay_bind_path: paths.overlay(),
        vsock_bind_dir: paths.vsock_dir(),
    })
}
