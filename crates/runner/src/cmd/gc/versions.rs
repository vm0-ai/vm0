use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::{Duration, SystemTime};

use tracing::{info, warn};

use crate::cmd::service;
#[cfg(test)]
use crate::error::RunnerError;
use crate::error::RunnerResult;
use crate::host_file;
use crate::lock;
use crate::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{GcDirEntryReader, read_dir_or_missing};
use super::lock_file::{ExistingLockProbe, probe_existing_lock, remove_unused_lock_after_probe};
use super::report::GcReport;

type ServiceUninstallFuture<'a> = Pin<Box<dyn Future<Output = RunnerResult<()>> + 'a>>;
type ServiceUninstallFn = for<'a> fn(&'a service::RunnerServiceUnit) -> ServiceUninstallFuture<'a>;

fn real_uninstall_service_unit(unit: &service::RunnerServiceUnit) -> ServiceUninstallFuture<'_> {
    Box::pin(service::uninstall_service_unit(unit))
}

/// Parse `v<major>.<minor>.<patch>` into a tuple for ordering. Returns `None`
/// for non-semver names so callers can filter them out in one pass.
pub(super) fn parse_semver(name: &str) -> Option<(u32, u32, u32)> {
    let rest = name.strip_prefix('v')?;
    let mut parts = rest.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

async fn version_newest_mtime(home: &HomePaths, bin_dir: &Path, name: &str) -> SystemTime {
    let version_bin = bin_dir.join(name);
    let version_config = home.runners_dir().join(name);
    let version_binary = version_bin.join("runner");
    let version_config_file = version_config.join("runner.yaml");
    let mut newest_mtime = SystemTime::UNIX_EPOCH;
    for path in [
        &version_bin,
        &version_binary,
        &version_config,
        &version_config_file,
    ] {
        if let Ok(meta) = tokio::fs::metadata(path).await
            && let Ok(mtime) = meta.modified()
            && mtime > newest_mtime
        {
            newest_mtime = mtime;
        }
    }
    newest_mtime
}

async fn version_gc_age(home: &HomePaths, bin_dir: &Path, name: &str) -> Duration {
    SystemTime::now()
        .duration_since(version_newest_mtime(home, bin_dir, name).await)
        .unwrap_or_default()
}

/// Why a version survives the current GC pass.
#[derive(Debug, Clone, Eq, PartialEq)]
enum VersionRetentionReason {
    ProtectVersion,
    KeepLatest,
    Recent(Duration),
    InvalidServiceSuffix(String),
    ServiceLockHeld,
    ServiceLockProbeError(String),
    Active,
}

impl VersionRetentionReason {
    fn log_skip(&self, name: &str) {
        match self {
            Self::ProtectVersion => {
                info!("version {name}: protected (--protect-version), skipping");
            }
            Self::KeepLatest => {
                info!("version {name}: within --keep-latest, skipping");
            }
            Self::Recent(age) => {
                info!("version {name}: too recent ({}s), skipping", age.as_secs());
            }
            Self::InvalidServiceSuffix(error) => {
                warn!("version {name}: invalid service unit suffix ({error}), skipping");
            }
            Self::ServiceLockHeld => {
                info!("version {name}: service lock held, skipping");
            }
            Self::ServiceLockProbeError(error) => {
                warn!("version {name}: cannot probe service lock ({error}), skipping");
            }
            Self::Active => {
                info!("version {name}: active, skipping");
            }
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct VersionGcEntry {
    name: String,
    retained: Option<VersionRetentionReason>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(super) struct VersionGcAnalysis {
    entries: Vec<VersionGcEntry>,
    directory_scan_complete: bool,
}

impl VersionGcAnalysis {
    pub(super) fn retained_names(&self) -> impl Iterator<Item = &str> {
        self.entries
            .iter()
            .filter(|entry| entry.retained.is_some())
            .map(|entry| entry.name.as_str())
    }

    pub(super) const fn directory_scan_complete(&self) -> bool {
        self.directory_scan_complete
    }
}

pub(super) async fn analyze_version_gc(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
) -> RunnerResult<VersionGcAnalysis> {
    let mut entry_reader = GcDirEntryReader::new();
    analyze_version_gc_with_reader(home, protect, keep_latest, &mut entry_reader).await
}

async fn analyze_version_gc_with_reader(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
    entry_reader: &mut GcDirEntryReader,
) -> RunnerResult<VersionGcAnalysis> {
    let bin_dir = home.bin_dir();
    let Some(mut entries) = read_dir_or_missing(&bin_dir).await? else {
        return Ok(VersionGcAnalysis {
            entries: Vec::new(),
            directory_scan_complete: true,
        });
    };

    // First pass: collect all semver-named dirs. We need the full set to
    // pick the top `keep_latest` by version, so we can't decide-and-delete
    // in one pass.
    let mut semver_dirs: Vec<(String, (u32, u32, u32))> = Vec::new();
    let mut directory_scan_complete = true;
    loop {
        let entry = match entry_reader
            .next_entry_warn(&mut entries, "gc_versions", &bin_dir)
            .await
        {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => {
                directory_scan_complete = false;
                break;
            }
        };
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(e) => {
                directory_scan_complete = false;
                warn!(
                    "version entry {}: cannot read file type ({e}), skipping",
                    entry.path().display()
                );
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(ver) = parse_semver(name) {
            semver_dirs.push((name.to_string(), ver));
        }
    }

    // Pick the top-N by semver descending. `keep_latest = None` means no
    // version-based protection (pre-#10411 behavior).
    let keep_count = keep_latest.unwrap_or(0);
    let kept_by_latest: HashSet<String> = if keep_count == 0 {
        HashSet::new()
    } else {
        let mut sorted = semver_dirs.clone();
        sorted.sort_by_key(|e| std::cmp::Reverse(e.1));
        sorted
            .into_iter()
            .take(keep_count)
            .map(|(n, _)| n)
            .collect()
    };

    let mut entries = Vec::new();
    for (name, _) in &semver_dirs {
        let retained =
            version_retention_reason(home, &bin_dir, name, protect, &kept_by_latest).await;
        entries.push(VersionGcEntry {
            name: name.clone(),
            retained,
        });
    }

    Ok(VersionGcAnalysis {
        entries,
        directory_scan_complete,
    })
}

#[cfg(test)]
pub(super) async fn analyze_version_gc_with_injected_scan_error(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
    successful_entries: usize,
) -> RunnerResult<VersionGcAnalysis> {
    let mut entry_reader = GcDirEntryReader::failing_after(successful_entries);
    analyze_version_gc_with_reader(home, protect, keep_latest, &mut entry_reader).await
}

async fn version_retention_reason(
    home: &HomePaths,
    bin_dir: &Path,
    name: &str,
    protect: Option<&str>,
    kept_by_latest: &HashSet<String>,
) -> Option<VersionRetentionReason> {
    if protect == Some(name) {
        return Some(VersionRetentionReason::ProtectVersion);
    }

    if kept_by_latest.contains(name) {
        return Some(VersionRetentionReason::KeepLatest);
    }

    let age = version_gc_age(home, bin_dir, name).await;
    if age < GC_MIN_AGE {
        return Some(VersionRetentionReason::Recent(age));
    }

    let unit = match service::RunnerServiceUnit::from_suffix(name) {
        Ok(unit) => unit,
        Err(e) => return Some(VersionRetentionReason::InvalidServiceSuffix(e.to_string())),
    };
    let service_lock_path = home.service_lock(unit.unit_name());
    let service_lock_parent = host_file::file_parent(&service_lock_path);
    match tokio::fs::symlink_metadata(service_lock_parent).await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => match probe_existing_lock(&service_lock_path) {
            ExistingLockProbe::Free(_) | ExistingLockProbe::Missing => {}
            ExistingLockProbe::Held => return Some(VersionRetentionReason::ServiceLockHeld),
            ExistingLockProbe::Error(e) => {
                return Some(VersionRetentionReason::ServiceLockProbeError(e));
            }
        },
        Err(e) => {
            return Some(VersionRetentionReason::ServiceLockProbeError(format!(
                "inspect service lock parent {}: {e}",
                service_lock_parent.display()
            )));
        }
    }

    match service::is_unit_active(&unit).await {
        Ok(true) => Some(VersionRetentionReason::Active),
        Ok(false) => None,
        Err(e) => {
            warn!("version {name}: cannot check unit status ({e}), assuming inactive");
            None
        }
    }
}

#[cfg(test)]
fn successful_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { Ok(()) })
}

#[cfg(test)]
fn failing_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { Err(RunnerError::Internal("fake uninstall failed".to_string())) })
}

#[cfg(test)]
async fn gc_versions(
    home: &HomePaths,
    dry_run: bool,
    protect: Option<&str>,
    keep_latest: Option<usize>,
) -> RunnerResult<Vec<String>> {
    let analysis = analyze_version_gc(home, protect, keep_latest).await?;
    gc_versions_with_analysis_and_uninstall(
        home,
        dry_run,
        analysis,
        successful_fake_uninstall_service_unit,
    )
    .await
}

/// Remove old deployment version directories that are not actively running.
///
/// Scans `home.bin_dir()` for semver-named subdirectories (e.g. `v0.2.0`) and
/// deletes inactive versions (bin dir, runner config dir, and systemd unit).
///
/// Survival rules (any one keeps the version):
/// - `--protect-version` matches the name.
/// - The version is in the top `keep_latest` by semver descending. This covers
///   the "staged but not yet installed" case where two overlapping releases
///   race: the older release's promote must not wipe the newer release's
///   just-staged binary even though the newer unit isn't active yet.
/// - The version binary, config file, or their directories are too recent to
///   safely delete.
/// - The corresponding service lifecycle lock is held by another install,
///   uninstall, or GC pass.
/// - The corresponding systemd unit is active.
pub(super) async fn gc_versions_with_analysis(
    home: &HomePaths,
    dry_run: bool,
    analysis: VersionGcAnalysis,
) -> RunnerResult<GcReport> {
    let removed = gc_versions_with_analysis_and_uninstall(
        home,
        dry_run,
        analysis,
        real_uninstall_service_unit,
    )
    .await?;
    Ok(GcReport::removed_versions(removed))
}

async fn gc_versions_with_analysis_and_uninstall(
    home: &HomePaths,
    dry_run: bool,
    analysis: VersionGcAnalysis,
    uninstall_service: ServiceUninstallFn,
) -> RunnerResult<Vec<String>> {
    let bin_dir = home.bin_dir();
    let mut removed: Vec<String> = Vec::new();
    for entry in &analysis.entries {
        let name = &entry.name;
        if let Some(reason) = &entry.retained {
            reason.log_skip(name);
            continue;
        }

        let version_bin = bin_dir.join(name);
        let version_config = home.runners_dir().join(name);
        let age = version_gc_age(home, &bin_dir, name).await;
        if age < GC_MIN_AGE {
            info!("version {name}: too recent ({}s), skipping", age.as_secs());
            continue;
        }

        let unit = match service::RunnerServiceUnit::from_suffix(name) {
            Ok(u) => u,
            Err(_) => continue,
        };
        let service_lock_path = home.service_lock(unit.unit_name());
        let service_lock_name = service_lock_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("service lock")
            .to_string();
        let service_lock = if dry_run {
            let service_lock_parent = host_file::file_parent(&service_lock_path);
            match tokio::fs::symlink_metadata(service_lock_parent).await {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Ok(_) => match probe_existing_lock(&service_lock_path) {
                    ExistingLockProbe::Free(lock) => Some(lock),
                    ExistingLockProbe::Missing => None,
                    ExistingLockProbe::Held => {
                        info!("version {name}: service lock held, skipping");
                        continue;
                    }
                    ExistingLockProbe::Error(e) => {
                        warn!("version {name}: cannot probe service lock ({e}), skipping");
                        continue;
                    }
                },
                Err(e) => {
                    warn!(
                        "version {name}: cannot inspect service lock parent {} before dry-run ({e}), skipping",
                        service_lock_parent.display()
                    );
                    continue;
                }
            }
        } else {
            match lock::try_acquire_or_busy(service_lock_path.clone()).await {
                Ok(lock::TryLock::Acquired(lock)) => Some(lock),
                Ok(lock::TryLock::Busy) => {
                    info!("version {name}: service lock held, skipping");
                    continue;
                }
                Err(e) => {
                    warn!("version {name}: cannot acquire service lock ({e}), skipping");
                    continue;
                }
            }
        };

        let age = version_gc_age(home, &bin_dir, name).await;
        if age < GC_MIN_AGE {
            info!(
                "version {name}: became too recent before delete ({}s), skipping",
                age.as_secs()
            );
            continue;
        }

        // Check while holding the service lifecycle lock so install cannot
        // race between the active probe and the remove path.
        match service::is_unit_active(&unit).await {
            Ok(true) => {
                info!("version {name}: active, skipping");
                continue;
            }
            Ok(false) => {}
            Err(e) => {
                // systemctl may be unavailable on non-systemd hosts. Continue
                // to the uninstall step; it will refuse deletion if it cannot
                // prove the service is stopped.
                warn!("version {name}: cannot check unit status ({e}), assuming inactive");
            }
        }

        if dry_run {
            info!("[dry-run] would remove version {name}");
        } else {
            let Some(service_lock) = service_lock.as_ref() else {
                warn!("version {name}: service lock missing before delete, skipping");
                continue;
            };
            // Uninstall is best-effort for missing/inactive units, but it
            // returns an error when it cannot prove the service is stopped.
            // In that case the version may still be backing a live runner, so
            // keep the bin/config directories for the next GC pass.
            if let Err(e) = uninstall_service(&unit).await {
                warn!("version {name}: cannot uninstall service safely ({e}), skipping");
                continue;
            }

            // Remove bin directory.
            if let Err(e) = tokio::fs::remove_dir_all(&version_bin).await
                && e.kind() != std::io::ErrorKind::NotFound
            {
                warn!("cannot remove {}: {e}", version_bin.display());
                continue;
            }

            // Best-effort remove runner config directory.
            let _ = tokio::fs::remove_dir_all(&version_config).await;

            info!("removed version {name}");
            remove_unused_lock_after_probe(
                &service_lock_path,
                service_lock,
                &service_lock_name,
                false,
            )
            .await;
        }
        removed.push(name.clone());
    }

    Ok(removed)
}

#[cfg(test)]
mod tests;
