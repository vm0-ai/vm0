use std::path::{Path, PathBuf};

use async_trait::async_trait;

/// Configuration for creating a snapshot.
#[derive(Debug)]
pub struct SnapshotCreateConfig {
    /// Unique identifier for this snapshot (used for runtime socket directory).
    pub id: String,
    /// Path to the sandbox backend binary (e.g., firecracker).
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

/// Output paths from a successful snapshot creation.
#[derive(Debug)]
pub struct SnapshotOutput {
    /// Path to the snapshot state file.
    pub snapshot_path: PathBuf,
    /// Path to the memory dump file.
    pub memory_path: PathBuf,
    /// Path to the COW (copy-on-write) file.
    pub cow_path: PathBuf,
}

/// Errors that can occur during snapshot operations.
///
/// These variants describe provider-neutral failure categories returned by
/// [`SnapshotProvider`] operations. A failed snapshot attempt should be treated
/// as incomplete: callers should not reuse output artifacts from the failed
/// attempt unless the concrete provider documents a stronger guarantee.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// The provider could not prepare host resources, validate inputs, or
    /// finish provider-specific setup needed before the snapshot can complete.
    ///
    /// Retry is usually only useful after fixing the reported prerequisite,
    /// configuration, or transient resource-allocation failure.
    #[error("setup failed: {0}")]
    Setup(String),
    /// The sandbox backend process or its launch chain failed while creating
    /// the snapshot.
    ///
    /// This includes failures to spawn the backend and cases where the backend
    /// exits before the provider can complete the snapshot workflow.
    #[error("process failed: {0}")]
    Process(String),
    /// The provider failed while releasing or finalizing snapshot resources.
    ///
    /// The output should be treated as invalid. Retry may require operator
    /// cleanup or the provider's garbage-collection path, depending on the
    /// concrete backend.
    #[error("teardown failed: {0}")]
    Teardown(String),
    /// The backend API reported an error while configuring, starting, pausing,
    /// or snapshotting the sandbox.
    ///
    /// Retry depends on whether the API failure was caused by transient backend
    /// state or by an invalid snapshot configuration.
    #[error("backend api error: {0}")]
    Api(String),
    /// The provider could not establish or observe the guest readiness
    /// connection required for snapshot creation.
    ///
    /// The backend may have started, but the snapshot workflow did not reach a
    /// complete state.
    #[error("vsock connection failed: {0}")]
    Vsock(String),
    /// A host I/O operation failed while preparing, finalizing, or checking
    /// snapshot artifacts.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Creates snapshots for fast sandbox boot.
///
/// This is a lightweight, stateless trait — it does not require a
/// [`SandboxRuntime`](crate::SandboxRuntime) instance.
#[async_trait]
pub trait SnapshotProvider: Send + Sync {
    /// Create a snapshot by booting a temporary VM, configuring it, and
    /// capturing its state to the output directory.
    async fn create_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<SnapshotOutput, SnapshotError>;

    /// Content hash of all internal configuration that affects snapshot output.
    ///
    /// Used by the runner to build a composite cache key for snapshots.
    fn config_hash(&self) -> String;

    /// Check whether all expected snapshot artifacts exist in the output directory.
    async fn is_complete(&self, output_dir: &Path) -> Result<bool, SnapshotError>;
}
