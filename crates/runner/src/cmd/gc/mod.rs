use std::collections::BTreeSet;
use std::time::Duration;

use clap::Args;

use crate::error::RunnerResult;
use crate::paths::HomePaths;

mod debootstrap;
mod deployments;
mod filesystem;
mod image_refs;
mod images;
mod job_logs;
mod lock_file;
mod nbd;
mod orphaned_locks;
mod report;
mod storage;
mod workspaces;

#[cfg(test)]
mod test_support;

use debootstrap::gc_debootstrap;
use deployments::gc_managed_resources;
use image_refs::protected_image_refs_for_gc;
use images::gc_nested_images_with_protected_refs;
use job_logs::gc_job_logs;
use nbd::gc_nbd_orphans;
use orphaned_locks::gc_orphaned_locks;
use report::{GcReport, log_gc_phase_summary, log_gc_summary};
use storage::gc_storage_cache;
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
    /// Keep the N newest eligible items in each independent retention policy:
    /// persistent Runner services, managed binary directories, managed Runner configuration
    /// directories, image snapshots, and stable debootstrap tarballs (each by modification time).
    /// Recent, active, locked, referenced, incomplete, and temporary artifacts follow their own
    /// safety rules; temporary debootstrap tarballs do not consume a stable retention slot.
    /// Omit this option or set it to 0 to disable top-N retention.
    #[arg(long)]
    keep_latest: Option<usize>,
    /// Persistent systemd service suffix to retain.
    #[arg(long)]
    keep_service_suffix: Vec<String>,
    /// Binary directory name to retain under the managed binary root.
    #[arg(long)]
    keep_bin_dirname: Vec<String>,
    /// Runner configuration directory name to retain under the managed runner root.
    #[arg(long)]
    keep_runner_dirname: Vec<String>,
    /// Deprecated compatibility alias that retains the same suffix or dirname in all three
    /// service and managed-directory namespaces.
    #[arg(long, hide = true)]
    protect_version: Option<String>,
}

pub async fn run_gc(args: GcArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;
    let (keep_service_suffixes, keep_bin_dirnames, keep_runner_dirnames) = normalize_keep_sets(
        args.keep_service_suffix,
        args.keep_bin_dirname,
        args.keep_runner_dirname,
        args.protect_version,
    );

    // Managed-resource cleanup holds the complete persistent and loaded
    // service-lock set while it resolves exact references and mutates
    // directories. Image protection then consumes only the final retained
    // config paths, after those locks release.
    let resource_outcome = gc_managed_resources(
        &home,
        &keep_service_suffixes,
        &keep_bin_dirnames,
        &keep_runner_dirnames,
        args.keep_latest,
        args.dry_run,
    )
    .await?;
    let (resource_report, retained_config_paths, resource_inventory_complete) =
        resource_outcome.into_parts();
    let protected_image_refs =
        protected_image_refs_for_gc(&retained_config_paths, resource_inventory_complete).await;

    let mut report = GcReport::default();
    record_gc_phase(
        &mut report,
        "runner services and managed resources",
        resource_report,
        args.dry_run,
    );
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

    // General lock GC preserves the service-lock namespace for lifecycle and
    // rolling-version compatibility; managed-resource GC removes only exact locks
    // whose installed units were successfully removed.
    let lock_report = gc_orphaned_locks(&home, args.dry_run).await?;
    record_gc_phase(&mut report, "orphaned locks", lock_report, args.dry_run);

    let job_log_report = gc_job_logs(&home, args.dry_run).await?;
    record_gc_phase(&mut report, "job logs", job_log_report, args.dry_run);

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

fn normalize_keep_sets(
    service_suffixes: Vec<String>,
    bin_dirnames: Vec<String>,
    runner_dirnames: Vec<String>,
    legacy_name: Option<String>,
) -> (BTreeSet<String>, BTreeSet<String>, BTreeSet<String>) {
    let mut service_suffixes = service_suffixes.into_iter().collect::<BTreeSet<_>>();
    let mut bin_dirnames = bin_dirnames.into_iter().collect::<BTreeSet<_>>();
    let mut runner_dirnames = runner_dirnames.into_iter().collect::<BTreeSet<_>>();
    if let Some(legacy_name) = legacy_name {
        service_suffixes.insert(legacy_name.clone());
        bin_dirnames.insert(legacy_name.clone());
        runner_dirnames.insert(legacy_name);
    }
    (service_suffixes, bin_dirnames, runner_dirnames)
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
    fn gc_protect_version_retains_all_legacy_same_name_namespaces() {
        let cli = GcCli::try_parse_from(["gc", "--protect-version", "v0.78.3"]).unwrap();
        let (service_suffixes, bin_dirnames, runner_dirnames) = normalize_keep_sets(
            cli.args.keep_service_suffix,
            cli.args.keep_bin_dirname,
            cli.args.keep_runner_dirname,
            cli.args.protect_version,
        );

        let expected = BTreeSet::from(["v0.78.3".to_string()]);
        assert_eq!(service_suffixes, expected);
        assert_eq!(bin_dirnames, expected);
        assert_eq!(runner_dirnames, expected);
    }

    #[test]
    fn gc_keep_flags_are_repeatable_and_independent() {
        let cli = GcCli::try_parse_from([
            "gc",
            "--keep-service-suffix",
            "production-blue",
            "--keep-service-suffix",
            "production-green",
            "--keep-bin-dirname",
            "binary-blue",
            "--keep-runner-dirname",
            "config-green",
        ])
        .unwrap();

        assert_eq!(
            cli.args.keep_service_suffix,
            ["production-blue", "production-green"]
        );
        assert_eq!(cli.args.keep_bin_dirname, ["binary-blue"]);
        assert_eq!(cli.args.keep_runner_dirname, ["config-green"]);
    }

    #[test]
    fn gc_legacy_protect_version_is_hidden_from_help() {
        let help = GcCli::command().render_help().to_string();
        assert!(!help.contains("--protect-version"));
    }

    #[test]
    fn gc_keep_latest_help_describes_retention_policy() {
        let help = GcCli::command()
            .render_help()
            .to_string()
            .to_ascii_lowercase();
        for phrase in [
            "each independent retention policy",
            "persistent runner services",
            "managed binary directories",
            "managed runner configuration directories",
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
