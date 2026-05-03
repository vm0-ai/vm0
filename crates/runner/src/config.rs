//! Runner YAML config (`runner.yaml`) — the schema the operator writes.
//!
//! The file is loaded once at startup via [`load`], validated, and then
//! consumed by the rest of the runner. For each VM spawn, a profile is
//! turned into a [`sandbox::FactoryConfig`] via
//! [`RunnerConfig::factory_config`].
//!
//! # Lifecycle
//! 1. [`load`] reads the YAML, deserializes into [`RunnerConfig`], and
//!    resolves any relative paths against the config file's parent directory.
//! 2. `validate` checks group name, profile names, image hashes, on-disk
//!    artifacts, resource ceilings, and the concurrency factor.
//! 3. Callers derive runtime objects (e.g. [`sandbox::FactoryConfig`]) from
//!    the loaded config.
//!
//! # Image identity: two content hashes per profile
//! Each [`ProfileConfig`] carries two hashes with different scopes:
//! - `rootfs_hash` — content hash of the bootable guest filesystem image on
//!   this runner. Shared across snapshot variants on the same host.
//! - `snapshot_hash` — content hash of the FC/kernel/vcpu/memory/provider
//!   config used to capture the memory snapshot from that rootfs. Local-only:
//!   snapshots are produced on each runner by booting the rootfs and
//!   capturing state, since the captured memory binds to host-specific state.
//!
//! Together they identify an exact boot image on this host.
//!
//! # Schema changes
//! Any change to the structs in this module is a change to the on-disk YAML
//! contract operators write. Add fields behind `#[serde(default)]` with a
//! sensible default; rename fields only with a migration plan.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{RunnerError, RunnerResult};
use crate::idle_pool::DEFAULT_IDLE_TIMEOUT_SECS;
use crate::paths::{HomePaths, RootfsPaths};
use crate::profile;

/// 0 means auto-detect from host CPU and memory at startup.
pub(crate) const DEFAULT_MAX_CONCURRENT: usize = 0;
/// No overcommit — CPU/memory budgets are taken at face value.
pub(crate) const DEFAULT_CONCURRENCY_FACTOR: f64 = 1.0;

const MAX_VCPU: u32 = 1024;
const MAX_MEMORY_MB: u32 = 1_048_576; // 1 TB
const MAX_DISK_MB: u32 = 1_048_576; // 1 TB

/// Top-level runner configuration, deserialized from `runner.yaml`.
///
/// Relative paths for `base_dir`, `ca_dir`, and the `firecracker` binaries
/// are resolved against the YAML file's parent directory during [`load`].
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerConfig {
    /// Human-readable identifier for this runner instance, surfaced in logs
    /// and reported to the control plane alongside `group`.
    pub name: String,
    /// Runner group in `org/name` format (e.g. `vm0/prod`). Used to scope
    /// runners on the server and to build on-disk paths; validated by
    /// [`crate::group::validate_or_err`].
    pub group: String,
    /// Runtime data root for this runner — holds per-VM workspaces, COW
    /// devices, sockets, etc. Locked exclusively on startup so two runner
    /// processes can't share the same directory.
    pub base_dir: PathBuf,
    /// Directory holding the MITM proxy's CA certificate and key, passed to
    /// the proxy via `confdir=…` so guests can trust intercepted HTTPS.
    pub ca_dir: PathBuf,
    /// Firecracker binary and guest kernel paths, shared across all profiles.
    pub firecracker: FirecrackerConfig,
    /// Sandbox concurrency and idle-pool tuning. Omit the key to accept
    /// defaults — `#[serde(default)]` fills in the whole sub-section.
    #[serde(default)]
    pub sandbox: SandboxConfig,
    /// Keyed by profile name (e.g. `vm0/default`). Validation requires at
    /// least one entry; each profile name is also checked for format.
    pub profiles: BTreeMap<String, ProfileConfig>,
    /// Control-plane endpoint and auth token. May be omitted in the YAML if
    /// `--api-url` / `--token` (or the corresponding env vars) are supplied
    /// at `start` time.
    pub server: Option<ServerConfig>,
}

/// Paths to the Firecracker binary and guest kernel used by every profile.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct FirecrackerConfig {
    /// Firecracker VMM binary. Validated to exist on disk at load time.
    pub binary: PathBuf,
    /// Guest kernel image (e.g. `vmlinux`). Validated to exist on disk at
    /// load time.
    pub kernel: PathBuf,
}

/// A bootable image variant: rootfs + snapshot + resource shape.
///
/// See the module-level docs for the two-hash identity scheme
/// (`rootfs_hash` covers the local rootfs, `snapshot_hash` is local-only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileConfig {
    /// Content-addressed rootfs hash (shared across snapshot variants on this host).
    pub rootfs_hash: String,
    /// Content-addressed snapshot hash (local-only, covers FC/kernel/vcpu/memory/provider config).
    pub snapshot_hash: String,
    /// Guest vCPU count. Must be non-zero and ≤ 1024.
    pub vcpu: u32,
    /// Guest RAM in MiB. Must be non-zero and ≤ 1 TiB.
    pub memory_mb: u32,
    /// Guest disk in MiB, used to size the COW overlay. Must be non-zero
    /// and ≤ 1 TiB.
    pub disk_mb: u32,
}

