use super::*;

#[tokio::test]
async fn sandbox_control_default_succeeds() {
    let control = MockSandboxControl::new("/tmp/test");
    let result = control
        .exec_remote("sandbox-1", "echo hi", Duration::from_secs(5), false)
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        control.kill_remote("sandbox-1").await.unwrap(),
        RemoteKillResult::Accepted
    );
    assert_eq!(
        control.runtime_dir("sandbox-1"),
        PathBuf::from("/tmp/test/sandbox-1")
    );
}

#[tokio::test]
async fn sandbox_control_records_commands() {
    let control = MockSandboxControl::new("/tmp/test");
    control
        .exec_remote("sandbox-1", "echo one", Duration::from_secs(5), false)
        .await
        .unwrap();
    control
        .exec_remote("sandbox-1", "echo two", Duration::from_secs(5), true)
        .await
        .unwrap();

    assert_eq!(
        control.recorded_commands(),
        vec!["echo one".to_string(), "echo two".to_string()],
    );
}

#[tokio::test]
async fn sandbox_control_records_kill_ids() {
    let control = MockSandboxControl::new("/tmp/test");
    control.kill_remote("sandbox-1").await.unwrap();
    control.kill_remote("sandbox-2").await.unwrap();

    assert_eq!(
        control.recorded_kill_ids(),
        vec!["sandbox-1".to_string(), "sandbox-2".to_string()],
    );
}

#[tokio::test]
async fn sandbox_control_queued_results() {
    let control = MockSandboxControl::new("/tmp/test");
    control.push_exec_remote_result(Err(SandboxControlError::NotFound("gone".into())));

    let result = control
        .exec_remote("sandbox-1", "test", Duration::from_secs(5), false)
        .await;
    assert!(result.is_err());

    // Falls back to default.
    let result = control
        .exec_remote("sandbox-1", "test", Duration::from_secs(5), false)
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn sandbox_control_queued_kill_results() {
    let control = MockSandboxControl::new("/tmp/test");
    control.push_kill_remote_result(Err(SandboxControlError::NotFound("gone".into())));

    let result = control.kill_remote("sandbox-1").await;
    assert!(result.is_err());

    assert_eq!(
        control.kill_remote("sandbox-1").await.unwrap(),
        RemoteKillResult::Accepted
    );
}
