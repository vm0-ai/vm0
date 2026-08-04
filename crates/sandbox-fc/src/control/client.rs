use std::io;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::net::UnixStream;

use super::exec_response::{ExecResult, RAW_EXEC_RESPONSE_VERSION, read_raw_exec_response};
use super::protocol::{
    CapabilitiesAction, CapabilitiesRequest, CapabilitiesResponse, ExecRequest, ExecResponse,
    RawExecRequest, TerminateRequest, TerminateResponse, read_frame, write_frame,
};

pub(super) enum ReceivedExecResponse {
    Raw(ExecResult),
    Legacy(ExecResponse),
}

/// Send an exec request to a control socket and return the wire response.
///
/// Used by `runner exec` to communicate with a running sandbox.
///
/// The returned [`ExecResponse::Success`] still contains base64-encoded stdout
/// and stderr. Use `FirecrackerControl::exec_remote` when the caller wants
/// decoded byte buffers.
///
/// Returns [`io::ErrorKind::InvalidInput`] when `timeout` cannot be represented
/// as a Tokio deadline.
pub async fn send_exec(
    sock_path: &Path,
    request: &ExecRequest,
    timeout: Duration,
) -> io::Result<ExecResponse> {
    send_control_request(sock_path, request, timeout).await
}

pub(super) async fn send_exec_result(
    sock_path: &Path,
    request: &ExecRequest,
    timeout: Duration,
) -> io::Result<ReceivedExecResponse> {
    let deadline = deadline_after(timeout)?;
    let capabilities: CapabilitiesResponse = send_control_request_until(
        sock_path,
        &CapabilitiesRequest {
            action: CapabilitiesAction::Capabilities,
        },
        deadline,
    )
    .await?;

    match capabilities {
        CapabilitiesResponse::Supported {
            exec_response_raw_version: RAW_EXEC_RESPONSE_VERSION,
        } => send_raw_exec_request(sock_path, request, deadline)
            .await
            .map(ReceivedExecResponse::Raw),
        CapabilitiesResponse::Supported { .. } | CapabilitiesResponse::Unsupported { .. } => {
            send_control_request_until(sock_path, request, deadline)
                .await
                .map(ReceivedExecResponse::Legacy)
        }
    }
}

/// Send a host-side terminate request to a control socket.
pub async fn send_terminate(
    sock_path: &Path,
    request: &TerminateRequest,
    timeout: Duration,
) -> io::Result<TerminateResponse> {
    send_control_request(sock_path, request, timeout).await
}

async fn send_control_request<Request, Response>(
    sock_path: &Path,
    request: &Request,
    timeout: Duration,
) -> io::Result<Response>
where
    Request: Serialize,
    Response: DeserializeOwned,
{
    let deadline = deadline_after(timeout)?;
    send_control_request_until(sock_path, request, deadline).await
}

async fn send_control_request_until<Request, Response>(
    sock_path: &Path,
    request: &Request,
    deadline: tokio::time::Instant,
) -> io::Result<Response>
where
    Request: Serialize,
    Response: DeserializeOwned,
{
    let mut stream = connect_until(sock_path, deadline).await?;
    let request_json = encode_json_request(request)?;

    tokio::time::timeout_at(deadline, async {
        write_frame(&mut stream, &request_json).await?;
        let frame = read_frame(&mut stream).await?;
        serde_json::from_slice(&frame).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("invalid response: {e}"))
        })
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request timed out"))?
}