/// Sandbox-level knobs for concurrency and the idle-VM pool.
///
/// All fields accept defaults via `#[serde(default)]`, so the whole
/// `sandbox:` block may be omitted from the YAML.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SandboxConfig {
    /// Hard cap on concurrent VMs. `0` auto-detects from host CPU and
    /// memory at startup (see [`DEFAULT_MAX_CONCURRENT`]).
    pub max_concurrent: usize,
    /// Overcommit factor applied to both CPU and memory budgets (default: 1.0).
    pub concurrency_factor: f64,
    /// Idle timeout in seconds for reusable VMs
    /// (default: [`DEFAULT_IDLE_TIMEOUT_SECS`]).
    pub idle_timeout_secs: u64,
    /// Maximum number of idle VMs to keep (0 = no limit, default: 0).
    pub max_idle: usize,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            concurrency_factor: DEFAULT_CONCURRENCY_FACTOR,
            idle_timeout_secs: DEFAULT_IDLE_TIMEOUT_SECS,
            max_idle: 0,
        }
    }
}

/// Control-plane connection settings. Either field may be supplied via
/// CLI flag or env var at `start` time and override what's in the YAML.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Base URL of the vm0 API (e.g. `https://api.example.com`). Overridable
    /// via `--api-url` / `VM0_API_URL`.
    pub url: String,
    /// Runner auth token. Overridable via `--token` / `VM0_RUNNER_TOKEN`.
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

