use std::os::unix::fs::symlink;

use api_contracts::generated::constants::runners::{
    RESUME_SESSION_HISTORY_MAX_BYTES, paths::CANONICAL_WORKING_DIR,
};
use sha2::{Digest, Sha256};
use tokio::fs;

use super::super::fs::workspace_cache_path_allocated_bytes;
use super::super::types::{
    WorkspaceSessionHistorySidecarMiss, WorkspaceSessionHistorySidecarPublication,
};
use super::super::{
    WorkspaceImageCache, WorkspaceSessionHistorySidecarPromotionSource,
    WorkspaceSessionHistorySidecarRepresentation,
};
use super::support::{TEST_PROFILE_NAME, local_cache, write_current_cache_entry};
use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::restored_session_identity::{RestoredSessionFramework, RestoredSessionIdentity};
use crate::types::ResumeSessionHistoryRefKind;

fn test_restored_session_identity(session_id: &str, history: &[u8]) -> RestoredSessionIdentity {
    RestoredSessionIdentity::new(
        RestoredSessionFramework::ClaudeCode,
        session_id,
        ResumeSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        Some(history.len() as u64),
    )
}

async fn publish_test_session_history_sidecar(
    cache: &WorkspaceImageCache,
    cache_key: &str,
    run_id: RunId,
    session_id: &str,
    history: &[u8],
) -> RestoredSessionIdentity {
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(cache_key, run_id);
    fs::write(&tmp_path, history).await.unwrap();
    let identity = test_restored_session_identity(session_id, history);
    let source = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
        restored_session_identity: identity.clone(),
    };
    cache
        .publish_session_history_sidecar(
            cache_key,
            run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&source),
        )
        .await
        .unwrap();
    identity
}

#[tokio::test]
async fn session_history_sidecar_publish_and_probe_hit() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-hit";
    let history = br#"{"type":"message","content":"hello"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;

    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let metadata_path = paths
        .workspace_image_cache_entry_dir(&cache_key)
        .join("session-history.metadata.json");
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&metadata_path).await.unwrap()).unwrap();
    assert!(metadata.get("historyGenerationRunId").is_none());
    assert!(metadata.get("allocatedBytes").is_none());
    let held_states = cache.held_workspace_states().await;
    assert_eq!(
        held_states[0].workspace_caches[0].profile,
        TEST_PROFILE_NAME
    );
    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();

    assert_eq!(
        sidecar.representation,
        WorkspaceSessionHistorySidecarRepresentation::Raw
    );
    assert_eq!(sidecar.encoded_size, history.len() as u64);
    assert_eq!(fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn previous_session_history_sidecar_metadata_remains_restoreable() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-previous";
    let history = br#"{"type":"message","content":"previous"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let metadata_path = paths
        .workspace_image_cache_entry_dir(&cache_key)
        .join("session-history.metadata.json");
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&metadata_path).await.unwrap()).unwrap();
    let metadata = metadata.as_object_mut().unwrap();
    assert!(
        metadata
            .insert("allocatedBytes".into(), 4096_u64.into())
            .is_none()
    );
    assert!(
        metadata
            .insert("historyGenerationRunId".into(), run_id.to_string().into(),)
            .is_none()
    );
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .await
        .unwrap();

    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();

    assert_eq!(
        sidecar.representation,
        WorkspaceSessionHistorySidecarRepresentation::Raw
    );
    assert_eq!(sidecar.encoded_size, history.len() as u64);
    assert_eq!(fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn invalid_session_history_sidecars_are_rejected_by_probe() {
    #[derive(Clone, Copy, Debug)]
    enum InvalidSidecarCase {
        MissingMetadata,
        MalformedMetadata,
        UnsupportedRepresentation,
        MetadataSymlink,
        MissingBody,
        BodySymlink,
        SessionMismatch,
        InvalidHash,
        InvalidSize,
        EncodedTooLarge,
    }

    for case in [
        InvalidSidecarCase::MissingMetadata,
        InvalidSidecarCase::MalformedMetadata,
        InvalidSidecarCase::UnsupportedRepresentation,
        InvalidSidecarCase::MetadataSymlink,
        InvalidSidecarCase::MissingBody,
        InvalidSidecarCase::BodySymlink,
        InvalidSidecarCase::SessionMismatch,
        InvalidSidecarCase::InvalidHash,
        InvalidSidecarCase::InvalidSize,
        InvalidSidecarCase::EncodedTooLarge,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let session_id = "sess-sidecar-invalid-observation";
        let history = br#"{"type":"message","content":"invalid"}"#;
        let cache_key = write_current_cache_entry(
            &cache,
            run_id,
            session_id,
            CANONICAL_WORKING_DIR,
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
        )
        .await;
        let identity =
            publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history)
                .await;
        let entry_dir = paths.workspace_image_cache_entry_dir(&cache_key);
        let metadata_path = entry_dir.join("session-history.metadata.json");
        let body_path = cache
            .probe_session_history_sidecar(&cache_key, &identity)
            .await
            .unwrap()
            .path;

        match case {
            InvalidSidecarCase::MissingMetadata => {
                fs::remove_file(&metadata_path).await.unwrap();
            }
            InvalidSidecarCase::MalformedMetadata => {
                fs::write(&metadata_path, b"not-json").await.unwrap();
            }
            InvalidSidecarCase::UnsupportedRepresentation
            | InvalidSidecarCase::SessionMismatch
            | InvalidSidecarCase::InvalidHash
            | InvalidSidecarCase::InvalidSize
            | InvalidSidecarCase::EncodedTooLarge => {
                let mut metadata: serde_json::Value =
                    serde_json::from_slice(&fs::read(&metadata_path).await.unwrap()).unwrap();
                match case {
                    InvalidSidecarCase::UnsupportedRepresentation => {
                        metadata["representation"] = "codex-zstd".into();
                    }
                    InvalidSidecarCase::SessionMismatch => {
                        metadata["sessionIdHash"] =
                            hex::encode(Sha256::digest(b"another-session")).into();
                    }
                    InvalidSidecarCase::InvalidHash => {
                        metadata["historyHash"] = "not-a-sha256-hash".into();
                    }
                    InvalidSidecarCase::InvalidSize => {
                        metadata["historySizeBytes"] = 0.into();
                    }
                    InvalidSidecarCase::EncodedTooLarge => {
                        metadata["encodedSize"] = (RESUME_SESSION_HISTORY_MAX_BYTES + 1).into();
                    }
                    unexpected => {
                        panic!("unexpected grouped invalid sidecar case: {unexpected:?}")
                    }
                }
                fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
                    .await
                    .unwrap();
            }
            InvalidSidecarCase::MetadataSymlink => {
                let target = entry_dir.join("session-history.metadata.target.json");
                fs::rename(&metadata_path, &target).await.unwrap();
                symlink(&target, &metadata_path).unwrap();
            }
            InvalidSidecarCase::MissingBody => {
                fs::remove_file(&body_path).await.unwrap();
            }
            InvalidSidecarCase::BodySymlink => {
                let target = entry_dir.join("session-history.target.blob");
                fs::rename(&body_path, &target).await.unwrap();
                symlink(&target, &body_path).unwrap();
            }
        }

        assert!(
            cache
                .probe_session_history_sidecar(&cache_key, &identity)
                .await
                .is_err(),
            "case: {case:?}"
        );
    }
}

