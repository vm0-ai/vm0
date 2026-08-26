use crate::ProtocolError;
use crate::frame::encode_into;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, expect_consumed,
    read_slice, read_str, read_u8, read_u16, read_u32, read_u64,
};
use crate::wire::{MSG_GUEST_STATE_RESTORE, MSG_GUEST_STATE_RESTORE_RESULT};
use crate::{DecodedExecResult, ExecCapturedOutput, ExecTermination};

/// Exact entropy byte count required by snapshot-sensitive guest restore.
pub const GUEST_STATE_RESTORE_ENTROPY_BYTES: usize = 256;

/// Maximum encoded timezone name accepted by the fixed restore operation.
pub const GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES: usize = 255;

/// Fixed stderr capture bound for the guest-state helper.
pub const GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

const TIMEZONE_NONE: u8 = 0;
const TIMEZONE_BEST_EFFORT: u8 = 1;
const TIMEZONE_REQUIRED: u8 = 2;

/// Typed timezone behavior for the fixed guest-state restore operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestStateRestoreTimezone<'a> {
    /// Do not change timezone state.
    None,
    /// Apply the timezone when available without failing the restore.
    BestEffort(&'a str),
    /// Require the timezone to exist and apply successfully.
    Required(&'a str),
}

/// Decoded fixed guest-state restore request.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct DecodedGuestStateRestoreRequest<'a> {
    /// Positive child-process timeout in milliseconds.
    pub timeout_ms: u32,
    /// Host realtime seconds since the Unix epoch.
    pub unix_seconds: u64,
    /// Fractional host realtime nanoseconds.
    pub unix_nanoseconds: u32,
    /// Exactly 256 host entropy bytes.
    pub entropy: &'a [u8],
    /// Optional timezone behavior.
    pub timezone: GuestStateRestoreTimezone<'a>,
}

impl std::fmt::Debug for DecodedGuestStateRestoreRequest<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DecodedGuestStateRestoreRequest")
            .field("timeout_ms", &self.timeout_ms)
            .field("unix_seconds", &self.unix_seconds)
            .field("unix_nanoseconds", &self.unix_nanoseconds)
            .field("entropy_len", &self.entropy.len())
            .field("timezone", &self.timezone)
            .finish()
    }
}

/// Encode a fixed guest-state restore request payload.
pub fn encode_guest_state_restore_request(
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
) -> Result<Vec<u8>, ProtocolError> {
    let timezone_length = validate_request(
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    )?;
    let payload_len = request_payload_len(timezone)?;
    let mut payload = Vec::with_capacity(payload_len);
    append_request_payload(
        &mut payload,
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
        timezone_length,
    );
    Ok(payload)
}

/// Encode a full fixed guest-state restore request frame into `frame`.
pub fn encode_guest_state_restore_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
) -> Result<(), ProtocolError> {
    let timezone_length = validate_request(
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    )?;
    let payload_len = request_payload_len(timezone)?;
    encode_into(frame, MSG_GUEST_STATE_RESTORE, seq, payload_len, |frame| {
        append_request_payload(
            frame,
            timeout_ms,
            unix_seconds,
            unix_nanoseconds,
            entropy,
            timezone,
            timezone_length,
        )
    })
}

/// Decode a fixed guest-state restore request payload.
pub fn decode_guest_state_restore_request(
    payload: &[u8],
) -> Result<DecodedGuestStateRestoreRequest<'_>, ProtocolError> {
    let mut offset = 0;
    let timeout_ms = read_u32(
        payload,
        &mut offset,
        "guest_state_restore timeout_ms truncated",
    )?;
    let unix_seconds = read_u64(
        payload,
        &mut offset,
        "guest_state_restore unix_seconds truncated",
    )?;
    let unix_nanoseconds = read_u32(
        payload,
        &mut offset,
        "guest_state_restore unix_nanoseconds truncated",
    )?;
    let timezone_mode = read_u8(
        payload,
        &mut offset,
        "guest_state_restore timezone_mode truncated",
    )?;
    let timezone_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_state_restore timezone_len truncated",
    )?);
    let timezone_name = read_str(
        payload,
        &mut offset,
        timezone_len,
        "guest_state_restore timezone truncated",
        "guest_state_restore timezone invalid UTF-8",
    )?;
    let entropy = read_slice(
        payload,
        &mut offset,
        GUEST_STATE_RESTORE_ENTROPY_BYTES,
        "guest_state_restore entropy truncated",
    )?;
    expect_consumed(payload, offset, "guest_state_restore trailing bytes")?;
    let timezone = decode_timezone(timezone_mode, timezone_name)?;
    validate_request(
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    )?;
    Ok(DecodedGuestStateRestoreRequest {
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    })
}

