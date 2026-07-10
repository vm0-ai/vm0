//! Runner-to-guest storage manifest wire contract.

use serde::{Deserialize, Serialize};

/// Storage preparation manifest sent from the runner to `guest-download`.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Volume storage entries.
    #[serde(default)]
    pub storages: Vec<StorageEntry>,
    /// Artifact entries.
    #[serde(default)]
    pub artifacts: Vec<ArtifactEntry>,
    /// Paths to remove before materializing changed entries.
    #[serde(default)]
    pub cleanup_paths: Vec<String>,
    /// Instruction-specific cleanup operations.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instruction_cleanups: Vec<InstructionCleanupEntry>,
}

/// Volume storage entry in the guest storage manifest.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    /// Guest filesystem path where the storage is mounted.
    pub mount_path: String,
    /// Optional staging path used before instruction normalization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_path: Option<String>,
    /// Archive URL, or `None` when existing contents are reused.
    #[serde(default)]
    pub archive_url: Option<String>,
    /// Optional filename used when normalizing instruction storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions_target_filename: Option<String>,
    /// Whether existing contents match the current fingerprint.
    #[serde(default)]
    pub cached: bool,
    /// VAS storage name used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_storage_name: Option<String>,
    /// VAS version identifier used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_version_id: Option<String>,
}

/// Artifact entry in the guest storage manifest.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    /// Guest filesystem path where the artifact is mounted.
    pub mount_path: String,
    /// Archive URL, including the repair source for a reused artifact.
    #[serde(default)]
    pub archive_url: Option<String>,
    /// Whether the artifact is explicitly empty.
    #[serde(default, skip_serializing_if = "is_false")]
    pub empty: bool,
    /// Whether existing contents match the current fingerprint.
    #[serde(default)]
    pub cached: bool,
    /// VAS storage name used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_storage_name: Option<String>,
    /// VAS storage identifier retained in the runner payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_storage_id: Option<String>,
    /// VAS version identifier used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_version_id: Option<String>,
    /// Guest behavior label for a missing artifact mount root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_root_policy: Option<String>,
}

/// Instruction-specific cleanup operation.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionCleanupEntry {
    /// Guest filesystem path containing the instruction content.
    pub mount_path: String,
    /// Specific instruction filename, or `None` for all managed instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_filename: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ArtifactEntry, InstructionCleanupEntry, Manifest, StorageEntry};

    #[test]
    fn canonical_manifest_preserves_wire_shape() {
        let manifest = Manifest {
            storages: vec![StorageEntry {
                mount_path: "/home/user/.codex".into(),
                extract_path: Some("/run/storage-instructions/0".into()),
                archive_url: Some("https://example.com/storage.tar.gz".into()),
                instructions_target_filename: Some("AGENTS.md".into()),
                cached: false,
                vas_storage_name: Some("instructions".into()),
                vas_version_id: Some("storage-v1".into()),
            }],
            artifacts: vec![ArtifactEntry {
                mount_path: "/workspace".into(),
                archive_url: None,
                empty: true,
                cached: true,
                vas_storage_name: Some("artifact".into()),
                vas_storage_id: Some("artifact-id".into()),
                vas_version_id: Some("artifact-v1".into()),
                missing_root_policy: Some("preserveParentVersion".into()),
            }],
            cleanup_paths: vec!["/data".into()],
            instruction_cleanups: vec![InstructionCleanupEntry {
                mount_path: "/home/user/.codex".into(),
                target_filename: Some("AGENTS.md".into()),
            }],
        };

        assert_eq!(
            serde_json::to_value(manifest).unwrap(),
            json!({
                "storages": [{
                    "mountPath": "/home/user/.codex",
                    "extractPath": "/run/storage-instructions/0",
                    "archiveUrl": "https://example.com/storage.tar.gz",
                    "instructionsTargetFilename": "AGENTS.md",
                    "cached": false,
                    "vasStorageName": "instructions",
                    "vasVersionId": "storage-v1"
                }],
                "artifacts": [{
                    "mountPath": "/workspace",
                    "archiveUrl": null,
                    "empty": true,
                    "cached": true,
                    "vasStorageName": "artifact",
                    "vasStorageId": "artifact-id",
                    "vasVersionId": "artifact-v1",
                    "missingRootPolicy": "preserveParentVersion"
                }],
                "cleanupPaths": ["/data"],
                "instructionCleanups": [{
                    "mountPath": "/home/user/.codex",
                    "targetFilename": "AGENTS.md"
                }]
            })
        );
    }

    #[test]
    fn legacy_manifest_defaults_omitted_fields() {
        let manifest: Manifest = serde_json::from_value(json!({
            "storages": [{
                "mountPath": "/data",
                "unknownStorageField": true
            }],
            "artifacts": [{
                "mountPath": "/workspace",
                "extractPath": "/ignored"
            }]
        }))
        .unwrap();

        assert_eq!(
            manifest,
            Manifest {
                storages: vec![StorageEntry {
                    mount_path: "/data".into(),
                    extract_path: None,
                    archive_url: None,
                    instructions_target_filename: None,
                    cached: false,
                    vas_storage_name: None,
                    vas_version_id: None,
                }],
                artifacts: vec![ArtifactEntry {
                    mount_path: "/workspace".into(),
                    archive_url: None,
                    empty: false,
                    cached: false,
                    vas_storage_name: None,
                    vas_storage_id: None,
                    vas_version_id: None,
                    missing_root_policy: None,
                }],
                cleanup_paths: Vec::new(),
                instruction_cleanups: Vec::new(),
            }
        );
    }
}
