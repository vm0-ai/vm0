#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::unreachable
)]

use std::io;
use std::ops::Deref;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use vsock_host::VsockHost;

/// Spawn a guest agent in a background OS thread that connects to the given socket path.
///
/// Retries connection up to 50 times with 10ms delay to handle the race between
/// host listener bind and guest connect.
fn start_guest(socket_path: &str) -> JoinHandle<io::Result<()>> {
    let path = socket_path.to_owned();
    thread::spawn(move || {
        let stream = retry_connect(&path)?;
        vsock_guest::handle_connection(stream)
    })
}

fn retry_connect(path: &str) -> io::Result<std::os::unix::net::UnixStream> {
    for i in 0..50 {
        match vsock_guest::connect_unix(path) {
            Ok(stream) => return Ok(stream),
            Err(e) if i < 49 => {
                let _ = e;
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// Test harness: creates temp dir, starts guest thread, connects host.
///
/// Implements `Drop` to clean up temp dirs and join guest threads even on panic.
struct Harness {
    dir: std::path::PathBuf,
    host: Option<VsockHost>,
    guest: Option<JoinHandle<io::Result<()>>>,
}

impl Harness {
    async fn new() -> Self {
        let dir = std::env::temp_dir()
            .join(format!("vsock-test-{}", std::process::id()))
            .join(format!("{:?}", std::thread::current().id()));
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        let base_path = dir.join("vsock").to_string_lossy().to_string();
        let listener_path = format!("{base_path}_1000");

        let guest = start_guest(&listener_path);
        let host = VsockHost::wait_for_connection(&base_path, Duration::from_secs(5))
            .await
            .expect("host connection failed");

        Self {
            dir,
            host: Some(host),
            guest: Some(guest),
        }
    }

    fn finish(mut self) {
        drop(self.host.take());
        if let Some(g) = self.guest.take() {
            g.join()
                .expect("guest thread panicked")
                .expect("guest returned error");
        }
    }

    /// Finish without asserting guest result (for shutdown tests where guest exits differently)
    fn finish_ignore_guest(mut self) {
        drop(self.host.take());
        if let Some(g) = self.guest.take() {
            let _ = g.join();
        }
    }
}

impl Deref for Harness {
    type Target = VsockHost;
    fn deref(&self) -> &VsockHost {
        self.host.as_ref().unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        // Drop host first to close the connection, then join guest thread.
        drop(self.host.take());
        if let Some(g) = self.guest.take() {
            let _ = g.join();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

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

// ── write_file ───────────────────────────────────────────────────────

#[tokio::test]
async fn test_write_file() {
    let h = Harness::new().await;

    let file_path = h.dir.join("testfile.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"hello from vsock-test";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    // Verify by reading the file back via exec
    let result = h
        .exec(&format!("cat '{file_path_str}'"), 5000, &[], false)
        .await
        .expect("exec cat failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_special_characters() {
    let h = Harness::new().await;

    let file_path = h.dir.join("special.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"Line1\nLine2\tTabbed\n\"Quoted\"";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_creates_parent_dirs() {
    let h = Harness::new().await;

    let file_path = h.dir.join("a/b/c/nested.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"nested content";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

// ── spawn_watch ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_spawn_watch() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("echo done", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");
    assert!(pid > 0);

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"done\n");
    assert!(event.stderr.is_empty());
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_exit_code() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("exit 42", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 42);
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_stderr() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("echo error >&2 && exit 1", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 1);
    assert_eq!(event.stderr, b"error\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_both_stdout_stderr() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("echo out && echo err >&2 && exit 2", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 2);
    assert_eq!(event.stdout, b"out\n");
    assert_eq!(event.stderr, b"err\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_no_output() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("true", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.is_empty());
    assert!(event.stderr.is_empty());
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_concurrent() {
    let h = Harness::new().await;

    // Spawn two processes — second finishes first
    let (pid1, _rx1) = h
        .spawn_watch("sleep 0.1 && echo first", 5000, &[], false, None)
        .await
        .expect("spawn_watch 1 failed");
    let (pid2, _rx2) = h
        .spawn_watch("echo second", 5000, &[], false, None)
        .await
        .expect("spawn_watch 2 failed");

    assert_ne!(pid1, pid2);

    // Wait in reverse order to exercise cached exit events
    let event2 = h
        .wait_for_exit(pid2, Duration::from_secs(5))
        .await
        .expect("wait_for_exit 2 failed");
    let event1 = h
        .wait_for_exit(pid1, Duration::from_secs(5))
        .await
        .expect("wait_for_exit 1 failed");

    assert_eq!(event1.exit_code, 0);
    assert_eq!(event1.stdout, b"first\n");
    assert_eq!(event2.exit_code, 0);
    assert_eq!(event2.stdout, b"second\n");
    h.finish();
}

/// Core concurrency test: exec works while wait_for_exit is pending.
///
/// This is the exact production scenario that motivated the VsockHost refactor —
/// runner calls wait_for_exit (blocks for hours) and a separate task needs to
/// exec into the same VM.
#[tokio::test]
async fn test_exec_while_waiting_for_exit() {
    let h = Harness::new().await;

    // Spawn a long-running process. Use `exec` to replace the shell so the
    // PID we get is the actual sleep process (same pattern as sigterm/sigkill tests).
    let (pid, _stdout_rx) = h
        .spawn_watch("exec sleep 60", 0, &[], false, None)
        .await
        .expect("spawn_watch failed");

    // Run wait_for_exit and exec concurrently on the same task via join!.
    // The exec branch runs a command and then kills the long-running process,
    // which unblocks wait_for_exit.
    let (wait_result, _) = tokio::join!(h.wait_for_exit(pid, Duration::from_secs(10)), async {
        // This exec must NOT block on the pending wait_for_exit.
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            h.exec("echo alive", 5000, &[], false),
        )
        .await
        .expect("exec timed out — wait_for_exit is blocking")
        .expect("exec failed");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, b"alive\n");

        // Kill the process group so wait_for_exit resolves.
        h.exec(
            &format!("kill -15 -{pid} 2>/dev/null || kill -15 {pid}"),
            5000,
            &[],
            false,
        )
        .await
        .expect("kill failed");
    });

    let event = wait_result.expect("wait_for_exit failed");
    assert_eq!(event.pid, pid);
    assert_ne!(event.exit_code, 0); // killed

    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_timeout() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("sleep 10", 100, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 124);
    assert!(event.stderr.starts_with(b"Timeout"));
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_cached_exit() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("echo cached", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    // Use an exec round-trip as a synchronization barrier: by the time exec
    // returns, the exit event from "echo cached" has arrived and been cached
    // by read_and_dispatch. This tests the cache-hit path without any sleep.
    h.exec("true", 5000, &[], false)
        .await
        .expect("barrier exec failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"cached\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_multiline() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("printf 'line1\\nline2\\nline3\\n'", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"line1\nline2\nline3\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_large_output() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch(
            "dd if=/dev/zero bs=1024 count=10 2>/dev/null | base64",
            5000,
            &[],
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(10))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.len() > 10000);
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_delayed_output() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("sleep 0.2 && echo delayed", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"delayed\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_sigterm() {
    let h = Harness::new().await;

    // Use `exec` to replace shell so the PID we get is the actual sleep process
    let (pid, _stdout_rx) = h
        .spawn_watch("exec sleep 60", 0, &[], false, None)
        .await
        .expect("spawn_watch failed");

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
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 143); // 128 + SIGTERM(15)
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_sigkill() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("exec sleep 60", 0, &[], false, None)
        .await
        .expect("spawn_watch failed");

    h.exec(
        &format!("kill -9 -{pid} 2>/dev/null || kill -9 {pid}"),
        5000,
        &[],
        false,
    )
    .await
    .expect("kill failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 137); // 128 + SIGKILL(9)
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_rapid_multiple() {
    let h = Harness::new().await;

    let mut pids = Vec::new();
    for i in 0..5 {
        let (pid, _rx) = h
            .spawn_watch(&format!("echo p{i}"), 5000, &[], false, None)
            .await
            .expect("spawn_watch failed");
        pids.push(pid);
    }

    // All PIDs should be unique
    let unique: std::collections::HashSet<_> = pids.iter().collect();
    assert_eq!(unique.len(), 5);

    // All should complete successfully with correct output
    for (i, &pid) in pids.iter().enumerate() {
        let event = h
            .wait_for_exit(pid, Duration::from_secs(5))
            .await
            .expect("wait_for_exit failed");
        assert_eq!(event.exit_code, 0);
        assert_eq!(event.stdout, format!("p{i}\n").as_bytes());
    }
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_nonexistent_command() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch("nonexistent_command_12345 2>&1", 5000, &[], false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

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
async fn test_spawn_watch_unicode() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch(
            "printf '你好世界\\nこんにちは\\n🎉emoji🚀'",
            5000,
            &[],
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    let stdout = String::from_utf8_lossy(&event.stdout);
    assert!(stdout.contains("你好世界"));
    assert!(stdout.contains("こんにちは"));
    assert!(stdout.contains("🎉emoji🚀"));
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_interleaved_output() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch(
            "echo out1 && echo err1 >&2 && echo out2 && echo err2 >&2",
            5000,
            &[],
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.windows(4).any(|w| w == b"out1"));
    assert!(event.stdout.windows(4).any(|w| w == b"out2"));
    assert!(event.stderr.windows(4).any(|w| w == b"err1"));
    assert!(event.stderr.windows(4).any(|w| w == b"err2"));
    h.finish();
}

/// Core regression test: a slow exec must not block a subsequent fast exec.
///
/// Before the fix, MSG_EXEC blocked the guest event loop synchronously, so a
/// `sleep 5` would prevent any other exec from being processed until it finished.
#[tokio::test]
async fn test_concurrent_exec_not_blocked() {
    let h = Harness::new().await;

    // Launch a slow exec (sleep 5) and a fast exec (echo ok) concurrently.
    // The fast one should complete within seconds despite the slow one running.
    let slow = h.exec("sleep 5", 10000, &[], false);
    let fast = async {
        // Small delay to ensure slow exec is dispatched first
        tokio::time::sleep(Duration::from_millis(100)).await;
        tokio::time::timeout(Duration::from_secs(3), h.exec("echo ok", 5000, &[], false))
            .await
            .expect("fast exec timed out — slow exec is blocking the event loop")
            .expect("fast exec failed")
    };

    let (_, fast_result) = tokio::join!(
        // We don't care about slow's result — just cancel it after fast completes
        async {
            tokio::select! {
                r = slow => Some(r),
                _ = tokio::time::sleep(Duration::from_secs(5)) => None,
            }
        },
        fast
    );

    assert_eq!(fast_result.exit_code, 0);
    assert_eq!(fast_result.stdout, b"ok\n");

    h.finish_ignore_guest();
}

// ── write_file (large) ──────────────────────────────────────────────

#[tokio::test]
async fn test_write_file_large() {
    let h = Harness::new().await;

    let file_path = h.dir.join("large.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    // 100KB content
    let content = vec![b'x'; 100_000];

    h.write_file(&file_path_str, &content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written.len(), 100_000);
    assert_eq!(written, content);
    h.finish();
}

// ── write_file (chunked — exceeds single-message limit) ────────────

#[tokio::test]
async fn test_write_file_chunked() {
    let h = Harness::new().await;

    let file_path = h.dir.join("chunked.bin");
    let file_path_str = file_path.to_string_lossy().to_string();
    // 16 MB content — exceeds the 15 MB chunk limit, triggers 2-chunk path + atomic rename
    let content = vec![0xABu8; 16 * 1024 * 1024];

    h.write_file(&file_path_str, &content, false)
        .await
        .expect("chunked write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written.len(), content.len());
    assert_eq!(written, content);

    // Temp file should not remain
    assert!(
        !std::path::Path::new(&format!("{file_path_str}.vm0tmp")).exists(),
        "temp file was not cleaned up"
    );
    h.finish();
}

// ── shutdown ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_shutdown() {
    let h = Harness::new().await;

    let acked = h.shutdown(Duration::from_secs(5)).await;
    assert!(acked);

    h.finish_ignore_guest();
}

#[tokio::test]
async fn test_shutdown_after_exec() {
    let h = Harness::new().await;

    // Run a command first, then shutdown
    let result = h
        .exec("echo before", 5000, &[], false)
        .await
        .expect("exec failed");
    assert_eq!(result.exit_code, 0);

    let acked = h.shutdown(Duration::from_secs(5)).await;
    assert!(acked);

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

#[tokio::test]
async fn test_spawn_watch_with_env() {
    let h = Harness::new().await;

    let (pid, _stdout_rx) = h
        .spawn_watch(
            "echo $GREETING",
            5000,
            &[("GREETING", "hi_from_env")],
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"hi_from_env\n");
    h.finish();
}

// ── stdout streaming ─────────────────────────────────────────────────

/// When stdout_log_path is set, stdout is streamed via MSG_STDOUT_CHUNK
/// and teed to the specified file. process_exit.stdout should be empty.
#[tokio::test]
async fn test_spawn_watch_stdout_streaming() {
    let h = Harness::new().await;

    let log_file = h.dir.join("stream.log");
    let log_path = log_file.to_string_lossy().to_string();

    let (pid, mut stdout_rx) = h
        .spawn_watch("echo hello_stream", 5000, &[], false, Some(&log_path))
        .await
        .expect("spawn_watch failed");

    // Collect streamed chunks
    let mut streamed = Vec::new();
    let event = loop {
        tokio::select! {
            biased;
            chunk = stdout_rx.recv() => {
                match chunk {
                    Some(data) => streamed.extend_from_slice(&data),
                    None => break h.wait_for_exit(pid, Duration::from_secs(5)).await.expect("wait failed"),
                }
            }
            event = h.wait_for_exit(pid, Duration::from_secs(5)) => {
                // Drain any remaining chunks
                while let Ok(data) = stdout_rx.try_recv() {
                    streamed.extend_from_slice(&data);
                }
                break event.expect("wait failed");
            }
        }
    };

    assert_eq!(event.exit_code, 0);
    // In streaming mode, stdout is delivered via chunks, not process_exit.
    assert!(event.stdout.is_empty());

    // Streamed data should contain the output
    assert_eq!(String::from_utf8_lossy(&streamed).trim(), "hello_stream");

    // VM-side log file should also have the output
    let log_content = std::fs::read_to_string(&log_file).expect("read log file");
    assert_eq!(log_content.trim(), "hello_stream");

    h.finish();
}

/// Streaming with multiple chunks (large output).
#[tokio::test]
async fn test_spawn_watch_stdout_streaming_large() {
    let h = Harness::new().await;

    let log_file = h.dir.join("stream_large.log");
    let log_path = log_file.to_string_lossy().to_string();

    // Generate ~20KB of output (well over the 8KB chunk size)
    let (pid, mut stdout_rx) = h
        .spawn_watch(
            "dd if=/dev/zero bs=1024 count=20 2>/dev/null | base64",
            5000,
            &[],
            false,
            Some(&log_path),
        )
        .await
        .expect("spawn_watch failed");

    let mut streamed = Vec::new();
    let event = loop {
        tokio::select! {
            biased;
            chunk = stdout_rx.recv() => {
                match chunk {
                    Some(data) => streamed.extend_from_slice(&data),
                    None => break h.wait_for_exit(pid, Duration::from_secs(10)).await.expect("wait failed"),
                }
            }
            event = h.wait_for_exit(pid, Duration::from_secs(10)) => {
                while let Ok(data) = stdout_rx.try_recv() {
                    streamed.extend_from_slice(&data);
                }
                break event.expect("wait failed");
            }
        }
    };

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.is_empty());
    // base64 of 20KB = ~27KB output, should span multiple chunks
    assert!(
        streamed.len() > 10000,
        "expected >10KB, got {}",
        streamed.len()
    );

    // VM-side log should match streamed data
    let log_content = std::fs::read(&log_file).expect("read log file");
    assert_eq!(log_content, streamed);

    h.finish();
}

/// stdout_log_path does not leak into child environment.
#[tokio::test]
async fn test_spawn_watch_stdout_log_path_not_in_env() {
    let h = Harness::new().await;

    let log_file = h.dir.join("no_leak.log");
    let log_path = log_file.to_string_lossy().to_string();

    // The child prints its own env — stdout_log_path is a protocol parameter,
    // not an env var, so it should never appear in the child's environment.
    let (pid, _stdout_rx) = h
        .spawn_watch("env", 5000, &[], false, Some(&log_path))
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait failed");

    assert_eq!(event.exit_code, 0);
    let log_content = std::fs::read_to_string(&log_file).expect("read log file");
    assert!(
        !log_content.contains(&log_path),
        "stdout_log_path should not appear in child env"
    );

    h.finish();
}

/// Timeout must fire even while stdout is being streamed.
/// Without the fix, the timeout killer thread was only spawned after the stdout
/// loop finished, so a process producing output past the deadline would hang.
#[tokio::test]
async fn test_spawn_watch_stdout_streaming_timeout() {
    let h = Harness::new().await;

    let log_file = h.dir.join("stream_timeout.log");
    let log_path = log_file.to_string_lossy().to_string();

    // Process that produces output forever — must be killed by the 100ms timeout.
    let (pid, mut stdout_rx) = h
        .spawn_watch(
            "while true; do echo tick; sleep 0.01; done",
            100,
            &[],
            false,
            Some(&log_path),
        )
        .await
        .expect("spawn_watch failed");

    // Drain streamed chunks until process exits
    let mut streamed = Vec::new();
    let event = loop {
        tokio::select! {
            biased;
            chunk = stdout_rx.recv() => {
                match chunk {
                    Some(data) => streamed.extend_from_slice(&data),
                    None => break h.wait_for_exit(pid, Duration::from_secs(5)).await.expect("wait failed"),
                }
            }
            event = h.wait_for_exit(pid, Duration::from_secs(5)) => {
                while let Ok(data) = stdout_rx.try_recv() {
                    streamed.extend_from_slice(&data);
                }
                break event.expect("wait failed");
            }
        }
    };

    assert_eq!(event.exit_code, 124); // timeout exit code
    // Should have received some streamed output before the kill
    assert!(
        !streamed.is_empty(),
        "expected some streamed output before timeout"
    );

    h.finish();
}