/// Encode a fixed guest-state restore terminal result payload.
pub fn encode_guest_state_restore_result(
    termination: ExecTermination,
    duration_ms: u32,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    validate_stderr(stderr)?;
    crate::encode_exec_result(
        termination,
        duration_ms,
        ExecCapturedOutput::Captured {
            bytes: &[],
            truncated: false,
        },
        stderr,
        diagnostic,
    )
}

/// Encode a full fixed guest-state restore terminal result frame.
pub fn encode_guest_state_restore_result_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<(), ProtocolError> {
    let payload = encode_guest_state_restore_result(termination, duration_ms, stderr, diagnostic)?;
    encode_into(
        frame,
        MSG_GUEST_STATE_RESTORE_RESULT,
        seq,
        payload.len(),
        |frame| frame.extend_from_slice(&payload),
    )
}

/// Decode a fixed guest-state restore terminal result payload.
pub fn decode_guest_state_restore_result(
    payload: &[u8],
) -> Result<DecodedExecResult<'_>, ProtocolError> {
    let decoded = crate::decode_exec_result(payload)?;
    match decoded.stdout {
        ExecCapturedOutput::Captured {
            bytes: [],
            truncated: false,
        } => {}
        _ => {
            return Err(ProtocolError::InvalidPayload(
                "guest_state_restore_result stdout must be empty captured output",
            ));
        }
    }
    validate_stderr(decoded.stderr)?;
    Ok(decoded)
}

fn validate_request(
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
) -> Result<u16, ProtocolError> {
    if timeout_ms == 0 {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore timeout_ms must be positive",
        ));
    }
    if unix_seconds > i64::MAX as u64 {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore unix_seconds exceed signed time range",
        ));
    }
    if unix_nanoseconds >= 1_000_000_000 {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore unix_nanoseconds must be below one second",
        ));
    }
    if entropy.len() != GUEST_STATE_RESTORE_ENTROPY_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore entropy must contain exactly 256 bytes",
        ));
    }
    let timezone_name = timezone_name(timezone);
    if timezone_name.len() > GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES {
        return Err(ProtocolError::PayloadTooLarge(
            "timezone",
            timezone_name.len(),
        ));
    }
    if !timezone_name.is_empty() && !is_safe_timezone_name(timezone_name) {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore timezone contains unsafe characters",
        ));
    }
    let length = ensure_u16_len("timezone", timezone_name.len())?;
    ensure_payload_fits_message(request_payload_len(timezone)?)?;
    Ok(length)
}

fn request_payload_len(timezone: GuestStateRestoreTimezone<'_>) -> Result<usize, ProtocolError> {
    let fixed = 4usize + 8 + 4 + 1 + 2 + GUEST_STATE_RESTORE_ENTROPY_BYTES;
    checked_payload_len_add(fixed, timezone_name(timezone).len())
}

fn append_request_payload(
    payload: &mut Vec<u8>,
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
    timezone_length: u16,
) {
    payload.extend_from_slice(&timeout_ms.to_be_bytes());
    payload.extend_from_slice(&unix_seconds.to_be_bytes());
    payload.extend_from_slice(&unix_nanoseconds.to_be_bytes());
    payload.push(timezone_tag(timezone));
    payload.extend_from_slice(&timezone_length.to_be_bytes());
    payload.extend_from_slice(timezone_name(timezone).as_bytes());
    payload.extend_from_slice(entropy);
}

