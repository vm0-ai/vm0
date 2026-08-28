use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::future::Future;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::time::SystemTime;

use futures_util::{StreamExt, stream};
use nix::fcntl::Flock;
use serde::Deserialize;
use tracing::{info, warn};

use crate::cmd::service;
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{
    GcDirEntryReader, GcDirStatus, collect_dir_stats, gc_path_dir_status, read_dir_or_missing,
};
use super::lock_file::{ExistingLockProbe, probe_existing_lock, remove_unused_lock_after_probe};
use super::report::GcReport;

const RUNNER_BINARY_NAME: &str = "runner";
const RUNNER_CONFIG_NAME: &str = "runner.yaml";
const SERVICE_CONFIG_SNAPSHOT_DIR: &str = "service-config-snapshots";
const SYSTEMD_SYSTEM_DIR: &str = "/etc/systemd/system";
const RESOURCE_QUERY_CONCURRENCY: usize = 4;

type ServiceUninstallFuture<'a> = Pin<Box<dyn Future<Output = RunnerResult<()>> + 'a>>;
type ServiceUninstallFn = for<'a> fn(&'a service::RunnerServiceUnit) -> ServiceUninstallFuture<'a>;
type RemoveDirAllFuture<'a> = Pin<Box<dyn Future<Output = std::io::Result<()>> + 'a>>;
type RemoveDirAllFn = for<'a> fn(&'a Path) -> RemoveDirAllFuture<'a>;

fn real_uninstall_service_unit(unit: &service::RunnerServiceUnit) -> ServiceUninstallFuture<'_> {
    Box::pin(service::uninstall_service_unit(unit))
}

fn real_remove_dir_all(path: &Path) -> RemoveDirAllFuture<'_> {
    Box::pin(tokio::fs::remove_dir_all(path))
}

pub(super) struct ManagedResourceGcOutcome {
    report: GcReport,
    retained_config_paths: Vec<PathBuf>,
    image_inventory_complete: bool,
}

