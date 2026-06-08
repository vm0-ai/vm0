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
//! 2. `validate` checks group name, profile names, image hashes, static host
//!    paths, resource ceilings, and the concurrency factor.
//! 3. Callers that consume image artifacts hold the relevant rootfs/snapshot
//!    locks and call [`validate_profile_image_artifacts`].
//! 4. Callers derive runtime objects (e.g. [`sandbox::FactoryConfig`]) from
//!    the loaded config.
//!
//! # Image identity: two content hashes per profile
//! Each [`ProfileConfig`] carries two hashes with different scopes:
//! - `rootfs_hash` — content hash of the bootable guest filesystem image on
//!   this runner. Shared across snapshot variants on the same host.
//! - `snapshot_hash` — content hash of the rootfs hash plus the
//!   FC/kernel/vcpu/memory/provider config used to capture the memory snapshot.
//!   Local-only: snapshots are produced on each runner by booting the rootfs
//!   and capturing state, since the captured memory binds to host-specific
//!   state.
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
    /// Content-addressed snapshot hash (local-only, covers rootfs plus VM/provider config).
    pub snapshot_hash: String,
    /// Guest vCPU count. Must be non-zero and ≤ 1024.
    pub vcpu: u32,
    /// Guest RAM in MiB. Must be non-zero and ≤ 1 TiB.
    pub memory_mb: u32,
    /// Rootfs disk in MiB. Used to size the bootable rootfs image.
    /// Must be non-zero and ≤ 1 TiB.
    pub rootfs_disk_mb: u32,
    /// Workspace disk in MiB. Used to size the writable workspace drive.
    /// Must be non-zero and ≤ 1 TiB.
    pub workspace_disk_mb: u32,
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
    // Image artifacts are mutable cache outputs. Runtime callers validate
    // them only after acquiring the matching shared rootfs/snapshot locks.
    load_with_home(path, &home, false).await
}

async fn load_with_home(
    path: &Path,
    home: &HomePaths,
    validate_image_artifacts: bool,
) -> RunnerResult<RunnerConfig> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| RunnerError::Config(format!("read {}: {e}", path.display())))?;
    let mut config: RunnerConfig = serde_yaml_ng::from_str(&content)
        .map_err(|e| RunnerError::Config(format!("parse {}: {e}", path.display())))?;
    if let Some(config_dir) = path.parent() {
        config.resolve_relative_paths(config_dir);
    }
    validate(&config, home, validate_image_artifacts).await?;
    Ok(config)
}

/// Generate a runner.yaml config file from a `RunnerConfig`.
pub async fn generate(config: &RunnerConfig) -> RunnerResult<()> {
    let runner_dir = &config.base_dir;
    crate::private_fs::ensure_private_dir(runner_dir).await?;

    let content = serde_yaml_ng::to_string(config)
        .map_err(|e| RunnerError::Config(format!("serialize config: {e}")))?;

    let config_path = runner_dir.join("runner.yaml");
    crate::private_fs::write_private_file(&config_path, content.as_bytes()).await?;
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

async fn check_snapshot_complete_marker(path: &Path, label: &str) -> RunnerResult<()> {
    let content = tokio::fs::read(path)
        .await
        .map_err(|e| RunnerError::Config(format!("read {label}: {e}")))?;
    if content != sandbox_fc::SNAPSHOT_COMPLETE_MARKER_CONTENT {
        return Err(RunnerError::Config(format!(
            "{label} is invalid: {}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) async fn validate_profile_image_artifacts(
    name: &str,
    profile: &ProfileConfig,
    home: &HomePaths,
) -> RunnerResult<()> {
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
    check_snapshot_complete_marker(
        &snapshot_paths.complete_marker(),
        &format!("profile {name} snapshot complete marker"),
    )
    .await?;
    Ok(())
}

async fn validate(
    config: &RunnerConfig,
    home: &HomePaths,
    validate_image_artifacts: bool,
) -> RunnerResult<()> {
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
        if profile.vcpu == 0
            || profile.memory_mb == 0
            || profile.rootfs_disk_mb == 0
            || profile.workspace_disk_mb == 0
        {
            return Err(RunnerError::Config(format!(
                "profile {name}: vcpu, memory_mb, rootfs_disk_mb, and workspace_disk_mb must be non-zero"
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
        if profile.rootfs_disk_mb > MAX_DISK_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: rootfs_disk_mb ({}) exceeds maximum ({MAX_DISK_MB})",
                profile.rootfs_disk_mb
            )));
        }
        if profile.workspace_disk_mb > MAX_DISK_MB {
            return Err(RunnerError::Config(format!(
                "profile {name}: workspace_disk_mb ({}) exceeds maximum ({MAX_DISK_MB})",
                profile.workspace_disk_mb
            )));
        }
        if validate_image_artifacts {
            validate_profile_image_artifacts(name, profile, home).await?;
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
#[path = "config_tests.rs"]
mod tests;
