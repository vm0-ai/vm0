use api_contracts::generated::types::webhooks::agent::storages::{commit, prepare};
use serde_json::json;

#[test]
fn generated_prepare_request_serializes_wire_shape() {
    let hash = "a".repeat(64);
    let request = prepare::Request {
        run_id: "run-1".to_string(),
        storage_name: "memory".to_string(),
        storage_type: "artifact".to_string(),
        files: vec![prepare::RequestFile {
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
        files: vec![commit::RequestFile {
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
