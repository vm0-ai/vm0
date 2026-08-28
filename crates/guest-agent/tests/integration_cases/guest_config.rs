//! Guest config bootstrap deserializes artifact missing-root policies.

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use guest_agent::env::{GuestConfig, GuestConfigRaw};

#[test]
fn guest_config_parses_artifact_missing_root_policies() -> Result<(), String> {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");
    let run_payload_file = crate::common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            artifacts: r#"[
                {"name":"omitted","mountPath":"/mnt/omitted","storageId":"storage-omitted","versionId":"version-omitted"},
                {"name":"fail","mountPath":"/mnt/fail","storageId":"storage-fail","versionId":"version-fail","missingRootPolicy":"fail"},
                {"name":"preserve","mountPath":"/mnt/preserve","storageId":"storage-preserve","versionId":"version-preserve","missingRootPolicy":"preserveParentVersion"}
            ]"#
            .to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: "run-artifact-policy-bootstrap".to_string(),
        home: Some("/home/vm0".to_string()),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..GuestConfigRaw::default()
    })?;

    assert_eq!(
        config
            .artifacts
            .iter()
            .map(|entry| (entry.name.as_str(), entry.missing_root_policy))
            .collect::<Vec<_>>(),
        vec![
            ("omitted", None),
            ("fail", Some(ArtifactEntryMissingRootPolicy::Fail)),
            (
                "preserve",
                Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
            ),
        ]
    );

    Ok(())
}
