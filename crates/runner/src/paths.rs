use std::path::PathBuf;

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

    pub fn runners_dir(&self) -> PathBuf {
        self.root.join("runners")
    }
}
