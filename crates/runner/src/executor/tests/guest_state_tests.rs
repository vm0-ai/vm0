use sandbox::{ExecResult, ExecTermination, Sandbox};
use sandbox_mock::MockSandbox;
use tracing::Level;
use tracing_subscriber::prelude::*;

use super::super::guest_state::{restore_guest_state, sync_guest_timezone};
use super::support::{CapturedEvent, CapturedEvents, minimal_context, sandbox_exec_error};
use crate::ids::RunId;
use crate::types::ExecutionContext;

#[tokio::test]
async fn restore_guest_state_combines_clock_sync_and_reseed() {
    let sandbox = MockSandbox::new("test");

    restore_guest_state(&sandbox).await.unwrap();

    let calls = sandbox.exec_calls();
    assert_eq!(calls.len(), 1);
    let clock_sync_index = calls[0]
        .cmd
        .find("date -s \"@")
        .expect("guest state restore should sync the clock first");
    let reseed_index = calls[0]
        .cmd
        .find("guest-reseed")
        .expect("guest state restore should reseed entropy");
    assert!(clock_sync_index < reseed_index);
    assert!(calls[0].cmd.contains("guest clock sync failed"));
    assert!(calls[0].cmd.contains("guest-reseed failed"));
    assert!(calls[0].sudo);
    let stdin_bytes = calls[0].stdin_bytes.as_ref().unwrap();
    assert_eq!(stdin_bytes.len(), 256);
}

#[tokio::test]
async fn restore_guest_state_propagates_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("restore failed")));

    let result = restore_guest_state(&sandbox);

    assert!(result.await.is_err());
}

#[tokio::test]
async fn restore_guest_state_fails_on_non_exited_result() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::WaitFailed,
        stdout: b"restore stdout".to_vec(),
        stderr: b"wait failed".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));

    let result = restore_guest_state(&sandbox).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest state restore failed (wait failed)"),
        "got: {message}"
    );
    assert!(
        message.contains("stderr (captured): wait failed"),
        "got: {message}"
    );
    assert!(
        message.contains("stdout (captured): restore stdout"),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_guest_state_reports_clock_failure_marker() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        b"date stdout".to_vec(),
        b"guest clock sync failed\ndate stderr".to_vec(),
    )));

    let result = restore_guest_state(&sandbox).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest state restore failed (exit code 2)"),
        "got: {message}"
    );
    assert!(
        message.contains("guest clock sync failed"),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_guest_state_reports_reseed_failure_marker() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"guest-reseed failed\nRNDRESEEDCRNG failed".to_vec(),
    )));

    let result = restore_guest_state(&sandbox).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest state restore failed (exit code 1)"),
        "got: {message}"
    );
    assert!(message.contains("guest-reseed failed"), "got: {message}");
}

#[tokio::test]
async fn sync_guest_timezone_accepts_common_timezone_name_shapes() {
    for tz in [
        "UTC",
        "Etc/GMT+1",
        "Etc/GMT-14",
        "America/Argentina/Buenos_Aires",
    ] {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(tz.into());

        sync_guest_timezone(&sandbox, &ctx).await;

        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 1, "timezone {tz:?} should call guest exec");
        assert!(
            calls[0]
                .cmd
                .starts_with(&format!("if test -f /usr/share/zoneinfo/{tz}; then ")),
            "unexpected timezone command: {}",
            calls[0].cmd
        );
        assert!(
            calls[0]
                .cmd
                .contains(&format!("echo '{tz}' > /etc/timezone")),
            "unexpected timezone command: {}",
            calls[0].cmd
        );
        assert!(
            calls[0]
                .cmd
                .contains(&format!("echo 'TZ={tz}' >> /etc/environment")),
            "unexpected timezone command: {}",
            calls[0].cmd
        );
        assert!(calls[0].cmd.ends_with(" fi"));
    }
}

#[tokio::test]
async fn sync_guest_timezone_skips_when_none() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    sync_guest_timezone(&sandbox, &ctx).await;

    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn sync_guest_timezone_rejects_invalid_timezone_names() {
    for invalid_tz in [
        "$(rm -rf /)",
        "../UTC",
        "Etc/../UTC",
        "America/New York",
        "UTC;id",
        "UTC'",
    ] {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(invalid_tz.into());

        sync_guest_timezone(&sandbox, &ctx).await;

        assert!(
            sandbox.exec_calls().is_empty(),
            "timezone {invalid_tz:?} should be rejected before guest exec"
        );
    }
}

#[tokio::test]
async fn sync_guest_timezone_empty_string_skips() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some(String::new());
    sync_guest_timezone(&sandbox, &ctx).await;

    assert!(sandbox.exec_calls().is_empty());
}

async fn capture_sync_guest_timezone_events(
    sandbox: &dyn Sandbox,
    ctx: &ExecutionContext,
) -> Vec<CapturedEvent> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    sync_guest_timezone(sandbox, ctx).await;

    captured.entries()
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_nonzero_exit() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        b"timezone stdout".to_vec(),
        b"timezone stderr".to_vec(),
    )));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::nil().to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("America/New_York")
    );
    assert_eq!(event.fields.get("exit_code").map(String::as_str), Some("2"));
    assert_eq!(
        event.fields.get("termination").map(String::as_str),
        Some("exited")
    );
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains("timezone stderr")),
        "event={event:#?}"
    );
    assert!(
        event
            .fields
            .get("stdout_excerpt")
            .is_some_and(|value| value.contains("timezone stdout")),
        "event={event:#?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_non_exited_result() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::StartFailed,
        stdout: b"timezone stdout".to_vec(),
        stderr: b"start failed".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));

    assert_eq!(
        event.fields.get("termination").map(String::as_str),
        Some("start_failed")
    );
    assert_eq!(event.fields.get("exit_code"), None);
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains("start failed")),
        "event={event:#?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock disconnected")));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;

    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::nil().to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("America/New_York")
    );
    assert!(
        event
            .fields
            .get("error")
            .is_some_and(|value| value.contains("vsock disconnected")),
        "event={event:#?}"
    );
}
