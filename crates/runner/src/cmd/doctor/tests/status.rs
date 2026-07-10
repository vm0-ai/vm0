use super::super::*;

#[tokio::test]
async fn read_status_defaults_missing_collections_to_empty() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("status.json"),
        r#"{"mode":"running","started_at":"2026-01-01T00:00:00.000Z"}"#,
    )
    .unwrap();

    let status = read_status(dir.path()).await.unwrap();

    assert!(status.active_runs.is_empty());
    assert!(status.idle_vms.is_empty());
}

#[tokio::test]
async fn read_status_missing_active_run_identifier_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("status.json"),
        r#"{
            "mode":"running",
            "started_at":"2026-01-01T00:00:00.000Z",
            "active_runs":[{"run_id":"R1"}]
        }"#,
    )
    .unwrap();

    assert!(read_status(dir.path()).await.is_none());
}

#[tokio::test]
async fn read_status_missing_idle_vm_identifier_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("status.json"),
        r#"{
            "mode":"running",
            "started_at":"2026-01-01T00:00:00.000Z",
            "idle_vms":[{"session_id":"session-a"}]
        }"#,
    )
    .unwrap();

    assert!(read_status(dir.path()).await.is_none());
}

#[test]
fn active_run_unknown_phase_defaults_running() {
    let active = ActiveRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        phase: Some("future-phase".into()),
        phase_started_at: None,
    };

    assert_eq!(active.phase(), ActiveRunPhase::Running);
}
