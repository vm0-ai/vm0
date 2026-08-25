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
use report::{GcReport, log_gc_phase_summary, log_gc_summary};
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
    /// Keep the N newest eligible items in each independent retention policy: managed runner
    /// versions (by semantic version), image snapshots (by modification time), and stable
    /// debootstrap tarballs (by modification time). Recent, active, locked, referenced, incomplete,
    /// and temporary artifacts follow their own safety rules; temporary debootstrap tarballs do not
    /// consume a stable retention slot.
    /// Omit this option or set it to 0 to disable top-N retention.
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

    let mut report = GcReport::default();
    let images_report = gc_nested_images_with_protected_refs(
        &home,
        args.keep_latest,
        args.dry_run,
        &protected_image_refs,
    )
    .await?;
    record_gc_phase(&mut report, "images", images_report, args.dry_run);

    let nbd_report = gc_nbd_orphans(args.dry_run).await?;
    record_gc_phase(&mut report, "nbd orphans", nbd_report, args.dry_run);

    let workspace_report = GcReport::from(gc_workspace_orphans(&home, args.dry_run).await?);
    record_gc_phase(
        &mut report,
        "workspace orphans",
        workspace_report,
        args.dry_run,
    );

    // General lock GC preserves service locks needed by version cleanup.
    let lock_report = gc_orphaned_locks(&home, args.dry_run).await?;
    record_gc_phase(&mut report, "orphaned locks", lock_report, args.dry_run);

    let job_log_report = gc_job_logs(&home, args.dry_run).await?;
    record_gc_phase(&mut report, "job logs", job_log_report, args.dry_run);

    let version_report = gc_versions_with_analysis(&home, args.dry_run, version_analysis).await?;
    record_gc_phase(&mut report, "versions", version_report, args.dry_run);

    // Version service locks become orphaned only after version cleanup.
    let version_lock_report = gc_orphaned_version_service_locks(&home, args.dry_run).await?;
    record_gc_phase(
        &mut report,
        "version service locks",
        version_lock_report,
        args.dry_run,
    );

    let debootstrap_report = gc_debootstrap(&home, args.keep_latest, args.dry_run).await?;
    record_gc_phase(
        &mut report,
        "debootstrap cache",
        debootstrap_report,
        args.dry_run,
    );

    let storage_report = gc_storage_cache(&home, args.dry_run).await?;
    record_gc_phase(&mut report, "storage cache", storage_report, args.dry_run);

    log_gc_summary(&report, args.dry_run);

    Ok(())
}

fn record_gc_phase(total: &mut GcReport, domain: &str, phase: GcReport, dry_run: bool) {
    log_gc_phase_summary(domain, &phase, dry_run);
    *total += phase;
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, Parser};
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    use crate::cmd::gc::test_support::test_home;

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

    #[test]
    fn gc_keep_latest_help_describes_retention_policy() {
        let help = GcCli::command()
            .render_help()
            .to_string()
            .to_ascii_lowercase();
        for phrase in [
            "each independent retention policy",
            "managed runner versions",
            "semantic version",
            "image snapshots",
            "stable debootstrap tarballs",
            "modification time",
            "recent, active, locked, referenced, incomplete, and temporary artifacts",
            "temporary debootstrap tarballs do not consume a stable retention slot",
            "omit this option or set it to 0 to disable top-n retention",
        ] {
            assert!(
                help.contains(phrase),
                "runner gc help is missing {phrase:?}:\n{help}"
            );
        }

        assert_eq!(
            GcCli::try_parse_from(["gc"]).unwrap().args.keep_latest,
            None
        );
        assert_eq!(
            GcCli::try_parse_from(["gc", "--keep-latest", "0"])
                .unwrap()
                .args
                .keep_latest,
            Some(0)
        );
    }

    async fn capture_orphaned_lock_phase(
        home: &HomePaths,
        dry_run: bool,
    ) -> (GcReport, Vec<String>) {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();

        let phase = gc_orphaned_locks(home, dry_run).await.unwrap();
        let mut total = GcReport::default();
        record_gc_phase(&mut total, "orphaned locks", phase, dry_run);

        drop(guard);
        let messages = captured
            .entries()
            .into_iter()
            .filter_map(|event| event.fields.get("message").cloned())
            .collect();
        (total, messages)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn gc_orphaned_lock_output_is_bounded_in_real_mode() {
        const LOCK_COUNT: usize = 2_000;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let locks_dir = home.locks_dir();
        std::fs::create_dir_all(&locks_dir).unwrap();
        for index in 0..LOCK_COUNT {
            std::fs::write(locks_dir.join(format!("unused-{index}.lock")), "").unwrap();
        }

        let (dry_run_report, dry_run_messages) = capture_orphaned_lock_phase(&home, true).await;
        assert_eq!(dry_run_report, GcReport::cleanup(LOCK_COUNT as u64, 0));
        assert_eq!(dry_run_messages.len(), LOCK_COUNT + 1);
        assert_eq!(
            dry_run_messages
                .iter()
                .filter(|message| message.starts_with("[dry-run] would remove unused lock "))
                .count(),
            LOCK_COUNT
        );
        assert_eq!(
            dry_run_messages.last().map(String::as_str),
            Some("gc orphaned locks complete: would_clean=2000, would_free=0 B")
        );
        assert_eq!(std::fs::read_dir(&locks_dir).unwrap().count(), LOCK_COUNT);

        let (real_report, real_messages) = capture_orphaned_lock_phase(&home, false).await;
        assert_eq!(real_report, GcReport::cleanup(LOCK_COUNT as u64, 0));
        assert_eq!(
            real_messages,
            ["gc orphaned locks complete: cleaned=2000, freed=0 B"]
        );
        assert_eq!(std::fs::read_dir(&locks_dir).unwrap().count(), 0);
    }
}