fn timezone_tag(timezone: GuestStateRestoreTimezone<'_>) -> u8 {
    match timezone {
        GuestStateRestoreTimezone::None => TIMEZONE_NONE,
        GuestStateRestoreTimezone::BestEffort(_) => TIMEZONE_BEST_EFFORT,
        GuestStateRestoreTimezone::Required(_) => TIMEZONE_REQUIRED,
    }
}

fn timezone_name(timezone: GuestStateRestoreTimezone<'_>) -> &str {
    match timezone {
        GuestStateRestoreTimezone::None => "",
        GuestStateRestoreTimezone::BestEffort(name) | GuestStateRestoreTimezone::Required(name) => {
            name
        }
    }
}

fn decode_timezone(mode: u8, name: &str) -> Result<GuestStateRestoreTimezone<'_>, ProtocolError> {
    match (mode, name) {
        (TIMEZONE_NONE, "") => Ok(GuestStateRestoreTimezone::None),
        (TIMEZONE_BEST_EFFORT, "") | (TIMEZONE_REQUIRED, "") => Err(ProtocolError::InvalidPayload(
            "guest_state_restore timezone must not be empty",
        )),
        (TIMEZONE_BEST_EFFORT, name) => Ok(GuestStateRestoreTimezone::BestEffort(name)),
        (TIMEZONE_REQUIRED, name) => Ok(GuestStateRestoreTimezone::Required(name)),
        (TIMEZONE_NONE, _) => Err(ProtocolError::InvalidPayload(
            "guest_state_restore none timezone mode requires an empty name",
        )),
        _ => Err(ProtocolError::InvalidPayload(
            "guest_state_restore timezone mode is invalid",
        )),
    }
}

fn is_safe_timezone_name(timezone: &str) -> bool {
    timezone.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || byte == b'/' || byte == b'_' || byte == b'-' || byte == b'+'
    })
}

