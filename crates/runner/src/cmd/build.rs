use clap::Args;

use super::rootfs::RootfsArgs;
use super::snapshot::SnapshotArgs;
use crate::config::{DEFAULT_MEMORY_MB, DEFAULT_VCPU};
use crate::error::RunnerResult;

#[derive(Args)]
pub struct BuildArgs {
    #[command(flatten)]
    rootfs: RootfsArgs,
    /// Number of vCPUs for the snapshot VM
    #[arg(long, default_value_t = DEFAULT_VCPU)]
    vcpu: u32,
    /// Memory size in MiB for the snapshot VM
    #[arg(long, default_value_t = DEFAULT_MEMORY_MB)]
    memory_mb: u32,
}

pub async fn run_build(args: BuildArgs) -> RunnerResult<()> {
    let rootfs_hash = super::rootfs::run_rootfs(args.rootfs).await?;
    let (snapshot_hash, _snapshot_config) = super::snapshot::run_snapshot(SnapshotArgs {
        rootfs_hash: rootfs_hash.clone(),
        vcpu: args.vcpu,
        memory_mb: args.memory_mb,
    })
    .await?;

    println!("rootfs_hash={rootfs_hash}");
    println!("snapshot_hash={snapshot_hash}");

    Ok(())
}
