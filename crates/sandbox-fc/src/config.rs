use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct FirecrackerConfig {
    pub binary_path: PathBuf,
    pub kernel_path: PathBuf,
    pub rootfs_path: PathBuf,
    /// Base directory for runtime data (workspaces, COW devices, etc.).
    pub base_dir: PathBuf,
    /// Profile name (e.g., "vm0/default") used for per-profile isolation.
    pub profile: String,
    /// Port of the HTTP/HTTPS proxy. When set, iptables rules redirect traffic through it.
    pub proxy_port: Option<u16>,
    /// Port of the DNS proxy. When set, iptables rules redirect DNS queries through it.
    pub dns_port: Option<u16>,
    /// Snapshot to restore from. When set, VMs boot via snapshot restore instead of fresh boot.
    pub snapshot: Option<SnapshotConfig>,
}

#[derive(Debug, Clone)]
pub struct SnapshotConfig {
    /// Path to the snapshot state file.
    pub snapshot_path: PathBuf,
    /// Path to the memory dump file.
    pub memory_path: PathBuf,
    /// Path to the golden COW file shipped with the snapshot.
    pub cow_path: PathBuf,
    /// Drive path recorded in the snapshot's Firecracker config (bind mount target).
    pub drive_bind_path: PathBuf,
    /// Vsock directory recorded in the snapshot's Firecracker config (bind mount target).
    pub vsock_bind_dir: PathBuf,
}
