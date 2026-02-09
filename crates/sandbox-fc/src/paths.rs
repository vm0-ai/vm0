use std::path::{Path, PathBuf};

/// Directory for flock-based pool index allocation.
/// `/var/lock` is the FHS-standard location for lock files (mode 1777).
pub const LOCK_DIR: &str = "/var/lock";

/// Factory-level paths derived from the base directory.
pub struct FactoryPaths {
    base_dir: PathBuf,
}

impl FactoryPaths {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn workspaces(&self) -> PathBuf {
        self.base_dir.join("workspaces")
    }

    pub fn overlays(&self) -> PathBuf {
        self.base_dir.join("overlays")
    }

    pub fn workspace(&self, id: &str) -> PathBuf {
        self.workspaces().join(id)
    }
}

/// Per-sandbox paths within a workspace directory.
pub struct SandboxPaths {
    workspace: PathBuf,
}

impl SandboxPaths {
    pub fn new(workspace: PathBuf) -> Self {
        Self { workspace }
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn config(&self) -> PathBuf {
        self.workspace.join("config.json")
    }

    pub fn vsock_dir(&self) -> PathBuf {
        self.workspace.join("vsock")
    }

    pub fn vsock(&self) -> PathBuf {
        self.vsock_dir().join("vsock.sock")
    }

    pub fn overlay(&self) -> PathBuf {
        self.workspace.join("overlay.ext4")
    }

    pub fn api_sock(&self) -> PathBuf {
        self.workspace.join("api.sock")
    }
}

/// Paths for snapshot output artifacts within an output directory.
pub struct SnapshotOutputPaths {
    output_dir: PathBuf,
}

impl SnapshotOutputPaths {
    pub fn new(output_dir: PathBuf) -> Self {
        Self { output_dir }
    }

    pub fn snapshot(&self) -> PathBuf {
        self.output_dir.join("snapshot.bin")
    }

    pub fn memory(&self) -> PathBuf {
        self.output_dir.join("memory.bin")
    }

    pub fn overlay(&self) -> PathBuf {
        self.output_dir.join("overlay.ext4")
    }
}
