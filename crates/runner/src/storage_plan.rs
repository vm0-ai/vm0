use std::collections::HashSet;
use std::path::PathBuf;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use guest_contracts::storage_manifest as wire;

use crate::error::{RunnerError, RunnerResult};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::storage_manifest::StorageManifest;

const CODEX_FRAMEWORK_HOME: &str = "/home/user/.codex";
const CLAUDE_FRAMEWORK_HOME: &str = "/home/user/.claude";
const AGENT_INSTRUCTIONS_STORAGE_NAME_PREFIX: &str = "agent-instructions@";

#[derive(Debug)]
pub(crate) struct StoragePlan {
    storages: Vec<StoragePlanEntry>,
    artifacts: Vec<ArtifactPlanEntry>,
    cleanup_paths: Vec<String>,
    instruction_cleanups: Vec<InstructionCleanup>,
    reused_entries: usize,
}

#[derive(Debug)]
struct StoragePlanEntry {
    mount_path: String,
    extract_path: Option<String>,
    instructions_target_filename: Option<String>,
    vas_storage_name: String,
    vas_version_id: String,
    archive_size: Option<u64>,
    action: StorageAction,
}

#[derive(Debug)]
enum StorageAction {
    Download { source: ArchiveSource },
    ReuseExisting,
    DownloadAndNormalize { source: ArchiveSource },
    NormalizeInPlace,
}

#[derive(Debug)]
struct ArtifactPlanEntry {
    mount_path: String,
    vas_storage_name: String,
    vas_storage_id: String,
    vas_version_id: String,
    archive_size: Option<u64>,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
    action: ArtifactAction,
}

#[derive(Debug)]
enum ArtifactAction {
    Download { source: ArchiveSource },
    ReuseOrRepair { source: ArchiveSource },
    PrepareEmpty { cached: bool },
}

#[derive(Debug)]
enum ArchiveSource {
    Remote(String),
    GuestStaged(String),
}

impl ArchiveSource {
    fn wire_url(self) -> String {
        match self {
            Self::Remote(url) | Self::GuestStaged(url) => url,
        }
    }

    fn remote_url(&self) -> Option<&str> {
        match self {
            Self::Remote(url) => Some(url),
            Self::GuestStaged(_) => None,
        }
    }
}

#[derive(Debug)]
struct InstructionCleanup {
    mount_path: String,
    target_filename: Option<String>,
}

#[derive(Clone, Copy)]
pub(crate) struct ArchiveHandle {
    kind: ArchiveKind,
    index: usize,
}

impl ArchiveHandle {
    #[cfg(test)]
    pub(crate) const fn storage(index: usize) -> Self {
        Self {
            kind: ArchiveKind::Storage,
            index,
        }
    }

    #[cfg(test)]
    pub(crate) const fn artifact(index: usize) -> Self {
        Self {
            kind: ArchiveKind::Artifact,
            index,
        }
    }
}

#[derive(Clone, Copy)]
enum ArchiveKind {
    Storage,
    Artifact,
}

pub(crate) struct CacheArchiveCandidate {
    pub(crate) handle: ArchiveHandle,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) archive_url: String,
    pub(crate) archive_size: Option<u64>,
}

