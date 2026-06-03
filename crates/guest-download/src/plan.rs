use crate::download::DownloadTask;
use crate::instructions::InstructionNormalization;
use crate::manifest::{Manifest, ManifestEntry};

pub(crate) struct RunPlan {
    pub(crate) cleanup_paths: Vec<String>,
    pub(crate) preserved_paths: Vec<String>,
    pub(crate) download_tasks: Vec<DownloadTask>,
    pub(crate) instruction_files: Vec<InstructionNormalization>,
}

impl RunPlan {
    pub(crate) fn from_manifest(manifest: &Manifest) -> Self {
        // Collect all mount paths that should be preserved (unchanged storages
        // and artifacts). Memory rides in artifacts[] post-#10602 so the memory
        // slot no longer needs its own preservation branch.
        let mut preserved_paths: Vec<String> = manifest
            .storages
            .iter()
            .filter(|s| s.cached)
            .map(|s| s.mount_path.clone())
            .collect();
        preserved_paths.extend(
            manifest
                .artifacts
                .iter()
                .filter(|a| a.cached)
                .map(|a| a.mount_path.clone()),
        );

        let instruction_files = manifest
            .storages
            .iter()
            .filter_map(|entry| {
                entry
                    .instructions_target_filename
                    .as_ref()
                    .map(|target_filename| {
                        InstructionNormalization::new(
                            entry.mount_path.clone(),
                            target_filename.clone(),
                        )
                    })
            })
            .collect();

        // Build unified task list: storages + artifact + memory, all downloaded in parallel.
        let mut download_tasks = Vec::new();

        // Storages: 404 is fatal
        append_download_tasks(
            &mut download_tasks,
            &manifest.storages,
            "storage",
            "storage_download",
            false,
            false,
        );

        // Artifacts: 404 is non-fatal (may not exist on first run)
        append_download_tasks(
            &mut download_tasks,
            &manifest.artifacts,
            "artifact",
            "artifact_download",
            true,
            true,
        );

        Self {
            cleanup_paths: manifest.cleanup_paths.clone(),
            preserved_paths,
            download_tasks,
            instruction_files,
        }
    }
}

/// Check if archive URL is valid (not None and not string "null").
fn is_valid_url(url: &Option<String>) -> bool {
    matches!(url, Some(u) if u != "null")
}

fn append_download_tasks(
    tasks: &mut Vec<DownloadTask>,
    entries: &[ManifestEntry],
    label_prefix: &str,
    op_name: &'static str,
    allow_404: bool,
    include_missing_root_policy: bool,
) {
    for (idx, entry) in entries.iter().enumerate() {
        if is_valid_url(&entry.archive_url)
            && let Some(url) = entry.archive_url.clone()
        {
            tasks.push(DownloadTask::new(
                format_entry_label(
                    entry,
                    label_prefix,
                    idx + 1,
                    &url,
                    include_missing_root_policy,
                ),
                op_name,
                url,
                entry.mount_path.clone(),
                allow_404,
            ));
        }
    }
}

