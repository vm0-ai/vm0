use std::io;
use std::sync::Arc;

use tokio::net::UnixStream;
use tokio::task::JoinHandle;
use vsock_proto::{ExecCapturedOutput, ExecOutputPolicy, ExecTermination};

use super::super::support::{
    assert_connection_accepts_exec_operation, operation_count, send_exec_result,
    send_raw_exec_result, setup_host_and_guest,
};
use super::support::{ExecStartFrame, expect_exec_start};
use crate::{VsockHost, exec_operation};

struct ReadFileFixture {
    host: Arc<VsockHost>,
    guest: UnixStream,
}

impl ReadFileFixture {
    async fn new() -> Self {
        let (host, guest) = setup_host_and_guest().await;
        Self {
            host: Arc::new(host),
            guest,
        }
    }

    fn spawn_read(
        &self,
        path: &'static str,
        max_bytes: u64,
        timeout_ms: u32,
    ) -> JoinHandle<io::Result<Option<Vec<u8>>>> {
        let host = Arc::clone(&self.host);
        tokio::spawn(async move { host.read_file(path, max_bytes, timeout_ms).await })
    }

    async fn expect_read_start(&mut self, max_bytes: u32) -> ExecStartFrame {
        let start = expect_exec_start(&mut self.guest).await;
        assert_eq!(start.label, "read-file");
        assert!(!start.sudo);
        assert_eq!(start.expected_exit_codes, vec![66]);
        assert_eq!(
            start.stdout,
            ExecOutputPolicy::Capture {
                limit_bytes: max_bytes,
            }
        );
        assert_eq!(
            start.stderr,
            ExecOutputPolicy::Capture {
                limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
            }
        );
        start
    }

    async fn send_result(
        &mut self,
        seq: u32,
        termination: ExecTermination,
        stdout: &[u8],
        stderr: &[u8],
    ) {
        send_exec_result(&mut self.guest, seq, termination, stdout, stderr).await;
    }

    async fn send_raw_result(&mut self, seq: u32, payload: Vec<u8>) {
        send_raw_exec_result(&mut self.guest, seq, payload).await;
    }
}

async fn read_file_terminal_error(
    termination: ExecTermination,
    stderr: &'static [u8],
    diagnostic: &'static str,
) -> io::Error {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/session.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    let payload = vsock_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        },
        diagnostic,
    )
    .unwrap();
    fixture.send_raw_result(start.seq(), payload).await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(operation_count(&fixture.host), 0);
    err
}

#[tokio::test]
async fn read_file_returns_content_and_missing() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/session.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    assert!(
        start
            .command
            .contains("cat 2>/dev/null < '/tmp/session.txt'")
    );
    fixture
        .send_result(
            start.seq(),
            ExecTermination::Exited { exit_code: 0 },
            b"session-id\n",
            b"",
        )
        .await;
    let content = read_task.await.unwrap().unwrap();
    assert_eq!(content.as_deref(), Some(&b"session-id\n"[..]));

    let missing_task = fixture.spawn_read("/tmp/missing.txt", 1024, 5000);
    let start = fixture.expect_read_start(1024).await;
    fixture
        .send_result(
            start.seq(),
            ExecTermination::Exited { exit_code: 66 },
            b"",
            b"",
        )
        .await;
    let missing = missing_task.await.unwrap().unwrap();
    assert_eq!(missing, None);
}

#[tokio::test]
async fn read_file_dispatches_concurrent_results_by_seq() {
    let mut fixture = ReadFileFixture::new().await;

    let first_task = fixture.spawn_read("/tmp/first.txt", 1024, 5000);
    let first = fixture.expect_read_start(1024).await;

    let second_task = fixture.spawn_read("/tmp/second.txt", 1024, 5000);
    let second = fixture.expect_read_start(1024).await;

    fixture
        .send_result(
            second.seq(),
            ExecTermination::Exited { exit_code: 0 },
            b"second\n",
            b"",
        )
        .await;
    fixture
        .send_result(
            first.seq(),
            ExecTermination::Exited { exit_code: 0 },
            b"first\n",
            b"",
        )
        .await;

    let first_content = first_task.await.unwrap().unwrap();
    let second_content = second_task.await.unwrap().unwrap();
    assert_eq!(first_content.as_deref(), Some(&b"first\n"[..]));
    assert_eq!(second_content.as_deref(), Some(&b"second\n"[..]));
    assert_eq!(operation_count(&fixture.host), 0);
}

#[tokio::test]
async fn read_file_errors_on_truncated_stdout() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/large.txt", 5, 5000);

    let start = fixture.expect_read_start(5).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        12,
        ExecCapturedOutput::Captured {
            bytes: b"hello",
            truncated: true,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        "",
    )
    .unwrap();
    fixture.send_raw_result(start.seq(), payload).await;

    let err = read_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("exceeded 5 bytes"));
}

