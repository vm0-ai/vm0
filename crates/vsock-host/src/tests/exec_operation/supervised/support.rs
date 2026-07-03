use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::task::JoinHandle;
use vsock_proto::{
    ExecCapturedOutput, ExecControlNonce, ExecControlPolicy, ExecOutputPolicy, ExecTermination,
    ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_START, RawMessage,
};

use super::super::super::support::{
    assert_connection_accepts_exec_operation, normal_operation_readiness, operation_count,
    read_guest_message, send_exec_result, send_exec_started, setup_host_and_guest,
};
use crate::operation_tracker::NormalOperationReadiness;
use crate::{
    ExecControlHandle, SupervisedExecControl, SupervisedExecHandle, SupervisedExecRequest,
};
use crate::{ExecOperationResult, VsockHost};

pub(super) fn supervised_request(command: &str) -> SupervisedExecRequest<'_> {
    SupervisedExecRequest {
        timeout: ExecTimeoutPolicy::None,
        command,
        env: &[],
        sudo: false,
        label: "supervised-test",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        expected_exit_codes: &[],
        control: SupervisedExecControl::Disabled,
        stdin_bytes: None,
        stream_queue_capacity: None,
        start_timeout: Duration::from_secs(5),
    }
}

pub(super) fn supervised_stream_request(command: &str) -> SupervisedExecRequest<'_> {
    SupervisedExecRequest {
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 16,
        },
        stderr: ExecOutputPolicy::Discard,
        stdin_bytes: None,
        stream_queue_capacity: Some(1),
        ..supervised_request(command)
    }
}

pub(super) struct SupervisedExecStartFrame {
    pub(super) msg: RawMessage,
    pub(super) control: ExecControlPolicy,
}

impl SupervisedExecStartFrame {
    pub(super) fn seq(&self) -> u32 {
        self.msg.seq
    }

    pub(super) fn control_enabled(&self) -> (ExecControlNonce, bool) {
        let ExecControlPolicy::Enabled {
            control_nonce,
            sink,
        } = self.control
        else {
            panic!("supervised exec should enable control");
        };
        (control_nonce, sink)
    }
}

pub(super) struct PendingSupervisedExec {
    pub(super) host: Arc<VsockHost>,
    pub(super) guest: UnixStream,
    pub(super) start: SupervisedExecStartFrame,
    task: JoinHandle<io::Result<SupervisedExecHandle>>,
}

impl PendingSupervisedExec {
    pub(super) async fn started(self) -> StartedSupervisedExec {
        self.started_with_pid(123).await
    }

    pub(super) async fn started_with_pid(mut self, pid: u32) -> StartedSupervisedExec {
        send_exec_started(&mut self.guest, self.start.seq(), pid).await;
        let handle = self.task.await.unwrap().unwrap();
        StartedSupervisedExec {
            host: self.host,
            guest: self.guest,
            start: self.start,
            handle,
        }
    }
}

pub(super) struct StartedSupervisedExec {
    pub(super) host: Arc<VsockHost>,
    pub(super) guest: UnixStream,
    pub(super) start: SupervisedExecStartFrame,
    pub(super) handle: SupervisedExecHandle,
}

pub(super) struct StartedControlSupervisedExec {
    pub(super) host: Arc<VsockHost>,
    pub(super) guest: UnixStream,
    pub(super) start: SupervisedExecStartFrame,
    pub(super) handle: SupervisedExecHandle,
    pub(super) control_handle: ExecControlHandle,
    pub(super) control_nonce: ExecControlNonce,
}

pub(super) async fn start_pending_supervised_exec(
    request: SupervisedExecRequest<'static>,
) -> PendingSupervisedExec {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.start_supervised_exec(request).await })
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let control = vsock_proto::decode_exec_start(&msg.payload)
        .unwrap()
        .control;

    PendingSupervisedExec {
        host,
        guest,
        start: SupervisedExecStartFrame { msg, control },
        task,
    }
}

pub(super) async fn start_supervised_exec_fixture(
    request: SupervisedExecRequest<'static>,
) -> StartedSupervisedExec {
    start_pending_supervised_exec(request).await.started().await
}

pub(super) async fn start_control_supervised_exec_fixture(
    command: &'static str,
) -> StartedControlSupervisedExec {
    let started = start_supervised_exec_fixture(SupervisedExecRequest {
        control: SupervisedExecControl::Enabled { sink: true },
        ..supervised_request(command)
    })
    .await;
    let (control_nonce, sink) = started.start.control_enabled();
    assert!(sink);
    let control_handle = started.handle.control_handle().unwrap();
    StartedControlSupervisedExec {
        host: started.host,
        guest: started.guest,
        start: started.start,
        handle: started.handle,
        control_handle,
        control_nonce,
    }
}

pub(super) async fn finish_supervised_exec_success(
    guest: &mut UnixStream,
    seq: u32,
    handle: SupervisedExecHandle,
) -> io::Result<ExecOperationResult> {
    send_exec_result(
        guest,
        seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    handle.wait(Duration::from_secs(5)).await
}

pub(super) fn assert_no_guest_frame(guest: &mut UnixStream, context: &str) {
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("{context}; read {n} bytes"),
        Err(err) => panic!("unexpected read error after {context}: {err}"),
    }
}

pub(super) async fn assert_supervised_start_rejected_without_frame(
    request: SupervisedExecRequest<'_>,
    expected_message: &str,
) {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host.start_supervised_exec(request).await {
        Ok(_) => panic!("invalid supervised exec request should be rejected"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(
        err.to_string().contains(expected_message),
        "unexpected error: {err}",
    );
    assert_eq!(operation_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

pub(super) async fn send_start_failed(
    guest: &mut tokio::net::UnixStream,
    seq: u32,
    diagnostic: &str,
) {
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::StartFailed,
        7,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        diagnostic,
    )
    .unwrap();
    let frame = vsock_proto::encode(vsock_proto::MSG_EXEC_RESULT, seq, &payload).unwrap();
    guest.write_all(&frame).await.unwrap();
}

pub(super) async fn send_guest_error(stream: &mut tokio::net::UnixStream, seq: u32, message: &str) {
    let payload = vsock_proto::encode_error(message);
    let frame = vsock_proto::encode(MSG_ERROR, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}
