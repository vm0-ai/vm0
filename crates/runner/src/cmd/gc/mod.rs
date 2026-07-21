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
mod r2;
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
use r2::gc_r2;
use report::{GcReport, log_gc_summary};
use storage::gc_storage_cache;
use version_service_locks::gc_orphaned_version_service_locks;
use versions::{analyze_version_gc, gc_versions_with_analysis};
use workspaces::gc_workspace_orphans;

/// Default TTL for completed R2 template objects. Older objects are deleted by
/// `gc_r2`. 7 days comfortably covers our typical release cadence: a template
/// from the last week's release is still useful for a host that just spun
/// up. If a host has been offline >7 days and the cached template got swept,
/// the next `runner build` does a one-time local rebuild + re-upload — slow
/// but correct.
const R2_DEFAULT_KEEP_DAYS: u64 = 7;

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
    /// TTL for R2 template cache objects (in days). Objects older than this
    /// are deleted from the `runner-templates/` prefix on R2. Default: 7 days.
    /// Minimum: 1 — `0` would wipe even the just-uploaded template.
    #[arg(long, default_value_t = R2_DEFAULT_KEEP_DAYS, value_parser = clap::value_parser!(u64).range(1..))]
    r2_keep_days: u64,
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
    report += gc_r2(args.r2_keep_days, args.dry_run).await;

    log_gc_summary(&report, args.dry_run);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// `--r2-keep-days 0` would wipe even just-uploaded templates. Verify the
    /// clap range validator rejects it (catches a regression if the
    /// `value_parser` annotation is dropped).
    #[derive(Parser)]
    struct GcCli {
        #[command(flatten)]
        args: GcArgs,
    }

    #[test]
    fn r2_keep_days_zero_is_rejected() {
        let r = GcCli::try_parse_from(["gc", "--r2-keep-days", "0"]);
        assert!(r.is_err(), "--r2-keep-days 0 must be rejected");
    }

    #[test]
    fn r2_keep_days_one_is_accepted() {
        let r = GcCli::try_parse_from(["gc", "--r2-keep-days", "1"]);
        assert!(r.is_ok(), "--r2-keep-days 1 must be accepted");
    }

    #[test]
    fn r2_keep_days_default_when_omitted() {
        let parsed = GcCli::try_parse_from(["gc"]).unwrap();
        assert_eq!(parsed.args.r2_keep_days, R2_DEFAULT_KEEP_DAYS);
    }
    #[test]
    fn gc_protect_version_flag_is_accepted() {
        let r = GcCli::try_parse_from(["gc", "--protect-version", "v0.78.3"]);
        assert!(r.is_ok(), "--protect-version must be accepted");
        let cli = r.unwrap();
        assert_eq!(cli.args.protect_version.as_deref(), Some("v0.78.3"));
    }
}
