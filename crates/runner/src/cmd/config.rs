use std::collections::BTreeMap;

use clap::Args;

use crate::config::{
    self, DEFAULT_CONCURRENCY_FACTOR, DEFAULT_MAX_CONCURRENT, FirecrackerConfig, ProfileConfig,
    RunnerConfig, SandboxConfig, ServerConfig,
};
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;
use crate::profile;

#[derive(Args)]
pub struct ConfigArgs {
    /// Profile entries: --profile vm0/default --rootfs-hash abc --snapshot-hash def
    /// Can be repeated for multiple profiles. Each --profile starts a new entry.
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
    /// Runner group in vm0/<name> format (e.g. "vm0/production")
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

    /// Keep VMs alive between conversation turns for session reuse
    #[arg(long)]
    keep_alive: bool,

    /// vm0 API URL
    #[arg(long, env = "VM0_API_URL")]
    api_url: String,
    /// Runner authentication token
    #[arg(long, env = "VM0_RUNNER_TOKEN")]
    token: String,
}

pub async fn run_config(args: ConfigArgs) -> RunnerResult<()> {
    // Validate parallel arrays have same length.
    if args.profile.len() != args.rootfs_hash.len()
        || args.profile.len() != args.snapshot_hash.len()
    {
        return Err(RunnerError::Config(
            "--profile, --rootfs-hash, and --snapshot-hash must be specified the same number of times".into(),
        ));
    }

    let paths = HomePaths::new()?;

    // Build profiles map, validating each entry.
    let mut profiles = BTreeMap::new();
    for (i, profile_name) in args.profile.iter().enumerate() {
        if !profile::validate_name(profile_name) {
            return Err(RunnerError::Config(format!(
                "invalid profile name: {profile_name}"
            )));
        }

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

        // Verify artifacts exist on disk.
        let rootfs_dir = paths.rootfs_dir().join(rootfs_hash);
        if !tokio::fs::try_exists(&rootfs_dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("check rootfs dir: {e}")))?
        {
            return Err(RunnerError::Config(format!(
                "rootfs not found for hash {rootfs_hash}; run `build --profile {profile_name}` first"
            )));
        }
        let snapshot_dir = paths.snapshots_dir().join(snapshot_hash);
        if !tokio::fs::try_exists(&snapshot_dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("check snapshot dir: {e}")))?
        {
            return Err(RunnerError::Config(format!(
                "snapshot not found for hash {snapshot_hash}; run `build --profile {profile_name}` first"
            )));
        }

        profiles.insert(
            profile_name.clone(),
            ProfileConfig {
                rootfs_hash: rootfs_hash.clone(),
                snapshot_hash: Some(snapshot_hash.clone()),
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
            keep_alive: args.keep_alive,
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
