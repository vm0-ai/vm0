use std::path::PathBuf;

/// Guest paths (must match rootfs layout).
pub mod guest {
    pub const ENV_JSON: &str = "/tmp/vm0-env.json";
    pub const STORAGE_MANIFEST: &str = "/tmp/storage-manifest.json";
    pub const DOWNLOAD_BIN: &str = "/usr/local/bin/guest-download";
    pub const ENV_LOADER: &str = "/usr/local/bin/vm0-agent/env-loader.mjs";
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
