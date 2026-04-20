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
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("setup failed: {0}")]
    Setup(String),
    #[error("process failed: {0}")]
    Process(String),
    #[error("teardown failed: {0}")]
    Teardown(String),
    #[error("backend api error: {0}")]
    Api(String),
    #[error("vsock connection failed: {0}")]
    Vsock(String),
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
