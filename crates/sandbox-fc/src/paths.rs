use std::path::{Path, PathBuf};

/// Directory for flock-based pool index allocation.
/// `/var/lock` is the FHS-standard location for lock files (mode 1777).
pub const LOCK_DIR: &str = "/var/lock";

/// Base directory for runtime sockets under `/run`.
/// Created with mode 1777 (world-writable + sticky bit) by `prerequisites.rs`.
pub const RUNTIME_DIR: &str = "/run/vm0";

/// Runtime paths under `/run/vm0/`.
pub struct RuntimePaths {
    base_dir: PathBuf,
}

impl Default for RuntimePaths {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimePaths {
    pub fn new() -> Self {
        Self {
            base_dir: PathBuf::from(RUNTIME_DIR),
        }
    }

    /// Socket directory: `/run/vm0/sock/<id>/`.
    pub fn sock_dir(&self, id: &str) -> PathBuf {
        self.base_dir.join("sock").join(id)
    }
}

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

/// Per-sandbox workspace paths (persistent data: config, overlay).
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

    pub fn overlay(&self) -> PathBuf {
        self.workspace.join("overlay.ext4")
    }
}

/// Per-sandbox runtime socket paths.
pub struct SockPaths {
    dir: PathBuf,
}

impl SockPaths {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn api_sock(&self) -> PathBuf {
        self.dir.join("api.sock")
    }

    pub fn vsock_dir(&self) -> PathBuf {
        self.dir.join("vsock")
    }

    pub fn vsock(&self) -> PathBuf {
        self.vsock_dir().join("vsock.sock")
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

    /// Work directory used during snapshot creation.
    /// Its layout is preserved as bind-mount targets during restore.
    pub fn work_dir(&self) -> PathBuf {
        self.output_dir.join("work")
    }

    /// Build a [`SnapshotConfig`] combining the output artifacts with
    /// the work directory paths recorded during snapshot creation.
    ///
    /// `sock_id` identifies the socket directory under `/run/vm0/sock/` —
    /// typically the config hash so each snapshot gets a unique path.
    pub fn snapshot_config(&self, sock_id: &str) -> crate::SnapshotConfig {
        let work = SandboxPaths::new(self.work_dir());
        let runtime = RuntimePaths::new();
        let sock = SockPaths::new(runtime.sock_dir(sock_id));
        crate::SnapshotConfig {
            snapshot_path: self.snapshot(),
            memory_path: self.memory(),
            overlay_path: self.overlay(),
            overlay_bind_path: work.overlay(),
            vsock_bind_dir: sock.vsock_dir(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_paths_fit_sun_path_limit() {
        let runtime = RuntimePaths::new();
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        let sock = SockPaths::new(runtime.sock_dir(uuid));

        let api = sock.api_sock();
        let vsock = sock.vsock();

        // sun_path limit is 108 bytes (including NUL terminator), so max usable = 107.
        assert!(
            api.as_os_str().len() <= 107,
            "api.sock path too long: {} bytes ({})",
            api.as_os_str().len(),
            api.display()
        );
        assert!(
            vsock.as_os_str().len() <= 107,
            "vsock.sock path too long: {} bytes ({})",
            vsock.as_os_str().len(),
            vsock.display()
        );
    }

    #[test]
    fn snapshot_socket_paths_fit_sun_path_limit() {
        // Worst case: full SHA-256 hex hash (64 chars) as output dir name.
        let sha256 = "a".repeat(64);
        let runtime = RuntimePaths::new();
        let sock = SockPaths::new(runtime.sock_dir(&sha256));

        let api = sock.api_sock();
        let vsock = sock.vsock();

        assert!(
            api.as_os_str().len() <= 107,
            "snapshot api.sock path too long: {} bytes ({})",
            api.as_os_str().len(),
            api.display()
        );
        assert!(
            vsock.as_os_str().len() <= 107,
            "snapshot vsock.sock path too long: {} bytes ({})",
            vsock.as_os_str().len(),
            vsock.display()
        );
    }
}
