use clap::Args;

use crate::error::RunnerResult;
use crate::rootfs::RootfsArgs;
use crate::snapshot::{DEFAULT_MEMORY_MB, DEFAULT_VCPU, SnapshotArgs};

#[derive(Args)]
pub struct BuildArgs {
    #[command(flatten)]
    rootfs: RootfsArgs,
    /// Number of vCPUs for the snapshot VM.
    #[arg(long, default_value_t = DEFAULT_VCPU)]
    vcpu: u32,
    /// Memory size in MiB for the snapshot VM.
    #[arg(long, default_value_t = DEFAULT_MEMORY_MB)]
    memory_mb: u32,
}

pub async fn run_build(args: BuildArgs) -> RunnerResult<()> {
    let rootfs_hash = crate::rootfs::run_rootfs(args.rootfs).await?;
    let snapshot_args = SnapshotArgs {
        rootfs_hash,
        vcpu: args.vcpu,
        memory_mb: args.memory_mb,
    };
    crate::snapshot::run_snapshot(snapshot_args).await
}
