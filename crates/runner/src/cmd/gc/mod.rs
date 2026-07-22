use std::time::Duration;

use clap::Args;

use crate::error::RunnerResult;
use crate::paths::HomePaths;

mod debootstrap;
mod filesystem;
mod image_refs;
mod images;
mod job_logs;
mod lock_file;
mod nbd;
mod orphaned_locks;
mod report;
mod storage;
mod version_service_locks;
mod versions;
mod workspaces;

#[cfg(test)]
mod test_support;

use debootstrap::gc_debootstrap;
use image_refs::protected_image_refs_for_gc;
use images::gc_nested_images_with_protected_refs;
use job_logs::gc_job_logs;
use nbd::gc_nbd_orphans;
use orphaned_locks::gc_orphaned_locks;
use report::{GcReport, log_gc_summary};
use storage::gc_storage_cache;
use version_service_locks::gc_orphaned_version_service_locks;
use versions::{analyze_version_gc, gc_versions_with_analysis};
use workspaces::gc_workspace_orphans;

/// Artifacts younger than this are unconditionally kept, regardless of lock
/// status or `--keep-latest`. This prevents races between `runner build`
/// releasing its lock and `runner start` acquiring a shared lock.
const GC_MIN_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Args)]
pub struct GcArgs {
    /// Show what would be deleted without actually deleting
    #[arg(long)]
    dry_run: bool,
    /// Keep the N most recent unused versions (by modification time)
    #[arg(long)]
    keep_latest: Option<usize>,
    /// Version name to protect from GC (e.g. "v0.78.3").
    /// Used during deployment to prevent deleting the version being deployed.
    #[arg(long)]
    protect_version: Option<String>,
}

pub async fn run_gc(args: GcArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;
    // Retained version and service configs protect their image pairs before
    // version cleanup consumes the same retention analysis.
    let version_analysis =
        analyze_version_gc(&home, args.protect_version.as_deref(), args.keep_latest).await?;
    let protected_image_refs = protected_image_refs_for_gc(&home, &version_analysis).await;

    let mut report = gc_nested_images_with_protected_refs(
        &home,
        args.keep_latest,
        args.dry_run,
        &protected_image_refs,
    )
    .await?;

    report += gc_nbd_orphans(args.dry_run).await?;
    report += GcReport::from(gc_workspace_orphans(&home, args.dry_run).await?);

    // General lock GC preserves service locks needed by version cleanup.
    report += gc_orphaned_locks(&home, args.dry_run).await?;
    report += gc_job_logs(&home, args.dry_run).await?;
    report += gc_versions_with_analysis(&home, args.dry_run, version_analysis).await?;

    // Version service locks become orphaned only after version cleanup.
    report += gc_orphaned_version_service_locks(&home, args.dry_run).await?;
    report += gc_debootstrap(&home, args.keep_latest, args.dry_run).await?;
    report += gc_storage_cache(&home, args.dry_run).await?;

    log_gc_summary(&report, args.dry_run);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct GcCli {
        #[command(flatten)]
        args: GcArgs,
    }

    #[test]
    fn gc_protect_version_flag_is_accepted() {
        let r = GcCli::try_parse_from(["gc", "--protect-version", "v0.78.3"]);
        assert!(r.is_ok(), "--protect-version must be accepted");
        let cli = r.unwrap();
        assert_eq!(cli.args.protect_version.as_deref(), Some("v0.78.3"));
    }
}
