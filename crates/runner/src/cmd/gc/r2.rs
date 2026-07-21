use tracing::{info, warn};

use crate::r2_cache::R2ImageCache;

use super::report::{GcReport, human_bytes};

/// Delete R2 template cache objects older than `keep_days`. Errors (R2 not
/// configured, network blip, etc.) are logged and swallowed: GC must not
/// fail the deploy because the cache layer is misconfigured. Returns the
/// successful full-pass report, or an empty report on init or scan failure. A
/// failed scan may have already deleted earlier pages.
///
/// Idempotent across the fleet — every host attempts the same scan; DELETE on
/// already-absent keys is a no-op success.
pub(super) async fn gc_r2(keep_days: u64, dry_run: bool) -> GcReport {
    let cache = match R2ImageCache::from_env().await {
        Ok(Some(c)) => c,
        Ok(None) => {
            info!("r2: cache not configured, skipping R2 GC");
            return GcReport::default();
        }
        Err(e) => {
            warn!("r2: init failed ({e}), skipping R2 GC");
            return GcReport::default();
        }
    };

    if dry_run {
        // No safe dry-run: list_objects_v2 + counting age would still cost
        // R2 reads, and we can't filter without making the call. Surface the
        // intent and skip the destructive part.
        info!("[dry-run] would delete R2 template objects older than {keep_days} days");
        return GcReport::default();
    }

    let max_age = std::time::Duration::from_secs(keep_days.saturating_mul(86_400));
    match cache.gc_older_than(max_age).await {
        Ok((0, _)) => {
            info!("r2: no objects older than {keep_days} days");
            GcReport::default()
        }
        Ok((count, bytes)) => {
            info!(
                "r2: deleted {count} object(s) older than {keep_days} days ({})",
                human_bytes(bytes)
            );
            GcReport::cleanup(count, bytes)
        }
        Err(e) => {
            warn!("r2: GC failed ({e}); will retry on next gc invocation");
            GcReport::default()
        }
    }
}