pub(crate) fn build_storage_plan(
    manifest: &StorageManifest,
    runtime_dir: &str,
    previous: Option<&StorageFingerprints>,
) -> RunnerResult<StoragePlan> {
    let mut cleanup_paths = Vec::new();
    let mut instruction_cleanups = Vec::new();
    let mut reused_entries = 0;

    let storages = manifest
        .storages
        .iter()
        .enumerate()
        .map(|(index, storage)| {
            let unchanged = previous.is_some_and(|fingerprints| {
                fingerprints
                    .storages
                    .get(&storage.mount_path)
                    .is_some_and(|fingerprint| {
                        fingerprint.matches(&storage.vas_storage_name, &storage.vas_version_id)
                    })
            });
            if unchanged {
                reused_entries += 1;
            } else if previous.is_some() {
                if storage.instructions_target_filename.is_some() {
                    instruction_cleanups.push(InstructionCleanup {
                        mount_path: storage.mount_path.clone(),
                        target_filename: storage.instructions_target_filename.clone(),
                    });
                } else {
                    cleanup_paths.push(storage.mount_path.clone());
                }
            }

            let is_instructions = storage.instructions_target_filename.is_some();
            let action = match (unchanged, is_instructions) {
                (true, false) => StorageAction::ReuseExisting,
                (true, true) => StorageAction::NormalizeInPlace,
                (false, false) => StorageAction::Download {
                    source: ArchiveSource::Remote(storage.archive_url.clone()),
                },
                (false, true) => StorageAction::DownloadAndNormalize {
                    source: ArchiveSource::Remote(storage.archive_url.clone()),
                },
            };

            StoragePlanEntry {
                mount_path: storage.mount_path.clone(),
                extract_path: is_instructions.then(|| instruction_extract_path(runtime_dir, index)),
                instructions_target_filename: storage.instructions_target_filename.clone(),
                vas_storage_name: storage.vas_storage_name.clone(),
                vas_version_id: storage.vas_version_id.clone(),
                archive_size: storage.archive_size.filter(|size| *size > 0),
                action,
            }
        })
        .collect::<Vec<_>>();

    let artifacts = manifest
        .artifacts
        .iter()
        .map(|artifact| {
            let empty = artifact.empty.unwrap_or(false);
            let unchanged = previous.is_some_and(|fingerprints| {
                fingerprints
                    .artifacts
                    .get(&artifact.mount_path)
                    .is_some_and(|fingerprint| {
                        fingerprint.matches(&artifact.vas_storage_name, &artifact.vas_version_id)
                    })
            });
            if unchanged {
                reused_entries += 1;
            } else if previous.is_some() {
                cleanup_paths.push(artifact.mount_path.clone());
            }

            let action = if empty {
                ArtifactAction::PrepareEmpty { cached: unchanged }
            } else {
                let archive_url = artifact.archive_url.clone().ok_or_else(|| {
                    RunnerError::Internal(format!(
                        "storage manifest artifact {} version {} is missing archiveUrl",
                        artifact.vas_storage_name, artifact.vas_version_id
                    ))
                })?;
                if unchanged {
                    ArtifactAction::ReuseOrRepair {
                        source: ArchiveSource::Remote(archive_url),
                    }
                } else {
                    ArtifactAction::Download {
                        source: ArchiveSource::Remote(archive_url),
                    }
                }
            };

            Ok(ArtifactPlanEntry {
                mount_path: artifact.mount_path.clone(),
                vas_storage_name: artifact.vas_storage_name.clone(),
                vas_storage_id: artifact.vas_storage_id.clone(),
                vas_version_id: artifact.vas_version_id.clone(),
                archive_size: artifact.archive_size.filter(|size| *size > 0),
                missing_root_policy: artifact.missing_root_policy,
                action,
            })
        })
        .collect::<RunnerResult<Vec<_>>>()?;

    if let Some(previous) = previous {
        record_removed_storages(
            previous,
            manifest
                .storages
                .iter()
                .map(|entry| entry.mount_path.as_str()),
            &mut cleanup_paths,
            &mut instruction_cleanups,
        );
        record_removed_artifacts(
            previous,
            manifest
                .artifacts
                .iter()
                .map(|entry| entry.mount_path.as_str()),
            &mut cleanup_paths,
        );
    }

    Ok(StoragePlan {
        storages,
        artifacts,
        cleanup_paths,
        instruction_cleanups,
        reused_entries,
    })
}

impl StoragePlan {
    pub(crate) fn requires_guest_work(&self) -> bool {
        !self.cleanup_paths.is_empty()
            || !self.instruction_cleanups.is_empty()
            || self
                .storages
                .iter()
                .any(|entry| !matches!(entry.action, StorageAction::ReuseExisting))
            || !self.artifacts.is_empty()
    }

    pub(crate) fn reused_entries(&self) -> usize {
        self.reused_entries
    }

