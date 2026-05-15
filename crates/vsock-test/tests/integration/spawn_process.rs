use std::time::Duration;

use crate::support::Harness;

// ── spawn_process ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_spawn_process() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("echo done", 5000, &[], false, false, None)
        .await
        .expect("spawn_process failed");
    let pid = handle.pid();
    assert!(pid > 0);

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"done\n");
    assert!(event.stderr.is_empty());
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_exit_code() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("exit 42", 5000, &[], false, false, None)
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 42);
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_stderr() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("echo error >&2 && exit 1", 5000, &[], false, false, None)
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 1);
    assert_eq!(event.stderr, b"error\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_both_stdout_stderr() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process(
            "echo out && echo err >&2 && exit 2",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 2);
    assert_eq!(event.stdout, b"out\n");
    assert_eq!(event.stderr, b"err\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_no_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("true", 5000, &[], false, false, None)
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.is_empty());
    assert!(event.stderr.is_empty());
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_concurrent() {
    let h = Harness::new().await;

    // Spawn two processes — second finishes first
    let handle1 = h
        .spawn_process("sleep 0.1 && echo first", 5000, &[], false, false, None)
        .await
        .expect("spawn_process 1 failed");
    let pid1 = handle1.pid();
    let handle2 = h
        .spawn_process("echo second", 5000, &[], false, false, None)
        .await
        .expect("spawn_process 2 failed");
    let pid2 = handle2.pid();

    assert_ne!(pid1, pid2);

    // Wait in reverse order to exercise out-of-order handle completion.
    let event2 = h
        .wait_spawn(handle2, Duration::from_secs(5))
        .await
        .expect("spawn wait 2 failed");
    let event1 = h
        .wait_spawn(handle1, Duration::from_secs(5))
        .await
        .expect("spawn wait 1 failed");

    assert_eq!(event1.exit_code, 0);
    assert_eq!(event1.stdout, b"first\n");
    assert_eq!(event2.exit_code, 0);
    assert_eq!(event2.stdout, b"second\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_timeout() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("sleep 10", 100, &[], false, false, None)
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 124);
    assert!(event.stderr.starts_with(b"Timeout"));
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_exit_before_wait() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("echo completed", 5000, &[], false, false, None)
        .await
        .expect("spawn_process failed");

    // Use an exec round-trip as a synchronization barrier: by the time exec
    // returns, the exit event from "echo completed" has already been delivered
    // into the handle-owned receiver. This covers waiting after completion
    // without any sleep.
    h.exec("true", 5000, &[], false)
        .await
        .expect("barrier exec failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"completed\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_multiline() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process(
            "printf 'line1\\nline2\\nline3\\n'",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"line1\nline2\nline3\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_large_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process(
            "dd if=/dev/zero bs=1024 count=10 2>/dev/null | base64",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(10))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.len() > 10000);
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_delayed_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("sleep 0.2 && echo delayed", 5000, &[], false, false, None)
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"delayed\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_sigterm() {
    let h = Harness::new().await;

    // Use `exec` to replace shell so the PID we get is the actual sleep process
    let handle = h
        .spawn_process("exec sleep 60", 0, &[], false, false, None)
        .await
        .expect("spawn_process failed");
    let pid = handle.pid();

    // Kill process group with SIGTERM
    h.exec(
        &format!("kill -15 -{pid} 2>/dev/null || kill -15 {pid}"),
        5000,
        &[],
        false,
    )
    .await
    .expect("kill failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 143); // 128 + SIGTERM(15)
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_sigkill() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process("exec sleep 60", 0, &[], false, false, None)
        .await
        .expect("spawn_process failed");
    let pid = handle.pid();

    h.exec(
        &format!("kill -9 -{pid} 2>/dev/null || kill -9 {pid}"),
        5000,
        &[],
        false,
    )
    .await
    .expect("kill failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 137); // 128 + SIGKILL(9)
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_rapid_multiple() {
    let h = Harness::new().await;

    let mut handles = Vec::new();
    for i in 0..5 {
        let handle = h
            .spawn_process(&format!("echo p{i}"), 5000, &[], false, false, None)
            .await
            .expect("spawn_process failed");
        handles.push(handle);
    }

    // All PIDs should be unique
    let unique: std::collections::HashSet<_> = handles
        .iter()
        .map(vsock_host::GuestProcessHandle::pid)
        .collect();
    assert_eq!(unique.len(), 5);

    // All should complete successfully with correct output
    for (i, handle) in handles.into_iter().enumerate() {
        let event = h
            .wait_spawn(handle, Duration::from_secs(5))
            .await
            .expect("spawn wait failed");
        assert_eq!(event.exit_code, 0);
        assert_eq!(event.stdout, format!("p{i}\n").as_bytes());
    }
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_nonexistent_command() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process(
            "nonexistent_command_12345 2>&1",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_ne!(event.exit_code, 0);
    let output = if event.stderr.is_empty() {
        &event.stdout
    } else {
        &event.stderr
    };
    let output_lower = String::from_utf8_lossy(output).to_lowercase();
    assert!(output_lower.contains("not found"));
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_unicode() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process(
            "printf '你好世界\\nこんにちは\\n🎉emoji🚀'",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    let stdout = String::from_utf8_lossy(&event.stdout);
    assert!(stdout.contains("你好世界"));
    assert!(stdout.contains("こんにちは"));
    assert!(stdout.contains("🎉emoji🚀"));
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_interleaved_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process(
            "echo out1 && echo err1 >&2 && echo out2 && echo err2 >&2",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.windows(4).any(|w| w == b"out1"));
    assert!(event.stdout.windows(4).any(|w| w == b"out2"));
    assert!(event.stderr.windows(4).any(|w| w == b"err1"));
    assert!(event.stderr.windows(4).any(|w| w == b"err2"));
    h.finish();
}

#[tokio::test]
async fn test_spawn_process_with_env() {
    let h = Harness::new().await;

    let handle = h
        .spawn_process(
            "echo $GREETING",
            5000,
            &[("GREETING", "hi_from_env")],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_process failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"hi_from_env\n");
    h.finish();
}
