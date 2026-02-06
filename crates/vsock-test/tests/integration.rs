use std::io;
use std::ops::{Deref, DerefMut};
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

impl DerefMut for Harness {
    fn deref_mut(&mut self) -> &mut VsockHost {
        self.host.as_mut().unwrap()
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
    let mut h = Harness::new().await;

    let result = h.exec("echo hello", 5000).await.expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    assert!(result.stderr.is_empty());
    h.finish();
}

#[tokio::test]
async fn test_exec_stderr() {
    let mut h = Harness::new().await;

    let result = h
        .exec("echo error >&2 && exit 1", 5000)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 1);
    assert_eq!(result.stderr, b"error\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_multiline() {
    let mut h = Harness::new().await;

    let result = h
        .exec("printf 'line1\\nline2\\nline3\\n'", 5000)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"line1\nline2\nline3\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_pipe_chain() {
    let mut h = Harness::new().await;

    let result = h
        .exec("echo 'hello world' | tr 'a-z' 'A-Z'", 5000)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"HELLO WORLD\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_env_vars() {
    let mut h = Harness::new().await;

    let result = h
        .exec("export TEST_VAR=hello; echo $TEST_VAR", 5000)
        .await
        .expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    h.finish();
}

#[tokio::test]
async fn test_exec_timeout() {
    let mut h = Harness::new().await;

    let result = h.exec("sleep 10", 100).await.expect("exec failed");

    assert_eq!(result.exit_code, 124);
    assert!(result.stderr.starts_with(b"Timeout"));
    h.finish();
}

#[tokio::test]
async fn test_exec_sequential() {
    let mut h = Harness::new().await;

    for i in 0..5 {
        let result = h
            .exec(&format!("echo {i}"), 5000)
            .await
            .expect("exec failed");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, format!("{i}\n").as_bytes());
    }
    h.finish();
}

// ── write_file ───────────────────────────────────────────────────────

#[tokio::test]
async fn test_write_file() {
    let mut h = Harness::new().await;

    let file_path = h.dir.join("testfile.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"hello from vsock-test";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    // Verify by reading the file back via exec
    let result = h
        .exec(&format!("cat '{file_path_str}'"), 5000)
        .await
        .expect("exec cat failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_special_characters() {
    let mut h = Harness::new().await;

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
    let mut h = Harness::new().await;

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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("echo done", 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("exit 42", 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("echo error >&2 && exit 1", 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("echo out && echo err >&2 && exit 2", 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("true", 5000)
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
    let mut h = Harness::new().await;

    // Spawn two processes — second finishes first
    let pid1 = h
        .spawn_watch("sleep 0.1 && echo first", 5000)
        .await
        .expect("spawn_watch 1 failed");
    let pid2 = h
        .spawn_watch("echo second", 5000)
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

#[tokio::test]
async fn test_spawn_watch_timeout() {
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("sleep 10", 100)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("echo cached", 5000)
        .await
        .expect("spawn_watch failed");

    // Use an exec round-trip as a synchronization barrier: by the time exec
    // returns, the exit event from "echo cached" has arrived and been cached
    // by read_and_dispatch. This tests the cache-hit path without any sleep.
    h.exec("true", 5000).await.expect("barrier exec failed");

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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("printf 'line1\\nline2\\nline3\\n'", 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch(
            "dd if=/dev/zero bs=1024 count=10 2>/dev/null | base64",
            5000,
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("sleep 0.2 && echo delayed", 5000)
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
    let mut h = Harness::new().await;

    // Use `exec` to replace shell so the PID we get is the actual sleep process
    let pid = h
        .spawn_watch("exec sleep 60", 0)
        .await
        .expect("spawn_watch failed");

    // Kill process group with SIGTERM
    h.exec(
        &format!("kill -15 -{pid} 2>/dev/null || kill -15 {pid}"),
        5000,
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("exec sleep 60", 0)
        .await
        .expect("spawn_watch failed");

    h.exec(
        &format!("kill -9 -{pid} 2>/dev/null || kill -9 {pid}"),
        5000,
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
    let mut h = Harness::new().await;

    let mut pids = Vec::new();
    for i in 0..5 {
        let pid = h
            .spawn_watch(&format!("echo p{i}"), 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("nonexistent_command_12345 2>&1", 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch("printf '你好世界\\nこんにちは\\n🎉emoji🚀'", 5000)
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
    let mut h = Harness::new().await;

    let pid = h
        .spawn_watch(
            "echo out1 && echo err1 >&2 && echo out2 && echo err2 >&2",
            5000,
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

// ── write_file (large) ──────────────────────────────────────────────

#[tokio::test]
async fn test_write_file_large() {
    let mut h = Harness::new().await;

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

// ── shutdown ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_shutdown() {
    let mut h = Harness::new().await;

    let acked = h.shutdown(Duration::from_secs(5)).await;
    assert!(acked);

    h.finish_ignore_guest();
}

#[tokio::test]
async fn test_shutdown_after_exec() {
    let mut h = Harness::new().await;

    // Run a command first, then shutdown
    let result = h.exec("echo before", 5000).await.expect("exec failed");
    assert_eq!(result.exit_code, 0);

    let acked = h.shutdown(Duration::from_secs(5)).await;
    assert!(acked);

    h.finish_ignore_guest();
}
