use std::collections::BTreeMap;

use clap::Args;

use crate::config::{
    self, DEFAULT_CONCURRENCY_FACTOR, DEFAULT_MAX_CONCURRENT, FirecrackerConfig, ProfileConfig,
    RunnerConfig, SandboxConfig, ServerConfig, validate_concurrency_factor,
};
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;
use crate::profile;

#[derive(Args)]
pub struct ConfigArgs {
    /// Profile entries: --profile vm0/default --rootfs-hash abc --snapshot-hash def
    /// Can be repeated for multiple profiles.
    #[arg(long, required = true)]
    profile: Vec<String>,
    /// Rootfs hash for the preceding --profile (one per profile, in order)
    #[arg(long, required = true)]
    rootfs_hash: Vec<String>,
    /// Snapshot hash for the preceding --profile (one per profile, in order)
    #[arg(long, required = true)]
    snapshot_hash: Vec<String>,

    /// Runner logical name
    #[arg(long)]
    name: String,
    /// Runner group in `vm0/<name>` format (e.g. "vm0/production")
    #[arg(long)]
    group: String,
    /// Runner directory name (under /var/lib/vm0-runner/runners/)
    #[arg(long)]
    runner_dirname: String,

    /// Maximum concurrent VMs (0 = auto-detect from host CPU/memory)
    #[arg(long, default_value_t = DEFAULT_MAX_CONCURRENT)]
    max_concurrent: usize,
    /// Overcommit factor for auto-detected concurrency (must be > 0)
    #[arg(long, default_value_t = DEFAULT_CONCURRENCY_FACTOR)]
    concurrency_factor: f64,

    /// vm0 API URL
    #[arg(long, env = "VM0_API_URL")]
    api_url: String,
    /// Runner authentication token
    #[arg(long, env = "VM0_RUNNER_TOKEN")]
    token: String,
}

pub async fn run_config(args: ConfigArgs) -> RunnerResult<()> {
    // Pure-CPU validation first — fail fast before any filesystem I/O.
    crate::group::validate_or_err(&args.group)?;
    crate::runner_dirname::validate_or_err(&args.runner_dirname)?;
    validate_concurrency_factor(args.concurrency_factor)?;
    if args.profile.len() != args.rootfs_hash.len()
        || args.profile.len() != args.snapshot_hash.len()
    {
        return Err(RunnerError::Config(
            "--profile, --rootfs-hash, and --snapshot-hash must be specified the same number of times".into(),
        ));
    }
    for profile_name in &args.profile {
        profile::validate_or_err(profile_name)?;
    }
    for h in args.rootfs_hash.iter().chain(args.snapshot_hash.iter()) {
        crate::image_hash::validate_or_err(h)?;
    }

    let paths = HomePaths::new()?;

    // Build profiles map.
    let mut profiles = BTreeMap::new();
    for (i, profile_name) in args.profile.iter().enumerate() {
        let def = profile::get(profile_name)?;
        // Length equality is validated above, so these indices are safe.
        let rootfs_hash = args
            .rootfs_hash
            .get(i)
            .ok_or_else(|| RunnerError::Internal(format!("missing rootfs_hash at index {i}")))?;
        let snapshot_hash = args
            .snapshot_hash
            .get(i)
            .ok_or_else(|| RunnerError::Internal(format!("missing snapshot_hash at index {i}")))?;

        // Verify rootfs directory exists on disk.
        let rootfs_dir = paths.images_dir().join(rootfs_hash);
        if !tokio::fs::try_exists(&rootfs_dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("check rootfs dir: {e}")))?
        {
            return Err(RunnerError::Config(format!(
                "rootfs not found for hash {rootfs_hash}; run `build --profile {profile_name}` first"
            )));
        }

        profiles.insert(
            profile_name.clone(),
            ProfileConfig {
                rootfs_hash: rootfs_hash.clone(),
                snapshot_hash: snapshot_hash.clone(),
                vcpu: def.vcpu,
                memory_mb: def.memory_mb,
                disk_mb: def.disk_mb,
            },
        );
    }

    let runner_dir = paths.runners_dir().join(&args.runner_dirname);

    let runner_config = RunnerConfig {
        name: args.name,
        group: args.group,
        base_dir: runner_dir.clone(),
        ca_dir: paths.ca_dir(),
        firecracker: FirecrackerConfig {
            binary: paths.firecracker_bin(FIRECRACKER_VERSION),
            kernel: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        },
        profiles,
        sandbox: SandboxConfig {
            max_concurrent: args.max_concurrent,
            concurrency_factor: args.concurrency_factor,
            ..SandboxConfig::default()
        },
        server: Some(ServerConfig {
            url: args.api_url,
            token: args.token,
        }),
    };

    config::generate(&runner_config).await?;
    let config_path = runner_dir.join("runner.yaml");
    tracing::info!("config written to {}", config_path.display());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_with_dirname(dirname: &str) -> ConfigArgs {
        ConfigArgs {
            profile: vec!["vm0/default".into()],
            rootfs_hash: vec!["dummy".into()],
            snapshot_hash: vec!["dummy".into()],
            name: "test".into(),
            group: "vm0/test".into(),
            runner_dirname: dirname.into(),
            max_concurrent: 0,
            concurrency_factor: 1.0,
            api_url: "http://localhost".into(),
            token: "x".into(),
        }
    }

    /// Asserts that `--runner-dirname` validation is wired into `run_config`.
    /// Without the validator call at the top, a malicious dirname would
    /// reach `paths.runners_dir().join(...)` and escape the base dir.
    #[tokio::test]
    async fn run_config_rejects_traversal_runner_dirname() {
        let err = run_config(args_with_dirname("../etc")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_absolute_runner_dirname() {
        let err = run_config(args_with_dirname("/etc")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    /// Guards against a partial wiring: if someone ever splits the
    /// validator into "leading-char only" and "charset only" halves and
    /// only calls the first, the previous two tests would still pass.
    /// This test covers a charset-only violation (uppercase) that has no
    /// traversal intent, asserting the full validator is invoked.
    #[tokio::test]
    async fn run_config_rejects_charset_violation_runner_dirname() {
        let err = run_config(args_with_dirname("V0.3.0")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    /// Empty string is a common user bug (unset shell variable expanded
    /// into `--runner-dirname ""`). It reaches the validator because
    /// clap does not reject empty arg values on its own. Covers the
    /// `is_empty()` branch, which is short-circuited before the other
    /// rejection conditions.
    #[tokio::test]
    async fn run_config_rejects_empty_runner_dirname() {
        let err = run_config(args_with_dirname("")).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
    }

    fn args_with_concurrency_factor(factor: f64) -> ConfigArgs {
        ConfigArgs {
            profile: vec!["vm0/default".into()],
            rootfs_hash: vec!["dummy".into()],
            snapshot_hash: vec!["dummy".into()],
            name: "test".into(),
            group: "vm0/test".into(),
            runner_dirname: "runner-01".into(),
            max_concurrent: 0,
            concurrency_factor: factor,
            api_url: "http://localhost".into(),
            token: "x".into(),
        }
    }

    #[tokio::test]
    async fn run_config_rejects_zero_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(0.0))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_negative_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(-1.0))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_infinite_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(f64::INFINITY))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }

    #[tokio::test]
    async fn run_config_rejects_nan_concurrency_factor() {
        let err = run_config(args_with_concurrency_factor(f64::NAN))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("concurrency_factor"), "got: {msg}");
    }
}
