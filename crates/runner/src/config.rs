use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, ImagePaths};
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
    pub image_hash: String,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub disk_mb: u32,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SandboxConfig {
    pub max_concurrent: usize,
    /// Overcommit factor applied to both CPU and memory budgets (default: 1.0).
    pub concurrency_factor: f64,
    /// Idle timeout in seconds for reusable VMs (default: 300).
    pub idle_timeout_secs: u64,
    /// Maximum number of idle VMs to keep (0 = no limit, default: 0).
    pub max_idle: usize,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            concurrency_factor: DEFAULT_CONCURRENCY_FACTOR,
            idle_timeout_secs: 300,
            max_idle: 0,
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
        if profile.vcpu == 0 || profile.memory_mb == 0 || profile.disk_mb == 0 {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu, memory_mb, and disk_mb must be non-zero"
            )));
        }
        // Validate all image files exist on disk.
        let image_paths = ImagePaths::new(home, &profile.image_hash);
        for path in image_paths.expected_files() {
            check_path_exists(&path, &format!("profile {name} image")).await?;
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

    /// Build a [`sandbox::FactoryConfig`] for a given profile.
    ///
    /// Resolves rootfs and snapshot paths from the profile's image hash
    /// using the standard content-addressed storage layout.
    pub fn factory_config(
        &self,
        profile_name: &str,
        profile: &ProfileConfig,
        home: &HomePaths,
    ) -> sandbox::FactoryConfig {
        Self::build_factory_config(
            &self.firecracker,
            &self.base_dir,
            profile_name,
            profile,
            home,
        )
    }

    /// Build a [`sandbox::FactoryConfig`] from components.
    ///
    /// Static variant of [`factory_config`](Self::factory_config) for
    /// use after `RunnerConfig` has been destructured.
    pub fn build_factory_config(
        firecracker: &FirecrackerConfig,
        base_dir: &Path,
        profile_name: &str,
        profile: &ProfileConfig,
        home: &HomePaths,
    ) -> sandbox::FactoryConfig {
        let image_paths = ImagePaths::new(home, &profile.image_hash);
        sandbox::FactoryConfig {
            profile: profile_name.to_string(),
            binary_path: firecracker.binary.clone(),
            kernel_path: firecracker.kernel.clone(),
            rootfs_path: image_paths.rootfs(),
            base_dir: base_dir.to_path_buf(),
            snapshot: Some(sandbox::SnapshotRef {
                output_dir: image_paths.dir().to_path_buf(),
                hash: profile.image_hash.clone(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a HomePaths rooted in a temp dir and populate fake image files
    /// for the given image hashes so config validation passes.
    async fn test_home_with_artifacts(dir: &std::path::Path, image_hashes: &[&str]) -> HomePaths {
        let home = HomePaths::with_root(dir.join("vm0-runner"));
        for &hash in image_hashes {
            let image = ImagePaths::new(&home, hash);
            tokio::fs::create_dir_all(image.dir()).await.unwrap();
            for path in image.expected_files() {
                tokio::fs::write(&path, b"").await.unwrap();
            }
        }
        home
    }

    fn make_profiles() -> BTreeMap<String, ProfileConfig> {
        let mut profiles = BTreeMap::new();
        profiles.insert(
            "vm0/default".into(),
            ProfileConfig {
                image_hash: "abc123".into(),
                vcpu: 2,
                memory_mb: 4096,
                disk_mb: 16384,
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
group: vm0/prod
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {fc}
  kernel: {kernel}
profiles:
  vm0/default:
    image_hash: abc123
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
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

        let home = test_home_with_artifacts(dir.path(), &["abc123"]).await;

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load_with_home(&config_path, &home).await.unwrap();
        assert_eq!(config.name, "test-runner");
        assert_eq!(config.profiles.len(), 1);
        let default = &config.profiles["vm0/default"];
        assert_eq!(default.vcpu, 2);
        assert_eq!(default.image_hash, "abc123");
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
        let home = test_home_with_artifacts(dir.path(), &["abc"]).await;

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
    image_hash: abc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
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
        let home = test_home_with_artifacts(dir.path(), &[] as &[&str]).await;

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
        let home = test_home_with_artifacts(dir.path(), &[] as &[&str]).await;

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
    image_hash: abc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
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
        let home = test_home_with_artifacts(dir.path(), &[] as &[&str]).await;

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
    image_hash: abc
    vcpu: 0
    memory_mb: 4096
    disk_mb: 16384
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
    async fn load_rejects_zero_disk_mb_in_profile() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[] as &[&str]).await;

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
    image_hash: abc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 0
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
    async fn load_rejects_incomplete_image() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        // Create image directory with only rootfs.ext4 (missing snapshot files).
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let image = ImagePaths::new(&home, "abc");
        tokio::fs::create_dir_all(image.dir()).await.unwrap();
        tokio::fs::write(image.rootfs(), b"").await.unwrap();

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
    image_hash: abc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
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
            err.to_string().contains("not found"),
            "expected missing file error, got: {err}"
        );
    }

    #[tokio::test]
    async fn load_rejects_invalid_concurrency_factor() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        let home = test_home_with_artifacts(dir.path(), &["abc"]).await;

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
    image_hash: abc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
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
        let home = test_home_with_artifacts(dir.path(), &["abc123"]).await;

        let runner_dir = dir.path().join("my-runner");
        let config = RunnerConfig {
            name: "test-runner".into(),
            group: "vm0/prod".into(),
            base_dir: runner_dir.clone(),
            ca_dir: dir.path().to_path_buf(),
            firecracker: FirecrackerConfig { binary: fc, kernel },
            profiles: make_profiles(),
            sandbox: SandboxConfig {
                max_concurrent: 8,
                concurrency_factor: 2.0,
                ..SandboxConfig::default()
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
        let home = test_home_with_artifacts(dir.path(), &["abc"]).await;

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
    image_hash: abc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
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
    fn factory_config_resolves_paths() {
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
        let fc = config.factory_config("vm0/default", profile, &home);

        assert_eq!(fc.binary_path, dir.path().join("firecracker"));
        assert_eq!(fc.kernel_path, dir.path().join("vmlinux"));
        assert_eq!(
            fc.rootfs_path,
            home.images_dir().join("abc123").join("rootfs.ext4")
        );
        assert_eq!(fc.profile, "vm0/default");
        let snap = fc.snapshot.unwrap();
        assert_eq!(snap.hash, "abc123");
        assert_eq!(snap.output_dir, home.images_dir().join("abc123"));
    }

    #[tokio::test]
    async fn idle_pool_config_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &["abc123"]).await;

        let runner_dir = dir.path().join("my-runner");
        let config = RunnerConfig {
            name: "test-runner".into(),
            group: "vm0/prod".into(),
            base_dir: runner_dir.clone(),
            ca_dir: dir.path().to_path_buf(),
            firecracker: FirecrackerConfig { binary: fc, kernel },
            profiles: make_profiles(),
            sandbox: SandboxConfig {
                max_concurrent: 4,
                concurrency_factor: 1.5,
                idle_timeout_secs: 600,
                max_idle: 10,
            },
            server: None,
        };

        generate(&config).await.unwrap();

        let loaded = load_with_home(&runner_dir.join("runner.yaml"), &home)
            .await
            .unwrap();
        assert_eq!(loaded.sandbox.idle_timeout_secs, 600);
        assert_eq!(loaded.sandbox.max_idle, 10);
        assert_eq!(loaded, config);
    }

    #[tokio::test]
    async fn idle_pool_defaults_when_omitted() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &["abc"]).await;

        // YAML without any idle pool fields
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
    image_hash: abc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load_with_home(&config_path, &home).await.unwrap();
        assert_eq!(config.sandbox.idle_timeout_secs, 300);
        assert_eq!(config.sandbox.max_idle, 0);
    }
}
