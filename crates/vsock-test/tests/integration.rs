#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::unreachable
)]

use std::io;
use std::ops::Deref;
use std::path::Path;
use std::sync::Once;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use vsock_host::VsockHost;

static WRITE_FILE_HELPER: Once = Once::new();
const WRITE_FILE_HELPER_BIN: &str = env!("CARGO_BIN_EXE_guest-write-file-test-helper");

fn install_write_file_helper() {
    WRITE_FILE_HELPER.call_once(|| {
        vsock_guest::set_debug_guest_write_file_path_for_tests(WRITE_FILE_HELPER_BIN.into())
            .expect("set guest-write-file test helper path");
    });
}

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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_quote_path(path: &Path) -> String {
    shell_quote(path.to_str().expect("test path must be valid UTF-8"))
}

async fn wait_for_path(path: &Path, timeout: Duration) {
    tokio::time::timeout(timeout, async {
        loop {
            if path.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for path {path:?}"));
}

#[test]
fn shell_quote_escapes_single_quotes() {
    assert_eq!(shell_quote("chunked'quote.bin"), "'chunked'\\''quote.bin'");
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
        install_write_file_helper();

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

    async fn wait_spawn(
        &self,
        handle: vsock_host::SpawnWatchHandle,
        timeout: Duration,
    ) -> io::Result<vsock_host::ProcessExitEvent> {
        tokio::time::timeout(timeout, handle.wait())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "wait timeout"))?
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
async fn test_write_file_path_with_shell_metacharacters() {
    let h = Harness::new().await;

    let file_path = h.dir.join("dash - quote ' dollar $ semi ;.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"path should be passed as an argv value";

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

#[tokio::test]
async fn test_write_file_sudo_create_does_not_create_parent_dirs() {
    let h = Harness::new().await;

    let file_path = h.dir.join("sudo/missing/parent.txt");
    let file_path_str = file_path.to_string_lossy().to_string();

    h.write_file(&file_path_str, b"content", true)
        .await
        .expect_err("sudo write_file should fail when parent is missing");

    assert!(!file_path.exists());
    h.finish();
}

#[tokio::test]
async fn test_write_file_unwritable_path_fails() {
    let h = Harness::new().await;

    let path = format!("/proc/vm0-write-file-denied-{}", std::process::id());
    h.write_file(&path, b"content", false)
        .await
        .expect_err("write_file should fail under /proc");

    h.finish();
}
// ── spawn_watch ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_spawn_watch() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("echo done", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch failed");
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
async fn test_spawn_watch_exit_code() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("exit 42", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 42);
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_stderr() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("echo error >&2 && exit 1", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 1);
    assert_eq!(event.stderr, b"error\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_both_stdout_stderr() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch(
            "echo out && echo err >&2 && exit 2",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

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
async fn test_spawn_watch_no_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("true", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch failed");

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
async fn test_spawn_watch_concurrent() {
    let h = Harness::new().await;

    // Spawn two processes — second finishes first
    let handle1 = h
        .spawn_watch("sleep 0.1 && echo first", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch 1 failed");
    let pid1 = handle1.pid();
    let handle2 = h
        .spawn_watch("echo second", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch 2 failed");
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
        .spawn_watch("exec sleep 60", 0, &[], false, false, None)
        .await
        .expect("spawn_watch failed");
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

#[tokio::test]
async fn test_spawn_watch_timeout() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("sleep 10", 100, &[], false, false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 124);
    assert!(event.stderr.starts_with(b"Timeout"));
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_exit_before_wait() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("echo completed", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch failed");

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
async fn test_spawn_watch_multiline() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch(
            "printf 'line1\\nline2\\nline3\\n'",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"line1\nline2\nline3\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_large_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch(
            "dd if=/dev/zero bs=1024 count=10 2>/dev/null | base64",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(10))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.len() > 10000);
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_delayed_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("sleep 0.2 && echo delayed", 5000, &[], false, false, None)
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"delayed\n");
    h.finish();
}

#[tokio::test]
async fn test_spawn_watch_sigterm() {
    let h = Harness::new().await;

    // Use `exec` to replace shell so the PID we get is the actual sleep process
    let handle = h
        .spawn_watch("exec sleep 60", 0, &[], false, false, None)
        .await
        .expect("spawn_watch failed");
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
async fn test_spawn_watch_sigkill() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch("exec sleep 60", 0, &[], false, false, None)
        .await
        .expect("spawn_watch failed");
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
async fn test_spawn_watch_rapid_multiple() {
    let h = Harness::new().await;

    let mut handles = Vec::new();
    for i in 0..5 {
        let handle = h
            .spawn_watch(&format!("echo p{i}"), 5000, &[], false, false, None)
            .await
            .expect("spawn_watch failed");
        handles.push(handle);
    }

    // All PIDs should be unique
    let unique: std::collections::HashSet<_> = handles
        .iter()
        .map(vsock_host::SpawnWatchHandle::pid)
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
async fn test_spawn_watch_nonexistent_command() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch(
            "nonexistent_command_12345 2>&1",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

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
async fn test_spawn_watch_unicode() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch(
            "printf '你好世界\\nこんにちは\\n🎉emoji🚀'",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

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
async fn test_spawn_watch_interleaved_output() {
    let h = Harness::new().await;

    let handle = h
        .spawn_watch(
            "echo out1 && echo err1 >&2 && echo out2 && echo err2 >&2",
            5000,
            &[],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

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

    let file_path = h.dir.join("chunked'quote.bin");
    let file_path_str = file_path.to_string_lossy().to_string();
    // 16 MB content exceeds the 15 MB chunk limit, triggering the staging +
    // shell rename path. The quote in the file name covers shell escaping.
    let content = vec![0xABu8; 16 * 1024 * 1024];

    h.write_file(&file_path_str, &content, false)
        .await
        .expect("chunked write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written.len(), content.len());
    assert_eq!(written, content);

    // Temp file should not remain
    let temp_prefix = format!("{file_path_str}.vm0tmp-");
    let temp_remains = std::fs::read_dir(file_path.parent().unwrap())
        .expect("failed to read temp dir")
        .flatten()
        .any(|entry| entry.path().to_string_lossy().starts_with(&temp_prefix));
    assert!(!temp_remains, "temp file was not cleaned up");
    h.finish();
}

#[tokio::test]
#[ignore = "local performance comparison only; no stable timing assertion"]
async fn bench_write_file_many_small_files() {
    let h = Harness::new().await;

    let start = std::time::Instant::now();
    for i in 0..100 {
        let file_path = h.dir.join(format!("bench/{i}.txt"));
        let file_path_str = file_path.to_string_lossy().to_string();
        h.write_file(&file_path_str, b"small content", false)
            .await
            .expect("write_file failed");
    }
    eprintln!("100 small write_file calls took {:?}", start.elapsed());

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

    let handle = h
        .spawn_watch(
            "echo $GREETING",
            5000,
            &[("GREETING", "hi_from_env")],
            false,
            false,
            None,
        )
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("spawn wait failed");

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

    let mut handle = h
        .spawn_watch("echo hello_stream", 5000, &[], false, true, Some(&log_path))
        .await
        .expect("spawn_watch failed");
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("wait failed");
    let mut streamed = Vec::new();
    while let Ok(data) = stdout_rx.try_recv() {
        streamed.extend_from_slice(&data);
    }

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

/// Streaming stdout must be observable before the process reaches exit.
#[tokio::test]
async fn test_spawn_watch_stdout_streaming_delivers_before_exit() {
    let h = Harness::new().await;

    let release_fifo = h.dir.join("release-streaming-process");
    let command = format!(
        "rm -f {release}; mkfifo {release}; printf 'before_exit\\n'; IFS= read -r _ < {release}",
        release = shell_quote_path(&release_fifo)
    );

    let mut handle = h
        .spawn_watch(&command, 5000, &[], false, true, None)
        .await
        .expect("spawn_watch failed");
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let chunk = tokio::time::timeout(Duration::from_secs(2), stdout_rx.recv())
        .await
        .expect("streaming stdout was not delivered before process exit")
        .expect("stdout stream closed before first chunk");
    assert_eq!(String::from_utf8_lossy(&chunk).trim(), "before_exit");

    std::fs::write(&release_fifo, b"\n").expect("release streaming process");
    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("wait failed");

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.is_empty());

    h.finish();
}

/// Streaming can be enabled without a guest-side tee file.
#[tokio::test]
async fn test_spawn_watch_stdout_stream_only() {
    let h = Harness::new().await;

    let existing_guest_log = h.dir.join("stream_only_guest.log");
    std::fs::write(&existing_guest_log, "preexisting\n").unwrap();

    let mut handle = h
        .spawn_watch("echo stream_only", 5000, &[], false, true, None)
        .await
        .expect("spawn_watch failed");
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("wait failed");
    let mut streamed = Vec::new();
    while let Ok(data) = stdout_rx.try_recv() {
        streamed.extend_from_slice(&data);
    }

    assert_eq!(event.exit_code, 0);
    assert!(event.stdout.is_empty());
    assert_eq!(String::from_utf8_lossy(&streamed).trim(), "stream_only");
    let log_content = std::fs::read_to_string(&existing_guest_log).unwrap();
    assert_eq!(log_content, "preexisting\n");

    h.finish();
}

/// Streaming with multiple chunks (large output).
#[tokio::test]
async fn test_spawn_watch_stdout_streaming_large() {
    let h = Harness::new().await;

    let log_file = h.dir.join("stream_large.log");
    let log_path = log_file.to_string_lossy().to_string();

    // Generate ~20KB of output (well over the 8KB chunk size)
    let mut handle = h
        .spawn_watch(
            "dd if=/dev/zero bs=1024 count=20 2>/dev/null | base64",
            5000,
            &[],
            false,
            true,
            Some(&log_path),
        )
        .await
        .expect("spawn_watch failed");
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let event = h
        .wait_spawn(handle, Duration::from_secs(10))
        .await
        .expect("wait failed");
    let mut streamed = Vec::new();
    while let Ok(data) = stdout_rx.try_recv() {
        streamed.extend_from_slice(&data);
    }

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
    let handle = h
        .spawn_watch("env", 5000, &[], false, true, Some(&log_path))
        .await
        .expect("spawn_watch failed");

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
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
    let mut handle = h
        .spawn_watch(
            "while true; do echo tick; sleep 0.01; done",
            100,
            &[],
            false,
            true,
            Some(&log_path),
        )
        .await
        .expect("spawn_watch failed");
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let event = h
        .wait_spawn(handle, Duration::from_secs(5))
        .await
        .expect("wait failed");
    let mut streamed = Vec::new();
    while let Ok(data) = stdout_rx.try_recv() {
        streamed.extend_from_slice(&data);
    }

    assert_eq!(event.exit_code, 124); // timeout exit code
    // Should have received some streamed output before the kill
    assert!(
        !streamed.is_empty(),
        "expected some streamed output before timeout"
    );

    h.finish();
}
