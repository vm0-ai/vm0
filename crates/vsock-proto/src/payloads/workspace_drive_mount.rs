use crate::frame::encode_into;
use crate::payloads::exec_operation::encode_exec_result_frame_into_with_type;
use crate::wire::{MSG_WORKSPACE_DRIVE_MOUNT, MSG_WORKSPACE_DRIVE_MOUNT_RESULT};
use crate::{DecodedExecResult, ExecCapturedOutput, ExecTermination, ProtocolError};

/// Fixed stdout/stderr capture bound for the workspace mount helper.
pub const WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

/// Encode a full fixed workspace-drive mount request frame.
///
/// The operation accepts no caller payload. The guest owns its program,
/// command, paths, identity, timeout, output policy, and containment.
///
/// # Errors
///
/// Returns [`ProtocolError`] if the encoded frame exceeds the protocol limit.
pub fn encode_workspace_drive_mount_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
) -> Result<(), ProtocolError> {
    encode_into(frame, MSG_WORKSPACE_DRIVE_MOUNT, seq, 0, |_| {})
}

/// Decode the fixed workspace-drive mount request payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] unless the payload is empty.
pub fn decode_workspace_drive_mount_request(payload: &[u8]) -> Result<(), ProtocolError> {
    crate::decode_empty_payload("workspace_drive_mount payload must be empty", payload)
}

/// Encode a fixed workspace-drive mount terminal result payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] if stdout or stderr was discarded or exceeds the
/// fixed capture bound, or if the result exceeds protocol field limits.
pub fn encode_workspace_drive_mount_result(
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    validate_result_output(stdout, "stdout")?;
    validate_result_output(stderr, "stderr")?;
    crate::encode_exec_result(termination, duration_ms, stdout, stderr, diagnostic)
}

/// Encode a full fixed workspace-drive mount terminal result frame.
///
/// # Errors
///
/// Returns [`ProtocolError`] if stdout or stderr was discarded or exceeds the
/// fixed capture bound, or if the result exceeds protocol field limits.
pub fn encode_workspace_drive_mount_result_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<(), ProtocolError> {
    validate_result_output(stdout, "stdout")?;
    validate_result_output(stderr, "stderr")?;
    encode_exec_result_frame_into_with_type::<MSG_WORKSPACE_DRIVE_MOUNT_RESULT>(
        frame,
        seq,
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    )
}

/// Decode a fixed workspace-drive mount terminal result payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] if the shared terminal result is malformed or
/// either output stream violates the fixed capture contract.
pub fn decode_workspace_drive_mount_result(
    payload: &[u8],
) -> Result<DecodedExecResult<'_>, ProtocolError> {
    let decoded = crate::decode_exec_result(payload)?;
    validate_result_output(decoded.stdout, "stdout")?;
    validate_result_output(decoded.stderr, "stderr")?;
    Ok(decoded)
}

fn validate_result_output(
    output: ExecCapturedOutput<'_>,
    field: &'static str,
) -> Result<(), ProtocolError> {
    match output {
        ExecCapturedOutput::Captured { bytes, .. }
            if bytes.len() <= WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES =>
        {
            Ok(())
        }
        ExecCapturedOutput::Captured { bytes, .. } => {
            Err(ProtocolError::PayloadTooLarge(field, bytes.len()))
        }
        ExecCapturedOutput::Discarded => Err(ProtocolError::InvalidPayload(
            "workspace_drive_mount_result output must be captured",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Decoder, MSG_WORKSPACE_DRIVE_MOUNT};

    #[test]
    fn request_is_empty() {
        let mut frame = vec![1, 2, 3];
        encode_workspace_drive_mount_request_frame_into(&mut frame, 17).unwrap();
        let decoded = Decoder::new().decode(&frame).unwrap().remove(0);

        assert_eq!(decoded.msg_type, MSG_WORKSPACE_DRIVE_MOUNT);
        assert_eq!(decoded.seq, 17);
        assert!(decoded.payload.is_empty());
        decode_workspace_drive_mount_request(&decoded.payload).unwrap();
        assert!(decode_workspace_drive_mount_request(b"unexpected").is_err());
    }

    #[test]
    fn result_round_trips_fixed_captured_output() {
        let payload = encode_workspace_drive_mount_result(
            ExecTermination::Exited { exit_code: 64 },
            23,
            ExecCapturedOutput::Captured {
                bytes: b"mount stdout",
                truncated: false,
            },
            ExecCapturedOutput::Captured {
                bytes: b"mount stderr",
                truncated: true,
            },
            "diagnostic",
        )
        .unwrap();
        let decoded = decode_workspace_drive_mount_result(&payload).unwrap();

        assert_eq!(
            decoded.termination,
            ExecTermination::Exited { exit_code: 64 }
        );
        assert_eq!(decoded.duration_ms, 23);
        assert_eq!(
            decoded.stdout,
            ExecCapturedOutput::Captured {
                bytes: b"mount stdout",
                truncated: false,
            }
        );
        assert_eq!(
            decoded.stderr,
            ExecCapturedOutput::Captured {
                bytes: b"mount stderr",
                truncated: true,
            }
        );
        assert_eq!(decoded.diagnostic, "diagnostic");
    }

    #[test]
    fn result_rejects_discarded_or_oversized_output() {
        let captured = ExecCapturedOutput::Captured {
            bytes: &[],
            truncated: false,
        };
        assert!(
            encode_workspace_drive_mount_result(
                ExecTermination::Exited { exit_code: 0 },
                1,
                ExecCapturedOutput::Discarded,
                captured,
                "",
            )
            .is_err()
        );

        let oversized = vec![0; WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES + 1];
        assert!(
            encode_workspace_drive_mount_result(
                ExecTermination::Exited { exit_code: 0 },
                1,
                ExecCapturedOutput::Captured {
                    bytes: &oversized,
                    truncated: true,
                },
                captured,
                "",
            )
            .is_err()
        );
    }
}
