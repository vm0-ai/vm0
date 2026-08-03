//! Timed child output collection must own the child through cleanup.

mod common;

use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

const MANAGED_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::test]
async fn command_output_timeout_preserves_completed_output()
-> Result<(), Box<dyn std::error::Error>> {
    let output = common::command_output_with_timeout(
        Command::new("/bin/sh")
            .arg("-c")
            .arg("printf 'captured stdout'; printf 'captured stderr' >&2; exit 7"),
        Duration::from_secs(5),
        "completed child exceeded its budget",
    )
    .await?;

    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, b"captured stdout");
    assert_eq!(output.stderr, b"captured stderr");
    Ok(())
}

#[tokio::test]
async fn command_output_timeout_reaps_child_before_returning()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let pid_file = tmp.path().join("child.pid");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("printf '%s\n' \"$$\" > \"$VM0_TEST_CHILD_PID_FILE\"; exec /bin/sleep 60")
        .env("VM0_TEST_CHILD_PID_FILE", &pid_file);
    let execution = tokio::spawn(async move {
        common::command_output_with_timeout(
            &mut command,
            MANAGED_TIMEOUT,
            "long-lived child exceeded its budget",
        )
        .await
    });

    common::wait_for_path(&pid_file, Duration::from_secs(5)).await?;
    let pid = std::fs::read_to_string(&pid_file)?.trim().parse::<u32>()?;
    let process_path = PathBuf::from(format!("/proc/{pid}"));
    assert!(
        process_path.exists(),
        "fixture child must be live before its timeout is advanced"
    );

    tokio::time::pause();
    tokio::time::advance(MANAGED_TIMEOUT).await;
    let join_result = execution.await;
    tokio::time::resume();
    let error = join_result?.expect_err("long-lived child should reach its managed timeout");

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(error.to_string(), "long-lived child exceeded its budget");
    assert!(
        !process_path.exists(),
        "timed-out child must be reaped before the helper returns"
    );
    Ok(())
}
