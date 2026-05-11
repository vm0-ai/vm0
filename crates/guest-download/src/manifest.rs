use serde::Deserialize;
use std::fs;

/// Guest-download manifest format written by the runner after reuse/cache
/// decisions have been applied.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    #[serde(default)]
    pub(crate) storages: Vec<ManifestEntry>,
    #[serde(default)]
    pub(crate) artifacts: Vec<ManifestEntry>,
    /// Paths to clean before downloading (stale file cleanup on VM reuse).
    #[serde(default)]
    pub(crate) cleanup_paths: Vec<String>,
}

impl Manifest {
    pub(crate) fn load(manifest_path: &str) -> Result<Self, ManifestLoadError> {
        let manifest_json = fs::read_to_string(manifest_path).map_err(ManifestLoadError::Read)?;
        serde_json::from_str(&manifest_json).map_err(ManifestLoadError::Parse)
    }
}

pub(crate) enum ManifestLoadError {
    Read(std::io::Error),
    Parse(serde_json::Error),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestEntry {
    pub(crate) mount_path: String,
    pub(crate) archive_url: Option<String>,
    #[serde(default)]
    pub(crate) instructions_target_filename: Option<String>,
    #[serde(default)]
    pub(crate) cached: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_deserializes_camel_case_cleanup_paths() {
        let json = r#"{
            "storages": [],
            "cleanupPaths": ["/home/user/.claude", "/home/user/.claude/skills/old"]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.cleanup_paths.len(), 2);
        assert_eq!(manifest.cleanup_paths[0], "/home/user/.claude");
    }

    #[test]
    fn manifest_defaults_cleanup_paths_when_absent() {
        let json = r#"{"storages": []}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.cleanup_paths.is_empty());
    }

    #[test]
    fn manifest_deserializes_cached_field() {
        let json = r#"{
            "storages": [
                {"mountPath": "/data", "archiveUrl": null, "cached": true},
                {"mountPath": "/other", "archiveUrl": "https://s3/v1", "cached": false}
            ],
            "artifacts": [{"mountPath": "/workspace", "archiveUrl": null, "cached": true}]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.storages[0].cached);
        assert!(!manifest.storages[1].cached);
        assert!(manifest.artifacts[0].cached);
    }

    #[test]
    fn manifest_defaults_cached_to_false() {
        let json = r#"{
            "storages": [{"mountPath": "/data"}],
            "artifacts": [{"mountPath": "/workspace"}]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(!manifest.storages[0].cached);
        assert!(!manifest.artifacts[0].cached);
    }

    #[test]
    fn manifest_ignores_runner_entry_metadata() {
        let json = r#"{
            "storages": [{
                "mountPath": "/data",
                "archiveUrl": "https://s3/storage.tar.gz",
                "vasStorageName": "storage",
                "vasVersionId": "v1"
            }],
            "artifacts": [{
                "mountPath": "/workspace",
                "archiveUrl": "https://s3/artifact.tar.gz",
                "vasStorageName": "artifact",
                "vasStorageId": "artifact-id",
                "vasVersionId": "v2"
            }]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.storages[0].mount_path, "/data");
        assert_eq!(manifest.artifacts[0].mount_path, "/workspace");
    }
}