async fn send_raw_exec_request(
    sock_path: &Path,
    request: &ExecRequest,
    deadline: tokio::time::Instant,
) -> io::Result<ExecResult> {
    let mut stream = connect_until(sock_path, deadline).await?;
    let request_json = encode_json_request(&RawExecRequest::from(request))?;

    tokio::time::timeout_at(deadline, async {
        write_frame(&mut stream, &request_json).await?;
        read_raw_exec_response(&mut stream).await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request timed out"))?
}

async fn connect_until(sock_path: &Path, deadline: tokio::time::Instant) -> io::Result<UnixStream> {
    tokio::time::timeout_at(deadline, UnixStream::connect(sock_path))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connect timed out"))?
}

fn encode_json_request(request: &impl Serialize) -> io::Result<Vec<u8>> {
    serde_json::to_vec(request).map_err(|e| io::Error::other(format!("serialize request: {e}")))
}

fn deadline_after(timeout: Duration) -> io::Result<tokio::time::Instant> {
    tokio::time::Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "request timeout overflowed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use sandbox::ExecTermination;
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn send_exec_missing_socket_returns_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("nonexistent.sock");

        let request = ExecRequest {
            expected_run_id: None,
            command: "echo test".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let result = send_exec(&sock_path, &request, Duration::from_millis(100)).await;
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn send_exec_oversized_timeout_returns_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");

        let request = ExecRequest {
            expected_run_id: None,
            command: "echo test".into(),
            timeout_secs: 5,
            sudo: false,
        };

        let result = send_exec(&sock_path, &request, Duration::MAX).await;
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    async fn assert_negotiated_exec_uses_legacy_response(capabilities: CapabilitiesResponse) {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        let server = tokio::spawn(async move {
            let (mut probe_stream, _) = listener.accept().await.unwrap();
            let probe_json = read_frame(&mut probe_stream).await.unwrap();
            let probe: CapabilitiesRequest = serde_json::from_slice(&probe_json).unwrap();
            assert_eq!(probe.action, CapabilitiesAction::Capabilities);
            assert!(serde_json::from_slice::<ExecRequest>(&probe_json).is_err());
            let capabilities = serde_json::to_vec(&capabilities).unwrap();
            write_frame(&mut probe_stream, &capabilities).await.unwrap();

            let (mut exec_stream, _) = listener.accept().await.unwrap();
            let exec_json = read_frame(&mut exec_stream).await.unwrap();
            let json: serde_json::Value = serde_json::from_slice(&exec_json).unwrap();
            assert!(json.get("response_format").is_none());
            let exec: ExecRequest = serde_json::from_slice(&exec_json).unwrap();
            assert_eq!(exec.command, "printf legacy");
            let response = serde_json::to_vec(&ExecResponse::Success {
                termination: ExecTermination::Exited { exit_code: 7 },
                stdout: BASE64.encode(b"legacy out"),
                stderr: BASE64.encode(b"legacy err"),
                stdout_truncated: true,
                stderr_truncated: false,
                diagnostic: "legacy diagnostic".into(),
            })
            .unwrap();
            write_frame(&mut exec_stream, &response).await.unwrap();
        });

        let response = send_exec_result(
            &sock_path,
            &ExecRequest {
                expected_run_id: None,
                command: "printf legacy".into(),
                timeout_secs: 5,
                sudo: false,
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap();

        let ReceivedExecResponse::Legacy(ExecResponse::Success {
            termination,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            diagnostic,
        }) = response
        else {
            panic!("legacy server should return the legacy response shape");
        };
        assert_eq!(termination, ExecTermination::Exited { exit_code: 7 });
        assert_eq!(BASE64.decode(stdout).unwrap(), b"legacy out");
        assert_eq!(BASE64.decode(stderr).unwrap(), b"legacy err");
        assert!(stdout_truncated);
        assert!(!stderr_truncated);
        assert_eq!(diagnostic, "legacy diagnostic");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn negotiated_exec_falls_back_before_sending_command_to_legacy_server() {
        assert_negotiated_exec_uses_legacy_response(CapabilitiesResponse::Unsupported {
            error: "invalid request: unknown field `action`".into(),
        })
        .await;
    }

    #[tokio::test]
    async fn negotiated_exec_falls_back_from_unknown_raw_version() {
        assert_negotiated_exec_uses_legacy_response(CapabilitiesResponse::Supported {
            exec_response_raw_version: RAW_EXEC_RESPONSE_VERSION + 1,
        })
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn send_exec_times_out_waiting_for_response() {
        use tokio::sync::oneshot;

        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        let (request_seen_tx, request_seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request_json = read_frame(&mut stream).await.unwrap();
            let request: ExecRequest = serde_json::from_slice(&request_json).unwrap();
            assert_eq!(request.command, "echo test");
            request_seen_tx.send(()).unwrap();
            let _stream = stream;
            let _ = release_rx.await;
        });

        let client = tokio::spawn(async move {
            let request = ExecRequest {
                expected_run_id: None,
                command: "echo test".into(),
                timeout_secs: 5,
                sudo: false,
            };
            send_exec(&sock_path, &request, Duration::from_secs(5)).await
        });

        request_seen_rx.await.unwrap();
        tokio::time::advance(Duration::from_secs(5)).await;

        let error = client.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(error.to_string(), "request timed out");

        release_tx.send(()).unwrap();
        server.await.unwrap();
    }
}
