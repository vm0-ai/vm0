use std::io;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Request from a `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExecRequest {
    /// Full run identity that must still own the sandbox at guest admission.
    ///
    /// Missing means the caller intentionally selected sandbox scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) expected_run_id: Option<String>,
    /// Command text to execute inside the guest.
    pub(super) command: String,
    /// Command timeout in seconds.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// 30 seconds.
    #[serde(default = "default_timeout")]
    pub(super) timeout_secs: u32,
    /// Whether to request sudo execution inside the guest.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// `false`. The guest command runner decides how sudo is applied.
    #[serde(default)]
    pub(super) sudo: bool,
}

fn default_timeout() -> u32 {
    30
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
    async fn exec_request_round_trip() {
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
