use api_contracts::generated::types::{
    runners::storage as runner_storage,
    webhooks::agent::storages::{FileEntryWithHash, commit, prepare},
};
use serde_json::json;

#[test]
fn generated_prepare_request_serializes_wire_shape() {
    let hash = "a".repeat(64);
    let request = prepare::Request {
        run_id: "run-1".to_string(),
        storage_name: "memory".to_string(),
        storage_type: "artifact".to_string(),
        files: vec![FileEntryWithHash {
            path: "file.txt".to_string(),
            hash: hash.clone(),
            size: 12,
        }],
        parent_version_id: None,
        force: None,
        base_version: None,
        changes: None,
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "storageName": "memory",
            "storageType": "artifact",
            "files": [{
                "path": "file.txt",
                "hash": hash,
                "size": 12,
            }],
        })
    );
    assert!(value.get("parentVersionId").is_none());
    assert!(value.get("force").is_none());
    assert!(value.get("baseVersion").is_none());
    assert!(value.get("changes").is_none());
}

#[test]
fn generated_prepare_request_serializes_optional_fields() {
    let request = prepare::Request {
        run_id: "run-1".to_string(),
        storage_name: "memory".to_string(),
        storage_type: "artifact".to_string(),
        files: vec![],
        parent_version_id: Some("parent-1".to_string()),
        force: Some(true),
        base_version: Some("base-1".to_string()),
        changes: Some(prepare::RequestChanges {
            added: vec!["new.txt".to_string()],
            modified: vec!["changed.txt".to_string()],
            deleted: vec!["old.txt".to_string()],
        }),
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["parentVersionId"], "parent-1");
    assert_eq!(value["force"], true);
    assert_eq!(value["baseVersion"], "base-1");
    assert_eq!(value["changes"]["added"], json!(["new.txt"]));
}

#[test]
fn generated_prepare_response_deserializes_deduplicated_shape() {
    let response: prepare::Response = serde_json::from_value(json!({
        "versionId": "version-1",
        "existing": true,
    }))
    .unwrap();

    assert_eq!(response.version_id, "version-1");
    assert!(response.existing);
    assert!(response.uploads.is_none());
}

#[test]
fn generated_prepare_response_deserializes_upload_shape() {
    let response: prepare::Response = serde_json::from_value(json!({
        "versionId": "version-1",
        "existing": false,
        "uploads": {
            "archive": {
                "key": "archive-key",
                "presignedUrl": "https://example.test/archive",
            },
            "manifest": {
                "key": "manifest-key",
                "presignedUrl": "https://example.test/manifest",
            },
        },
    }))
    .unwrap();

    let uploads = response.uploads.unwrap();
    assert_eq!(uploads.archive.key, "archive-key");
    assert_eq!(
        uploads.archive.presigned_url,
        "https://example.test/archive"
    );
    assert_eq!(uploads.manifest.key, "manifest-key");
    assert_eq!(
        uploads.manifest.presigned_url,
        "https://example.test/manifest"
    );
}

#[test]
fn generated_commit_request_serializes_wire_shape() {
    let hash = "b".repeat(64);
    let request = commit::Request {
        run_id: "run-1".to_string(),
        storage_name: "memory".to_string(),
        storage_type: "artifact".to_string(),
        version_id: "version-1".to_string(),
        parent_version_id: None,
        files: vec![FileEntryWithHash {
            path: "file.txt".to_string(),
            hash: hash.clone(),
            size: 34,
        }],
        message: Some("checkpoint".to_string()),
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "storageName": "memory",
            "storageType": "artifact",
            "versionId": "version-1",
            "files": [{
                "path": "file.txt",
                "hash": hash,
                "size": 34,
            }],
            "message": "checkpoint",
        })
    );
    assert!(value.get("parentVersionId").is_none());
}

#[test]
fn generated_commit_request_preserves_empty_message() {
    let request = commit::Request {
        run_id: "run-1".to_string(),
        storage_name: "memory".to_string(),
        storage_type: "artifact".to_string(),
        version_id: "version-1".to_string(),
        parent_version_id: None,
        files: vec![],
        message: Some(String::new()),
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["message"], "");
}

