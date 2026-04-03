use std::path::PathBuf;

pub struct ResourceLimits {
    pub cpu_count: u32,
    pub memory_mb: u32,
}

pub struct SandboxConfig {
    pub id: uuid::Uuid,
    pub resources: ResourceLimits,
}

/// Reference to a pre-built snapshot for fast VM boot.
/// The backend resolves individual artifact paths from the output directory.
pub struct SnapshotRef {
    /// Directory containing snapshot artifacts (snapshot.bin, memory.bin, cow.img).
    pub output_dir: PathBuf,
    /// Content hash of the snapshot, used as an identifier for path derivation.
    pub hash: String,
}

/// Configuration for creating a sandbox factory for a specific profile.
pub struct FactoryConfig {
    /// Profile name (e.g., "vm0/default").
    pub profile: String,
    /// Path to the sandbox backend binary (e.g., firecracker).
    pub binary_path: PathBuf,
    /// Path to the guest kernel image.
    pub kernel_path: PathBuf,
    /// Path to the root filesystem image.
    pub rootfs_path: PathBuf,
    /// Base directory for runtime data (workspaces, COW devices, etc.).
    pub base_dir: PathBuf,
    /// Snapshot to restore from. When set, VMs boot via snapshot restore.
    pub snapshot: Option<SnapshotRef>,
}

/// Configuration for the sandbox runtime (shared resources).
pub struct RuntimeConfig {
    /// Proxy port for network traffic interception. Shared across all factories.
    pub proxy_port: Option<u16>,
    /// DNS proxy port for DNS query interception. Shared across all factories.
    pub dns_port: Option<u16>,
}
