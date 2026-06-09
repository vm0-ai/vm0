use api_contracts::generated::types::runners::storage::{ArtifactEntry, StorageEntry};

pub(in crate::executor::tests) fn api_storage(
    name: &str,
    mount_path: &str,
    version: &str,
    archive_url: &str,
) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        instructions_target_filename: None,
    }
}

pub(in crate::executor::tests) fn api_artifact(
    name: &str,
    mount_path: &str,
    storage_id: &str,
    version: &str,
    archive_url: &str,
) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_storage_id: storage_id.into(),
        vas_version_id: version.into(),
        manifest_url: None,
        missing_root_policy: None,
    }
}
