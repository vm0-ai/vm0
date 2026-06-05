use std::io;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Request from a `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecRequest {
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

/// Response to a `runner exec` client.
///
/// This enum is serialized without a tag. Clients should distinguish variants
/// by shape: a command result response contains command result fields, while an
/// error response contains only an `error` string.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExecResponse {
    /// Command execution produced a captured result.
    ///
    /// This variant does not imply a zero exit code; inspect `exit_code` for the
    /// command's status.
    Success {
        /// Process exit code returned by the guest command runner.
        exit_code: i32,
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
    Terminate,
}

/// Request from a host-side termination client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminateRequest {
    pub action: TerminateAction,
}

/// Result status for a host-side termination request.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminateStatus {
    Accepted,
    AlreadyStopped,
    /// The sandbox is parked in idle ownership; direct process termination
    /// would leave runner-owned idle resources retained.
    RefusedIdle,
}

/// Response to a host-side termination client.
#[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TerminateResponse {
    Status { status: TerminateStatus },
    Error { error: String },
}

/// Maximum frame size: 64 MiB (generous for large stdout/stderr).
const MAX_FRAME_SIZE: u32 = 64 * 1024 * 1024;

/// Read a length-prefixed frame from the stream.
pub(super) async fn read_frame(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
    let len = stream.read_u32().await?;
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len} bytes"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Write a length-prefixed frame to the stream.
pub(super) async fn write_frame(stream: &mut UnixStream, data: &[u8]) -> io::Result<()> {
    let len = u32::try_from(data.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("payload too large: {} bytes", data.len()),
        )
    })?;
    stream.write_u32(len).await?;
    stream.write_all(data).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use tokio::io::AsyncWriteExt;
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

        writer.write_u32(MAX_FRAME_SIZE + 1).await.unwrap();
        drop(writer);

        let err = read_frame(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("frame too large"));
    }

    #[tokio::test]
    async fn protocol_round_trip() {
        let request = ExecRequest {
            command: "echo hello".into(),
            timeout_secs: 10,
            sudo: false,
        };
        let request_json = serde_json::to_vec(&request).unwrap();

        // Verify request deserializes correctly.
        let decoded: ExecRequest = serde_json::from_slice(&request_json).unwrap();
        assert_eq!(decoded.command, "echo hello");
        assert_eq!(decoded.timeout_secs, 10);
        assert!(!decoded.sudo);

        // Verify success response round-trips.
        let response = ExecResponse::Success {
            exit_code: 0,
            stdout: BASE64.encode(b"hello\n"),
            stderr: BASE64.encode(b""),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: ExecResponse = serde_json::from_slice(&response_json).unwrap();
        match decoded {
            ExecResponse::Success {
                exit_code,
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
            } => {
                assert_eq!(exit_code, 0);
                assert_eq!(BASE64.decode(stdout).unwrap(), b"hello\n");
                assert_eq!(BASE64.decode(stderr).unwrap(), b"");
                assert!(!stdout_truncated);
                assert!(!stderr_truncated);
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
    fn exec_request_default_timeout() {
        // timeout_secs has a serde default of 30
        let json = r#"{"command":"echo hi"}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
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
    fn exec_response_success_serialization() {
        let resp = ExecResponse::Success {
            exit_code: 0,
            stdout: BASE64.encode(b"output\n"),
            stderr: BASE64.encode(b""),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let json = serde_json::to_value(&resp).unwrap();
        // Untagged enum: no "type" field, just the fields directly
        assert_eq!(json["exit_code"], 0);
        assert!(json.get("stdout").is_some());
        assert!(json.get("stderr").is_some());
        assert!(json.get("error").is_none());
    }

    #[test]
    fn exec_response_error_serialization() {
        let resp = ExecResponse::Error {
            error: "sandbox not running".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["error"], "sandbox not running");
        assert!(json.get("exit_code").is_none());
    }

    #[test]
    fn terminate_protocol_round_trip() {
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
        };
        let request_json = serde_json::to_vec(&request).unwrap();

        let decoded: TerminateRequest = serde_json::from_slice(&request_json).unwrap();
        assert!(matches!(decoded.action, TerminateAction::Terminate));

        let response = TerminateResponse::Status {
            status: TerminateStatus::Accepted,
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: TerminateResponse = serde_json::from_slice(&response_json).unwrap();
        assert_eq!(
            decoded,
            TerminateResponse::Status {
                status: TerminateStatus::Accepted
            }
        );

        let response = TerminateResponse::Status {
            status: TerminateStatus::RefusedIdle,
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: TerminateResponse = serde_json::from_slice(&response_json).unwrap();
        assert_eq!(
            decoded,
            TerminateResponse::Status {
                status: TerminateStatus::RefusedIdle
            }
        );

        let response = TerminateResponse::Error {
            error: "sandbox not running".into(),
        };
        let response_json = serde_json::to_vec(&response).unwrap();
        let decoded: TerminateResponse = serde_json::from_slice(&response_json).unwrap();
        assert_eq!(
            decoded,
            TerminateResponse::Error {
                error: "sandbox not running".into()
            }
        );
    }

    #[test]
    fn terminate_request_does_not_decode_as_exec_request() {
        let request = TerminateRequest {
            action: TerminateAction::Terminate,
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