impl ManagedResourceGcOutcome {
    pub(super) fn into_parts(self) -> (GcReport, Vec<PathBuf>, bool) {
        (
            self.report,
            self.retained_config_paths,
            self.image_inventory_complete,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceInventoryKind {
    Persistent,
    ReferenceOnly,
}

struct ServiceRecord {
    unit: service::RunnerServiceUnit,
    kind: ServiceInventoryKind,
    bin_dir: PathBuf,
    runner_dir: Option<PathBuf>,
    activation_config_path: PathBuf,
    newest_mtime: SystemTime,
    retain_record: bool,
}

struct ManagedDir {
    dirname: String,
    path: PathBuf,
    newest_mtime: SystemTime,
    device: u64,
    inode: u64,
    retain: bool,
}

struct LockedUnit {
    unit: service::RunnerServiceUnit,
    kind: ServiceInventoryKind,
    lock: Option<Flock<std::fs::File>>,
}

struct ManagedResourceGcRequest<'a> {
    persistent_service_suffixes: &'a [String],
    reference_only_service_suffixes: &'a [String],
    keep_service_suffixes: &'a BTreeSet<String>,
    keep_bin_dirnames: &'a BTreeSet<String>,
    keep_runner_dirnames: &'a BTreeSet<String>,
    keep_latest: Option<usize>,
    service_inventory_complete: bool,
    dry_run: bool,
}

struct ManagedResourceGcOperations {
    uninstall_service: ServiceUninstallFn,
    remove_dir_all: RemoveDirAllFn,
}

enum ManagedDirRemoval {
    Removed(u64),
    Missing,
    Retained,
    Incomplete,
}

struct InstalledServiceInventory {
    suffixes: Vec<String>,
    complete: bool,
}

#[derive(Deserialize)]
struct ConfigBaseDir {
    base_dir: PathBuf,
}

async fn discover_installed_service_suffixes(system_dir: &Path) -> InstalledServiceInventory {
    let mut entry_reader = GcDirEntryReader::new();
    discover_installed_service_suffixes_with_reader(system_dir, &mut entry_reader).await
}

async fn discover_installed_service_suffixes_with_reader(
    system_dir: &Path,
    entry_reader: &mut GcDirEntryReader,
) -> InstalledServiceInventory {
    let Some(mut entries) = (match read_dir_or_missing(system_dir).await {
        Ok(entries) => entries,
        Err(error) => {
            warn!(
                "runner managed resources: cannot scan installed services in {} ({error}); retaining all resources",
                system_dir.display()
            );
            return InstalledServiceInventory {
                suffixes: Vec::new(),
                complete: false,
            };
        }
    }) else {
        return InstalledServiceInventory {
            suffixes: Vec::new(),
            complete: true,
        };
    };

    let mut suffixes = BTreeSet::new();
    let mut complete = true;
    loop {
        let entry = match entry_reader
            .next_entry_warn(&mut entries, "runner_managed_resources", system_dir)
            .await
        {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => {
                complete = false;
                break;
            }
        };
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            let bytes = file_name.as_bytes();
            if bytes.starts_with(b"vm0-runner-") && bytes.ends_with(b".service") {
                warn!(
                    "runner managed resources: installed Runner service entry {} is not valid UTF-8; retaining all resources",
                    entry.path().display()
                );
                complete = false;
            }
            continue;
        };
        if !file_name.starts_with("vm0-runner-") || !file_name.ends_with(".service") {
            continue;
        }
        let Some(unit) = service::RunnerServiceUnit::from_file_name(file_name) else {
            warn!(
                "runner managed resources: installed Runner service filename {file_name:?} is invalid; retaining all resources"
            );
            complete = false;
            continue;
        };
        suffixes.insert(unit.suffix().to_string());
    }

    InstalledServiceInventory {
        suffixes: suffixes.into_iter().collect(),
        complete,
    }
}

pub(super) async fn gc_managed_resources(
    home: &HomePaths,
    keep_service_suffixes: &BTreeSet<String>,
    keep_bin_dirnames: &BTreeSet<String>,
    keep_runner_dirnames: &BTreeSet<String>,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<ManagedResourceGcOutcome> {
    let persistent_inventory =
        discover_installed_service_suffixes(Path::new(SYSTEMD_SYSTEM_DIR)).await;
    let loaded_units = match service::loaded_runner_service_units().await {
        Ok(units) => Some(units),
        Err(error) => {
            warn!(
                "runner managed resources: cannot scan loaded Runner services ({error}); retaining all resources"
            );
            None
        }
    };
    let persistent = persistent_inventory
        .suffixes
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let reference_only_service_suffixes = loaded_units
        .as_ref()
        .into_iter()
        .flatten()
        .filter(|unit| !persistent.contains(unit.suffix()))
        .map(|unit| unit.suffix().to_string())
        .collect::<Vec<_>>();

    gc_managed_resources_with_operations(
        home,
        ManagedResourceGcRequest {
            persistent_service_suffixes: &persistent_inventory.suffixes,
            reference_only_service_suffixes: &reference_only_service_suffixes,
            keep_service_suffixes,
            keep_bin_dirnames,
            keep_runner_dirnames,
            keep_latest,
            service_inventory_complete: persistent_inventory.complete && loaded_units.is_some(),
            dry_run,
        },
        ManagedResourceGcOperations {
            uninstall_service: real_uninstall_service_unit,
            remove_dir_all: real_remove_dir_all,
        },
    )
    .await
}

async fn gc_managed_resources_with_operations(
    home: &HomePaths,
    request: ManagedResourceGcRequest<'_>,
    operations: ManagedResourceGcOperations,
) -> RunnerResult<ManagedResourceGcOutcome> {
    let ManagedResourceGcRequest {
        persistent_service_suffixes,
        reference_only_service_suffixes,
        keep_service_suffixes,
        keep_bin_dirnames,
        keep_runner_dirnames,
        keep_latest,
        service_inventory_complete,
        dry_run,
    } = request;
    let ManagedResourceGcOperations {
        uninstall_service,
        remove_dir_all,
    } = operations;

    validate_service_suffixes(keep_service_suffixes)?;
    validate_dirnames("--keep-bin-dirname", keep_bin_dirnames)?;
    validate_dirnames("--keep-runner-dirname", keep_runner_dirnames)?;
    if !service_inventory_complete || !managed_roots_are_safe(home).await {
        return Ok(incomplete_outcome());
    }

    let Some(mut bin_dirs) = discover_managed_dirs(
        &home.bin_dir(),
        "binary",
        RUNNER_BINARY_NAME,
        keep_bin_dirnames,
    )
    .await
    else {
        return Ok(incomplete_outcome());
    };
    let Some(mut runner_dirs) = discover_managed_dirs(
        &home.runners_dir(),
        "Runner",
        RUNNER_CONFIG_NAME,
        keep_runner_dirnames,
    )
    .await
    else {
        return Ok(incomplete_outcome());
    };

    mark_recent_managed_dirs(&mut bin_dirs);
    mark_recent_managed_dirs(&mut runner_dirs);
    mark_latest_managed_dirs(&mut bin_dirs, keep_latest.unwrap_or(0));
    mark_latest_managed_dirs(&mut runner_dirs, keep_latest.unwrap_or(0));

    let units = validated_units(persistent_service_suffixes, reference_only_service_suffixes)?;
    let locked_units = match lock_complete_inventory(home, units, dry_run).await {
        Some(locked_units) => locked_units,
        None => return Ok(incomplete_outcome()),
    };
    let records = stream::iter(&locked_units)
        .map(|locked| resolve_service_record(home, locked, keep_service_suffixes))
        .buffered(RESOURCE_QUERY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let Some(mut records) = records.into_iter().collect::<Option<Vec<_>>>() else {
        return Ok(incomplete_outcome());
    };

    if !mark_active_services(&mut records).await {
        return Ok(incomplete_outcome());
    }
    mark_recent_services(&mut records);
    mark_latest_services(&mut records, keep_latest.unwrap_or(0));

    let Some(live_refs) = live_managed_references(home).await else {
        return Ok(incomplete_outcome());
    };
    let Some(runner_lock_state) = lock_managed_runner_dirs(home, &runner_dirs, dry_run).await
    else {
        return Ok(incomplete_outcome());
    };
    let Some(current_bin_dir) = current_managed_bin_dir(home) else {
        return Ok(incomplete_outcome());
    };
    mark_paths_retained(&mut bin_dirs, &live_refs.bin_dirs);
    mark_paths_retained(&mut runner_dirs, &live_refs.runner_dirs);
    mark_paths_retained(&mut runner_dirs, &runner_lock_state.busy_dirs);
    if let Some(current_bin_dir) = current_bin_dir {
        mark_paths_retained(&mut bin_dirs, &HashSet::from([current_bin_dir]));
    }

    if !mark_newly_active_services(&mut records).await {
        return Ok(incomplete_outcome());
    }

    let locks_by_suffix = locked_units
        .iter()
        .map(|locked| (locked.unit.suffix(), locked.lock.as_ref()))
        .collect::<BTreeMap<_, _>>();
    let mut removed_services = Vec::new();
    let mut image_inventory_complete = true;
    for record in &mut records {
        if record.kind == ServiceInventoryKind::ReferenceOnly || record.retain_record {
            continue;
        }
        if dry_run {
            info!(
                "[dry-run] would remove Runner service {}",
                record.unit.suffix()
            );
            removed_services.push(record.unit.suffix().to_string());
            continue;
        }
        if let Err(error) = uninstall_service(&record.unit).await {
            warn!(
                "runner service {}: cannot uninstall safely ({error}); retaining its exact resources",
                record.unit.suffix()
            );
            record.retain_record = true;
            continue;
        }
        let lock_path = record.unit.lock_path(home);
        if let Some(Some(service_lock)) = locks_by_suffix.get(record.unit.suffix()) {
            remove_unused_lock_after_probe(
                &lock_path,
                service_lock,
                record.unit.lock_file_name(),
                false,
            )
            .await;
        }
        removed_services.push(record.unit.suffix().to_string());
    }

    let mut retained_bin_dirs = bin_dirs
        .iter()
        .filter(|item| item.retain)
        .map(|item| item.path.clone())
        .collect::<HashSet<_>>();
    let mut retained_runner_dirs = runner_dirs
        .iter()
        .filter(|item| item.retain)
        .map(|item| item.path.clone())
        .collect::<HashSet<_>>();
    let removed_suffixes = removed_services
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    for record in &records {
        if !removed_suffixes.contains(record.unit.suffix()) {
            retained_bin_dirs.insert(record.bin_dir.clone());
            retained_runner_dirs.extend(record.runner_dir.iter().cloned());
        }
    }

    let mut resource_activity_count = 0;
    let mut freed_bytes = 0;
    for item in &mut runner_dirs {
        if retained_runner_dirs.contains(&item.path) {
            continue;
        }
        match remove_managed_dir("Runner", item, RUNNER_CONFIG_NAME, dry_run, remove_dir_all).await
        {
            ManagedDirRemoval::Removed(size) => {
                resource_activity_count += 1;
                freed_bytes += size;
            }
            ManagedDirRemoval::Missing => {}
            ManagedDirRemoval::Retained => {
                item.retain = true;
                retained_runner_dirs.insert(item.path.clone());
            }
            ManagedDirRemoval::Incomplete => {
                item.retain = true;
                retained_runner_dirs.insert(item.path.clone());
                image_inventory_complete = false;
            }
        }
    }
    for item in &mut bin_dirs {
        if retained_bin_dirs.contains(&item.path) {
            continue;
        }
        match remove_managed_dir("binary", item, RUNNER_BINARY_NAME, dry_run, remove_dir_all).await
        {
            ManagedDirRemoval::Removed(size) => {
                resource_activity_count += 1;
                freed_bytes += size;
            }
            ManagedDirRemoval::Missing => {}
            ManagedDirRemoval::Retained => {
                item.retain = true;
                retained_bin_dirs.insert(item.path.clone());
            }
            ManagedDirRemoval::Incomplete => {
                item.retain = true;
                retained_bin_dirs.insert(item.path.clone());
                image_inventory_complete = false;
            }
        }
    }

    let mut retained_config_paths = records
        .iter()
        .filter(|record| !removed_suffixes.contains(record.unit.suffix()))
        .map(|record| record.activation_config_path.clone())
        .collect::<Vec<_>>();
    retained_config_paths.extend(
        keep_runner_dirnames
            .iter()
            .map(|dirname| home.runners_dir().join(dirname).join(RUNNER_CONFIG_NAME)),
    );
    retained_config_paths.extend(
        runner_dirs
            .iter()
            .filter(|item| retained_runner_dirs.contains(&item.path))
            .map(|item| item.path.join(RUNNER_CONFIG_NAME)),
    );
    retained_config_paths.sort();
    retained_config_paths.dedup();

    let mut report = GcReport::removed_services(removed_services);
    report += GcReport::cleanup(resource_activity_count, freed_bytes);
    Ok(ManagedResourceGcOutcome {
        report,
        retained_config_paths,
        image_inventory_complete,
    })
}

async fn discover_managed_dirs(
    root: &Path,
    label: &str,
    expected_file_name: &str,
    explicit_keeps: &BTreeSet<String>,
) -> Option<Vec<ManagedDir>> {
    let mut entries = match read_dir_or_missing(root).await {
        Ok(Some(entries)) => entries,
        Ok(None) => return Some(Vec::new()),
        Err(error) => {
            warn!(
                "runner managed resources: cannot scan managed {label} root {} ({error}); retaining all resources",
                root.display()
            );
            return None;
        }
    };
    let mut reader = GcDirEntryReader::new();
    let mut dirs = Vec::new();
    loop {
        let entry = match reader
            .next_entry_warn(&mut entries, "runner_managed_resources", root)
            .await
        {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(_) => return None,
        };
        let file_name = entry.file_name();
        let Some(dirname) = file_name.to_str() else {
            warn!(
                "runner managed resources: managed {label} entry {} is not valid UTF-8; retaining all resources",
                entry.path().display()
            );
            return None;
        };
        if !crate::runner_dirname::validate_name(dirname) {
            warn!(
                "runner managed resources: managed {label} entry {dirname:?} has an invalid dirname; retaining all resources"
            );
            return None;
        }
        match gc_path_dir_status(&entry.path()).await {
            Ok(GcDirStatus::RealDir(_)) => {}
            Ok(GcDirStatus::Missing) => continue,
            Ok(GcDirStatus::NotDirectory) => {
                warn!(
                    "runner managed resources: managed {label} entry {} is not a real directory; retaining all resources",
                    entry.path().display()
                );
                return None;
            }
            Err(error) => {
                warn!(
                    "runner managed resources: cannot inspect managed {label} entry {} ({error}); retaining all resources",
                    entry.path().display()
                );
                return None;
            }
        }
        let path = root.join(dirname);
        let stats = collect_dir_stats(&path).await;
        let Some(root_metadata) = stats.root_metadata else {
            warn!(
                "runner managed resources: cannot completely inspect managed {label} directory {}; retaining all resources",
                path.display()
            );
            return None;
        };
        let newest_mtime = stats
            .mtime
            .max(newest_mtime([path.join(expected_file_name)]).await);
        dirs.push(ManagedDir {
            dirname: dirname.to_string(),
            path,
            newest_mtime,
            device: root_metadata.dev(),
            inode: root_metadata.ino(),
            retain: explicit_keeps.contains(dirname),
        });
    }
    dirs.sort_by(|left, right| left.dirname.cmp(&right.dirname));
    Some(dirs)
}

async fn resolve_service_record(
    home: &HomePaths,
    locked: &LockedUnit,
    keep_service_suffixes: &BTreeSet<String>,
) -> Option<ServiceRecord> {
    let command_paths = match service::read_unit_command_paths(&locked.unit).await {
        Ok(Some(paths)) => paths,
        Ok(None) => {
            warn!(
                "runner service {}: effective ExecStart has no parseable Runner command; retaining all resources",
                locked.unit.suffix()
            );
            return None;
        }
        Err(error) => {
            warn!(
                "runner service {}: cannot read effective ExecStart ({error}); retaining all resources",
                locked.unit.suffix()
            );
            return None;
        }
    };

    let Ok(Some(bin_dirname)) = managed_file_dirname(
        command_paths.executable_path(),
        &home.bin_dir(),
        RUNNER_BINARY_NAME,
    ) else {
        warn!(
            "runner service {}: executable {} is outside the managed binary layout; retaining all resources",
            locked.unit.suffix(),
            command_paths.executable_path().display()
        );
        return None;
    };
    let activation_config_path = command_paths.activation_config_path();
    if !activation_config_path.is_absolute() {
        warn!(
            "runner service {}: activation config {} is not absolute; retaining all resources",
            locked.unit.suffix(),
            activation_config_path.display()
        );
        return None;
    }
    let runner_dir = match managed_runner_dir_from_activation_path(
        activation_config_path,
        &home.runners_dir(),
        locked.unit.suffix(),
    ) {
        Ok(Some(path)) => {
            if let Some(config_base_dir) = read_config_base_dir(activation_config_path).await {
                let config_base_dir = config_base_dir?;
                if config_base_dir != path {
                    warn!(
                        "runner service {}: activation config base_dir {} disagrees with managed path {}; retaining all resources",
                        locked.unit.suffix(),
                        config_base_dir.display(),
                        path.display()
                    );
                    return None;
                }
            }
            Some(path)
        }
        Ok(None) => match read_config_base_dir(activation_config_path).await {
            Some(Some(base_dir)) => match managed_exact_dir(&base_dir, &home.runners_dir()) {
                Ok(runner_dir) => runner_dir,
                Err(()) => {
                    warn!(
                        "runner service {}: activation config base_dir {} has an invalid managed Runner layout; retaining all resources",
                        locked.unit.suffix(),
                        base_dir.display()
                    );
                    return None;
                }
            },
            Some(None) => return None,
            None => None,
        },
        Err(()) => return None,
    };

    let bin_dir = home.bin_dir().join(bin_dirname);
    if !managed_service_paths_are_safe(
        locked.unit.suffix(),
        &bin_dir,
        command_paths.executable_path(),
        activation_config_path,
        runner_dir.as_deref(),
    )
    .await
    {
        return None;
    }
    let mut service_mtime = newest_mtime([command_paths.executable_path(), activation_config_path])
        .await
        .max(newest_mtime([locked.unit.unit_file_path()]).await);
    if let Some(runner_dir) = &runner_dir {
        service_mtime = service_mtime.max(newest_mtime([runner_dir]).await);
    }
    Some(ServiceRecord {
        unit: locked.unit.clone(),
        kind: locked.kind,
        bin_dir,
        runner_dir,
        activation_config_path: activation_config_path.to_path_buf(),
        newest_mtime: service_mtime,
        retain_record: locked.kind == ServiceInventoryKind::ReferenceOnly
            || keep_service_suffixes.contains(locked.unit.suffix()),
    })
}

/// `None` means the config does not exist. `Some(None)` means it exists but cannot be resolved.
async fn read_config_base_dir(path: &Path) -> Option<Option<PathBuf>> {
    let content = match crate::config::read_diagnostic_config_to_string(path).await {
        Ok(Some(content)) => content,
        Ok(None) => return None,
        Err(error) => {
            warn!(
                "runner managed resources: cannot read activation config {} ({error}); retaining all resources",
                path.display()
            );
            return Some(None);
        }
    };
    let parsed = match serde_yaml_ng::from_str::<ConfigBaseDir>(&content) {
        Ok(parsed) => parsed,
        Err(error) => {
            warn!(
                "runner managed resources: cannot parse base_dir from activation config {} ({error}); retaining all resources",
                path.display()
            );
            return Some(None);
        }
    };
    let base_dir = if parsed.base_dir.is_absolute() {
        parsed.base_dir
    } else {
        let Some(parent) = path.parent() else {
            return Some(None);
        };
        parent.join(parsed.base_dir)
    };
    Some(Some(base_dir))
}

fn managed_runner_dir_from_activation_path(
    path: &Path,
    root: &Path,
    service_suffix: &str,
) -> Result<Option<PathBuf>, ()> {
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(None);
    };
    let mut components = relative.components();
    let Component::Normal(dirname) = components.next().ok_or(())? else {
        return Err(());
    };
    let dirname = dirname.to_str().ok_or(())?;
    if !crate::runner_dirname::validate_name(dirname) {
        return Err(());
    }
    let Some(second) = components.next() else {
        return Err(());
    };
    match second {
        Component::Normal(file_name)
            if file_name == RUNNER_CONFIG_NAME && components.next().is_none() => {}
        Component::Normal(directory) if directory == SERVICE_CONFIG_SNAPSHOT_DIR => {
            let Component::Normal(file_name) = components.next().ok_or(())? else {
                return Err(());
            };
            if components.next().is_some()
                || !valid_activation_snapshot_file_name(file_name, service_suffix)
            {
                return Err(());
            }
        }
        _ => return Err(()),
    }
    Ok(Some(root.join(dirname)))
}

fn valid_activation_snapshot_file_name(file_name: &std::ffi::OsStr, service_suffix: &str) -> bool {
    let Some(file_name) = file_name.to_str() else {
        return false;
    };
    let Some(digest) = file_name
        .strip_prefix(service_suffix)
        .and_then(|rest| rest.strip_prefix('-'))
        .and_then(|rest| rest.strip_suffix(".yaml"))
    else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn managed_file_dirname(
    path: &Path,
    root: &Path,
    expected_file_name: &str,
) -> Result<Option<String>, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(None);
    };
    let mut components = relative.components();
    let Some(Component::Normal(dirname)) = components.next() else {
        return Err(());
    };
    let Some(Component::Normal(file_name)) = components.next() else {
        return Err(());
    };
    if components.next().is_some() || file_name != expected_file_name {
        return Err(());
    }
    let dirname = dirname.to_str().ok_or(())?;
    if !crate::runner_dirname::validate_name(dirname) {
        return Err(());
    }
    Ok(Some(dirname.to_string()))
}

fn managed_exact_dir(path: &Path, root: &Path) -> Result<Option<PathBuf>, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(None);
    };
    let mut components = relative.components();
    let Some(Component::Normal(dirname)) = components.next() else {
        return Err(());
    };
    if components.next().is_some() {
        return Err(());
    }
    let dirname = dirname.to_str().ok_or(())?;
    if !crate::runner_dirname::validate_name(dirname) {
        return Err(());
    }
    Ok(Some(root.join(dirname)))
}

