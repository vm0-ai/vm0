use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{RunnerError, RunnerResult};

/// Update a directory's mtime to now, so `runner gc` treats it as recently used.
pub fn touch_mtime(dir: &Path) {
    let Ok(f) = std::fs::File::open(dir) else {
        tracing::debug!("touch_mtime: cannot open {}", dir.display());
        return;
    };
    if let Err(e) =
        f.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()))
    {
        tracing::debug!("touch_mtime: set_times failed for {}: {e}", dir.display());
    }
}

/// Guest paths (must match rootfs layout).
pub mod guest {
    pub const STORAGE_MANIFEST: &str = "/tmp/storage-manifest.json";
    pub const DOWNLOAD_BIN: &str = "/usr/local/bin/guest-download";
    pub const RUN_AGENT: &str = "/usr/local/bin/guest-agent";
}

/// Runner-level paths derived from the base directory.
pub struct RunnerPaths {
    base_dir: PathBuf,
}

impl RunnerPaths {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn status(&self) -> PathBuf {
        self.base_dir.join("status.json")
    }

    pub fn mitm_addon(&self) -> PathBuf {
        self.base_dir.join("mitm-addon.py")
    }

    pub fn proxy_registry(&self) -> PathBuf {
        self.base_dir.join("proxy-registry.json")
    }

    pub fn proxy_registry_lock(&self) -> PathBuf {
        self.base_dir.join("proxy-registry.json.lock")
    }
}

/// Paths rooted at ~/.vm0-runner/.
pub struct HomePaths {
    root: PathBuf,
}

impl HomePaths {
    pub fn new() -> RunnerResult<Self> {
        let home = std::env::var("HOME")
            .map_err(|_| RunnerError::Config("HOME environment variable not set".into()))?;
        Ok(Self {
            root: PathBuf::from(home).join(".vm0-runner"),
        })
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }

    pub fn firecracker_dir(&self, version: &str) -> PathBuf {
        self.root.join("firecracker").join(version)
    }

    pub fn firecracker_bin(&self, version: &str) -> PathBuf {
        self.firecracker_dir(version).join("firecracker")
    }

    pub fn kernel_bin(&self, fc_version: &str, kernel_version: &str) -> PathBuf {
        let kernel_name = format!("vmlinux-{kernel_version}");
        self.firecracker_dir(fc_version).join(kernel_name)
    }

    pub fn mitmproxy_dir(&self, version: &str) -> PathBuf {
        self.root.join("mitmproxy").join(version)
    }

    pub fn mitmdump_bin(&self, version: &str) -> PathBuf {
        self.mitmproxy_dir(version).join("mitmdump")
    }

    pub fn rootfs_dir(&self) -> PathBuf {
        self.root.join("rootfs")
    }