#[tokio::test]
async fn session_history_sidecar_explicit_prune_removes_existing_sidecar() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-prune";
    let history = br#"{"type":"message","content":"old"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;

    cache
        .publish_session_history_sidecar(
            &cache_key,
            RunId::new_v4(),
            WorkspaceSessionHistorySidecarPublication::Prune,
        )
        .await
        .unwrap();

    assert_eq!(
        cache
            .probe_session_history_sidecar(&cache_key, &identity)
            .await
            .unwrap_err(),
        WorkspaceSessionHistorySidecarMiss::Missing
    );
}

#[tokio::test]
async fn session_history_sidecar_invalid_replacement_preserves_existing_sidecar() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-invalid-source-prune";
    let history = br#"{"type":"message","content":"old"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let invalid_tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, RunId::new_v4());
    fs::write(&invalid_tmp_path, b"new").await.unwrap();
    let invalid_source = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path: invalid_tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: 0,
        restored_session_identity: identity.clone(),
    };

    cache
        .publish_session_history_sidecar(
            &cache_key,
            RunId::new_v4(),
            WorkspaceSessionHistorySidecarPublication::Replace(&invalid_source),
        )
        .await
        .unwrap();

    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();
    assert_eq!(fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn session_history_sidecar_preserve_keeps_existing_sidecar() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-preserve";
    let history = br#"{"type":"message","content":"old"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;

    cache
        .publish_session_history_sidecar(
            &cache_key,
            RunId::new_v4(),
            WorkspaceSessionHistorySidecarPublication::PreserveExisting,
        )
        .await
        .unwrap();

    let sidecar = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap();
    assert_eq!(fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn session_history_sidecar_failed_replacement_preserves_committed_sidecar() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "session-a",
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let history_a = br#"{"type":"message","content":"a"}"#;
    let identity_a =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, "session-a", history_a)
            .await;
    let committed_a = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap();
    let metadata_path = paths
        .workspace_image_cache_entry_dir(&cache_key)
        .join("session-history.metadata.json");
    let metadata_a = fs::read(&metadata_path).await.unwrap();

    let replacement_run_id = RunId::new_v4();
    let history_b = br#"{"type":"message","content":"b"}"#;
    let identity_b = test_restored_session_identity("session-b", history_b);
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, replacement_run_id);
    fs::write(&tmp_path, history_b).await.unwrap();
    let replacement = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history_b.len() as u64,
        restored_session_identity: identity_b,
    };
    let blocked_slot = paths
        .workspace_image_cache_entry_dir(&cache_key)
        .join("session-history.second.blob");
    fs::create_dir(&blocked_slot).await.unwrap();

    cache
        .publish_session_history_sidecar(
            &cache_key,
            replacement_run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&replacement),
        )
        .await
        .unwrap_err();

    let still_committed = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap();
    assert_eq!(still_committed.path, committed_a.path);
    assert_eq!(fs::read(still_committed.path).await.unwrap(), history_a);
    assert_eq!(fs::read(metadata_path).await.unwrap(), metadata_a);
}

