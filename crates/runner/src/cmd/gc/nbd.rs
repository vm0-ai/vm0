use tracing::info;

use crate::error::{RunnerError, RunnerResult};

use super::report::GcReport;

/// Scan for lock-free NBD devices whose recorded owner task has exited and
/// optionally disconnect them. Returns the number of orphans cleaned.
pub(super) async fn gc_nbd_orphans(dry_run: bool) -> RunnerResult<GcReport> {
    let (max_devs, orphans) = tokio::task::spawn_blocking(crate::cmd::nbd::find_nbd_orphans)
        .await
        .map_err(|e| RunnerError::Internal(format!("nbd orphan scan task failed: {e}")))?;

    if orphans.is_empty() {
        tracing::debug!("nbd: scanned {max_devs} devices, no orphans");
        return Ok(GcReport::default());
    }

    let found = orphans.len() as u32;
    let mut cleaned: u32 = 0;
    for (device_index, pid) in orphans {
        if dry_run {
            info!(
                "[dry-run] would disconnect orphan NBD device /dev/nbd{device_index} (owner PID {pid} dead)"
            );
            cleaned += 1;
        } else {
            // Re-check before disconnect while holding the same per-index lock
            // the allocator uses. Between the scan and now, the device could
            // have been freed and re-acquired by another runner.
            let result = match tokio::task::spawn_blocking(move || {
                crate::cmd::nbd::disconnect_orphan_if_still_dead(device_index, pid)
            })
            .await
            {
                Ok(result) => result,
                Err(e) => {
                    tracing::warn!("nbd disconnect task failed for /dev/nbd{device_index}: {e}");
                    continue;
                }
            };

            match result {
                crate::cmd::nbd::NbdOrphanDisconnect::Disconnected => {
                    info!(
                        "disconnected orphan NBD device /dev/nbd{device_index} (owner PID {pid} dead)"
                    );
                    cleaned += 1;
                }
                crate::cmd::nbd::NbdOrphanDisconnect::Locked => {
                    info!("nbd{device_index}: skipping disconnect, NBD device lock is held");
                }
                crate::cmd::nbd::NbdOrphanDisconnect::Changed => {
                    info!(
                        "nbd{device_index}: skipping disconnect, device state changed since scan"
                    );
                }
                crate::cmd::nbd::NbdOrphanDisconnect::Failed(e) => {
                    info!("failed to disconnect orphan NBD device /dev/nbd{device_index}: {e}");
                }
            }
        }
    }

    if cleaned < found {
        info!("nbd orphans: {found} found, {cleaned} cleaned");
    }

    Ok(GcReport::cleanup(u64::from(cleaned), 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn gc_nbd_orphans_no_devices() {
        // On CI / dev machines without NBD module, this should return 0 without panicking.
        let report = gc_nbd_orphans(true).await.unwrap();
        assert_eq!(report, GcReport::default());
    }

    #[test]
    fn read_nbd_pid_nonexistent_device() {
        // A device index that almost certainly doesn't exist.
        assert!(crate::cmd::nbd::read_nbd_pid(9999).is_none());
    }

    #[test]
    fn read_nbds_max_returns_default_without_module() {
        // When the NBD module is not loaded, the function should return the default.
        // On CI this is expected; on a host with NBD it returns the actual value.
        let max = crate::cmd::nbd::read_nbds_max();
        assert!(max > 0);
    }
}
