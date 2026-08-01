use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{minimal_context, test_executor_config, test_telemetry};
use crate::types::SandboxReuseResult;

#[tokio::test]
async fn run_in_sandbox_folds_timezone_sync_into_restore_exec() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    let exec_calls = sandbox.exec_calls();
    let restore_calls = exec_calls
        .iter()
        .filter(|call| call.cmd.contains("guest-reseed"))
        .collect::<Vec<_>>();
    assert_eq!(
        restore_calls.len(),
        1,
        "restore should run once; calls: {exec_calls:?}"
    );
    let restore_command = &restore_calls[0].cmd;
    assert!(
        restore_command.contains("if test -f /usr/share/zoneinfo/Asia/Shanghai"),
        "restore should include timezone sync; command: {restore_command}"
    );
    assert!(
        restore_command.contains("guest timezone sync failed"),
        "timezone sync should remain best-effort; command: {restore_command}"
    );
    let standalone_timezone_calls = exec_calls
        .iter()
        .filter(|call| {
            call.cmd
                .starts_with("if test -f /usr/share/zoneinfo/Asia/Shanghai")
        })
        .collect::<Vec<_>>();
    assert!(
        standalone_timezone_calls.is_empty(),
        "restore path should not run a separate timezone exec; calls: {exec_calls:?}"
    );
    assert_eq!(
        exec_calls
            .iter()
            .filter(|call| call.cmd.contains("/usr/share/zoneinfo/Asia/Shanghai"))
            .count(),
        1,
        "timezone sync should appear in exactly one exec; calls: {exec_calls:?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_runs_standalone_timezone_sync_without_restore_exec() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = sandbox_mock::MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    let mut telemetry = test_telemetry(&config, &ctx);

    run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        RunControls::new(tokio_util::sync::CancellationToken::new(), None),
    )
    .await
    .unwrap();

    let exec_calls = sandbox.exec_calls();
    assert!(
        exec_calls.iter().any(|call| call
            .cmd
            .starts_with("if test -f /usr/share/zoneinfo/Asia/Shanghai")),
        "fresh path should keep standalone timezone sync; calls: {exec_calls:?}"
    );
    assert!(
        exec_calls
            .iter()
            .all(|call| !call.cmd.contains("guest-reseed")),
        "fresh path should not run guest state restore; calls: {exec_calls:?}"
    );
}
