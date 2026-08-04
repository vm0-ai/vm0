use std::io;

use sandbox::ExecTermination;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Request from a `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecRequest {
    /// Full run identity that must still own the sandbox at guest admission.
    ///
    /// Missing means the caller intentionally selected sandbox scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_run_id: Option<String>,
    /// Command text to execute inside the guest.
    pub command: String,
    /// Command timeout in seconds.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// 30 seconds.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    /// Whether to request sudo execution inside the guest.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// `false`. The guest command runner decides how sudo is applied.
    #[serde(default)]
    pub sudo: bool,
}

fn default_timeout() -> u32 {
    30
}

/// Request that probes control-server capabilities without executing a command.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CapabilitiesRequest {
    pub(super) action: CapabilitiesAction,
}

/// Non-executing control action used for protocol negotiation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CapabilitiesAction {
    Capabilities,
}

/// Response to a control capability probe.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum CapabilitiesResponse {
    Supported { exec_response_raw_version: u8 },
    Unsupported { error: String },
}

/// Exec response representation selected by a negotiated request.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ExecResponseFormat {
    #[default]
    JsonBase64,
    RawV1,
}

/// Server-side exec request shape that also accepts a negotiated response format.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WireExecRequest {
    #[serde(default)]
    pub(super) expected_run_id: Option<String>,
    pub(super) command: String,
    #[serde(default = "default_timeout")]
    pub(super) timeout_secs: u32,
    #[serde(default)]
    pub(super) sudo: bool,
    #[serde(default)]
    pub(super) response_format: ExecResponseFormat,
}

impl WireExecRequest {
    pub(super) fn into_request(self) -> (ExecRequest, ExecResponseFormat) {
        let Self {
            expected_run_id,
            command,
            timeout_secs,
            sudo,
            response_format,
        } = self;
        (
            ExecRequest {
                expected_run_id,
                command,
                timeout_secs,
                sudo,
            },
            response_format,
        )
    }
}

/// Borrowed exec request that explicitly selects raw response version 1.
#[derive(Debug, Serialize)]
pub(super) struct RawExecRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) expected_run_id: Option<&'a str>,
    pub(super) command: &'a str,
    pub(super) timeout_secs: u32,
    pub(super) sudo: bool,
    pub(super) response_format: ExecResponseFormat,
}

impl<'a> From<&'a ExecRequest> for RawExecRequest<'a> {
    fn from(request: &'a ExecRequest) -> Self {
        Self {
            expected_run_id: request.expected_run_id.as_deref(),
            command: &request.command,
            timeout_secs: request.timeout_secs,
            sudo: request.sudo,
            response_format: ExecResponseFormat::RawV1,
        }
    }
}

/// Response to a `runner exec` client.
///
/// This enum is serialized without a tag. Clients should distinguish variants
/// by shape: a command result response contains command result fields, while an
/// error response contains only an `error` string.
/// Unknown fields are rejected so mixed success/error shapes fail closed.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum ExecResponse {
    /// Command execution produced a captured result.
    Success {
        /// Structured terminal state returned by the guest command runner.
        termination: ExecTermination,
        /// Base64-encoded captured stdout bytes.
        ///
        /// This is not plain UTF-8 text. `FirecrackerControl::exec_remote`
        /// decodes it before returning `sandbox::RemoteExecResult`.
        stdout: String,
        /// Base64-encoded captured stderr bytes.
        ///
        /// This is not plain UTF-8 text. `FirecrackerControl::exec_remote`
        /// decodes it before returning `sandbox::RemoteExecResult`.
        stderr: String,
        /// Whether stdout was cut at the capture limit.
        ///
        /// Truncation is independent of the command exit code.
        stdout_truncated: bool,
        /// Whether stderr was cut at the capture limit.
        ///
        /// Truncation is independent of the command exit code.
        stderr_truncated: bool,
        /// Guest-provided terminal diagnostic text.
        diagnostic: String,
    },
    /// Request failed before a command result could be returned.
    Error {
        /// Human-readable error message for operators and clients.
        error: String,
    },
}

/// Host-side control action requested over the local control socket.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminateAction {
    /// Request host-side sandbox termination.
    ///
    /// This variant serializes as `"terminate"` in the request action field.
    Terminate,
}

/// Request from a host-side termination client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminateRequest {
    /// Requested host-side control action.
    ///
    /// Sandbox-scoped termination clients send `{"action":"terminate"}`.
    pub action: TerminateAction,
    /// Full run identity that must still own the sandbox at termination
    /// admission. Missing means intentionally sandbox-scoped termination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_run_id: Option<String>,
}

/// Result status for a host-side termination request.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminateStatus {
    /// The sandbox owner accepted and acknowledged the termination request.
    ///
    /// This status serializes as `"accepted"`.
    Accepted,
    /// The sandbox owner or termination path is already stopped or unavailable.
    ///
    /// Callers may treat this as an idempotent stopped outcome. This status
    /// serializes as `"already_stopped"`.
    AlreadyStopped,
    /// The sandbox is parked in idle ownership; direct process termination
    /// would leave runner-owned idle resources retained.
    ///
    /// This status serializes as `"refused_idle"`.
    RefusedIdle,
}

/// Response to a host-side termination client.
///
/// This enum is serialized without a tag. Clients should distinguish variants
/// by shape: a status response contains a `status` field, while an error
/// response contains only an `error` string.
/// Unknown fields are rejected so mixed status/error shapes fail closed.
#[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum TerminateResponse {
    /// Termination request completed with a status result.
    ///
    /// This variant serializes as `{"status":"..."}`, for example
    /// `{"status":"accepted"}`.
    Status {
        /// Status describing how the termination request was handled.
        status: TerminateStatus,
    },
    /// Request failed before a termination status could be returned.
    ///
    /// This variant serializes as `{"error":"..."}`.
    Error {
        /// Human-readable error message for operators and clients.
        error: String,
    },
}

/// Maximum frame payload size: 64 MiB, excluding the 4-byte length prefix.
pub(super) const MAX_FRAME_PAYLOAD_SIZE: u32 = 64 * 1024 * 1024;

fn frame_payload_len_error(len: usize) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("frame too large: {len} bytes"),
    )
}

pub(super) fn validate_frame_payload_len(len: usize) -> io::Result<u32> {
    if len > MAX_FRAME_PAYLOAD_SIZE as usize {
        return Err(frame_payload_len_error(len));
    }

    Ok(len as u32)
}

/// Read a length-prefixed frame from the stream.
pub(super) async fn read_frame(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
    let len = read_frame_payload_len(stream).await?;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Read and validate a frame payload length without allocating its payload.
pub(super) async fn read_frame_payload_len(stream: &mut UnixStream) -> io::Result<usize> {
    let len = stream.read_u32().await? as usize;
    validate_frame_payload_len(len)?;
    Ok(len)
}

/// Write a length-prefixed frame to the stream.
pub(super) async fn write_frame(stream: &mut UnixStream, data: &[u8]) -> io::Result<()> {
    write_frame_payload_len(stream, data.len()).await?;
    stream.write_all(data).await?;
    stream.flush().await?;
    Ok(())
}

/// Validate and write a frame payload length without requiring a contiguous payload.
pub(super) async fn write_frame_payload_len(stream: &mut UnixStream, len: usize) -> io::Result<()> {
    stream.write_u32(validate_frame_payload_len(len)?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{UnixListener, UnixStream};

    #[tokio::test]
    async fn frame_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");

        let listener = UnixListener::bind(&sock_path).unwrap();

        let payload = b"hello world";
        let sock = sock_path.clone();
        let client = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            write_frame(&mut stream, payload).await.unwrap();
            read_frame(&mut stream).await.unwrap()
        });

        let (mut stream, _) = listener.accept().await.unwrap();
        let received = read_frame(&mut stream).await.unwrap();
        assert_eq!(received, payload);

        write_frame(&mut stream, b"reply").await.unwrap();
        let reply = client.await.unwrap();
        assert_eq!(reply, b"reply");
    }

    #[tokio::test]
    async fn read_frame_rejects_frames_larger_than_max_size() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();

        writer.write_u32(MAX_FRAME_PAYLOAD_SIZE + 1).await.unwrap();
        drop(writer);

        let err = read_frame(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("frame too large"));
    }

    #[tokio::test]
    async fn write_frame_rejects_frames_larger_than_max_size_without_writing_prefix() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let payload = vec![0u8; MAX_FRAME_PAYLOAD_SIZE as usize + 1];

        let err = write_frame(&mut writer, &payload).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("frame too large"));

        drop(writer);
        let err = reader.read_u32().await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn protocol_round_trip() {
        let request = ExecRequest {
            expected_run_id: None,
            command: "echo hello".into(),
            timeout_secs: 10,
            sudo: false,
        };
        let request_json = serde_json::to_vec(&request).unwrap();

        // Verify request deserializes correctly.
        let decoded: ExecRequest = serde_json::from_slice(&request_json).unwrap();
        assert_eq!(decoded.expected_run_id, None);
        assert_eq!(decoded.command, "echo hello");
        assert_eq!(decoded.timeout_secs, 10);
        assert!(!decoded.sudo);
        assert!(
            serde_json::from_slice::<serde_json::Value>(&request_json)
                .unwrap()
                .get("expected_run_id")
                .is_none()
        );

        // Verify success response round-trips.
        let response = ExecResponse::Success {
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout: BASE64.encode(b"hello\n"),
            stderr: BASE64.encode(b""),
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: "terminal diagnostic".into(),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponse = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponse::Success {
                termination,
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
                diagnostic,
            } => {
                assert_eq!(termination, ExecTermination::Exited { exit_code: 0 });
                assert_eq!(BASE64.decode(stdout).unwrap(), b"hello\n");
                assert_eq!(BASE64.decode(stderr).unwrap(), b"");
                assert!(!stdout_truncated);
                assert!(!stderr_truncated);
                assert_eq!(diagnostic, "terminal diagnostic");
            }
            ExecResponse::Error { .. } => panic!("expected success"),
        }

        // Verify error response round-trips.
        let response = ExecResponse::Error {
            error: "sandbox not running".into(),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponse = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponse::Error { error } => {
                assert_eq!(error, "sandbox not running");
            }
            ExecResponse::Success { .. } => panic!("expected error"),
        }
    }

    #[test]
    fn guarded_exec_request_round_trips_run_identity() {
        let request = ExecRequest {
            expected_run_id: Some("run-full-id".into()),
            command: "true".into(),
            timeout_secs: 30,
            sudo: false,
        };

        let request_json = serde_json::to_value(&request).unwrap();
        assert_eq!(request_json["expected_run_id"], "run-full-id");
        let decoded: ExecRequest = serde_json::from_value(request_json).unwrap();
        assert_eq!(decoded.expected_run_id.as_deref(), Some("run-full-id"));
    }

    #[test]
    fn exec_request_default_timeout() {
        // timeout_secs has a serde default of 30
        let json = r#"{"command":"echo hi"}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.expected_run_id, None);
        assert_eq!(req.command, "echo hi");
        assert_eq!(req.timeout_secs, 30);
        assert!(!req.sudo);
    }

    #[test]
    fn exec_request_with_sudo() {
        let json = r#"{"command":"apt install curl","timeout_secs":60,"sudo":true}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "apt install curl");
        assert_eq!(req.timeout_secs, 60);
        assert!(req.sudo);
    }

    #[test]
    fn wire_exec_request_preserves_legacy_defaults() {
        let request: WireExecRequest = serde_json::from_str(r#"{"command":"echo hi"}"#).unwrap();
        let (request, response_format) = request.into_request();

        assert_eq!(request.expected_run_id, None);
        assert_eq!(request.command, "echo hi");
        assert_eq!(request.timeout_secs, 30);
        assert!(!request.sudo);
        assert_eq!(response_format, ExecResponseFormat::JsonBase64);
    }

    #[test]
    fn raw_exec_request_explicitly_selects_raw_v1() {
        let request = ExecRequest {
            expected_run_id: Some("run-full-id".into()),
            command: "printf raw".into(),
            timeout_secs: 17,
            sudo: true,
        };
        let json = serde_json::to_value(RawExecRequest::from(&request)).unwrap();

        assert_eq!(json["expected_run_id"], "run-full-id");
        assert_eq!(json["command"], "printf raw");
        assert_eq!(json["timeout_secs"], 17);
        assert_eq!(json["sudo"], true);
        assert_eq!(json["response_format"], "raw_v1");

        let decoded: WireExecRequest = serde_json::from_value(json).unwrap();
        let (decoded, response_format) = decoded.into_request();
        assert_eq!(decoded.expected_run_id.as_deref(), Some("run-full-id"));
        assert_eq!(decoded.command, "printf raw");
        assert_eq!(response_format, ExecResponseFormat::RawV1);
    }

    #[test]
    fn exec_response_success_serialization() {
        let resp = ExecResponse::Success {
            termination: ExecTermination::Exited { exit_code: 0 },
            stdout: BASE64.encode(b"output\n"),
            stderr: BASE64.encode(b""),
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: "diagnostic".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        // Untagged enum: no "type" field, just the fields directly
        assert_eq!(json["termination"]["kind"], "exited");
        assert_eq!(json["termination"]["exit_code"], 0);
        assert!(json.get("exit_code").is_none());
        assert!(json.get("stdout").is_some());
        assert!(json.get("stderr").is_some());
        assert_eq!(json["diagnostic"], "diagnostic");
        assert!(json.get("error").is_none());
    }

    #[test]
    fn exec_response_success_serializes_non_exited_termination() {
        for (termination, expected_kind) in [
            (ExecTermination::TimedOut, "timed_out"),
            (ExecTermination::Cancelled, "cancelled"),
            (ExecTermination::StartFailed, "start_failed"),
            (ExecTermination::WaitFailed, "wait_failed"),
        ] {
            let resp = ExecResponse::Success {
                termination,
                stdout: BASE64.encode(b""),
                stderr: BASE64.encode(b""),
                stdout_truncated: false,
                stderr_truncated: false,
                diagnostic: String::new(),
            };
            let json = serde_json::to_value(&resp).unwrap();
            assert_eq!(json["termination"]["kind"], expected_kind);
            assert!(json["termination"].get("exit_code").is_none());
            let decoded: ExecResponse = serde_json::from_value(json).unwrap();
            match decoded {
                ExecResponse::Success {
                    termination: decoded,
                    ..
                } => assert_eq!(decoded, termination),
                ExecResponse::Error { .. } => panic!("expected success"),
            }
        }
    }

    #[test]
    fn exec_response_rejects_legacy_exit_code_success_shape() {
        let legacy = serde_json::json!({
            "exit_code": 0,
            "stdout": BASE64.encode(b""),
            "stderr": BASE64.encode(b""),
            "stdout_truncated": false,
            "stderr_truncated": false
        });

        let result = serde_json::from_value::<ExecResponse>(legacy);
        assert!(result.is_err());
    }

    #[test]
    fn exec_response_rejects_mixed_success_error_shape() {
        let mixed = serde_json::json!({
            "termination": {
                "kind": "exited",
                "exit_code": 0,
            },
            "stdout": BASE64.encode(b""),
            "stderr": BASE64.encode(b""),
            "stdout_truncated": false,
            "stderr_truncated": false,
            "diagnostic": "",
            "error": "sandbox not running",
        });

        let result = serde_json::from_value::<ExecResponse>(mixed);
        assert!(result.is_err());
    }

    #[test]
    fn exec_response_rejects_non_exited_termination_with_exit_code() {
        for exit_code in [serde_json::json!(124), serde_json::Value::Null] {
            let malformed = serde_json::json!({
                "termination": {
                    "kind": "timed_out",
                    "exit_code": exit_code,
                },
                "stdout": BASE64.encode(b""),
                "stderr": BASE64.encode(b""),
                "stdout_truncated": false,
                "stderr_truncated": false,
                "diagnostic": "",
            });

            let result = serde_json::from_value::<ExecResponse>(malformed);
            assert!(result.is_err());
        }
    }

    #[test]
    fn exec_response_rejects_exited_termination_without_exit_code() {
        for termination in [
            serde_json::json!({
                "kind": "exited",
            }),
            serde_json::json!({
                "kind": "exited",
                "exit_code": null,
            }),
        ] {
            let malformed = serde_json::json!({
                "termination": termination,
                "stdout": BASE64.encode(b""),
                "stderr": BASE64.encode(b""),
                "stdout_truncated": false,
                "stderr_truncated": false,
                "diagnostic": "",
            });

            let result = serde_json::from_value::<ExecResponse>(malformed);
            assert!(result.is_err());
        }
    }

    #[test]
    fn exec_response_rejects_termination_unknown_field() {
        let malformed = serde_json::json!({
            "termination": {
                "kind": "exited",
                "exit_code": 0,
                "signal": 9,
            },
            "stdout": BASE64.encode(b""),
            "stderr": BASE64.encode(b""),
            "stdout_truncated": false,
            "stderr_truncated": false,
            "diagnostic": "",
        });

        let result = serde_json::from_value::<ExecResponse>(malformed);
        assert!(result.is_err());
    }

    #[test]
    fn exec_response_rejects_invalid_termination_kind_shapes() {
        for termination in [
            r#"{"exit_code":0}"#,
            r#"{"kind":"unknown","exit_code":0}"#,
            r#"{"kind":"exited","kind":"timed_out","exit_code":0}"#,
            r#"{"kind":"exited","exit_code":0,"exit_code":1}"#,
        ] {
            let malformed = format!(
                r#"{{
                    "termination": {termination},
                    "stdout": "{}",
                    "stderr": "{}",
                    "stdout_truncated": false,
                    "stderr_truncated": false,
                    "diagnostic": ""
                }}"#,
                BASE64.encode(b""),
                BASE64.encode(b"")
            );

            let result = serde_json::from_str::<ExecResponse>(&malformed);
            assert!(result.is_err());
        }
    }

    #[test]
    fn exec_response_error_serialization() {
        let resp = ExecResponse::Error {
            error: "sandbox not running".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["error"], "sandbox not running");
        assert!(json.get("termination").is_none());
        assert!(json.get("exit_code").is_none());
    }

    #[test]
    fn terminate_protocol_round_trip() {
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
            expected_run_id: None,
        };
        let request_json = serde_json::to_value(&request).unwrap();
        assert_eq!(
            request_json,
            serde_json::json!({
                "action": "terminate",
            })
        );

        let decoded: TerminateRequest = serde_json::from_value(request_json).unwrap();
        assert!(matches!(decoded.action, TerminateAction::Terminate));
        assert_eq!(decoded.expected_run_id, None);

        for (status, status_json) in [
            (TerminateStatus::Accepted, "accepted"),
            (TerminateStatus::AlreadyStopped, "already_stopped"),
            (TerminateStatus::RefusedIdle, "refused_idle"),
        ] {
            let response = TerminateResponse::Status { status };
            let response_json = serde_json::to_value(&response).unwrap();
            assert_eq!(
                response_json,
                serde_json::json!({
                    "status": status_json,
                })
            );

            let decoded: TerminateResponse = serde_json::from_value(response_json).unwrap();
            assert_eq!(decoded, TerminateResponse::Status { status });
        }

        let response = TerminateResponse::Error {
            error: "sandbox not running".into(),
        };
        let response_json = serde_json::to_value(&response).unwrap();
        assert_eq!(
            response_json,
            serde_json::json!({
                "error": "sandbox not running",
            })
        );

        let decoded: TerminateResponse = serde_json::from_value(response_json).unwrap();
        assert_eq!(
            decoded,
            TerminateResponse::Error {
                error: "sandbox not running".into()
            }
        );
    }

    #[test]
    fn guarded_terminate_request_round_trips_run_identity() {
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
            expected_run_id: Some("run-full-id".into()),
        };

        let request_json = serde_json::to_value(&request).unwrap();
        assert_eq!(request_json["expected_run_id"], "run-full-id");
        let decoded: TerminateRequest = serde_json::from_value(request_json).unwrap();
        assert_eq!(decoded.expected_run_id.as_deref(), Some("run-full-id"));
    }

    #[test]
    fn terminate_response_rejects_mixed_status_error_shape() {
        let mixed = serde_json::json!({
            "status": "accepted",
            "error": "sandbox not running",
        });

        let result = serde_json::from_value::<TerminateResponse>(mixed);
        assert!(result.is_err());
    }

    #[test]
    fn terminate_request_does_not_decode_as_exec_request() {
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
            expected_run_id: None,
        };
        let request_json = serde_json::to_vec(&request).unwrap();

        assert!(serde_json::from_slice::<ExecRequest>(&request_json).is_err());
    }

    #[test]
    fn terminate_request_rejects_exec_fields() {
        let request_json = serde_json::json!({
            "action": "terminate",
            "command": "true",
            "timeout_secs": 1,
        });

        assert!(serde_json::from_value::<TerminateRequest>(request_json).is_err());
    }

    #[test]
    fn exec_request_rejects_terminate_fields() {
        let request_json = serde_json::json!({
            "command": "true",
            "timeout_secs": 1,
            "action": "terminate",
        });

        assert!(serde_json::from_value::<ExecRequest>(request_json).is_err());
    }
}
