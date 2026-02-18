use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{RunnerError, RunnerResult};

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
}
