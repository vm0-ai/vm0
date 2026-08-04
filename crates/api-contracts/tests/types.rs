use api_contracts::generated::types::{
    build_info,
    models::{
        ModelProviderCredentialScope, ModelProviderType, SupportedRunModel, policies, preference,
    },
    runners::{storage as runner_storage, zero_cli},
    webhooks::agent::{
        checkpoints,
        storages::{FileEntryWithHash, commit, prepare},
    },
};
use serde_json::json;

#[test]
fn generated_checkpoint_request_omits_absent_snapshots() {
    let history_hash = "a".repeat(64);
    let request = checkpoints::Request {
        run_id: "run-1".to_string(),
        cli_agent_type: "claude-code".to_string(),
        cli_agent_session_id: "session-1".to_string(),
        cli_agent_session_history_hash: history_hash.clone(),
        artifact_snapshots: None,
        volume_versions_snapshot: None,
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "cliAgentType": "claude-code",
            "cliAgentSessionId": "session-1",
            "cliAgentSessionHistoryHash": history_hash,
        })
    );
    assert!(value.get("artifactSnapshots").is_none());
    assert!(value.get("volumeVersionsSnapshot").is_none());
}

#[test]
fn generated_checkpoint_request_round_trips_preserve_parent_snapshot() {
    let request = checkpoints::Request {
        run_id: "run-1".to_string(),
        cli_agent_type: "codex".to_string(),
        cli_agent_session_id: "session-1".to_string(),
        cli_agent_session_history_hash: "b".repeat(64),
        artifact_snapshots: Some(vec![checkpoints::RequestArtifactSnapshot {
            name: "memory".to_string(),
            version: "version-1".to_string(),
            mount_path: "/memory".to_string(),
            missing_root_policy: Some(
                runner_storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion,
            ),
        }]),
        volume_versions_snapshot: None,
    };

    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "cliAgentType": "codex",
            "cliAgentSessionId": "session-1",
            "cliAgentSessionHistoryHash": "b".repeat(64),
            "artifactSnapshots": [{
                "name": "memory",
                "version": "version-1",
                "mountPath": "/memory",
                "missingRootPolicy": "preserveParentVersion",
            }],
        })
    );

    let round_trip: checkpoints::Request = serde_json::from_value(value).unwrap();
    assert_eq!(round_trip, request);
}

#[test]
fn generated_prepare_request_serializes_wire_shape() {
    let hash = "a".repeat(64);
    let request = prepare::Request {
        run_id: "run-1".to_string(),
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
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
            "storageId": "00000000-0000-4000-8000-000000000001",
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
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
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
    assert_eq!(value["storageId"], "00000000-0000-4000-8000-000000000001");
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
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
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
            "storageId": "00000000-0000-4000-8000-000000000001",
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
        storage_id: "00000000-0000-4000-8000-000000000001".to_string(),
        version_id: "version-1".to_string(),
        parent_version_id: None,
        files: vec![],
        message: Some(String::new()),
    };

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["storageId"], "00000000-0000-4000-8000-000000000001");
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
fn generated_storage_mount_entry_preserves_canonical_shape() {
    let mount: runner_storage::StorageMountEntry = serde_json::from_value(json!({
        "name": "memory",
        "storageId": "storage-id-1",
        "versionId": "version-1",
        "mountPath": "/memory",
        "empty": true,
        "missingRootPolicy": "preserveParentVersion",
        "writeback": true,
    }))
    .unwrap();

    assert_eq!(mount.name, "memory");
    assert_eq!(mount.storage_id, "storage-id-1");
    assert_eq!(mount.version_id, "version-1");
    assert_eq!(mount.empty, Some(true));
    assert_eq!(mount.writeback, Some(true));
    assert_eq!(
        mount.missing_root_policy,
        Some(runner_storage::ArtifactEntryMissingRootPolicy::PreserveParentVersion)
    );
}

#[test]
fn generated_model_policy_response_preserves_typed_discovery_fields() {
    let response: policies::Response = serde_json::from_value(json!({
        "policies": [{
            "id": "00000000-0000-4000-8000-000000000001",
            "model": "gpt-5.6-sol",
            "modelLabel": "GPT 5.6 Sol",
            "isDefault": true,
            "defaultProviderType": "codex-oauth-token",
            "credentialScope": "member",
            "modelProviderId": null,
            "routeStatus": "valid",
            "routeStatusReason": null,
            "createdAt": "2026-08-04T00:00:00.000Z",
            "updatedAt": "2026-08-04T00:00:00.000Z"
        }],
        "workspaceDefaultModel": "gpt-5.6-sol",
        "workspaceDefaultPolicyId": "00000000-0000-4000-8000-000000000001"
    }))
    .unwrap();

    assert_eq!(response.policies[0].model, SupportedRunModel::Gpt56Sol);
    assert_eq!(
        response.policies[0].default_provider_type,
        ModelProviderType::CodexOauthToken
    );
    assert_eq!(
        response.policies[0].credential_scope,
        ModelProviderCredentialScope::Member
    );
    assert_eq!(
        response.policies[0].route_status,
        policies::OrgModelPolicyRouteStatus::Valid
    );
    assert!(response.policies[0].model_provider_surface_id.is_none());
    assert_eq!(
        response.workspace_default_model,
        Some(SupportedRunModel::Gpt56Sol)
    );
}

#[test]
fn generated_selected_model_and_build_identity_responses_accept_absent_values() {
    let selected: preference::Response = serde_json::from_value(json!({
        "selectedModel": null,
        "updatedAt": null
    }))
    .unwrap();
    let identity: build_info::Response = serde_json::from_value(json!({
        "commitSha": null
    }))
    .unwrap();

    assert!(selected.selected_model.is_none());
    assert!(selected.updated_at.is_none());
    assert!(identity.commit_sha.is_none());
    assert!(identity.version.is_none());
}

#[test]
fn generated_zero_cli_compatibility_descriptor_omits_unavailable_metadata() {
    let unavailable: zero_cli::CompatibilityDescriptor =
        serde_json::from_value(json!({ "available": false })).unwrap();
    assert_eq!(
        serde_json::to_value(unavailable).unwrap(),
        json!({ "available": false })
    );

    let available: zero_cli::CompatibilityDescriptor = serde_json::from_value(json!({
        "available": true,
        "version": "1.2.3",
        "buildId": "runner-rs@1.2.3",
        "checksumSha256": "a".repeat(64),
        "token": "must-not-survive",
        "commandArguments": ["secret"]
    }))
    .unwrap();
    let value = serde_json::to_value(available).unwrap();

    assert_eq!(value["version"], "1.2.3");
    assert_eq!(value["buildId"], "runner-rs@1.2.3");
    assert_eq!(value["checksumSha256"], "a".repeat(64));
    assert!(value.get("token").is_none());
    assert!(value.get("commandArguments").is_none());
}
