use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{RunnerError, RunnerResult};

pub(crate) const DEFAULT_VCPU: u32 = 2;
pub(crate) const DEFAULT_MEMORY_MB: u32 = 2048;
pub(crate) const DEFAULT_MAX_CONCURRENT: usize = 4;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerConfig {
    pub name: String,
    pub group: String,
    pub base_dir: PathBuf,
    pub firecracker: FirecrackerConfig,
    #[serde(default)]
    pub sandbox: SandboxConfig,
    pub server: Option<ServerConfig>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct FirecrackerConfig {
    pub binary: PathBuf,
    pub kernel: PathBuf,
    pub rootfs: PathBuf,
    pub snapshot: Option<SnapshotConfig>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct SnapshotConfig {
    pub snapshot_path: PathBuf,
    pub memory_path: PathBuf,
    pub overlay_path: PathBuf,
    pub overlay_bind_path: PathBuf,
    pub vsock_bind_dir: PathBuf,
}

impl From<sandbox_fc::SnapshotConfig> for SnapshotConfig {
    fn from(sc: sandbox_fc::SnapshotConfig) -> Self {
        Self {
            snapshot_path: sc.snapshot_path,
            memory_path: sc.memory_path,
            overlay_path: sc.overlay_path,
            overlay_bind_path: sc.overlay_bind_path,
            vsock_bind_dir: sc.vsock_bind_dir,
        }
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SandboxConfig {
    pub vcpu: u32,
    pub memory_mb: u32,
    pub max_concurrent: usize,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            vcpu: DEFAULT_VCPU,
            memory_mb: DEFAULT_MEMORY_MB,
            max_concurrent: DEFAULT_MAX_CONCURRENT,
        }
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerConfig {
    pub url: String,
    pub token: String,
}

/// Load and validate a runner config from a YAML file.
///
/// Relative paths in the config are resolved against the config file's parent directory.
pub async fn load(path: &Path) -> RunnerResult<RunnerConfig> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| RunnerError::Config(format!("read {}: {e}", path.display())))?;
    let mut config: RunnerConfig = serde_yaml_ng::from_str(&content)
        .map_err(|e| RunnerError::Config(format!("parse {}: {e}", path.display())))?;
    if let Some(config_dir) = path.parent() {
        config.resolve_relative_paths(config_dir);
    }
    validate_paths(&config).await?;
    Ok(config)
}

/// Generate a runner.yaml config file from a `RunnerConfig`.
pub async fn generate(config: &RunnerConfig) -> RunnerResult<()> {
    let runner_dir = &config.base_dir;
    tokio::fs::create_dir_all(runner_dir)
        .await
        .map_err(|e| RunnerError::Config(format!("create {}: {e}", runner_dir.display())))?;

    let content = serde_yaml_ng::to_string(config)
        .map_err(|e| RunnerError::Config(format!("serialize config: {e}")))?;

    let config_path = runner_dir.join("runner.yaml");
    tokio::fs::write(&config_path, content)
        .await
        .map_err(|e| RunnerError::Config(format!("write {}: {e}", config_path.display())))?;
    Ok(())
}

async fn check_path_exists(path: &Path, label: &str) -> RunnerResult<()> {
    let exists = tokio::fs::try_exists(path)
        .await
        .map_err(|e| RunnerError::Config(format!("check {label}: {e}")))?;
    if !exists {
        return Err(RunnerError::Config(format!(
            "{label} not found: {}",
            path.display()
        )));
    }
    Ok(())
}

async fn validate_paths(config: &RunnerConfig) -> RunnerResult<()> {
    check_path_exists(&config.firecracker.binary, "firecracker binary").await?;
    check_path_exists(&config.firecracker.kernel, "kernel").await?;
    check_path_exists(&config.firecracker.rootfs, "rootfs").await?;

    if let Some(snap) = &config.firecracker.snapshot {
        check_path_exists(&snap.snapshot_path, "snapshot state").await?;
        check_path_exists(&snap.memory_path, "snapshot memory").await?;
        check_path_exists(&snap.overlay_path, "snapshot overlay").await?;
        // overlay_bind_path and vsock_bind_dir are created at sandbox runtime
    }

    Ok(())
}

impl RunnerConfig {
    /// Resolve relative paths against `config_dir` (the directory containing the YAML file).
    fn resolve_relative_paths(&mut self, config_dir: &Path) {
        let resolve = |p: &mut PathBuf| {
            if p.is_relative() {
                *p = config_dir.join(&*p);
            }
        };
        resolve(&mut self.base_dir);
        resolve(&mut self.firecracker.binary);
        resolve(&mut self.firecracker.kernel);
        resolve(&mut self.firecracker.rootfs);
        if let Some(snap) = &mut self.firecracker.snapshot {
            resolve(&mut snap.snapshot_path);
            resolve(&mut snap.memory_path);
            resolve(&mut snap.overlay_path);
            resolve(&mut snap.overlay_bind_path);
            resolve(&mut snap.vsock_bind_dir);
        }
    }

    /// Build a `sandbox_fc::SnapshotConfig` from the config's snapshot paths.
    pub fn snapshot_config(&self) -> Option<sandbox_fc::SnapshotConfig> {
        self.firecracker
            .snapshot
            .as_ref()
            .map(|s| sandbox_fc::SnapshotConfig {
                snapshot_path: s.snapshot_path.clone(),
                memory_path: s.memory_path.clone(),
                overlay_path: s.overlay_path.clone(),
                overlay_bind_path: s.overlay_bind_path.clone(),
                vsock_bind_dir: s.vsock_bind_dir.clone(),
            })
    }

    /// Build a `sandbox_fc::FirecrackerConfig` from this runner config.
    pub fn firecracker_config(&self) -> sandbox_fc::FirecrackerConfig {
        sandbox_fc::FirecrackerConfig {
            binary_path: self.firecracker.binary.clone(),
            kernel_path: self.firecracker.kernel.clone(),
            rootfs_path: self.firecracker.rootfs.clone(),
            base_dir: self.base_dir.clone(),
            concurrency: self.sandbox.max_concurrent,
            proxy_port: None,
            snapshot: self.snapshot_config(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_full_config() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        let rootfs = dir.path().join("rootfs.squashfs");
        for f in [&fc, &kernel, &rootfs] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let yaml = format!(
            r#"
name: test-runner
group: acme/prod
base_dir: {base_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
  rootfs: {rootfs}
sandbox:
  vcpu: 4
  memory_mb: 4096
  max_concurrent: 8
server:
  url: https://api.example.com
  token: secret
"#,
            base_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            rootfs = rootfs.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load(&config_path).await.unwrap();
        assert_eq!(config.name, "test-runner");
        assert_eq!(config.group, "acme/prod");
        assert_eq!(config.sandbox.vcpu, 4);
        assert_eq!(config.sandbox.memory_mb, 4096);
        assert_eq!(config.sandbox.max_concurrent, 8);
        let server = config.server.unwrap();
        assert_eq!(server.url, "https://api.example.com");
        assert_eq!(server.token, "secret");
    }

    #[tokio::test]
    async fn load_defaults_for_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        let rootfs = dir.path().join("rootfs.squashfs");
        for f in [&fc, &kernel, &rootfs] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
  rootfs: {rootfs}
"#,
            base_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            rootfs = rootfs.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load(&config_path).await.unwrap();
        assert_eq!(config.sandbox.vcpu, DEFAULT_VCPU);
        assert_eq!(config.sandbox.memory_mb, DEFAULT_MEMORY_MB);
        assert_eq!(config.sandbox.max_concurrent, DEFAULT_MAX_CONCURRENT);
        assert!(config.server.is_none());
    }

    #[tokio::test]
    async fn load_fails_on_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
firecracker:
  binary: /nonexistent/firecracker
  kernel: /nonexistent/kernel
  rootfs: /nonexistent/rootfs
"#,
            base_dir = dir.path().display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load(&config_path).await.unwrap_err();
        assert!(err.to_string().contains("not found"), "got: {err}");
    }

    #[tokio::test]
    async fn load_with_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        let rootfs = dir.path().join("rootfs.squashfs");
        let snap = dir.path().join("snapshot.bin");
        let mem = dir.path().join("memory.bin");
        let overlay = dir.path().join("overlay.ext4");
        let overlay_bind = dir.path().join("overlay_bind.ext4");
        let vsock_dir = dir.path().join("vsock");
        for f in [&fc, &kernel, &rootfs, &snap, &mem, &overlay] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
  rootfs: {rootfs}
  snapshot:
    snapshot_path: {snap}
    memory_path: {mem}
    overlay_path: {overlay}
    overlay_bind_path: {overlay_bind}
    vsock_bind_dir: {vsock_dir}
"#,
            base_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            rootfs = rootfs.display(),
            snap = snap.display(),
            mem = mem.display(),
            overlay = overlay.display(),
            overlay_bind = overlay_bind.display(),
            vsock_dir = vsock_dir.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load(&config_path).await.unwrap();
        let snap_config = config.snapshot_config().unwrap();
        assert_eq!(snap_config.snapshot_path, snap);
        assert_eq!(snap_config.memory_path, mem);
        assert_eq!(snap_config.overlay_path, overlay);
        assert_eq!(snap_config.overlay_bind_path, overlay_bind);
        assert_eq!(snap_config.vsock_bind_dir, vsock_dir);
    }

    #[tokio::test]
    async fn generate_then_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        let rootfs = dir.path().join("rootfs.squashfs");
        for f in [&fc, &kernel, &rootfs] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let runner_dir = dir.path().join("my-runner");
        let config = RunnerConfig {
            name: "test-runner".into(),
            group: "acme/prod".into(),
            base_dir: runner_dir.clone(),
            firecracker: FirecrackerConfig {
                binary: fc.clone(),
                kernel: kernel.clone(),
                rootfs: rootfs.clone(),
                snapshot: None,
            },
            sandbox: SandboxConfig {
                vcpu: 4,
                memory_mb: 4096,
                max_concurrent: 8,
            },
            server: Some(ServerConfig {
                url: "https://api.example.com".into(),
                token: "secret".into(),
            }),
        };

        generate(&config).await.unwrap();

        let loaded = load(&runner_dir.join("runner.yaml")).await.unwrap();
        assert_eq!(loaded, config);
    }

    #[tokio::test]
    async fn generate_then_load_round_trip_with_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        let rootfs = dir.path().join("rootfs.squashfs");
        let snap = dir.path().join("snapshot.bin");
        let mem = dir.path().join("memory.bin");
        let overlay = dir.path().join("overlay.ext4");
        for f in [&fc, &kernel, &rootfs, &snap, &mem, &overlay] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let runner_dir = dir.path().join("my-runner");
        let config = RunnerConfig {
            name: "snap-runner".into(),
            group: "acme/staging".into(),
            base_dir: runner_dir.clone(),
            firecracker: FirecrackerConfig {
                binary: fc,
                kernel,
                rootfs,
                snapshot: Some(SnapshotConfig {
                    snapshot_path: snap,
                    memory_path: mem,
                    overlay_path: overlay,
                    overlay_bind_path: dir.path().join("work/overlay.ext4"),
                    vsock_bind_dir: dir.path().join("work/vsock"),
                }),
            },
            sandbox: SandboxConfig::default(),
            server: None,
        };

        generate(&config).await.unwrap();

        let loaded = load(&runner_dir.join("runner.yaml")).await.unwrap();
        assert_eq!(loaded, config);
    }

    #[tokio::test]
    async fn load_resolves_relative_paths() {
        let dir = tempfile::tempdir().unwrap();

        // Create files in a subdirectory
        let sub = dir.path().join("artifacts");
        tokio::fs::create_dir_all(&sub).await.unwrap();
        for name in ["firecracker", "vmlinux", "rootfs.squashfs"] {
            tokio::fs::write(sub.join(name), b"").await.unwrap();
        }

        // YAML uses relative paths (relative to config file location)
        let yaml = r#"
name: test
group: test/group
base_dir: my-runner
firecracker:
  binary: artifacts/firecracker
  kernel: artifacts/vmlinux
  rootfs: artifacts/rootfs.squashfs
"#;

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, yaml).await.unwrap();

        let config = load(&config_path).await.unwrap();

        // All paths should be resolved to absolute paths under dir
        assert!(config.base_dir.is_absolute());
        assert_eq!(config.base_dir, dir.path().join("my-runner"));
        assert_eq!(config.firecracker.binary, sub.join("firecracker"));
        assert_eq!(config.firecracker.kernel, sub.join("vmlinux"));
        assert_eq!(config.firecracker.rootfs, sub.join("rootfs.squashfs"));
    }
}
