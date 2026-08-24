use std::ffi::OsStr;
use std::process::ExitCode;
use std::time::Duration;

use super::super::run_submit_with_home;
use super::support::submit_args_for_test;
use crate::ids::RunId;
use crate::local_queue::{self, JobRequest, JobResponse};
use crate::paths::HomePaths;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const INTERRUPT_CHILD_ENV: &str = "OKOU_RUNNER_LOCAL_SUBMIT_INTERRUPT_TEST";
const INTERRUPT_CHILD_VALUE: &str = "after-job-publication";
const INTERRUPT_CHILD_TEST: &str =
    "cmd::local::submit::tests::interrupt::sigint_after_job_publication_uses_cancel_cleanup_child";

pub(super) fn post_publish_test_checkpoint() {
    if std::env::var_os(INTERRUPT_CHILD_ENV).as_deref() != Some(OsStr::new(INTERRUPT_CHILD_VALUE)) {
        return;
    }

    nix::sys::signal::kill(nix::unistd::Pid::this(), nix::sys::signal::Signal::SIGINT)
        .expect("send SIGINT after local job publication");
}

#[tokio::test]
async fn sigint_after_job_publication_uses_cancel_cleanup() {
    run_ignored_child_test(
        INTERRUPT_CHILD_TEST,
        (INTERRUPT_CHILD_ENV, INTERRUPT_CHILD_VALUE),
        &[],
        Duration::from_secs(5),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by sigint_after_job_publication_uses_cancel_cleanup"]
async fn sigint_after_job_publication_uses_cancel_cleanup_child() {
    if !ignored_child_test_env_guard_enabled((INTERRUPT_CHILD_ENV, INTERRUPT_CHILD_VALUE)) {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    let profile = crate::profile::DEFAULT_PROFILE.to_owned();
    let runner = tokio::spawn(wait_for_cancel_and_write_failure(
        group_dir.clone(),
        profile.clone(),
    ));

    let exit = run_submit_with_home(submit_args_for_test(), home)
        .await
        .unwrap();
    let job_id = runner.await.unwrap();

    assert_eq!(exit, ExitCode::FAILURE);
    assert!(
        !local_queue::job_path(&group_dir, &profile, job_id)
            .unwrap()
            .exists(),
        "interrupted submit must not leave an executable job"
    );
    assert!(!local_queue::cancel_path(&group_dir, job_id).exists());
    assert!(!local_queue::claim_path(&group_dir, job_id).exists());
    assert!(!local_queue::result_path(&group_dir, job_id).exists());
}

async fn wait_for_cancel_and_write_failure(
    group_dir: std::path::PathBuf,
    profile: String,
) -> RunId {
    let job_dir = local_queue::profile_jobs_dir(&group_dir, &profile).unwrap();
    let request = loop {
        if let Ok(entries) = std::fs::read_dir(&job_dir) {
            let request = entries.filter_map(Result::ok).find_map(|entry| {
                let path = entry.path();
                (path.extension().and_then(|ext| ext.to_str()) == Some("job")).then(|| {
                    serde_json::from_slice::<JobRequest>(&std::fs::read(path).unwrap()).unwrap()
                })
            });
            if let Some(request) = request {
                break request;
            }
        }
        tokio::task::yield_now().await;
    };

    let cancel_path = local_queue::cancel_path(&group_dir, request.job_id);
    while !local_queue::marker_file_exists(&cancel_path, "local cancel marker").unwrap() {
        tokio::task::yield_now().await;
    }

    let result = JobResponse {
        run_id: request.job_id,
        exit_code: 1,
        error: Some("cancelled by test runner".to_owned()),
    };
    let result_path = local_queue::result_path(&group_dir, request.job_id);
    std::fs::write(result_path, serde_json::to_vec(&result).unwrap()).unwrap();
    request.job_id
}