#[test]
fn generated_commit_response_deserializes_success_shape() {
    let response: commit::Response = serde_json::from_value(json!({
        "success": true,
        "versionId": "version-1",
        "storageName": "memory",
        "size": 42,
        "fileCount": 3,
        "deduplicated": true,
    }))
    .unwrap();

    assert!(response.success);
    assert_eq!(response.version_id, "version-1");
    assert_eq!(response.storage_name, "memory");
    assert_eq!(response.size, 42.0);
    assert_eq!(response.file_count, 3.0);
    assert_eq!(response.deduplicated, Some(true));
}

#[test]
fn generated_storage_manifest_deserializes_web_claim_shape() {
    let manifest: runner_storage::StorageManifest = serde_json::from_value(json!({
        "storages": [{
            "name": "workspace",
            "mountPath": "/workspace",
            "vasStorageName": "workspace-volume",
            "vasVersionId": "version-1",
            "instructionsTargetFilename": "AGENTS.md",
            "archiveUrl": "https://storage.example/workspace.tar.gz",
        }],
        "artifacts": [{
            "mountPath": "/home/user/.claude/projects/project",
            "vasStorageName": "memory",
            "vasStorageId": "storage-id-1",
            "vasVersionId": "version-2",
            "archiveUrl": "https://storage.example/artifact.tar.gz",
            "manifestUrl": "https://storage.example/manifest.json",
        }],
    }))
    .unwrap();

    assert_eq!(manifest.storages[0].name, "workspace");
    assert_eq!(manifest.storages[0].mount_path, "/workspace");
    assert_eq!(manifest.storages[0].vas_storage_name, "workspace-volume");
    assert_eq!(
        manifest.storages[0].instructions_target_filename.as_deref(),
        Some("AGENTS.md")
    );
    assert_eq!(manifest.artifacts[0].vas_storage_id, "storage-id-1");
    assert_eq!(
        manifest.artifacts[0].manifest_url.as_deref(),
        Some("https://storage.example/manifest.json")
    );
}

#[test]
fn generated_storage_manifest_serializes_without_absent_manifest_url() {
    let manifest = runner_storage::StorageManifest {
        storages: vec![runner_storage::StorageEntry {
            name: "workspace".to_string(),
            mount_path: "/workspace".to_string(),
            vas_storage_name: "workspace-volume".to_string(),
            vas_version_id: "version-1".to_string(),
            instructions_target_filename: None,
            archive_url: "https://storage.example/workspace.tar.gz".to_string(),
        }],
        artifacts: vec![runner_storage::ArtifactEntry {
            mount_path: "/home/user/.claude/projects/project".to_string(),
            vas_storage_name: "memory".to_string(),
            vas_storage_id: "storage-id-1".to_string(),
            vas_version_id: "version-2".to_string(),
            archive_url: "https://storage.example/artifact.tar.gz".to_string(),
            manifest_url: None,
            missing_root_policy: None,
        }],
    };

    let value = serde_json::to_value(manifest).unwrap();

    assert_eq!(
        value,
        json!({
            "storages": [{
                "name": "workspace",
                "mountPath": "/workspace",
                "vasStorageName": "workspace-volume",
                "vasVersionId": "version-1",
                "archiveUrl": "https://storage.example/workspace.tar.gz",
            }],
            "artifacts": [{
                "mountPath": "/home/user/.claude/projects/project",
                "vasStorageName": "memory",
                "vasStorageId": "storage-id-1",
                "vasVersionId": "version-2",
                "archiveUrl": "https://storage.example/artifact.tar.gz",
            }],
        })
    );
}

#[test]
fn generated_storage_manifest_serializes_empty_artifacts() {
    let manifest = runner_storage::StorageManifest {
        storages: vec![],
        artifacts: vec![],
    };

    let value = serde_json::to_value(manifest).unwrap();

    assert_eq!(
        value,
        json!({
            "storages": [],
            "artifacts": [],
        })
    );
}

#[test]
fn generated_storage_manifest_rejects_guest_download_null_archive_url() {
    let result = serde_json::from_value::<runner_storage::StorageManifest>(json!({
        "storages": [{
            "name": "workspace",
            "mountPath": "/workspace",
            "vasStorageName": "workspace-volume",
            "vasVersionId": "version-1",
            "archiveUrl": null,
        }],
        "artifacts": [],
    }));

    assert!(result.is_err());
}
