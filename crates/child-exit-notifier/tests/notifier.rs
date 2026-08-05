#![cfg(target_os = "linux")]

use std::process::Stdio;
use std::time::Duration;

use child_exit_notifier::{ChildExitNotifier, ChildExitNotifierError};
use tokio::process::Command;

#[tokio::test]
async fn reports_child_exit_before_reap() {
    let mut child = Command::new("sh")
        .args(["-c", "read value"])
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let notifier = ChildExitNotifier::open(&child).unwrap();

    drop(child.stdin.take());

    tokio::time::timeout(Duration::from_secs(2), notifier.wait_for_exit())
        .await
        .expect("child exit notification timed out")
        .expect("child exit notification failed");
    child.wait().await.unwrap();
}

#[tokio::test]
async fn reports_missing_pid_after_child_reap() {
    let mut child = Command::new("sh")
        .args(["-c", "exit 0"])
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    child.wait().await.unwrap();

    assert!(matches!(
        ChildExitNotifier::open(&child),
        Err(ChildExitNotifierError::MissingPid)
    ));
}