/// Validate that `concurrency_factor` is a positive finite number.
///
/// Shared between `run_config()` (CLI entry) and `validate()` (config load)
/// so the invariant is defined in one place.
pub(crate) fn validate_concurrency_factor(value: f64) -> RunnerResult<()> {
    if !value.is_finite() || value <= 0.0 {
        return Err(RunnerError::Config(
            "concurrency_factor must be a positive finite number".into(),
        ));
    }
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
    // Pure-CPU checks first — fail fast before any filesystem I/O.
    crate::group::validate_or_err(&config.group)?;
    if config.profiles.is_empty() {
        return Err(RunnerError::Config("profiles must not be empty".into()));
    }
    for name in config.profiles.keys() {
        profile::validate_or_err(name)?;
    }
    for profile in config.profiles.values() {
        crate::image_hash::validate_or_err(&profile.rootfs_hash)?;
        crate::image_hash::validate_or_err(&profile.snapshot_hash)?;
    }

    check_path_exists(&config.ca_dir, "ca_dir").await?;
    check_path_exists(&config.firecracker.binary, "firecracker binary").await?;
    check_path_exists(&config.firecracker.kernel, "kernel").await?;

    for (name, profile) in &config.profiles {
        if profile.vcpu == 0 || profile.memory_mb == 0 || profile.disk_mb == 0 {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu, memory_mb, and disk_mb must be non-zero"
            )));
        }
        if profile.vcpu > MAX_VCPU {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu ({}) exceeds maximum ({MAX_VCPU})",
                profile.vcpu
            )));
        }
        if profile.memory_mb > MAX_MEMORY_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: memory_mb ({}) exceeds maximum ({MAX_MEMORY_MB})",
                profile.memory_mb
            )));
        }
        if profile.disk_mb > MAX_DISK_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: disk_mb ({}) exceeds maximum ({MAX_DISK_MB})",
                profile.disk_mb
            )));
        }
        // Validate rootfs files exist on disk.
        let rootfs_paths = RootfsPaths::new(home, &profile.rootfs_hash);
        for path in rootfs_paths.expected_files() {
            check_path_exists(&path, &format!("profile {name} rootfs")).await?;
        }
        // Validate snapshot files exist on disk.
        let snapshot_paths = rootfs_paths.snapshot(&profile.snapshot_hash);
        for path in snapshot_paths.expected_files() {
            check_path_exists(&path, &format!("profile {name} snapshot")).await?;
        }
    }

    validate_concurrency_factor(config.sandbox.concurrency_factor)?;
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
        let rootfs_paths = RootfsPaths::new(home, &profile.rootfs_hash);
        let snapshot_paths = rootfs_paths.snapshot(&profile.snapshot_hash);
        sandbox::FactoryConfig {
            profile: profile_name.to_string(),
            binary_path: firecracker.binary.clone(),
            kernel_path: firecracker.kernel.clone(),
            rootfs_path: rootfs_paths.rootfs(),
            base_dir: base_dir.to_path_buf(),
            snapshot: Some(sandbox::SnapshotRef {
                output_dir: snapshot_paths.dir().to_path_buf(),
                hash: profile.snapshot_hash.clone(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 64 lowercase hex chars — matches `Sha256::digest(...).hex_encode()`.
    const TEST_ROOTFS_HASH: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const TEST_SNAPSHOT_HASH: &str =
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    /// Create a HomePaths rooted in a temp dir and populate fake image files
    /// for the given (rootfs_hash, snapshot_hash) pairs so config validation passes.
    async fn test_home_with_artifacts(dir: &std::path::Path, hashes: &[(&str, &str)]) -> HomePaths {
        let home = HomePaths::with_root(dir.join("vm0-runner"));
        for &(rootfs_hash, snapshot_hash) in hashes {
            let rootfs = RootfsPaths::new(&home, rootfs_hash);
            tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
            tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
            if !snapshot_hash.is_empty() {
                let snapshot = rootfs.snapshot(snapshot_hash);
                tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
                for path in [
                    snapshot.snapshot_bin(),
                    snapshot.memory_bin(),
                    snapshot.cow_img(),
                ] {
                    tokio::fs::write(&path, b"").await.unwrap();
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
                rootfs_hash: TEST_ROOTFS_HASH.into(),
                snapshot_hash: TEST_SNAPSHOT_HASH.into(),
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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
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
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load_with_home(&config_path, &home).await.unwrap();
        assert_eq!(config.name, "test-runner");
        assert_eq!(config.profiles.len(), 1);
        let default = &config.profiles["vm0/default"];
        assert_eq!(default.vcpu, 2);
        assert_eq!(default.rootfs_hash, TEST_ROOTFS_HASH);
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
        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
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
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
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
    async fn load_rejects_invalid_rootfs_hash() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

        // `../etc` would escape `images_dir()` if joined unchecked. The
        // validator must reject this at config-load time, before any
        // filesystem I/O on the bad path.
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
    rootfs_hash: ../etc
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(err.to_string().contains("invalid image hash"), "got: {err}");
    }

    #[tokio::test]
    async fn load_rejects_invalid_snapshot_hash() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: ../etc
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(err.to_string().contains("invalid image hash"), "got: {err}");
    }

    #[tokio::test]
    async fn load_rejects_zero_vcpu_in_profile() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 0
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
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
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 0
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(err.to_string().contains("non-zero"), "got: {err}");
    }

    #[tokio::test]
    async fn load_accepts_vcpu_at_maximum() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 1024
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        // vcpu == MAX_VCPU should be accepted (validation uses >, not >=)
        let result = load_with_home(&config_path, &home).await;
        assert!(result.is_ok(), "got: {}", result.unwrap_err());
    }

    #[tokio::test]
    async fn load_rejects_excessive_vcpu_in_profile() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2048
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
    }

    #[tokio::test]
    async fn load_rejects_excessive_memory_mb_in_profile() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 2000000
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
    }

    #[tokio::test]
    async fn load_rejects_excessive_disk_mb_in_profile() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), &[] as &[(&str, &str)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 2000000
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let err = load_with_home(&config_path, &home).await.unwrap_err();
        assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
    }

    #[tokio::test]
    async fn load_rejects_incomplete_image() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }

        // Create rootfs.ext4 but NO snapshot files — validation should fail.
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
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

        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
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
                hash = TEST_ROOTFS_HASH,
                snap_hash = TEST_SNAPSHOT_HASH,
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
        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

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
        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

        let yaml = format!(
            r#"
name: test
group: test/group
base_dir: my-runner
ca_dir: artifacts
firecracker:
  binary: artifacts/firecracker
  kernel: artifacts/vmlinux
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

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
        let rootfs_paths = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
        assert_eq!(fc.rootfs_path, rootfs_paths.rootfs());
        assert_eq!(fc.profile, "vm0/default");
        let snap = fc.snapshot.unwrap();
        assert_eq!(snap.hash, TEST_SNAPSHOT_HASH);
        let snapshot_paths = RootfsPaths::new(&home, TEST_ROOTFS_HASH).snapshot(TEST_SNAPSHOT_HASH);
        assert_eq!(snap.output_dir, snapshot_paths.dir().to_path_buf());
    }

    #[tokio::test]
    async fn idle_pool_config_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let fc = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for f in [&fc, &kernel] {
            tokio::fs::write(f, b"").await.unwrap();
        }
        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

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
        let home =
            test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

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
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 16384
"#,
            base_dir = dir.path().display(),
            ca_dir = dir.path().display(),
            fc = fc.display(),
            kernel = kernel.display(),
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        );

        let config_path = dir.path().join("runner.yaml");
        tokio::fs::write(&config_path, &yaml).await.unwrap();

        let config = load_with_home(&config_path, &home).await.unwrap();
        assert_eq!(config.sandbox.idle_timeout_secs, DEFAULT_IDLE_TIMEOUT_SECS);
        assert_eq!(config.sandbox.max_idle, 0);
    }
}
