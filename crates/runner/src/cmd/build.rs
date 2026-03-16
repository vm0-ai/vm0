use clap::Args;

use super::rootfs::RootfsArgs;
use super::snapshot::SnapshotArgs;
use crate::error::RunnerResult;
use crate::profile;

#[derive(Args)]
pub struct BuildArgs {
    #[command(flatten)]
    rootfs: RootfsArgs,
}

pub async fn run_build(args: BuildArgs) -> RunnerResult<()> {
    let def = profile::get(&args.rootfs.profile)?;
    let dry_run = args.rootfs.dry_run;
    let rootfs_hash = super::rootfs::run_rootfs(args.rootfs).await?;
    super::snapshot::run_snapshot(SnapshotArgs {
        rootfs_hash,
        vcpu: def.vcpu,
        memory_mb: def.memory_mb,
        dry_run,
    })
    .await?;

    Ok(())
}