    pub(crate) fn entry_count(&self) -> usize {
        self.storages.len() + self.artifacts.len()
    }

    pub(crate) fn cleanup_path_count(&self) -> usize {
        self.cleanup_paths.len()
    }

    pub(crate) fn instruction_cleanup_count(&self) -> usize {
        self.instruction_cleanups.len()
    }

    pub(crate) fn cache_candidates(&self) -> Vec<CacheArchiveCandidate> {
        let storage_candidates = self
            .storages
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let source = match &entry.action {
                    StorageAction::Download { source }
                    | StorageAction::DownloadAndNormalize { source } => source,
                    StorageAction::ReuseExisting | StorageAction::NormalizeInPlace => return None,
                };
                Some(CacheArchiveCandidate {
                    handle: ArchiveHandle {
                        kind: ArchiveKind::Storage,
                        index,
                    },
                    name: entry.vas_storage_name.clone(),
                    version: entry.vas_version_id.clone(),
                    archive_url: source.remote_url()?.to_string(),
                    archive_size: entry.archive_size,
                })
            });
        let artifact_candidates = self
            .artifacts
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let ArtifactAction::Download { source } = &entry.action else {
                    return None;
                };
                Some(CacheArchiveCandidate {
                    handle: ArchiveHandle {
                        kind: ArchiveKind::Artifact,
                        index,
                    },
                    name: entry.vas_storage_name.clone(),
                    version: entry.vas_version_id.clone(),
                    archive_url: source.remote_url()?.to_string(),
                    archive_size: entry.archive_size,
                })
            });
        storage_candidates.chain(artifact_candidates).collect()
    }

    pub(crate) fn stage_archive(
        &mut self,
        handle: ArchiveHandle,
        expected_name: &str,
        expected_version: &str,
        expected_url: &str,
        guest_url: String,
    ) -> bool {
        let (name, version, source) = match handle.kind {
            ArchiveKind::Storage => {
                let Some(entry) = self.storages.get_mut(handle.index) else {
                    return false;
                };
                let source = match &mut entry.action {
                    StorageAction::Download { source }
                    | StorageAction::DownloadAndNormalize { source } => source,
                    StorageAction::ReuseExisting | StorageAction::NormalizeInPlace => return false,
                };
                (&entry.vas_storage_name, &entry.vas_version_id, source)
            }
            ArchiveKind::Artifact => {
                let Some(entry) = self.artifacts.get_mut(handle.index) else {
                    return false;
                };
                let ArtifactAction::Download { source } = &mut entry.action else {
                    return false;
                };
                (&entry.vas_storage_name, &entry.vas_version_id, source)
            }
        };
        if name != expected_name
            || version != expected_version
            || source.remote_url() != Some(expected_url)
        {
            return false;
        }
        *source = ArchiveSource::GuestStaged(guest_url);
        true
    }

    pub(crate) fn into_guest_manifest(self) -> wire::Manifest {
        wire::Manifest {
            storages: self
                .storages
                .into_iter()
                .map(|entry| {
                    let (archive_url, cached) = match entry.action {
                        StorageAction::Download { source }
                        | StorageAction::DownloadAndNormalize { source } => {
                            (Some(source.wire_url()), false)
                        }
                        StorageAction::ReuseExisting | StorageAction::NormalizeInPlace => {
                            (None, true)
                        }
                    };
                    wire::StorageEntry {
                        mount_path: entry.mount_path,
                        extract_path: entry.extract_path,
                        archive_url,
                        instructions_target_filename: entry.instructions_target_filename,
                        cached,
                        vas_storage_name: Some(entry.vas_storage_name),
                        vas_version_id: Some(entry.vas_version_id),
                    }
                })
                .collect(),
            artifacts: self
                .artifacts
                .into_iter()
                .map(|entry| {
                    let (archive_url, empty, cached) = match entry.action {
                        ArtifactAction::Download { source } => {
                            (Some(source.wire_url()), false, false)
                        }
                        ArtifactAction::ReuseOrRepair { source } => {
                            (Some(source.wire_url()), false, true)
                        }
                        ArtifactAction::PrepareEmpty { cached } => (None, true, cached),
                    };
                    wire::ArtifactEntry {
                        mount_path: entry.mount_path,
                        archive_url,
                        empty,
                        cached,
                        vas_storage_name: Some(entry.vas_storage_name),
                        vas_storage_id: Some(entry.vas_storage_id),
                        vas_version_id: Some(entry.vas_version_id),
                        missing_root_policy: entry
                            .missing_root_policy
                            .map(missing_root_policy_wire_value),
                    }
                })
                .collect(),
            cleanup_paths: self.cleanup_paths,
            instruction_cleanups: self
                .instruction_cleanups
                .into_iter()
                .map(|entry| wire::InstructionCleanupEntry {
                    mount_path: entry.mount_path,
                    target_filename: entry.target_filename,
                })
                .collect(),
        }
    }

    #[cfg(test)]
    pub(crate) fn archive_source_url_for_test(&self, handle: ArchiveHandle) -> Option<&str> {
        let source = match handle.kind {
            ArchiveKind::Storage => {
                let entry = self.storages.get(handle.index)?;
                match &entry.action {
                    StorageAction::Download { source }
                    | StorageAction::DownloadAndNormalize { source } => source,
                    StorageAction::ReuseExisting | StorageAction::NormalizeInPlace => return None,
                }
            }
            ArchiveKind::Artifact => {
                let entry = self.artifacts.get(handle.index)?;
                match &entry.action {
                    ArtifactAction::Download { source }
                    | ArtifactAction::ReuseOrRepair { source } => source,
                    ArtifactAction::PrepareEmpty { .. } => return None,
                }
            }
        };
        Some(match source {
            ArchiveSource::Remote(url) | ArchiveSource::GuestStaged(url) => url,
        })
    }
}