#[tokio::test]
async fn read_file_rejects_success_result_with_stderr() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/session.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    fixture
        .send_result(
            start.seq(),
            ExecTermination::Exited { exit_code: 0 },
            b"session-id\n",
            b"unexpected stderr",
        )
        .await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("included stderr"));
}

#[tokio::test]
async fn read_file_rejects_success_result_with_truncated_stderr() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/session.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        12,
        ExecCapturedOutput::Captured {
            bytes: b"session-id\n",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        "",
    )
    .unwrap();
    fixture.send_raw_result(start.seq(), payload).await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("stderr truncated"));
}

#[tokio::test]
async fn read_file_rejects_missing_result_with_output() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/missing.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    fixture
        .send_result(
            start.seq(),
            ExecTermination::Exited { exit_code: 66 },
            b"unexpected",
            b"",
        )
        .await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("included stdout"));
}

#[tokio::test]
async fn read_file_rejects_missing_result_with_truncated_stdout() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/missing.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 66 },
        12,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        "",
    )
    .unwrap();
    fixture.send_raw_result(start.seq(), payload).await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("stdout truncated"));
}

#[tokio::test]
async fn read_file_rejects_missing_result_with_stderr() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/missing.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    fixture
        .send_result(
            start.seq(),
            ExecTermination::Exited { exit_code: 66 },
            b"",
            b"unexpected stderr",
        )
        .await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("included stderr"));
}

#[tokio::test]
async fn read_file_rejects_missing_result_with_truncated_stderr() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/missing.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 66 },
        12,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        "",
    )
    .unwrap();
    fixture.send_raw_result(start.seq(), payload).await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("stderr truncated"));
}

#[tokio::test]
async fn read_file_preserves_truncated_stderr_on_nonzero_exit() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/unreadable.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 1 },
        12,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        "",
    )
    .unwrap();
    fixture.send_raw_result(start.seq(), payload).await;

    let err = read_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert!(err.to_string().contains("stderr truncated"));
}

#[tokio::test]
async fn read_file_reports_terminal_timeout_as_timed_out() {
    let err = read_file_terminal_error(
        ExecTermination::TimedOut,
        b"helper timed out",
        "guest reported timeout",
    )
    .await;

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    let message = err.to_string();
    assert!(message.contains("read_file timed out for /tmp/session.txt"));
    assert!(message.contains("helper timed out"));
    assert!(message.contains("guest reported timeout"));
}

#[tokio::test]
async fn read_file_reports_non_exit_terminal_states() {
    for (termination, expected, diagnostic) in [
        (
            ExecTermination::Cancelled,
            "read_file was cancelled for /tmp/session.txt",
            "cancelled by guest",
        ),
        (
            ExecTermination::StartFailed,
            "read_file exec start failed for /tmp/session.txt",
            "spawn failed",
        ),
        (
            ExecTermination::WaitFailed,
            "read_file exec wait failed for /tmp/session.txt",
            "wait failed",
        ),
    ] {
        let err = read_file_terminal_error(termination, b"helper stderr", diagnostic).await;

        assert_eq!(err.kind(), io::ErrorKind::Other);
        let message = err.to_string();
        assert!(message.contains(expected));
        assert!(message.contains("helper stderr"));
        assert!(message.contains(diagnostic));
    }
}

#[tokio::test]
async fn read_file_rejects_invalid_inputs_without_sending_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = host.read_file("", 1024, 5000).await.unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    let err = host
        .read_file("/tmp/bad\0path.txt", 1024, 5000)
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    let err = host.read_file("/tmp/empty.txt", 0, 5000).await.unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    let err = host
        .read_file("/tmp/huge.txt", u64::from(u32::MAX) + 1, 5000)
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    let err = host
        .read_file("/tmp/timeout.txt", 1024, 0)
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn read_file_quotes_guest_path_with_single_quote() {
    let mut fixture = ReadFileFixture::new().await;
    let read_task = fixture.spawn_read("/tmp/session'one.txt", 1024, 5000);

    let start = fixture.expect_read_start(1024).await;
    assert_eq!(
        start.command,
        "if test -f '/tmp/session'\\''one.txt'; then cat 2>/dev/null < '/tmp/session'\\''one.txt' || { test -f '/tmp/session'\\''one.txt' || exit 66; printf '%s\\n' 'failed to read file' >&2; exit 1; }; else exit 66; fi"
    );
    fixture
        .send_result(
            start.seq(),
            ExecTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;

    let content = read_task.await.unwrap().unwrap();
    assert_eq!(content.as_deref(), Some(&b"ok"[..]));
}
