use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, RootfsPaths};
use crate::profile;

/// 0 means auto-detect from host CPU and memory at startup.
pub(crate) const DEFAULT_MAX_CONCURRENT: usize = 0;
pub(crate) const DEFAULT_CONCURRENCY_FACTOR: f64 = 1.0;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerConfig {
    pub name: String,
    pub group: String,
    pub base_dir: PathBuf,
    pub ca_dir: PathBuf,
    pub firecracker: FirecrackerConfig,
    #[serde(default)]
    pub sandbox: SandboxConfig,
    pub profiles: BTreeMap<String, ProfileConfig>,
    pub server: Option<ServerConfig>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct FirecrackerConfig {
    pub binary: PathBuf,
    pub kernel: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileConfig {
    pub rootfs_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_hash: Option<String>,
    pub vcpu: u32,
    pub memory_mb: u32,
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
    pub max_concurrent: usize,
    /// Overcommit factor applied to both CPU and memory budgets (default: 1.0).
    pub concurrency_factor: f64,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            concurrency_factor: DEFAULT_CONCURRENCY_FACTOR,
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
    let home = HomePaths::new()?;
    load_with_home(path, &home).await
}

async fn load_with_home(path: &Path, home: &HomePaths) -> RunnerResult<RunnerConfig> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| RunnerError::Config(format!("read {}: {e}", path.display())))?;
    let mut config: RunnerConfig = serde_yaml_ng::from_str(&content)
        .map_err(|e| RunnerError::Config(format!("parse {}: {e}", path.display())))?;
    if let Some(config_dir) = path.parent() {
        config.resolve_relative_paths(config_dir);
    }
    validate(&config, home).await?;
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

async fn validate(config: &RunnerConfig, home: &HomePaths) -> RunnerResult<()> {
    check_path_exists(&config.ca_dir, "ca_dir").await?;
    check_path_exists(&config.firecracker.binary, "firecracker binary").await?;
    check_path_exists(&config.firecracker.kernel, "kernel").await?;

    if config.profiles.is_empty() {
        return Err(RunnerError::Config("profiles must not be empty".into()));
    }
    for (name, profile) in &config.profiles {
        if !profile::validate_name(name) {
            return Err(RunnerError::Config(format!(
                "invalid profile name: {name} (must be org/name format, lowercase alphanumeric + hyphens)"
            )));
        }
        if profile.vcpu == 0 || profile.memory_mb == 0 {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu and memory_mb must be non-zero"
            )));
        }
        // Validate rootfs exists on disk.
        let rootfs_path = RootfsPaths::new(home, &profile.rootfs_hash).rootfs();
        check_path_exists(&rootfs_path, &format!("profile {name} rootfs")).await?;
        // Validate snapshot files exist if snapshot_hash is set.
        if let Some(hash) = &profile.snapshot_hash {
            let snap_dir = home.snapshots_dir().join(hash);
            check_path_exists(
                &snap_dir.join("snapshot.bin"),
                &format!("profile {name} snapshot"),
            )
            .await?;
            check_path_exists(
                &snap_dir.join("memory.bin"),
                &format!("profile {name} snapshot memory"),
            )
            .await?;
            check_path_exists(
                &snap_dir.join("overlay.ext4"),
                &format!("profile {name} snapshot overlay"),
            )
            .await?;
        }
    }

    if !config.sandbox.concurrency_factor.is_finite() || config.sandbox.concurrency_factor <= 0.0 {
        return Err(RunnerError::Config(
            "sandbox.concurrency_factor must be a positive finite number".into(),
        ));
    }
    Ok(())
}

impl RunnerConfig {
    /// Resolve relative paths against `config_dir` (the directory containing the YAML file).
    pub(crate) fn resolve_relative_paths(&mut self, config_dir: &Path) {
        let resolve = |p: &mut PathBuf| {
            if p.is_relative() {
                *p = config_dir.join(&*p);
            }
        };
        resolve(&mut self.base_dir);
        resolve(&mut self.ca_dir);
        resolve(&mut self.firecracker.binary);
        resolve(&mut self.firecracker.kernel);
    }