#[tokio::test]
async fn session_history_sidecar_verified_replacement_supersedes_previous_identity() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "session-a",
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let history_a = br#"{"type":"message","content":"a"}"#;
    let identity_a =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, "session-a", history_a)
            .await;
    let body_a = cache
        .probe_session_history_sidecar(&cache_key, &identity_a)
        .await
        .unwrap()
        .path;
    let history_b = br#"{"type":"message","content":"b"}"#;
    let identity_b = test_restored_session_identity("session-b", history_b);
    let replacement_run_id = RunId::new_v4();
    let tmp_path = cache.workspace_image_cache_tmp_sidecar(&cache_key, replacement_run_id);
    fs::write(&tmp_path, history_b).await.unwrap();
    let replacement = WorkspaceSessionHistorySidecarPromotionSource {
        tmp_path,
        representation: WorkspaceSessionHistorySidecarRepresentation::Raw,
        encoded_size: history_b.len() as u64,
        restored_session_identity: identity_b.clone(),
    };

    cache
        .publish_session_history_sidecar(
            &cache_key,
            replacement_run_id,
            WorkspaceSessionHistorySidecarPublication::Replace(&replacement),
        )
        .await
        .unwrap();

    assert_eq!(
        cache
            .probe_session_history_sidecar(&cache_key, &identity_a)
            .await
            .unwrap_err(),
        WorkspaceSessionHistorySidecarMiss::IdentityMismatch
    );
    let sidecar_b = cache
        .probe_session_history_sidecar(&cache_key, &identity_b)
        .await
        .unwrap();
    assert_ne!(sidecar_b.path, body_a);
    assert!(!body_a.exists());
    assert_eq!(fs::read(sidecar_b.path).await.unwrap(), history_b);
}

#[tokio::test]
async fn session_history_sidecar_probe_rejects_mismatched_body_identity() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-mismatch";
    let history = br#"{"type":"message","content":"stable"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let identity =
        publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let body_path = cache
        .probe_session_history_sidecar(&cache_key, &identity)
        .await
        .unwrap()
        .path;
    fs::write(body_path, b"changed").await.unwrap();

    assert_eq!(
        cache
            .probe_session_history_sidecar(&cache_key, &identity)
            .await
            .unwrap_err(),
        WorkspaceSessionHistorySidecarMiss::FileIdentityMismatch
    );
}

#[tokio::test]
async fn session_history_sidecar_counts_toward_gc_candidate_and_inspection() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let session_id = "sess-sidecar-accounting";
    let history = br#"{"type":"message","content":"accounting"}"#;
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        session_id,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    publish_test_session_history_sidecar(&cache, &cache_key, run_id, session_id, history).await;
    let current_allocated = workspace_cache_path_allocated_bytes(
        &paths.workspace_image_cache_current_image(&cache_key),
    )
    .await;
    let sidecar_allocated = cache
        .session_history_sidecar_allocated_bytes(&cache_key)
        .await;

    let candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();
    assert_eq!(
        candidate.allocated_bytes,
        current_allocated.saturating_add(sidecar_allocated)
    );

    let inspection = cache.inspect().await.unwrap();
    let entry = inspection
        .entries
        .iter()
        .find(|entry| entry.cache_key == cache_key)
        .unwrap();
    assert_eq!(
        entry.allocated_bytes,
        current_allocated.saturating_add(sidecar_allocated)
    );
}
