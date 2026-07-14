use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use tracing::warn;

use crate::cmd::service;
use crate::config;
use crate::image_hash;
use crate::paths::HomePaths;

use super::filesystem::{next_entry_warn, read_dir_or_missing};
use super::versions::VersionGcAnalysis;

pub(super) type ProtectedImageRefs = HashMap<String, HashSet<String>>;

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
    protected_image_refs
        .entry(rootfs_hash)
        .or_default()
        .insert(snapshot_hash);
}

pub(super) fn is_protected_image_ref(
    protected_image_refs: &ProtectedImageRefs,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> bool {
    protected_image_refs
        .get(rootfs_hash)
        .is_some_and(|snapshot_hashes| snapshot_hashes.contains(snapshot_hash))
}

pub(super) async fn protected_image_refs_for_gc(
    home: &HomePaths,
    version_analysis: &VersionGcAnalysis,
) -> ProtectedImageRefs {
    let mut refs = ProtectedImageRefs::new();
    collect_retained_version_image_refs(home, version_analysis, &mut refs).await;
    collect_enabled_service_image_refs(&mut refs).await;
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

async fn collect_enabled_service_image_refs(refs: &mut ProtectedImageRefs) {
    for config_path in enabled_runner_service_config_paths(Path::new("/etc/systemd/system")).await {
        collect_config_image_refs(&config_path, "enabled service", refs).await;
    }
}

async fn enabled_runner_service_config_paths(system_dir: &Path) -> Vec<PathBuf> {
    let Some(mut entries) = (match read_dir_or_missing(system_dir).await {
        Ok(entries) => entries,
        Err(e) => {
            warn!(
                "runner service image refs: cannot read {} ({e}), skipping service-derived refs",
                system_dir.display()
            );
            return Vec::new();
        }
    }) else {
        return Vec::new();
    };

    let mut paths = Vec::new();
    while let Some(entry) =
        next_entry_warn(&mut entries, "runner_service_config_refs", system_dir).await
    {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(unit) = runner_service_unit_from_file_name(file_name) else {
            continue;
        };
        match service::is_unit_enabled(&unit).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                warn!(
                    "runner service image refs: cannot check whether {} is enabled ({e}), skipping",
                    unit.service_name()
                );
                continue;
            }
        }
        let Some(config_path) = service::read_unit_config_path(&entry.path()).await else {
            warn!(
                "runner service image refs: enabled service {} has no parseable config path, skipping",
                unit.service_name()
            );
            continue;
        };
        paths.push(config_path);
    }
    paths
}

fn runner_service_unit_from_file_name(file_name: &str) -> Option<service::RunnerServiceUnit> {
    let suffix = file_name
        .strip_prefix("vm0-runner-")?
        .strip_suffix(".service")?;
    service::RunnerServiceUnit::from_suffix(suffix).ok()
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