    /// Build a `sandbox_fc::FirecrackerConfig` for a given profile.
    ///
    /// Resolves rootfs and snapshot paths from the profile's hashes
    /// using the standard content-addressed storage layout.
    pub fn firecracker_config(
        &self,
        profile: &ProfileConfig,
        home: &HomePaths,
        concurrency: usize,
        proxy_port: Option<u16>,
    ) -> sandbox_fc::FirecrackerConfig {
        let rootfs_paths = RootfsPaths::new(home, &profile.rootfs_hash);
        let snapshot = profile.snapshot_hash.as_ref().map(|hash| {
            let snapshot_output =
                sandbox_fc::SnapshotOutputPaths::new(home.snapshots_dir().join(hash));
            snapshot_output.snapshot_config(hash)
        });
        sandbox_fc::FirecrackerConfig {
            binary_path: self.firecracker.binary.clone(),
            kernel_path: self.firecracker.kernel.clone(),
            rootfs_path: rootfs_paths.rootfs(),
            base_dir: self.base_dir.clone(),
            concurrency,
            proxy_port,
            snapshot,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a HomePaths rooted in a temp dir and populate fake rootfs/snapshot
    /// files for the given profile hashes so config validation passes.
    async fn test_home_with_artifacts(
        dir: &std::path::Path,
        profiles: &[(&str, Option<&str>)], // (rootfs_hash, snapshot_hash)
    ) -> HomePaths {
        let home = HomePaths::with_root(dir.join(".vm0-runner"));
        for &(rootfs_hash, snapshot_hash) in profiles {
            let rootfs = RootfsPaths::new(&home, rootfs_hash).rootfs();
            tokio::fs::create_dir_all(rootfs.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(&rootfs, b"").await.unwrap();
            if let Some(hash) = snapshot_hash {
                let snap_dir = home.snapshots_dir().join(hash);
                tokio::fs::create_dir_all(&snap_dir).await.unwrap();
                for name in ["snapshot.bin", "memory.bin", "overlay.ext4"] {
                    tokio::fs::write(snap_dir.join(name), b"").await.unwrap();
                }
            }
        }
        home
    }

    fn make_profiles() -> BTreeMap<String, ProfileConfig> {
        let mut profiles = BTreeMap::new();
        profiles.insert(
            "vm0/default".into(),
            ProfileConfig {
                rootfs_hash: "abc123".into(),
                snapshot_hash: Some("def456".into()),
                vcpu: 2,
                memory_mb: 2048,
            },
        );
        profiles
    }

    #[tokio::test]
    async fn load_config_with_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let yaml = format!(
            r#"
name: test-runner
group: acme/prod
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
profiles:
  vm0/default:
    rootfs_hash: abc123
    snapshot_hash: def456
    vcpu: 2
    memory_mb: 2048
  vm0/browser:
    rootfs_hash: fed987
    snapshot_hash: cba654
    vcpu: 4
    memory_mb: 4096
sandbox:
  max_concurrent: 8
  concurrency_factor: 2.0
server:
  url: https://api.example.com
  token: secret
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
        );

        let home = test_home_with_artifacts(
            dir.path(),
            &[("abc123", Some("def456")), ("fed987", Some("cba654"))],
        )
        .await;

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load_with_home(&config_path, &home).await.unwrap();
        assert_eq!(config.name, "test-runner");
        assert_eq!(config.profiles.len(), 2);
        let default = &config.profiles["vm0/default"];
        assert_eq!(default.vcpu, 2);
        assert_eq!(default.rootfs_hash, "abc123");
        let browser = &config.profiles["vm0/browser"];
        assert_eq!(browser.vcpu, 4);
        assert_eq!(browser.memory_mb, 4096);
        assert_eq!(config.sandbox.max_concurrent, 8);
        assert!((config.sandbox.concurrency_factor - 2.0).abs() < f64::EPSILON);
        let server = config.server.unwrap();
        assert_eq!(server.url, "https://api.example.com");
        assert_eq!(server.token, "secret");
    }

    #[tokio::test]
    async fn load_defaults_for_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[("abc", None)]).await;

        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
profiles:
  vm0/default:
    rootfs_hash: abc
    vcpu: 2
    memory_mb: 2048
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load_with_home(&config_path, &home).await.unwrap();
        assert_eq!(config.sandbox.max_concurrent, DEFAULT_MAX_CONCURRENT);
        assert!(
            (config.sandbox.concurrency_factor - DEFAULT_CONCURRENCY_FACTOR).abs() < f64::EPSILON
        );
        assert!(config.server.is_none());
    }

    #[tokio::test]
    async fn load_rejects_empty_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[]).await;

        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
