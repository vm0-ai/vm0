mod attempt;
mod cow;
mod error;
mod output;
mod provider;
mod publish;
mod runtime;

pub use error::SnapshotError;
pub use output::SNAPSHOT_COMPLETE_MARKER_CONTENT;
pub use provider::FirecrackerSnapshotProvider;

use sandbox::SnapshotCreateConfig;
use tracing::info;

use crate::config::SnapshotConfig;
use crate::network::{NetnsPool, NetnsPoolConfig};
use crate::paths::{RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::prerequisites;

use self::attempt::{
    SnapshotAttempt, cleanup_after_netns_pool_failure, cleanup_existing_snapshot_sock_dir,
};
use self::cow::{
    SnapshotAttemptDirGuard, create_sparse_cow_file, snapshot_attempt_cow_file,
    snapshot_attempt_dir, snapshot_attempt_token,
};
use self::output::prepare_snapshot_output;
use self::publish::FirecrackerPendingSnapshotPublish;
use self::runtime::run_snapshot_workflow;

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
/// 13. Cleanup Firecracker/netns/NBD runtime resources and keep the temporary COW
/// 14. Move COW file + bitmap to output dir and publish the complete marker
pub async fn create_snapshot(
    config: SnapshotCreateConfig,
) -> Result<SnapshotConfig, SnapshotError> {
    let mut pending = create_uncommitted_snapshot(config).await?;
    match pending.commit_config().await {
        Ok(config) => Ok(config),
        Err(err) => {
            let _ = pending.discard_inner().await;
            Err(err)
        }
    }
}

async fn create_uncommitted_snapshot(
    config: SnapshotCreateConfig,
) -> Result<FirecrackerPendingSnapshotPublish, SnapshotError> {
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
    let work = prepare_snapshot_output(&output).await?;

    // Socket directory under /run, keyed by config id so concurrent builds don't collide.
    let runtime_paths = RuntimePaths::new();
    let sock_dir = runtime_paths.sock_dir(&config.id);
    cleanup_existing_snapshot_sock_dir(&sock_dir).await;

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
    let base_size = tokio::fs::metadata(&config.rootfs_path)
        .await
        .map_err(|e| SnapshotError::Setup(format!("base image metadata: {e}")))?
        .len();

    // The stable `work/cow-device-bind` path is baked into the snapshot for
    // restore, but the temporary COW backing file is not. Keep the COW under an
    // attempt-scoped directory so a cancelled attempt's detached finalizer cannot
    // unlink a later rebuild's COW after the outer snapshot lock has been released.
    let attempt_token = snapshot_attempt_token();
    let attempt_dir = snapshot_attempt_dir(paths.workspace(), &attempt_token);
    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .map_err(|e| SnapshotError::Setup(format!("create snapshot attempt dir: {e}")))?;
    let mut attempt_dir_guard = SnapshotAttemptDirGuard::new(attempt_dir);
    let cow_file = snapshot_attempt_cow_file(paths.workspace(), &attempt_token);
    create_sparse_cow_file(&cow_file, base_size)?;

    let device_pool =
        nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    let cow_device = device_pool
        .create_cow_device(&config.rootfs_path, &cow_file, base_size)
        .await
        .map_err(|e| SnapshotError::Setup(format!("create NBD COW device: {e}")))?;

    info!(device = %cow_device.device_path().display(), "NBD COW device created");

    // 3. Create network namespace (pool of 1, index auto-allocated via flock).
    let netns_pool = match NetnsPool::create_checked(netns_config).await {
        Ok(pool) => pool,
        Err(e) => {
            cleanup_after_netns_pool_failure(cow_device, &device_pool, &sock_dir).await;
            return Err(SnapshotError::Setup(format!("netns pool: {e}")));
        }
    };

    let mut attempt = SnapshotAttempt::new(
        paths,
        sock_paths,
        output,
        netns_pool,
        device_pool,
        cow_device,
    );
    attempt_dir_guard.disarm();
    let result = run_snapshot_workflow(&config, &mut attempt).await;
    let result = match result {
        Ok(snapshot_config) => attempt.prepare_success_publish().await.map(|kept_cow| {
            FirecrackerPendingSnapshotPublish::new(
                snapshot_config,
                SnapshotOutputPaths::new(config.output_dir.clone()),
                kept_cow,
            )
        }),
        Err(err) => Err(err),
    };

    attempt.cleanup_device_pool().await;
    attempt.cleanup_netns_pool().await;
    attempt.cleanup_sock_dir().await;

    result
}
