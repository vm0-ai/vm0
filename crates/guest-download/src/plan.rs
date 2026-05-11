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
        );

        // Artifacts: 404 is non-fatal (may not exist on first run)
        append_download_tasks(
            &mut download_tasks,
            &manifest.artifacts,
            "artifact",
            "artifact_download",
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
) {
    for (idx, entry) in entries.iter().enumerate() {
        if is_valid_url(&entry.archive_url)
            && let Some(url) = entry.archive_url.clone()
        {
            tasks.push(DownloadTask::new(
                format!("{} {}", label_prefix, idx + 1),
                op_name,
                url,
                entry.mount_path.clone(),
                allow_404,
            ));
        }
    }
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
                {"mountPath": "/data", "archiveUrl": "https://s3/storage.tar.gz"}
            ],
            "artifacts": [
                {"mountPath": "/workspace/a", "archiveUrl": "https://s3/a.tar.gz"},
                {"mountPath": "/workspace/b", "archiveUrl": "https://s3/b.tar.gz"}
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
                "storage 1".into(),
                "storage_download",
                "https://s3/storage.tar.gz".into(),
                "/data".into(),
                false,
            )
        );
        assert_eq!(
            plan.download_tasks[1],
            DownloadTask::new(
                "artifact 1".into(),
                "artifact_download",
                "https://s3/a.tar.gz".into(),
                "/workspace/a".into(),
                true,
            )
        );
        assert_eq!(
            plan.download_tasks[2],
            DownloadTask::new(
                "artifact 2".into(),
                "artifact_download",
                "https://s3/b.tar.gz".into(),
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
