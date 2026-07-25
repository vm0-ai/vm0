use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use tracing::warn;

use crate::cmd::service;
use crate::config;
use crate::image_hash;
use crate::paths::HomePaths;

use super::filesystem::{GcDirEntryReader, read_dir_or_missing};
use super::versions::VersionGcAnalysis;

type ProtectedImageRefMap = HashMap<String, HashSet<String>>;

pub(super) enum ProtectedImageRefs {
    Complete(ProtectedImageRefMap),
    Incomplete,
}

impl ProtectedImageRefs {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) const fn is_complete(&self) -> bool {
        matches!(self, Self::Complete(_))
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        match self {
            Self::Complete(refs) => refs.is_empty(),
            Self::Incomplete => false,
        }
    }

    #[cfg(test)]
    pub(super) const fn incomplete() -> Self {
        Self::Incomplete
    }
}

impl Default for ProtectedImageRefs {
    fn default() -> Self {
        Self::Complete(HashMap::new())
    }
}

#[derive(serde::Deserialize)]
struct ConfigImageRefs {
    profiles: BTreeMap<String, ConfigProfileImageRef>,
}

#[derive(serde::Deserialize)]
struct ConfigProfileImageRef {
    rootfs_hash: String,
    snapshot_hash: String,
}

fn insert_protected_image_ref(
    protected_image_refs: &mut ProtectedImageRefs,
    rootfs_hash: String,
    snapshot_hash: String,
) {
    if let ProtectedImageRefs::Complete(refs) = protected_image_refs {
        refs.entry(rootfs_hash).or_default().insert(snapshot_hash);
    }
}

pub(super) fn is_protected_image_ref(
    protected_image_refs: &ProtectedImageRefs,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> bool {
    match protected_image_refs {
        ProtectedImageRefs::Complete(refs) => refs
            .get(rootfs_hash)
            .is_some_and(|snapshot_hashes| snapshot_hashes.contains(snapshot_hash)),
        // Preserve fail-closed behavior if a future caller checks a pair
        // without first rejecting the incomplete inventory.
        ProtectedImageRefs::Incomplete => true,
    }
}

pub(super) async fn protected_image_refs_for_gc(
    home: &HomePaths,
    version_analysis: &VersionGcAnalysis,
) -> ProtectedImageRefs {
    if !version_analysis.directory_scan_complete() {
        warn!("runner image refs: version directory scan incomplete, skipping image GC");
        return ProtectedImageRefs::Incomplete;
    }

    let mut refs = ProtectedImageRefs::new();
    collect_retained_version_image_refs(home, version_analysis, &mut refs).await;
    if !collect_enabled_service_image_refs(&mut refs).await {
        return ProtectedImageRefs::Incomplete;
    }
    refs
}

async fn collect_retained_version_image_refs(
    home: &HomePaths,
    version_analysis: &VersionGcAnalysis,
    refs: &mut ProtectedImageRefs,
) {
    for name in version_analysis.retained_names() {
        let config_path = home.runners_dir().join(name).join("runner.yaml");
        collect_config_image_refs(&config_path, "retained version", refs).await;
    }
}

async fn collect_enabled_service_image_refs(refs: &mut ProtectedImageRefs) -> bool {
    collect_enabled_service_image_refs_from_dir(Path::new("/etc/systemd/system"), refs).await
}

async fn collect_enabled_service_image_refs_from_dir(
    system_dir: &Path,
    refs: &mut ProtectedImageRefs,
) -> bool {
    let scan = enabled_runner_service_config_paths(system_dir).await;
    for config_path in scan.paths {
        collect_config_image_refs(&config_path, "enabled service", refs).await;
    }
    scan.inventory_complete
}

struct EnabledRunnerServiceConfigPaths {
    paths: Vec<PathBuf>,
    inventory_complete: bool,
}

async fn enabled_runner_service_config_paths(system_dir: &Path) -> EnabledRunnerServiceConfigPaths {
    let mut entry_reader = GcDirEntryReader::new();
    enabled_runner_service_config_paths_with_reader(system_dir, &mut entry_reader).await
}

async fn enabled_runner_service_config_paths_with_reader(
    system_dir: &Path,
    entry_reader: &mut GcDirEntryReader,
) -> EnabledRunnerServiceConfigPaths {
    let Some(mut entries) = (match read_dir_or_missing(system_dir).await {
        Ok(entries) => entries,
        Err(e) => {
            warn!(
                "runner service image refs: cannot read {} ({e}), skipping service-derived refs",
                system_dir.display()
            );
            return EnabledRunnerServiceConfigPaths {
                paths: Vec::new(),
                inventory_complete: false,
            };
        }
    }) else {
        return EnabledRunnerServiceConfigPaths {
            paths: Vec::new(),
            inventory_complete: true,
        };
    };

    let mut paths = Vec::new();
    let mut inventory_complete = true;
    loop {
        let entry = match entry_reader
            .next_entry_warn(&mut entries, "runner_service_config_refs", system_dir)
            .await
        {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => {
                inventory_complete = false;
                break;
            }
        };
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(unit) = service::RunnerServiceUnit::from_file_name(file_name) else {
            continue;
        };
        match service::is_unit_enabled(&unit).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                warn!(
                    "runner service image refs: cannot check whether {} is enabled ({e}), protection inventory incomplete",
                    unit.service_name()
                );
                inventory_complete = false;
                continue;
            }
        }
        let config_path = match service::read_unit_config_path(&unit).await {
            Ok(Some(config_path)) => config_path,
            Ok(None) => {
                warn!(
                    "runner service image refs: enabled service {} has no parseable config path, skipping",
                    unit.service_name()
                );
                continue;
            }
            Err(e) => {
                warn!(
                    "runner service image refs: cannot read effective config for enabled service {} ({e}), protection inventory incomplete",
                    unit.service_name()
                );
                inventory_complete = false;
                continue;
            }
        };
        paths.push(config_path);
    }
    EnabledRunnerServiceConfigPaths {
        paths,
        inventory_complete,
    }
}

async fn collect_config_image_refs(
    config_path: &Path,
    source: &str,
    refs: &mut ProtectedImageRefs,
) {
    let Some(content) = (match config::read_diagnostic_config_to_string(config_path).await {
        Ok(content) => content,
        Err(e) => {
            warn!(
                "runner image refs: cannot read {source} config {} ({e}), skipping",
                config_path.display()
            );
            return;
        }
    }) else {
        warn!(
            "runner image refs: {source} config {} is missing, skipping",
            config_path.display()
        );
        return;
    };

    let config = match serde_yaml_ng::from_str::<ConfigImageRefs>(&content) {
        Ok(config) => config,
        Err(_) => {
            warn!(
                "runner image refs: cannot parse {source} config {}, skipping",
                config_path.display()
            );
            return;
        }
    };
    for (_, profile_ref) in config.profiles {
        if image_hash::validate_or_err(&profile_ref.rootfs_hash).is_err() {
            warn!(
                "runner image refs: {source} config {} has a profile with an invalid rootfs hash, skipping profile",
                config_path.display()
            );
            continue;
        }
        if image_hash::validate_or_err(&profile_ref.snapshot_hash).is_err() {
            warn!(
                "runner image refs: {source} config {} has a profile with an invalid snapshot hash, skipping profile",
                config_path.display()
            );
            continue;
        }
        insert_protected_image_ref(refs, profile_ref.rootfs_hash, profile_ref.snapshot_hash);
    }
}

#[cfg(test)]
mod tests;
