use sandbox::{ExecResult, Sandbox};
use sandbox_mock::MockSandbox;
use tracing::Level;
use tracing_subscriber::prelude::*;

use super::super::guest_state::{fix_guest_clock, reseed_guest_entropy, sync_guest_timezone};
use super::support::{CapturedEvent, CapturedEvents, minimal_context, sandbox_exec_error};
use crate::ids::RunId;
use crate::types::ExecutionContext;

#[tokio::test]
async fn fix_guest_clock_calls_date_command() {
    let sandbox = MockSandbox::new("test");
    // Default mock returns exit 0 — clock fix should succeed.
    fix_guest_clock(&sandbox).await.unwrap();
}

#[tokio::test]
async fn fix_guest_clock_propagates_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("timeout")));
    let result = fix_guest_clock(&sandbox).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn fix_guest_clock_fails_on_nonzero_exit() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        b"date stdout".to_vec(),
        b"date stderr".to_vec(),
    )));

    let result = fix_guest_clock(&sandbox).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest clock sync failed (exit code 2)"),
        "got: {message}"
    );
    assert!(
        message.contains("stderr (captured): date stderr"),
        "got: {message}"
    );
    assert!(
        message.contains("stdout (captured): date stdout"),
        "got: {message}"
    );
}

#[tokio::test]
async fn reseed_guest_entropy_succeeds() {
    let sandbox = MockSandbox::new("test");
    reseed_guest_entropy(&sandbox).await.unwrap();

    let calls = sandbox.exec_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].cmd, "guest-reseed");
    assert!(calls[0].sudo);
    let stdin_bytes = calls[0].stdin_bytes.as_ref().unwrap();
    assert_eq!(stdin_bytes.len(), 256);
}

#[tokio::test]
async fn reseed_guest_entropy_propagates_exec_error() {
    let sandbox = MockSandbox::new("test");
    // Sandbox-level failure (vsock connection issue).
    sandbox.push_exec_result(Err(sandbox_exec_error("reseed failed")));
    let result = reseed_guest_entropy(&sandbox).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn reseed_guest_entropy_fails_on_nonzero_exit() {
    let sandbox = MockSandbox::new("test");
    // guest-reseed exits with code 1 (e.g., ioctl failed).
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"RNDRESEEDCRNG failed: Operation not permitted".to_vec(),
    )));
    let result = reseed_guest_entropy(&sandbox).await;
    assert!(result.is_err());
    let msg = result.unwrap_err().to_string();
    assert!(msg.contains("guest-reseed failed"), "got: {msg}");
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
