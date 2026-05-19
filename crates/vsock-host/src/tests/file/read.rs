use std::io;
use std::sync::Arc;

use vsock_proto::{ExecCapturedOutput, ExecTermination};

use super::super::support::{
    assert_connection_accepts_exec_operation, operation_count, send_exec_result,
    send_raw_exec_result, setup_host_and_guest,
};
use super::support::expect_exec_start;

#[tokio::test]
async fn read_file_returns_content_and_missing() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let read_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.read_file("/tmp/session.txt", 1024, 5000).await })
    };
    let start = expect_exec_start(&mut guest).await;
    assert_eq!(start.label, "read-file");
    assert!(start.command.contains("cat -- '/tmp/session.txt'"));
    assert_eq!(start.expected_exit_codes, vec![66]);
    send_exec_result(
        &mut guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"session-id\n",
        b"",
    )
    .await;
    let content = read_task.await.unwrap().unwrap();
    assert_eq!(content.as_deref(), Some(&b"session-id\n"[..]));

    let missing_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.read_file("/tmp/missing.txt", 1024, 5000).await })
    };
    let start = expect_exec_start(&mut guest).await;
    assert_eq!(start.expected_exit_codes, vec![66]);
    send_exec_result(
        &mut guest,
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
async fn read_file_errors_on_truncated_stdout() {
    let (host, mut guest) = setup_host_and_guest().await;
    let read_task = tokio::spawn(async move { host.read_file("/tmp/large.txt", 5, 5000).await });

    let start = expect_exec_start(&mut guest).await;
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
    send_raw_exec_result(&mut guest, start.seq(), payload).await;

    let err = read_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("exceeded 5 bytes"));
}

#[tokio::test]
async fn read_file_rejects_invalid_max_bytes_without_sending_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = host.read_file("/tmp/empty.txt", 0, 5000).await.unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    let err = host
        .read_file("/tmp/huge.txt", u64::from(u32::MAX) + 1, 5000)
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn read_file_quotes_guest_path_with_single_quote() {
    let (host, mut guest) = setup_host_and_guest().await;
    let read_task =
        tokio::spawn(async move { host.read_file("/tmp/session'one.txt", 1024, 5000).await });

    let start = expect_exec_start(&mut guest).await;
    assert_eq!(
        start.command,
        "if test -f '/tmp/session'\\''one.txt'; then cat -- '/tmp/session'\\''one.txt'; else exit 66; fi"
    );
    send_exec_result(
        &mut guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;

    let content = read_task.await.unwrap().unwrap();
    assert_eq!(content.as_deref(), Some(&b"ok"[..]));
}
