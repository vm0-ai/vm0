use std::process::ExitCode;

use super::super::{SubmitArgs, run_submit_with_home};
use super::support::{submit_queue_entry, wait_for_job_and_write_result, write_queue_job_file};
use crate::ids::RunId;
use crate::local_queue;
use crate::paths::HomePaths;

#[tokio::test]
async fn submit_returns_failure_for_nonzero_job_response() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let group_dir = home.groups_dir().join(group);
    let watcher = tokio::spawn(wait_for_job_and_write_result(
        group_dir.clone(),
        crate::profile::DEFAULT_PROFILE.to_owned(),
        42,
        Some("agent failed".into()),
    ));

    let code = run_submit_with_home(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            chat_thread_id: None,
            session_id: None,
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();
    let request = watcher.await.unwrap();
    let result_path = local_queue::result_path(&group_dir, request.job_id);

    assert_eq!(code, ExitCode::FAILURE);
    assert!(
        !result_path.exists(),
        "completed cleanup should remove nonzero result files"
    );
}

#[test]
fn cleanup_completed_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.job.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    // Create some files
    std::fs::write(&queue.job, b"{}").unwrap();
    std::fs::write(&queue.result, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();

    // First cleanup
    queue.cleanup_completed();
    assert!(!queue.job.exists());
    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(
        !queue.claim.exists(),
        "completed-result cleanup should remove stale claims left after result write"
    );

    // Second cleanup (idempotent — no panic on missing files)
    queue.cleanup_completed();
}

#[test]
fn completed_cleanup_removes_duplicate_job_files() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
    let large_job = write_queue_job_file(group_dir, "vm0/large", job_id);
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.result, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();

    queue.cleanup_completed();

    assert!(!default_job.exists());
    assert!(!large_job.exists());
    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn completed_cleanup_keeps_result_when_job_cannot_be_removed() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(&queue.job).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.result, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();

    queue.cleanup_completed();

    assert!(
        queue.result.exists(),
        "result must remain as the terminal marker if the job path was not removed"
    );
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn completed_cleanup_keeps_result_when_duplicate_job_cannot_be_removed() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    let default_job = write_queue_job_file(group_dir, crate::profile::DEFAULT_PROFILE, job_id);
    let blocked_job = local_queue::job_path(group_dir, "vm0/large", job_id).unwrap();
    std::fs::create_dir_all(&blocked_job).unwrap();
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.result, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();

    queue.cleanup_completed();

    assert!(!default_job.exists());
    assert!(blocked_job.exists());
    assert!(
        queue.result.exists(),
        "result must remain as the terminal marker if any duplicate job path was not removed"
    );
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}

#[test]
fn completed_cleanup_removes_result_when_job_already_absent() {
    let dir = tempfile::tempdir().unwrap();
    let group_dir = dir.path();
    let job_id = RunId::new_v4();
    let queue = submit_queue_entry(group_dir, job_id);
    std::fs::create_dir_all(queue.result.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.cancel.parent().unwrap()).unwrap();
    std::fs::create_dir_all(queue.claim.parent().unwrap()).unwrap();

    std::fs::write(&queue.result, b"{}").unwrap();
    std::fs::write(&queue.cancel, b"").unwrap();
    std::fs::write(&queue.claim, b"").unwrap();

    queue.cleanup_completed();

    assert!(!queue.result.exists());
    assert!(!queue.cancel.exists());
    assert!(!queue.claim.exists());
}