struct LiveManagedReferences {
    bin_dirs: HashSet<PathBuf>,
    runner_dirs: HashSet<PathBuf>,
}

struct ManagedRunnerLockState {
    busy_dirs: HashSet<PathBuf>,
    _guards: Vec<Flock<std::fs::File>>,
}

async fn live_managed_references(home: &HomePaths) -> Option<LiveManagedReferences> {
    let instances = match crate::live_runner_instances::try_list(home).await {
        Ok(instances) => instances,
        Err(error) => {
            warn!(
                "runner managed resources: cannot read live Runner inventory ({error}); retaining all resources"
            );
            return None;
        }
    };
    let mut bin_dirs = HashSet::new();
    let mut runner_dirs = HashSet::new();
    for instance in instances {
        match managed_exact_dir(&instance.base_dir, &home.runners_dir()) {
            Ok(Some(runner_dir)) => {
                runner_dirs.insert(runner_dir);
            }
            Ok(None) => {}
            Err(()) => {
                warn!(
                    "runner managed resources: live Runner base_dir {} has an invalid managed layout; retaining all resources",
                    instance.base_dir.display()
                );
                return None;
            }
        }
        let proc_exe = PathBuf::from("/proc")
            .join(instance.pid.to_string())
            .join("exe");
        match tokio::fs::read_link(&proc_exe).await {
            Ok(executable) => {
                match managed_file_dirname(&executable, &home.bin_dir(), RUNNER_BINARY_NAME) {
                    Ok(Some(dirname)) => {
                        bin_dirs.insert(home.bin_dir().join(dirname));
                    }
                    Ok(None) => {}
                    Err(()) => {
                        warn!(
                            "runner managed resources: live Runner executable {} has an invalid managed layout; retaining all binary resources",
                            executable.display()
                        );
                        return None;
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                warn!(
                    "runner managed resources: cannot resolve live Runner executable {} ({error}); retaining all binary resources",
                    proc_exe.display()
                );
                return None;
            }
        }
    }
    Some(LiveManagedReferences {
        bin_dirs,
        runner_dirs,
    })
}

async fn lock_managed_runner_dirs(
    home: &HomePaths,
    runner_dirs: &[ManagedDir],
    dry_run: bool,
) -> Option<ManagedRunnerLockState> {
    let mut busy_dirs = HashSet::new();
    let mut guards = Vec::new();
    for item in runner_dirs {
        let canonical = match item.path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                warn!(
                    "runner managed resources: cannot canonicalize managed Runner directory {} ({error}); retaining all resources",
                    item.path.display()
                );
                return None;
            }
        };
        let lock_path = home.base_dir_lock(&canonical);
        if dry_run {
            match probe_existing_lock(&lock_path) {
                ExistingLockProbe::Held => {
                    busy_dirs.insert(item.path.clone());
                }
                ExistingLockProbe::Free(_) | ExistingLockProbe::Missing => {}
                ExistingLockProbe::Error(error) => {
                    warn!(
                        "runner managed resources: cannot probe base-dir lock for {} ({error}); retaining all resources",
                        item.path.display()
                    );
                    return None;
                }
            }
            continue;
        }
        match lock::try_acquire_or_busy(lock_path).await {
            Ok(lock::TryLock::Acquired(guard)) => guards.push(guard),
            Ok(lock::TryLock::Busy) => {
                busy_dirs.insert(item.path.clone());
            }
            Err(error) => {
                warn!(
                    "runner managed resources: cannot acquire base-dir lock for {} ({error}); retaining all resources",
                    item.path.display()
                );
                return None;
            }
        }
    }
    Some(ManagedRunnerLockState {
        busy_dirs,
        _guards: guards,
    })
}