profiles: {{}}
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(
            err.to_string().contains("profiles must not be empty"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn load_rejects_invalid_profile_name() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[]).await;

        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
profiles:
  bad-name:
    rootfs_hash: abc
    vcpu: 2
    memory_mb: 2048
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(
            err.to_string().contains("invalid profile name"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn load_rejects_zero_vcpu_in_profile() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[]).await;

        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
profiles:
  vm0/default:
    rootfs_hash: abc
    vcpu: 0
    memory_mb: 2048
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(err.to_string().contains("non-zero"), "got: {err}");
    }

    #[tokio::test]
    async fn load_rejects_invalid_concurrency_factor() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let home = test_home_with_artifacts(dir.path(), &[("abc", None)]).await;

        for bad_value in ["0.0", "-1.0", ".nan", ".inf", "-.inf"] {
            let yaml = format!(
                r#"
name: test
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
profiles:
  vm0/default:
    rootfs_hash: abc
    vcpu: 2
    memory_mb: 2048
sandbox:
  concurrency_factor: {bad_value}
"#,
                base_dir = dir.path().display(),
                ca_dir = dir.path().display(),
                fc = fc.display(),
                kernel = kernel.display(),
            );

            let config_path = dir.path().join("runner.yaml");
            tokio::fs::write(&config_path, &yaml).await.unwrap();

            let err = load_with_home(&config_path, &home).await.unwrap_err();
            assert!(
                err.to_string().contains("concurrency_factor"),
                "expected concurrency_factor error for {bad_value}, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn generate_then_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[("abc123", Some("def456"))]).await;

        let runner_dir = dir.path().join("my-runner");
        let config = RunnerConfig {
            name: "test-runner".into(),
            group: "acme/prod".into(),
            base_dir: runner_dir.clone(),
            ca_dir: dir.path().to_path_buf(),
            firecracker: FirecrackerConfig { binary: fc, kernel },
            profiles: make_profiles(),
            sandbox: SandboxConfig {
                max_concurrent: 8,
                concurrency_factor: 2.0,
            },
            server: Some(ServerConfig {
                url: "https://api.example.com".into(),
                token: "secret".into(),
            }),
        };

        generate(&config).await.unwrap();

        let loaded = load_with_home(&runner_dir.join("runner.yaml"), &home)
            .await
            .unwrap();
        assert_eq!(loaded, config);
    }

    #[tokio::test]
    async fn load_resolves_relative_paths() {
        let dir = tempfile::tempdir().unwrap();

        let sub = dir.path().join("artifacts");
        tokio::fs::create_dir_all(&sub).await.unwrap();
        for name in ["firecracker", "vmlinux"] {
            tokio::fs::write(sub.join(name), b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[("abc", None)]).await;

        let yaml = r#"
name: test
group: test/group
base_dir: my-runner
ca_dir: artifacts
firecracker:
  binary: artifacts/firecracker
  kernel: artifacts/vmlinux
profiles:
  vm0/default:
    rootfs_hash: abc
    vcpu: 2
    memory_mb: 2048
"#;

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, yaml).await.unwrap();

        let config = load_with_home(&config_path, &home).await.unwrap();

        assert!(config.base_dir.is_absolute());
        assert_eq!(config.base_dir, dir.path().join("my-runner"));
        assert_eq!(config.ca_dir, sub);
        assert_eq!(config.firecracker.binary, sub.join("firecracker"));
        assert_eq!(config.firecracker.kernel, sub.join("vmlinux"));
    }

    #[test]
    fn firecracker_config_resolves_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());

        let config = RunnerConfig {
            name: "test".into(),
            group: "test/group".into(),
            base_dir: dir.path().join("runner"),
            ca_dir: dir.path().join("ca"),
            firecracker: FirecrackerConfig {
                binary: dir.path().join("firecracker"),
                kernel: dir.path().join("vmlinux"),
            },
            profiles: make_profiles(),
            sandbox: SandboxConfig::default(),
            server: None,
        };

        let profile = &config.profiles["vm0/default"];
        let fc = config.firecracker_config(profile, &home, 4, Some(8080));

        assert_eq!(fc.binary_path, dir.path().join("firecracker"));
        assert_eq!(fc.kernel_path, dir.path().join("vmlinux"));
        assert_eq!(
            fc.rootfs_path,
            home.rootfs_dir().join("abc123").join("rootfs.squashfs")
        );
        assert_eq!(fc.concurrency, 4);
        assert_eq!(fc.proxy_port, Some(8080));
        assert!(fc.snapshot.is_some());
    }
}
