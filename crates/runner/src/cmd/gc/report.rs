use tracing::info;

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct GcReport {
    pub(super) freed_bytes: u64,
    pub(super) activity_count: u64,
    removed_versions: Vec<String>,
    pub(super) version_service_locks_removed: u64,
}

impl GcReport {
    pub(super) fn cleanup(activity_count: u64, freed_bytes: u64) -> Self {
        Self {
            freed_bytes,
            activity_count,
            ..Self::default()
        }
    }

    pub(super) fn removed_versions(removed_versions: Vec<String>) -> Self {
        Self {
            activity_count: removed_versions.len() as u64,
            removed_versions,
            ..Self::default()
        }
    }

    pub(super) fn version_service_locks_removed(version_service_locks_removed: u64) -> Self {
        Self {
            activity_count: version_service_locks_removed,
            version_service_locks_removed,
            ..Self::default()
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.activity_count == 0 && self.freed_bytes == 0
    }
}

impl std::ops::AddAssign for GcReport {
    fn add_assign(&mut self, mut rhs: Self) {
        self.freed_bytes += rhs.freed_bytes;
        self.activity_count += rhs.activity_count;
        self.removed_versions.append(&mut rhs.removed_versions);
        self.version_service_locks_removed += rhs.version_service_locks_removed;
    }
}

pub(super) fn log_gc_summary(report: &GcReport, dry_run: bool) {
    if report.is_empty() {
        info!("nothing to clean up");
    } else {
        let verb = if dry_run { "would be freed" } else { "freed" };
        info!("total: {} {verb}", human_bytes(report.freed_bytes));
        if !report.removed_versions.is_empty() {
            let list = report.removed_versions.join(", ");
            if dry_run {
                info!("versions that would be removed: {list}");
            } else {
                info!("versions removed: {list}");
            }
        }
        if report.version_service_locks_removed > 0 {
            if dry_run {
                info!(
                    "version service locks that would be removed: {}",
                    report.version_service_locks_removed
                );
            } else {
                info!(
                    "version service locks removed: {}",
                    report.version_service_locks_removed
                );
            }
        }
    }
}

pub(super) fn human_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.1} GiB", b / GIB)
    } else if b >= MIB {
        format!("{:.1} MiB", b / MIB)
    } else if b >= KIB {
        format!("{:.1} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    fn capture_gc_summary(report: &GcReport, dry_run: bool) -> Vec<String> {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        log_gc_summary(report, dry_run);
        drop(guard);
        captured
            .entries()
            .into_iter()
            .filter_map(|event| event.fields.get("message").cloned())
            .collect()
    }
    #[test]
    fn human_bytes_formats_correctly() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.0 KiB");
        assert_eq!(human_bytes(1024 * 1024), "1.0 MiB");
        assert_eq!(human_bytes(1024 * 1024 * 1024), "1.0 GiB");
    }

    #[test]
    fn gc_report_composition_preserves_all_summary_fields() {
        let mut report = GcReport::cleanup(2, 512);
        report += GcReport::removed_versions(vec!["v1.0.0".into(), "v2.0.0".into()]);
        report += GcReport::version_service_locks_removed(3);
        report += GcReport::cleanup(1, 1024);

        assert_eq!(report.freed_bytes, 1536);
        assert_eq!(report.activity_count, 8);
        assert_eq!(report.removed_versions, ["v1.0.0", "v2.0.0"]);
        assert_eq!(report.version_service_locks_removed, 3);
        assert!(!report.is_empty());
    }

    #[test]
    fn gc_summary_distinguishes_true_noop_from_nonzero_bytes() {
        assert_eq!(
            capture_gc_summary(&GcReport::default(), false),
            ["nothing to clean up"]
        );
        assert_eq!(
            capture_gc_summary(&GcReport::cleanup(0, 1024), false),
            ["total: 1.0 KiB freed"]
        );
    }

    #[test]
    fn gc_summary_reports_zero_byte_activity_in_real_and_dry_run_modes() {
        let report = GcReport::cleanup(1, 0);

        assert_eq!(capture_gc_summary(&report, false), ["total: 0 B freed"]);
        assert_eq!(
            capture_gc_summary(&report, true),
            ["total: 0 B would be freed"]
        );
    }

    #[test]
    fn gc_summary_reports_typed_details_in_real_and_dry_run_modes() {
        let mut report = GcReport::removed_versions(vec!["v1.0.0".into(), "v2.0.0".into()]);
        report += GcReport::version_service_locks_removed(2);

        assert_eq!(
            capture_gc_summary(&report, false),
            [
                "total: 0 B freed",
                "versions removed: v1.0.0, v2.0.0",
                "version service locks removed: 2",
            ]
        );
        assert_eq!(
            capture_gc_summary(&report, true),
            [
                "total: 0 B would be freed",
                "versions that would be removed: v1.0.0, v2.0.0",
                "version service locks that would be removed: 2",
            ]
        );
    }
}