/// `None` means current executable discovery failed; `Some(None)` means it is external.
fn current_managed_bin_dir(home: &HomePaths) -> Option<Option<PathBuf>> {
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            warn!(
                "runner managed resources: cannot resolve current executable ({error}); retaining all binary resources"
            );
            return None;
        }
    };
    match managed_file_dirname(&executable, &home.bin_dir(), RUNNER_BINARY_NAME) {
        Ok(dirname) => Some(dirname.map(|dirname| home.bin_dir().join(dirname))),
        Err(()) => {
            warn!(
                "runner managed resources: current executable {} has an invalid managed layout; retaining all binary resources",
                executable.display()
            );
            None
        }
    }
}

fn mark_paths_retained(items: &mut [ManagedDir], paths: &HashSet<PathBuf>) {
    for item in items {
        item.retain |= paths.contains(&item.path);
    }
}

fn mark_recent_managed_dirs(items: &mut [ManagedDir]) {
    let now = SystemTime::now();
    for item in items {
        let age = now.duration_since(item.newest_mtime).unwrap_or_default();
        item.retain |= age < GC_MIN_AGE;
    }
}

fn mark_latest_managed_dirs(items: &mut [ManagedDir], keep_count: usize) {
    if keep_count == 0 {
        return;
    }
    let mut sorted = items.iter().enumerate().collect::<Vec<_>>();
    sorted.sort_by(|(_, left), (_, right)| {
        right
            .newest_mtime
            .cmp(&left.newest_mtime)
            .then_with(|| left.dirname.cmp(&right.dirname))
    });
    let retained = sorted
        .into_iter()
        .take(keep_count)
        .map(|(index, _)| index)
        .collect::<HashSet<_>>();
    for (index, item) in items.iter_mut().enumerate() {
        item.retain |= retained.contains(&index);
    }
}

