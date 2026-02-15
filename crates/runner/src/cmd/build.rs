use clap::Args;

use super::rootfs::RootfsArgs;
use super::snapshot::SnapshotArgs;
use crate::config::{
    self, DEFAULT_MAX_CONCURRENT, DEFAULT_MEMORY_MB, DEFAULT_VCPU, FirecrackerConfig, RunnerConfig,
    SandboxConfig, ServerConfig,
};
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::RunnerResult;
use crate::paths::{HomePaths, RootfsPaths};

#[derive(Args)]
pub struct BuildArgs {
    /// Runner logical name
    #[arg(long)]
    name: String,
    /// Runner group in scope/name format (e.g. "acme/production")
    #[arg(long)]
    group: String,
    /// Runner directory name (under ~/.vm0-runner/runners/)
    #[arg(long)]
    runner_dirname: String,

    #[command(flatten)]
    rootfs: RootfsArgs,
    /// Number of vCPUs for the snapshot VM
    #[arg(long, default_value_t = DEFAULT_VCPU)]
    vcpu: u32,
    /// Memory size in MiB for the snapshot VM
    #[arg(long, default_value_t = DEFAULT_MEMORY_MB)]
    memory_mb: u32,

    /// Maximum concurrent job executions
    #[arg(long, default_value_t = DEFAULT_MAX_CONCURRENT)]
    max_concurrent: usize,

    /// vm0 API URL
    #[arg(long, env = "VM0_API_URL")]
    api_url: String,
    /// Runner authentication token
    #[arg(long, env = "VM0_RUNNER_TOKEN")]
    token: String,
}

pub async fn run_build(args: BuildArgs) -> RunnerResult<()> {
    let rootfs_hash = super::rootfs::run_rootfs(args.rootfs).await?;
    let snapshot_paths = super::snapshot::run_snapshot(SnapshotArgs {
        rootfs_hash: rootfs_hash.clone(),
        vcpu: args.vcpu,
        memory_mb: args.memory_mb,
    })
    .await?;

    // Generate runner.yaml
    let paths = HomePaths::new()?;
    let rootfs_paths = RootfsPaths::new(&paths, &rootfs_hash);
    let runner_dir = paths.runners_dir().join(&args.runner_dirname);

    let runner_config = RunnerConfig {
        name: args.name,
        group: args.group,
        base_dir: runner_dir.clone(),
        ca_dir: rootfs_paths.dir().to_path_buf(),
        firecracker: FirecrackerConfig {
            binary: paths.firecracker_bin(FIRECRACKER_VERSION),
            kernel: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
            rootfs: rootfs_paths.rootfs(),
            snapshot: Some(snapshot_paths),
        },
        sandbox: SandboxConfig {
            vcpu: args.vcpu,
            memory_mb: args.memory_mb,
            max_concurrent: args.max_concurrent,
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