fn record_removed_storages<'a>(
    previous: &StorageFingerprints,
    current_paths: impl IntoIterator<Item = &'a str>,
    cleanup_paths: &mut Vec<String>,
    instruction_cleanups: &mut Vec<InstructionCleanup>,
) {
    let current_paths = current_paths.into_iter().collect::<HashSet<_>>();
    for (path, fingerprint) in &previous.storages {
        if current_paths.contains(path.as_str()) {
            continue;
        }
        if is_removed_framework_home_instruction(path, fingerprint) {
            instruction_cleanups.push(InstructionCleanup {
                mount_path: path.clone(),
                target_filename: None,
            });
        } else {
            cleanup_paths.push(path.clone());
        }
    }
}

fn record_removed_artifacts<'a>(
    previous: &StorageFingerprints,
    current_paths: impl IntoIterator<Item = &'a str>,
    cleanup_paths: &mut Vec<String>,
) {
    let current_paths = current_paths.into_iter().collect::<HashSet<_>>();
    for path in previous.artifacts.keys() {
        if !current_paths.contains(path.as_str()) {
            cleanup_paths.push(path.clone());
        }
    }
}

fn is_framework_home_path(path: &str) -> bool {
    matches!(path, CODEX_FRAMEWORK_HOME | CLAUDE_FRAMEWORK_HOME)
}

fn is_removed_framework_home_instruction(path: &str, fingerprint: &StorageFingerprint) -> bool {
    is_framework_home_path(path)
        && (fingerprint.is_tainted()
            || fingerprint
                .vas_storage_name()
                .is_some_and(|name| name.starts_with(AGENT_INSTRUCTIONS_STORAGE_NAME_PREFIX)))
}

fn instruction_extract_path(runtime_dir: &str, index: usize) -> String {
    let mut path = PathBuf::from(runtime_dir);
    path.push("storage-instructions");
    path.push(index.to_string());
    path.to_string_lossy().into_owned()
}

fn missing_root_policy_wire_value(policy: ArtifactEntryMissingRootPolicy) -> String {
    match policy {
        ArtifactEntryMissingRootPolicy::Fail => "fail",
        ArtifactEntryMissingRootPolicy::PreserveParentVersion => "preserveParentVersion",
    }
    .to_string()
}

#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod tests;