fn validate_stderr(stderr: ExecCapturedOutput<'_>) -> Result<(), ProtocolError> {
    match stderr {
        ExecCapturedOutput::Captured { bytes, .. }
            if bytes.len() <= GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES =>
        {
            Ok(())
        }
        ExecCapturedOutput::Captured { bytes, .. } => {
            Err(ProtocolError::PayloadTooLarge("stderr", bytes.len()))
        }
        ExecCapturedOutput::Discarded => Err(ProtocolError::InvalidPayload(
            "guest_state_restore_result stderr must be captured",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entropy() -> [u8; GUEST_STATE_RESTORE_ENTROPY_BYTES] {
        std::array::from_fn(|index| index as u8)
    }

    #[test]
    fn request_round_trip_preserves_fixed_inputs() {
        for timezone in [
            GuestStateRestoreTimezone::None,
            GuestStateRestoreTimezone::BestEffort("Asia/Shanghai"),
            GuestStateRestoreTimezone::Required("Etc/GMT+1"),
        ] {
            let entropy = entropy();
            let payload = encode_guest_state_restore_request(
                300_000,
                1_778_000_000,
                123_000_000,
                &entropy,
                timezone,
            )
            .unwrap();

            let decoded = decode_guest_state_restore_request(&payload).unwrap();

            assert_eq!(decoded.timeout_ms, 300_000);
            assert_eq!(decoded.unix_seconds, 1_778_000_000);
            assert_eq!(decoded.unix_nanoseconds, 123_000_000);
            assert_eq!(decoded.entropy, entropy);
            assert_eq!(decoded.timezone, timezone);
        }
    }

    #[test]
    fn request_debug_redacts_entropy_contents() {
        let entropy = [222; GUEST_STATE_RESTORE_ENTROPY_BYTES];
        let payload =
            encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
                .unwrap();
        let decoded = decode_guest_state_restore_request(&payload).unwrap();

        let debug = format!("{decoded:?}");
        assert!(debug.contains("entropy_len: 256"), "debug={debug}");
        assert!(!debug.contains("222, 222"), "debug={debug}");
    }

    #[test]
    fn request_rejects_invalid_fixed_inputs() {
        let entropy = entropy();
        assert!(
            encode_guest_state_restore_request(0, 1, 0, &entropy, GuestStateRestoreTimezone::None)
                .is_err()
        );
        assert!(
            encode_guest_state_restore_request(
                1,
                i64::MAX as u64 + 1,
                0,
                &entropy,
                GuestStateRestoreTimezone::None
            )
            .is_err()
        );
        assert!(
            encode_guest_state_restore_request(
                1,
                1,
                1_000_000_000,
                &entropy,
                GuestStateRestoreTimezone::None
            )
            .is_err()
        );
        assert!(
            encode_guest_state_restore_request(
                1,
                1,
                0,
                &entropy[..255],
                GuestStateRestoreTimezone::None
            )
            .is_err()
        );
        assert!(
            encode_guest_state_restore_request(
                1,
                1,
                0,
                &entropy,
                GuestStateRestoreTimezone::Required("../UTC")
            )
            .is_err()
        );
        let oversized_timezone = "A".repeat(GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES + 1);
        assert!(
            encode_guest_state_restore_request(
                1,
                1,
                0,
                &entropy,
                GuestStateRestoreTimezone::Required(&oversized_timezone)
            )
            .is_err()
        );
    }

    #[test]
    fn request_decoder_rejects_bad_mode_length_and_trailing_bytes() {
        let entropy = entropy();
        let mut payload =
            encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
                .unwrap();
        payload[16] = TIMEZONE_REQUIRED;
        assert!(decode_guest_state_restore_request(&payload).is_err());

        let mut invalid_mode =
            encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
                .unwrap();
        invalid_mode[16] = u8::MAX;
        assert!(decode_guest_state_restore_request(&invalid_mode).is_err());

        let mut none_with_name = encode_guest_state_restore_request(
            1,
            1,
            0,
            &entropy,
            GuestStateRestoreTimezone::BestEffort("UTC"),
        )
        .unwrap();
        none_with_name[16] = TIMEZONE_NONE;
        assert!(decode_guest_state_restore_request(&none_with_name).is_err());

        let mut invalid_utf8 = encode_guest_state_restore_request(
            1,
            1,
            0,
            &entropy,
            GuestStateRestoreTimezone::Required("A"),
        )
        .unwrap();
        invalid_utf8[19] = u8::MAX;
        assert!(decode_guest_state_restore_request(&invalid_utf8).is_err());

        let mut truncated = payload;
        truncated.pop();
        assert!(decode_guest_state_restore_request(&truncated).is_err());

        let mut trailing =
            encode_guest_state_restore_request(1, 1, 0, &entropy, GuestStateRestoreTimezone::None)
                .unwrap();
        trailing.push(0);
        assert!(decode_guest_state_restore_request(&trailing).is_err());
    }

    #[test]
    fn result_round_trip_requires_empty_stdout_and_bounded_stderr() {
        let stderr = ExecCapturedOutput::Captured {
            bytes: b"guest-reseed failed",
            truncated: false,
        };
        let payload = encode_guest_state_restore_result(
            ExecTermination::Exited { exit_code: 1 },
            17,
            stderr,
            "diagnostic",
        )
        .unwrap();

        let decoded = decode_guest_state_restore_result(&payload).unwrap();
        assert_eq!(
            decoded.termination,
            ExecTermination::Exited { exit_code: 1 }
        );
        assert_eq!(decoded.duration_ms, 17);
        assert_eq!(
            decoded.stdout,
            ExecCapturedOutput::Captured {
                bytes: &[],
                truncated: false
            }
        );
        assert_eq!(decoded.stderr, stderr);
        assert_eq!(decoded.diagnostic, "diagnostic");

        assert!(
            encode_guest_state_restore_result(
                ExecTermination::WaitFailed,
                0,
                ExecCapturedOutput::Discarded,
                ""
            )
            .is_err()
        );
    }
}
