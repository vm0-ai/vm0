use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct FirecrackerConfig {
    pub binary_path: PathBuf,
    pub kernel_path: PathBuf,
    pub rootfs_path: PathBuf,
    /// Base directory for runtime data (workspaces, overlays, etc.).
    pub base_dir: PathBuf,
    /// Number of VMs that can run concurrently (determines pool pre-warm size).
    pub concurrency: usize,
    /// Port of the HTTP/HTTPS proxy. When set, iptables rules redirect traffic through it.
    pub proxy_port: Option<u16>,
    /// Snapshot to restore from. When set, VMs boot via snapshot restore instead of fresh boot.
    pub snapshot: Option<SnapshotConfig>,
}

#[derive(Debug, Clone)]
pub struct SnapshotConfig {
    /// Path to the snapshot state file.
    pub snapshot_path: PathBuf,
    /// Path to the memory dump file.
    pub memory_path: PathBuf,
    /// Path to the base overlay file shipped with the snapshot.
    pub overlay_path: PathBuf,
    /// Overlay path recorded in the snapshot's Firecracker config (bind mount target).
    pub overlay_bind_path: PathBuf,
    /// Vsock directory recorded in the snapshot's Firecracker config (bind mount target).
    pub vsock_bind_dir: PathBuf,
}
