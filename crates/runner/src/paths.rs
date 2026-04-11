use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::RunnerResult;

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

    pub fn mitm_addon_dir(&self) -> PathBuf {
        self.base_dir.join("mitm-addon")
    }

    pub fn proxy_registry(&self) -> PathBuf {
        self.base_dir.join("proxy-registry.json")
    }

    pub fn proxy_registry_lock(&self) -> PathBuf {
        self.base_dir.join("proxy-registry.json.lock")
    }
}

/// Paths rooted at /var/lib/vm0-runner/.
pub struct HomePaths {
    root: PathBuf,
}

impl HomePaths {
    pub fn new() -> RunnerResult<Self> {
        Ok(Self {
            root: PathBuf::from("/var/lib/vm0-runner"),
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

    pub fn images_dir(&self) -> PathBuf {
        self.root.join("images")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn runners_dir(&self) -> PathBuf {
        self.root.join("runners")
    }

    pub fn groups_dir(&self) -> PathBuf {
        self.root.join("groups")
    }

    pub fn ca_dir(&self) -> PathBuf {
        self.root.join("ca")
    }

    pub fn debootstrap_dir(&self) -> PathBuf {
        self.root.join("debootstrap")
    }

    pub fn locks_dir(&self) -> PathBuf {
        self.root.join("locks")
    }

    pub fn base_dir_lock(&self, base_dir: &Path) -> PathBuf {
        let hash = hex::encode(Sha256::digest(base_dir.as_os_str().as_encoded_bytes()));
        self.locks_dir().join(format!("base-dir-{hash}.lock"))
    }

    pub fn image_lock(&self, hash: &str) -> PathBuf {
        self.locks_dir().join(format!("image-{hash}.lock"))
    }
}

/// Paths for a unified image build output (rootfs + snapshot, keyed by image hash).
pub struct ImagePaths {
    dir: PathBuf,
}

impl ImagePaths {
    pub fn new(home: &HomePaths, hash: &str) -> Self {
        Self {
            dir: home.images_dir().join(hash),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn rootfs(&self) -> PathBuf {
        self.dir.join("rootfs.ext4")
    }

    pub fn snapshot_bin(&self) -> PathBuf {
        self.dir.join("snapshot.bin")
    }

    pub fn memory_bin(&self) -> PathBuf {
        self.dir.join("memory.bin")
    }

    pub fn cow_img(&self) -> PathBuf {
        self.dir.join("cow.img")
    }

    /// All files that must exist for the image to be considered complete.
    pub fn expected_files(&self) -> [PathBuf; 4] {
        [
            self.rootfs(),
            self.snapshot_bin(),
            self.memory_bin(),
            self.cow_img(),
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

    pub fn system_log(&self, run_id: uuid::Uuid) -> PathBuf {
        self.dir.join(format!("system-{run_id}.log"))
    }

    pub fn metrics_log(&self, run_id: uuid::Uuid) -> PathBuf {
        self.dir.join(format!("metrics-{run_id}.jsonl"))
    }

    /// Whether `name` matches any GC-eligible log file pattern.
    ///
    /// Includes per-job logs (`network-*`, `system-*`, `metrics-*`) and
    /// runner instance logs (`runner-*.log`).
    pub fn is_gc_eligible_log(name: &str) -> bool {
        (name.starts_with("network-") && name.ends_with(".jsonl"))
            || (name.starts_with("system-") && name.ends_with(".log"))
            || (name.starts_with("metrics-") && name.ends_with(".jsonl"))
            || (name.starts_with("runner-") && name.ends_with(".log"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_paths_structure() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(home.bin_dir(), PathBuf::from("/test/bin"));
        assert_eq!(home.images_dir(), PathBuf::from("/test/images"));
        assert_eq!(home.logs_dir(), PathBuf::from("/test/logs"));
        assert_eq!(home.runners_dir(), PathBuf::from("/test/runners"));
        assert_eq!(home.groups_dir(), PathBuf::from("/test/groups"));
        assert_eq!(home.ca_dir(), PathBuf::from("/test/ca"));
        assert_eq!(home.debootstrap_dir(), PathBuf::from("/test/debootstrap"));
        assert_eq!(home.locks_dir(), PathBuf::from("/test/locks"));
    }

    #[test]
    fn firecracker_paths() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(
            home.firecracker_bin("v1.10.1"),
            PathBuf::from("/test/firecracker/v1.10.1/firecracker")
        );
        assert_eq!(
            home.kernel_bin("v1.10.1", "6.1"),
            PathBuf::from("/test/firecracker/v1.10.1/vmlinux-6.1")
        );
    }

    #[test]
    fn mitmdump_path() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        assert_eq!(
            home.mitmdump_bin("11.1.3"),
            PathBuf::from("/test/mitmproxy/11.1.3/mitmdump")
        );
    }

    #[test]
    fn lock_paths() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let image_lock = home.image_lock("abc123");
        assert!(image_lock.starts_with("/test/locks/"));
        assert!(image_lock.to_string_lossy().contains("image-abc123"));
    }

    #[test]
    fn base_dir_lock_is_deterministic() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let lock1 = home.base_dir_lock(Path::new("/data/runner-01"));
        let lock2 = home.base_dir_lock(Path::new("/data/runner-01"));
        assert_eq!(lock1, lock2);

        // Different base dirs produce different locks
        let lock3 = home.base_dir_lock(Path::new("/data/runner-02"));
        assert_ne!(lock1, lock3);
    }

    #[test]
    fn runner_paths_structure() {
        let rp = RunnerPaths::new(PathBuf::from("/data/r1"));
        assert_eq!(rp.status(), PathBuf::from("/data/r1/status.json"));
        assert_eq!(rp.mitm_addon_dir(), PathBuf::from("/data/r1/mitm-addon"));
        assert_eq!(
            rp.proxy_registry(),
            PathBuf::from("/data/r1/proxy-registry.json")
        );
        assert_eq!(
            rp.proxy_registry_lock(),
            PathBuf::from("/data/r1/proxy-registry.json.lock")
        );
    }

    #[test]
    fn image_paths_structure() {
        let home = HomePaths::with_root(PathBuf::from("/test"));
        let ip = ImagePaths::new(&home, "abc123");
        assert_eq!(ip.dir(), Path::new("/test/images/abc123"));
        assert_eq!(
            ip.rootfs(),
            PathBuf::from("/test/images/abc123/rootfs.ext4")
        );
        assert_eq!(
            ip.snapshot_bin(),
            PathBuf::from("/test/images/abc123/snapshot.bin")
        );
        assert_eq!(
            ip.memory_bin(),
            PathBuf::from("/test/images/abc123/memory.bin")
        );
        assert_eq!(ip.cow_img(), PathBuf::from("/test/images/abc123/cow.img"));
        assert_eq!(ip.expected_files().len(), 4);
    }

    #[test]
    fn log_paths_structure() {
        let lp = LogPaths::new(PathBuf::from("/test/logs"));
        let id = uuid::Uuid::nil();
        assert!(lp.network_log(id).to_string_lossy().contains("network-"));
        assert!(lp.system_log(id).to_string_lossy().contains("system-"));
        assert!(lp.metrics_log(id).to_string_lossy().contains("metrics-"));
    }

    #[test]
    fn is_gc_eligible_log_matching() {
        assert!(LogPaths::is_gc_eligible_log(
            "network-550e8400-e29b-41d4-a716-446655440000.jsonl"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            "system-550e8400-e29b-41d4-a716-446655440000.log"
        ));
        assert!(LogPaths::is_gc_eligible_log(
            "metrics-550e8400-e29b-41d4-a716-446655440000.jsonl"
        ));
        assert!(LogPaths::is_gc_eligible_log("runner-2026-04-01.log"));
    }

    #[test]
    fn is_gc_eligible_log_non_matching() {
        assert!(!LogPaths::is_gc_eligible_log("config.yaml"));
        assert!(!LogPaths::is_gc_eligible_log("status.json"));
        assert!(!LogPaths::is_gc_eligible_log("network-.log")); // wrong extension
        assert!(!LogPaths::is_gc_eligible_log("system-.jsonl")); // wrong extension
        assert!(!LogPaths::is_gc_eligible_log("other-file.jsonl"));
    }

    #[test]
    fn touch_mtime_nonexistent_dir_does_not_panic() {
        touch_mtime(Path::new("/nonexistent/dir"));
    }
}