async fn mark_active_services(records: &mut [ServiceRecord]) -> bool {
    let persistent_units = records
        .iter()
        .filter(|record| record.kind == ServiceInventoryKind::Persistent)
        .map(|record| record.unit.clone())
        .collect::<Vec<_>>();
    let states = stream::iter(&persistent_units)
        .map(|unit| async move {
            match service::cleanup_unit_is_active(unit).await {
                Ok(active) => Some(active),
                Err(error) => {
                    warn!(
                        "runner service {}: cannot check activity ({error}); retaining all resources",
                        unit.suffix()
                    );
                    None
                }
            }
        })
        .buffered(RESOURCE_QUERY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let Some(states) = states.into_iter().collect::<Option<Vec<_>>>() else {
        return false;
    };
    for (record, active) in records
        .iter_mut()
        .filter(|record| record.kind == ServiceInventoryKind::Persistent)
        .zip(states)
    {
        record.retain_record |= active;
    }
    true
}

async fn mark_newly_active_services(records: &mut [ServiceRecord]) -> bool {
    mark_active_services(records).await
}

fn mark_recent_services(records: &mut [ServiceRecord]) {
    let now = SystemTime::now();
    for record in records {
        if record.kind == ServiceInventoryKind::Persistent {
            let age = now.duration_since(record.newest_mtime).unwrap_or_default();
            record.retain_record |= age < GC_MIN_AGE;
        }
    }
}

fn mark_latest_services(records: &mut [ServiceRecord], keep_count: usize) {
    if keep_count == 0 {
        return;
    }
    let mut sorted = records
        .iter()
        .enumerate()
        .filter(|(_, record)| record.kind == ServiceInventoryKind::Persistent)
        .collect::<Vec<_>>();
    sorted.sort_by(|(_, left), (_, right)| {
        right
            .newest_mtime
            .cmp(&left.newest_mtime)
            .then_with(|| left.unit.suffix().cmp(right.unit.suffix()))
    });
    let retained = sorted
        .into_iter()
        .take(keep_count)
        .map(|(index, _)| index)
        .collect::<HashSet<_>>();
    for (index, record) in records.iter_mut().enumerate() {
        record.retain_record |= retained.contains(&index);
    }
}

fn incomplete_outcome() -> ManagedResourceGcOutcome {
    ManagedResourceGcOutcome {
        report: GcReport::default(),
        retained_config_paths: Vec::new(),
        image_inventory_complete: false,
    }
}

fn validate_dirnames(flag: &str, dirnames: &BTreeSet<String>) -> RunnerResult<()> {
    for dirname in dirnames {
        if !crate::runner_dirname::validate_name(dirname) {
            return Err(RunnerError::Config(format!(
                "invalid {flag} value {}: {}",
                crate::runner_dirname::invalid_name_diagnostic(dirname),
                crate::runner_dirname::validation_rules()
            )));
        }
    }
    Ok(())
}

fn validate_service_suffixes(service_suffixes: &BTreeSet<String>) -> RunnerResult<()> {
    for suffix in service_suffixes {
        service::RunnerServiceUnit::from_suffix(suffix)?;
    }
    Ok(())
}

fn validated_units(
    persistent_suffixes: &[String],
    reference_only_suffixes: &[String],
) -> RunnerResult<Vec<(service::RunnerServiceUnit, ServiceInventoryKind)>> {
    let mut units = BTreeMap::new();
    for suffix in reference_only_suffixes {
        units.insert(
            suffix.clone(),
            (
                service::RunnerServiceUnit::from_suffix(suffix)?,
                ServiceInventoryKind::ReferenceOnly,
            ),
        );
    }
    for suffix in persistent_suffixes {
        units.insert(
            suffix.clone(),
            (
                service::RunnerServiceUnit::from_suffix(suffix)?,
                ServiceInventoryKind::Persistent,
            ),
        );
    }
    Ok(units.into_values().collect())
}

async fn lock_complete_inventory(
    home: &HomePaths,
    units: Vec<(service::RunnerServiceUnit, ServiceInventoryKind)>,
    dry_run: bool,
) -> Option<Vec<LockedUnit>> {
    let mut locked_units = Vec::with_capacity(units.len());
    for (unit, kind) in units {
        let lock_path = unit.lock_path(home);
        let lock = if dry_run {
            match probe_existing_lock(&lock_path) {
                ExistingLockProbe::Free(lock) => Some(lock),
                ExistingLockProbe::Missing => None,
                ExistingLockProbe::Held => {
                    info!(
                        "runner service {}: service lock held; retaining all resources",
                        unit.suffix()
                    );
                    return None;
                }
                ExistingLockProbe::Error(error) => {
                    warn!(
                        "runner service {}: cannot probe service lock ({error}); retaining all resources",
                        unit.suffix()
                    );
                    return None;
                }
            }
        } else {
            match lock::try_acquire_or_busy(lock_path).await {
                Ok(lock::TryLock::Acquired(lock)) => Some(lock),
                Ok(lock::TryLock::Busy) => {
                    info!(
                        "runner service {}: service lock held; retaining all resources",
                        unit.suffix()
                    );
                    return None;
                }
                Err(error) => {
                    warn!(
                        "runner service {}: cannot acquire service lock ({error}); retaining all resources",
                        unit.suffix()
                    );
                    return None;
                }
            }
        };
        locked_units.push(LockedUnit { unit, kind, lock });
    }
    Some(locked_units)
}

async fn managed_roots_are_safe(home: &HomePaths) -> bool {
    for (label, root) in [("binary", home.bin_dir()), ("Runner", home.runners_dir())] {
        match gc_path_dir_status(&root).await {
            Ok(GcDirStatus::RealDir(_) | GcDirStatus::Missing) => {}
            Ok(GcDirStatus::NotDirectory) => {
                warn!(
                    "runner managed resources: managed {label} root {} is not a directory; retaining all resources",
                    root.display()
                );
                return false;
            }
            Err(error) => {
                warn!(
                    "runner managed resources: cannot inspect managed {label} root {} ({error}); retaining all resources",
                    root.display()
                );
                return false;
            }
        }
    }
    true
}

async fn managed_service_paths_are_safe(
    suffix: &str,
    bin_dir: &Path,
    executable_path: &Path,
    activation_config_path: &Path,
    runner_dir: Option<&Path>,
) -> bool {
    for (label, path) in [("binary", Some(bin_dir)), ("Runner", runner_dir)] {
        let Some(path) = path else {
            continue;
        };
        match gc_path_dir_status(path).await {
            Ok(GcDirStatus::RealDir(_) | GcDirStatus::Missing) => {}
            Ok(GcDirStatus::NotDirectory) => {
                warn!(
                    "runner service {suffix}: managed {label} path {} is not a real directory; retaining all resources",
                    path.display()
                );
                return false;
            }
            Err(error) => {
                warn!(
                    "runner service {suffix}: cannot inspect managed {label} path {} ({error}); retaining all resources",
                    path.display()
                );
                return false;
            }
        }
    }
    for (label, path) in [
        ("executable", executable_path),
        ("activation config", activation_config_path),
    ] {
        match tokio::fs::symlink_metadata(path).await {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => {
                warn!(
                    "runner service {suffix}: {label} path {} is not a regular file; retaining all resources",
                    path.display()
                );
                return false;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                warn!(
                    "runner service {suffix}: cannot inspect {label} path {} ({error}); retaining all resources",
                    path.display()
                );
                return false;
            }
        }
    }
    true
}

async fn newest_mtime<const N: usize>(paths: [impl AsRef<Path>; N]) -> SystemTime {
    let mut newest = SystemTime::UNIX_EPOCH;
    for path in paths {
        if let Ok(metadata) = tokio::fs::symlink_metadata(path.as_ref()).await
            && let Ok(mtime) = metadata.modified()
        {
            newest = newest.max(mtime);
        }
    }
    newest
}

async fn remove_managed_dir(
    label: &str,
    item: &ManagedDir,
    expected_file_name: &str,
    dry_run: bool,
    remove_dir_all: RemoveDirAllFn,
) -> ManagedDirRemoval {
    let metadata = match gc_path_dir_status(&item.path).await {
        Ok(GcDirStatus::RealDir(metadata)) => metadata,
        Ok(GcDirStatus::Missing) => return ManagedDirRemoval::Missing,
        Ok(GcDirStatus::NotDirectory) => {
            warn!(
                "managed {label} directory {} was replaced by a non-directory; skipping removal",
                item.path.display()
            );
            return ManagedDirRemoval::Incomplete;
        }
        Err(error) => {
            warn!(
                "cannot recheck managed {label} directory {}: {error}",
                item.path.display()
            );
            return ManagedDirRemoval::Incomplete;
        }
    };
    if metadata.dev() != item.device || metadata.ino() != item.inode {
        warn!(
            "managed {label} directory {} changed identity after inventory; skipping removal",
            item.path.display()
        );
        return ManagedDirRemoval::Incomplete;
    }
    let stats = collect_dir_stats(&item.path).await;
    let Some(root_metadata) = stats.root_metadata else {
        warn!(
            "cannot completely recheck managed {label} directory {}; skipping removal",
            item.path.display()
        );
        return ManagedDirRemoval::Incomplete;
    };
    if root_metadata.dev() != item.device || root_metadata.ino() != item.inode {
        warn!(
            "managed {label} directory {} changed identity during recheck; skipping removal",
            item.path.display()
        );
        return ManagedDirRemoval::Incomplete;
    }
    let newest_mtime = stats
        .mtime
        .max(newest_mtime([item.path.join(expected_file_name)]).await);
    if SystemTime::now()
        .duration_since(newest_mtime)
        .unwrap_or_default()
        < GC_MIN_AGE
    {
        info!(
            "managed {label} directory {} became recent after inventory; retaining it",
            item.path.display()
        );
        return ManagedDirRemoval::Retained;
    }
    if dry_run {
        info!(
            "[dry-run] would remove managed {label} directory {}",
            item.path.display()
        );
        return ManagedDirRemoval::Removed(stats.size);
    }
    match remove_dir_all(&item.path).await {
        Ok(()) => ManagedDirRemoval::Removed(stats.size),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ManagedDirRemoval::Missing,
        Err(error) => {
            warn!("cannot remove {}: {error}", item.path.display());
            ManagedDirRemoval::Incomplete
        }
    }
}

#[cfg(test)]
mod tests;
