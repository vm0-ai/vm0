use std::io;
use std::sync::Arc;
use std::time::Duration;

use vsock_proto::{
    ExecControlPolicy, ExecLifecyclePolicy, ExecOutputStream, ExecTermination, ExecTimeoutPolicy,
};

use super::super::super::support::{
    assert_connection_accepts_exec_operation, normal_operation_readiness, operation_count,
    read_guest_message, send_exec_output, send_exec_result, send_exec_started,
    setup_host_and_guest,
};
use super::super::start_capture_operation;
use super::support::{
    send_guest_error, send_start_failed, start_pending_supervised_exec, supervised_request,
    supervised_stream_request,
};
use crate::SupervisedExecRequest;
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn supervised_exec_returns_handle_after_exec_started() {
    let pending = start_pending_supervised_exec(supervised_request("long-running")).await;

    let decoded = vsock_proto::decode_exec_start(&pending.start.msg.payload).unwrap();
    assert_eq!(decoded.lifecycle, ExecLifecyclePolicy::Supervised);
    assert_eq!(decoded.role, vsock_proto::ExecProcessRole::Workload);
    assert_eq!(decoded.timeout, ExecTimeoutPolicy::None);
    assert_eq!(decoded.control, ExecControlPolicy::Disabled);

    pending.assert_waiting_for_started();

    let mut started = pending.started_with_pid(123).await;
    assert_eq!(started.handle.pid(), 123);
    let start_seq = started.start.seq();

    send_exec_result(
        &mut started.guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let result = started.handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        normal_operation_readiness(&started.host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_sends_stdin_bytes() {
    let pending = start_pending_supervised_exec(SupervisedExecRequest {
        stdin_bytes: Some(b"supervised-stdin"),
        ..supervised_request("cat")
    })
    .await;

    let decoded = vsock_proto::decode_exec_start(&pending.start.msg.payload).unwrap();
    assert_eq!(decoded.lifecycle, ExecLifecyclePolicy::Supervised);
    assert_eq!(decoded.command, "cat");
    assert_eq!(decoded.stdin_bytes, Some(&b"supervised-stdin"[..]));

    let mut started = pending.started().await;
    let start_seq = started.start.seq();
    send_exec_result(
        &mut started.guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let result = started.handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn supervised_exec_start_failed_before_started_returns_error() {
    let mut pending = start_pending_supervised_exec(supervised_request("missing-binary")).await;
    let start_seq = pending.start.seq();

    send_start_failed(&mut pending.guest, start_seq, "spawn failed").await;

    let finished = pending.wait_start_result().await;
    let err = match finished.start_result {
        Ok(_) => panic!("supervised exec should fail when start fails"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "spawn failed");
    assert_eq!(operation_count(&finished.host), 0);
    assert_eq!(
        normal_operation_readiness(&finished.host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_error_before_started_returns_error_without_cancel() {
    let mut pending =
        start_pending_supervised_exec(supervised_request("guest-error-before-started")).await;
    let start_seq = pending.start.seq();

    send_guest_error(&mut pending.guest, start_seq, "guest rejected start").await;

    let mut finished = pending.wait_start_result().await;
    let err = match finished.start_result {
        Ok(_) => panic!("supervised exec should fail when guest returns an error before started"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest rejected start");
    assert_eq!(operation_count(&finished.host), 0);
    assert_eq!(
        normal_operation_readiness(&finished.host),
        NormalOperationReadiness::Idle
    );
    match finished.guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("guest start error must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after guest start error: {err}"),
    }

    assert_connection_accepts_exec_operation(&finished.host, &mut finished.guest).await;
}

#[tokio::test]
async fn supervised_exec_output_before_started_poisons_connection() {
    let mut pending =
        start_pending_supervised_exec(supervised_stream_request("stream-before-start")).await;
    let start_seq = pending.start.seq();

    send_exec_output(
        &mut pending.guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"early",
        false,
    )
    .await;

    pending
        .host
        .wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let finished = pending.wait_start_result().await;
    let err = match finished.start_result {
        Ok(_) => panic!("supervised exec should fail when early output poisons the connection"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_non_start_failed_result_before_started_poisons_connection() {
    let mut pending =
        start_pending_supervised_exec(supervised_request("result-before-start")).await;
    let start_seq = pending.start.seq();

    send_exec_result(
        &mut pending.guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;

    pending
        .host
        .wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let finished = pending.wait_start_result().await;
    let err = match finished.start_result {
        Ok(_) => panic!("supervised exec should fail when early result poisons the connection"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn supervised_exec_duplicate_started_poisons_connection() {
    let pending = start_pending_supervised_exec(supervised_request("duplicate-started")).await;
    let mut started = pending.started_with_pid(123).await;
    let start_seq = started.start.seq();
    send_exec_started(&mut started.guest, start_seq, 456).await;

    started
        .host
        .wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = started
        .handle
        .wait(Duration::from_secs(5))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn one_shot_exec_rejects_exec_started() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "one-shot-started").await;
    let start = read_guest_message(&mut guest).await;

    send_exec_started(&mut guest, start.seq, 99).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}