fn format_entry_label(
    entry: &ManifestEntry,
    label_prefix: &str,
    index: usize,
    archive_url: &str,
    include_missing_root_policy: bool,
) -> String {
    let storage_name = entry.vas_storage_name.as_deref().unwrap_or("unknown");
    let version_id = entry.vas_version_id.as_deref().unwrap_or("unknown");
    let url_scheme = archive_url
        .split_once("://")
        .map(|(scheme, _)| scheme)
        .unwrap_or("unknown");
    let missing_root_policy = if include_missing_root_policy {
        format!(
            " missingRootPolicy={}",
            entry.missing_root_policy.as_deref().unwrap_or("fail")
        )
    } else {
        String::new()
    };

    format!(
        "{} {} mountPath={} vasStorageName={} vasVersionId={} urlScheme={} cached={}{}",
        label_prefix,
        index,
        entry.mount_path,
        storage_name,
        version_id,
        url_scheme,
        entry.cached,
        missing_root_policy
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_valid_url_none() {
        assert!(!is_valid_url(&None));
    }

    #[test]
    fn is_valid_url_null_string() {
        assert!(!is_valid_url(&Some("null".to_string())));
    }

    #[test]
    fn is_valid_url_valid() {
        assert!(is_valid_url(&Some(
            "https://example.com/archive.tar.gz".to_string()
        )));
    }

    #[test]
    fn is_valid_url_file_scheme() {
        assert!(is_valid_url(&Some(
            "file:///tmp/vm0-storage-cache/abc.tar.gz".to_string()
        )));
    }

    #[test]
    fn manifest_entries_yield_storage_and_artifact_tasks() {
        let json = r#"{
            "storages": [
                {
                    "mountPath": "/data",
                    "archiveUrl": "https://s3/storage.tar.gz",
                    "vasStorageName": "data",
                    "vasVersionId": "storage-v1"
                }
            ],
            "artifacts": [
                {
                    "mountPath": "/workspace/a",
                    "archiveUrl": "https://s3/a.tar.gz",
                    "vasStorageName": "workspace-a",
                    "vasVersionId": "artifact-v1",
                    "missingRootPolicy": "preserveParentVersion"
                },
                {
                    "mountPath": "/workspace/b",
                    "archiveUrl": "file:///tmp/vm0-storage-cache/b.tar.gz",
                    "vasStorageName": "workspace-b",
                    "vasVersionId": "artifact-v2"
                }
            ]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.storages.len(), 1);
        assert_eq!(manifest.artifacts.len(), 2);

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(plan.download_tasks.len(), 3);
        assert_eq!(
            plan.download_tasks[0],
            DownloadTask::new(
                "storage 1 mountPath=/data vasStorageName=data vasVersionId=storage-v1 urlScheme=https cached=false".into(),
                "storage_download",
                "https://s3/storage.tar.gz".into(),
                "/data".into(),
                false,
            )
        );
        assert_eq!(
            plan.download_tasks[1],
            DownloadTask::new(
                "artifact 1 mountPath=/workspace/a vasStorageName=workspace-a vasVersionId=artifact-v1 urlScheme=https cached=false missingRootPolicy=preserveParentVersion".into(),
                "artifact_download",
                "https://s3/a.tar.gz".into(),
                "/workspace/a".into(),
                true,
            )
        );
        assert_eq!(
            plan.download_tasks[2],
            DownloadTask::new(
                "artifact 2 mountPath=/workspace/b vasStorageName=workspace-b vasVersionId=artifact-v2 urlScheme=file cached=false missingRootPolicy=fail".into(),
                "artifact_download",
                "file:///tmp/vm0-storage-cache/b.tar.gz".into(),
                "/workspace/b".into(),
                true,
            )
        );
    }

    #[test]
    fn run_plan_collects_preserved_paths_and_instruction_targets() {
        let json = r#"{
            "storages": [
                {
                    "mountPath": "/home/user/.codex",
                    "archiveUrl": null,
                    "cached": true,
                    "instructionsTargetFilename": "AGENTS.md"
                },
                {
                    "mountPath": "/home/user/new",
                    "archiveUrl": null,
                    "cached": false
                }
            ],
            "artifacts": [
                {"mountPath": "/workspace", "archiveUrl": null, "cached": true}
            ],
            "cleanupPaths": ["/home/user/.codex"]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();

        let plan = RunPlan::from_manifest(&manifest);

        assert_eq!(plan.cleanup_paths, ["/home/user/.codex"]);
        assert_eq!(plan.preserved_paths, ["/home/user/.codex", "/workspace"]);
        assert_eq!(plan.instruction_files.len(), 1);
        assert_eq!(
            plan.instruction_files[0],
            InstructionNormalization::new("/home/user/.codex".into(), "AGENTS.md".into())
        );
    }
}
