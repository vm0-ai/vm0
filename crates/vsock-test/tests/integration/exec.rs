use std::time::Duration;

use crate::support::{Harness, shell_quote_path, wait_for_path};

// ── exec ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_exec() {
    let h = Harness::new().await;

    let result = h
        .exec("echo hello", 5000, &[], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    assert!(result.stderr.is_empty());
    h.finish();
}

#[tokio::test]
async fn test_exec_stderr() {
    let h = Harness::new().await;

    let result = h
        .exec("echo error >&2 && exit 1", 5000, &[], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 1);
    assert_eq!(result.stderr, b"error\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_multiline() {
    let h = Harness::new().await;

    let result = h
        .exec("printf 'line1\\nline2\\nline3\\n'", 5000, &[], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"line1\nline2\nline3\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_pipe_chain() {
    let h = Harness::new().await;

    let result = h
        .exec("echo 'hello world' | tr 'a-z' 'A-Z'", 5000, &[], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"HELLO WORLD\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_env_vars() {
    let h = Harness::new().await;

    let result = h
        .exec("export TEST_VAR=hello; echo $TEST_VAR", 5000, &[], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_timeout() {
    let h = Harness::new().await;

    let result = h
        .exec("sleep 10", 100, &[], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 124);
    assert!(result.stderr.starts_with(b"Timeout"));
    h.finish();
}

#[tokio::test]
async fn test_exec_sequential() {
    let h = Harness::new().await;

    for i in 0..5 {
        let result = h
            .exec(&format!("echo {i}"), 5000, &[], false)
            .await
            .expect("exec failed");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, format!("{i}\n").as_bytes());
    }
    h.finish();
}

#[tokio::test]
async fn test_exec_sudo() {
    let h = Harness::new().await;

    // In debug mode, sudo=true uses `sudo sh -c`, which may fail if sudo is
    // not installed. We only verify the flag is correctly sent through the
    // protocol and the guest attempts the right code path (non-panic, returns
    // a result). In release/production the process runs as root so sudo=true
    // just uses `sh -c` directly.
    let result = h
        .exec("whoami", 5000, &[], true)
        .await
        .expect("exec sudo failed");
    // Don't assert exit_code — depends on whether sudo is available
    let _ = result;
    h.finish();
}

/// Core concurrency test: exec works while spawn wait is pending.
///
/// This is the exact production scenario that motivated the VsockHost refactor —
/// runner waits for spawn exit (blocks for hours) and a separate task needs to
/// exec into the same VM.
#[tokio::test]
async fn test_exec_while_waiting_for_exit() {
    let h = Harness::new().await;

    // Spawn a long-running process. Use `exec` to replace the shell so the
    // PID we get is the actual sleep process (same pattern as sigterm/sigkill tests).
    let handle = h
        .spawn_process("exec sleep 60", 0, &[], false, false, None)
        .await
        .expect("spawn_process failed");
    let pid = handle.pid();

    // Run spawn wait and exec concurrently on the same task via join!.
    // The exec branch runs a command and then kills the long-running process,
    // which unblocks spawn wait.
    let (wait_result, _) = tokio::join!(h.wait_spawn(handle, Duration::from_secs(10)), async {
        // This exec must NOT block on the pending spawn wait.
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            h.exec("echo alive", 5000, &[], false),
        )
        .await
        .expect("exec timed out — spawn wait is blocking")
        .expect("exec failed");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, b"alive\n");

        // Kill the process group so spawn wait resolves.
        h.exec(
            &format!("kill -15 -{pid} 2>/dev/null || kill -15 {pid}"),
            5000,
            &[],
            false,
        )
        .await
        .expect("kill failed");
    });

    let event = wait_result.expect("spawn wait failed");
    assert_eq!(event.pid, pid);
    assert_ne!(event.exit_code, 0); // killed

    h.finish();
}

/// Core regression test: a slow exec must not block a subsequent fast exec.
///
/// Before the command operation path moved work off the guest event loop, a
/// `sleep 5` could prevent any other exec from being processed until it finished.
#[tokio::test]
async fn test_concurrent_exec_not_blocked() {
    let h = Harness::new().await;
    let ready_marker = h.dir.join("slow-exec-ready");
    let slow_command = format!(
        "rm -f {ready} && touch {ready} && sleep 5",
        ready = shell_quote_path(&ready_marker)
    );

    // Launch a slow exec and wait until its guest-side shell has started
    // before submitting the fast exec.
    let slow = h.exec(&slow_command, 10000, &[], false);
    let (fast_done_tx, fast_done_rx) = tokio::sync::oneshot::channel();
    let fast = async {
        wait_for_path(&ready_marker, Duration::from_secs(3)).await;
        let result =
            tokio::time::timeout(Duration::from_secs(3), h.exec("echo ok", 5000, &[], false))
                .await
                .expect("fast exec timed out — slow exec is blocking the event loop")
                .expect("fast exec failed");
        let _ = fast_done_tx.send(());
        result
    };

    let (_, fast_result) = tokio::join!(
        // We don't care about slow's result — cancel the future once the fast
        // exec proves the guest event loop is not blocked.
        async {
            tokio::select! {
                r = slow => Some(r),
                _ = fast_done_rx => None,
            }
        },
        fast
    );

    assert_eq!(fast_result.exit_code, 0);
    assert_eq!(fast_result.stdout, b"ok\n");

    h.finish_ignore_guest();
}

// ── exec with env ────────────────────────────────────────────────────

#[tokio::test]
async fn test_exec_with_env() {
    let h = Harness::new().await;

    let result = h
        .exec("echo $MY_VAR", 5000, &[("MY_VAR", "hello_env")], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello_env\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_with_multiple_env() {
    let h = Harness::new().await;

    let result = h
        .exec(
            "echo $A $B",
            5000,
            &[("A", "first"), ("B", "second")],
            false,
        )
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"first second\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_with_env_special_chars() {
    let h = Harness::new().await;

    let result = h
        .exec("echo $VAL", 5000, &[("VAL", "it's a \"test\"")], false)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"it's a \"test\"\n");
    h.finish();
}
