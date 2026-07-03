use std::time::Duration;

use crate::support::{Harness, exec_exit_code, run_exec};

// ── shutdown ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_shutdown() {
    let h = Harness::new().await;

    let acked = h.host().shutdown(Duration::from_secs(5)).await;
    assert!(acked);

    h.finish_ignore_guest();
}

#[tokio::test]
async fn test_shutdown_after_exec() {
    let h = Harness::new().await;

    // Run a command first, then shutdown
    let result = run_exec(h.host(), "echo before", 5000, &[], false)
        .await
        .expect("exec failed");
    assert_eq!(exec_exit_code(&result), Some(0));

    let acked = h.host().shutdown(Duration::from_secs(5)).await;
    assert!(acked);

    h.finish_ignore_guest();
}
