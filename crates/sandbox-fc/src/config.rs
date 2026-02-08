use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct FirecrackerConfig {
    pub binary_path: PathBuf,
    pub kernel_path: PathBuf,
    pub rootfs_path: PathBuf,
    pub workspaces_dir: PathBuf,
    pub proxy_port: Option<u16>,
    pub snapshot: Option<SnapshotConfig>,
}

#[derive(Debug, Clone)]
pub struct SnapshotConfig {
    pub snapshot_path: PathBuf,
    pub memory_path: PathBuf,
    pub overlay_path: PathBuf,
}