    pub fn snapshots_dir(&self) -> PathBuf {
        self.root.join("snapshots")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn runners_dir(&self) -> PathBuf {
        self.root.join("runners")
    }

    pub fn locks_dir(&self) -> PathBuf {
        self.root.join("locks")
    }

    pub fn base_dir_lock(&self, base_dir: &Path) -> PathBuf {
        let hash = Sha256::digest(base_dir.as_os_str().as_encoded_bytes());
        self.locks_dir().join(format!("base-dir-{hash:x}.lock"))
    }

    pub fn rootfs_lock(&self, hash: &str) -> PathBuf {
        self.locks_dir().join(format!("rootfs-{hash}.lock"))
    }

    pub fn snapshot_lock(&self, hash: &str) -> PathBuf {
        self.locks_dir().join(format!("snapshot-{hash}.lock"))
    }

    /// Extract the rootfs hash from a managed rootfs file path.
    ///
    /// Returns `Some(hash)` if the path is `<rootfs_dir>/{hash}/<file>`, `None` otherwise.
    pub fn extract_rootfs_hash(&self, rootfs_path: &Path) -> Option<String> {
        let parent = rootfs_path.parent()?;
        if parent.parent()? == self.rootfs_dir() {
            parent.file_name()?.to_str().map(String::from)
        } else {
            None
        }
    }

    /// Extract the snapshot hash from a managed snapshot file path.
    ///
    /// Returns `Some(hash)` if the path is `<snapshots_dir>/{hash}/<file>`, `None` otherwise.
    pub fn extract_snapshot_hash(&self, snapshot_path: &Path) -> Option<String> {
        let parent = snapshot_path.parent()?;
        if parent.parent()? == self.snapshots_dir() {
            parent.file_name()?.to_str().map(String::from)
        } else {
            None
        }
    }
}

/// Paths for a rootfs build output directory (keyed by input hash).
pub struct RootfsPaths {
    dir: PathBuf,
}

impl RootfsPaths {
    pub fn new(home: &HomePaths, hash: &str) -> Self {
        Self {
            dir: home.rootfs_dir().join(hash),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn rootfs(&self) -> PathBuf {
        self.dir.join("rootfs.squashfs")
    }

    pub fn ca_cert(&self) -> PathBuf {
        self.dir.join("mitmproxy-ca-cert.pem")
    }

    pub fn ca_key(&self) -> PathBuf {
        self.dir.join("mitmproxy-ca-key.pem")
    }

    pub fn ca_combined(&self) -> PathBuf {
        self.dir.join("mitmproxy-ca.pem")
    }

    /// All files that must exist for the build to be considered complete.
    pub fn expected_files(&self) -> [PathBuf; 4] {
        [
            self.rootfs(),
            self.ca_cert(),
            self.ca_key(),
            self.ca_combined(),
        ]
    }
}

/// Log file paths derived from `HomePaths::logs_dir()`.
#[derive(Clone)]
pub struct LogPaths {
    dir: PathBuf,
}

impl LogPaths {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn network_log(&self, run_id: uuid::Uuid) -> PathBuf {
        self.dir.join(format!("network-{run_id}.jsonl"))
    }

    /// Whether `name` matches the `network-{run_id}.jsonl` pattern.
    pub fn is_network_log(name: &str) -> bool {
        name.starts_with("network-") && name.ends_with(".jsonl")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(root: &Path) -> HomePaths {
        HomePaths::with_root(root.to_path_buf())
    }

    #[test]
    fn extract_rootfs_hash_from_managed_path() {
        let h = home(Path::new("/home/user/.vm0-runner"));
        let path = Path::new("/home/user/.vm0-runner/rootfs/abc123/rootfs.squashfs");
        assert_eq!(h.extract_rootfs_hash(path).as_deref(), Some("abc123"));
    }

    #[test]
    fn extract_rootfs_hash_returns_none_for_unmanaged_path() {
        let h = home(Path::new("/home/user/.vm0-runner"));
        let path = Path::new("/other/rootfs/abc123/rootfs.squashfs");
        assert_eq!(h.extract_rootfs_hash(path), None);
    }

    #[test]
    fn extract_rootfs_hash_returns_none_for_bare_file() {
        let h = home(Path::new("/home/user/.vm0-runner"));
        let path = Path::new("/home/user/.vm0-runner/rootfs/rootfs.squashfs");
        // parent = rootfs/, parent.parent = .vm0-runner/ — doesn't match rootfs_dir
        assert_eq!(h.extract_rootfs_hash(path), None);
    }

    #[test]
    fn extract_snapshot_hash_from_managed_path() {
        let h = home(Path::new("/home/user/.vm0-runner"));
        let path = Path::new("/home/user/.vm0-runner/snapshots/def456/snapshot.bin");
        assert_eq!(h.extract_snapshot_hash(path).as_deref(), Some("def456"));
    }

    #[test]
    fn extract_snapshot_hash_returns_none_for_unmanaged_path() {
        let h = home(Path::new("/home/user/.vm0-runner"));
        let path = Path::new("/tmp/snapshots/def456/snapshot.bin");
        assert_eq!(h.extract_snapshot_hash(path), None);
    }
}
