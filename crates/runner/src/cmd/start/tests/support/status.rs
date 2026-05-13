use super::super::super::*;
use super::wait::{WaitProbe, wait_for_probe};

#[derive(serde::Deserialize)]
struct StatusSnapshot {
    active_runs: Vec<ActiveRunSnapshot>,
    #[serde(default)]
    idle_vms: Vec<IdleVmSnapshot>,
}

#[derive(serde::Deserialize)]
struct StatusModeSnapshot {
    mode: Option<String>,
}

#[derive(serde::Deserialize)]
struct ActiveRunSnapshot {
    run_id: String,
}

#[derive(serde::Deserialize)]
struct IdleVmSnapshot {
    session_id: String,
}

pub(in super::super) async fn status_idle_sessions_and_active_runs(
    status_path: &std::path::Path,
) -> (Vec<String>, Vec<String>) {
    let raw = tokio::fs::read_to_string(status_path).await.unwrap();
    let status: StatusSnapshot = serde_json::from_str(&raw).unwrap();
    let mut sessions: Vec<String> = status
        .idle_vms
        .into_iter()
        .map(|vm| vm.session_id)
        .collect();
    sessions.sort_unstable();
    let mut run_ids: Vec<String> = status
        .active_runs
        .into_iter()
        .map(|run| run.run_id)
        .collect();
    run_ids.sort_unstable();
    (sessions, run_ids)
}

pub(in super::super) async fn status_idle_sessions(status_path: &std::path::Path) -> Vec<String> {
    status_idle_sessions_and_active_runs(status_path).await.0
}

async fn status_mode_if_exists(status_path: &std::path::Path) -> Option<Option<String>> {
    match tokio::fs::try_exists(status_path).await {
        Ok(true) => {
            let raw = tokio::fs::read_to_string(status_path).await.unwrap();
            let status: StatusModeSnapshot = serde_json::from_str(&raw).unwrap();
            Some(status.mode)
        }
        Ok(false) => None,
        Err(err) => panic!(
            "failed to check status file {}: {err}",
            status_path.display()
        ),
    }
}

pub(in super::super) async fn wait_status_mode(
    status_path: &std::path::Path,
    expected: &str,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        match status_mode_if_exists(status_path).await {
            Some(Some(mode)) if mode == expected => WaitProbe::Ready(()),
            Some(Some(mode)) => WaitProbe::Pending(format!(
                "status mode did not reach {expected:?} within {timeout:?} (actual: {mode:?})",
            )),
            Some(None) => WaitProbe::Pending(format!(
                "status file {} did not contain mode within {timeout:?}",
                status_path.display(),
            )),
            None => WaitProbe::Pending(format!(
                "status file {} was not written within {timeout:?}",
                status_path.display(),
            )),
        }
    })
    .await;
}

#[tokio::test]
async fn status_parser_defaults_omitted_idle_vms_to_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    tokio::fs::write(
        &path,
        r#"{"active_runs":[{"run_id":"run-b"},{"run_id":"run-a"}]}"#,
    )
    .await
    .unwrap();

    let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(&path).await;

    assert!(idle_sessions.is_empty());
    assert_eq!(active_runs, vec!["run-a", "run-b"]);
}

#[tokio::test]
#[should_panic(expected = "missing field `active_runs`")]
async fn status_parser_requires_active_runs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    tokio::fs::write(&path, r#"{"idle_vms":[]}"#).await.unwrap();

    let _ = status_idle_sessions_and_active_runs(&path).await;
}

pub(in super::super) async fn wait_status_idle_sessions_and_active_runs(
    status_path: &std::path::Path,
    expected_idle_sessions: &[&str],
    expected_active_runs: &[String],
    timeout: Duration,
) {
    let mut expected_idle_sessions: Vec<String> = expected_idle_sessions
        .iter()
        .map(|session| (*session).to_string())
        .collect();
    expected_idle_sessions.sort_unstable();
    let mut expected_active_runs = expected_active_runs.to_vec();
    expected_active_runs.sort_unstable();

    wait_for_probe(timeout, || async {
        match status_idle_sessions_and_active_runs_if_exists(status_path).await {
            Some((idle_sessions, active_runs))
                if idle_sessions == expected_idle_sessions
                    && active_runs == expected_active_runs =>
            {
                WaitProbe::Ready(())
            }
            Some((idle_sessions, active_runs)) => WaitProbe::Pending(format!(
                "status did not reach expected idle={expected_idle_sessions:?} active={expected_active_runs:?} within {timeout:?} (actual idle={idle_sessions:?} active={active_runs:?})",
            )),
            None => WaitProbe::Pending(format!(
                "status file {} was not written within {timeout:?}",
                status_path.display(),
            )),
        }
    })
    .await;
}

async fn status_idle_sessions_and_active_runs_if_exists(
    status_path: &std::path::Path,
) -> Option<(Vec<String>, Vec<String>)> {
    match tokio::fs::try_exists(status_path).await {
        Ok(true) => Some(status_idle_sessions_and_active_runs(status_path).await),
        Ok(false) => None,
        Err(err) => panic!(
            "failed to check status file {}: {err}",
            status_path.display()
        ),
    }
}

pub(in super::super) async fn publish_idle_status(pool: &SharedIdlePool, status: &StatusTracker) {
    let snapshot = pool.lock().await.status_snapshot();
    assert!(
        status
            .set_idle_info_at_revision(snapshot.revision, snapshot.idle_vms)
            .await
    );
}

pub(in super::super) async fn wait_status_idle_empty_with_active_run(
    status_path: &std::path::Path,
    run_id: RunId,
    timeout: Duration,
) {
    let expected = run_id.to_string();
    wait_for_probe(timeout, || async {
        let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(status_path).await;
        if idle_sessions.is_empty() && active_runs.iter().any(|id| id == &expected) {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "status did not atomically clear idle_vms and add active run {expected} within {timeout:?} (idle: {idle_sessions:?}, active: {active_runs:?})",
            ))
        }
    })
    .await;
}
