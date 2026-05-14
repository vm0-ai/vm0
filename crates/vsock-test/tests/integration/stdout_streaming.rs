use std::time::Duration;

use crate::support::{Harness, shell_quote_path};

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
