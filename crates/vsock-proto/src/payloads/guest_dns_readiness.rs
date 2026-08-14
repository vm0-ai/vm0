use crate::ProtocolError;
use crate::frame::encode_into;
use crate::read::{expect_consumed, read_i32, read_slice, read_str, read_u8, read_u16, read_u32};
use crate::wire::MSG_GUEST_DNS_READINESS;

const TERMINATION_EXITED: u8 = 0x00;
const TERMINATION_TIMED_OUT: u8 = 0x01;
const TERMINATION_CANCELLED: u8 = 0x02;
const TERMINATION_START_FAILED: u8 = 0x03;
const TERMINATION_WAIT_FAILED: u8 = 0x04;
const RESULT_FLAG_OUTPUT_TRUNCATED: u8 = 0x01;

/// Maximum encoded hostname length accepted by a guest DNS readiness request.
pub const GUEST_DNS_READINESS_MAX_HOSTNAME_BYTES: usize = 253;

/// Maximum retained answer bytes in a guest DNS readiness result.
pub const GUEST_DNS_READINESS_MAX_ANSWER_BYTES: usize = 1_024;

/// Maximum retained diagnostic bytes in a guest DNS readiness result.
pub const GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES: usize = 512;

/// Decoded guest DNS readiness request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedGuestDnsReadinessRequest<'a> {
    /// Positive child-process timeout in milliseconds.
    pub timeout_ms: u32,
    /// Hostname passed as one argument to the fixed guest resolver command.
    pub hostname: &'a str,
}

/// Terminal state of the fixed guest DNS readiness process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestDnsReadinessTermination {
    /// The process exited with the supplied exit code.
    Exited {
        /// Process exit code, with signals represented as `128 + signal`.
        exit_code: i32,
    },
    /// The process exceeded its request timeout and was killed.
    TimedOut,
    /// The owning guest connection was cancelled and the process was killed.
    Cancelled,
    /// The process could not be started.
    StartFailed,
    /// Waiting for or cleaning up the process failed.
    WaitFailed,
}

/// Decoded result of the fixed guest DNS readiness process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedGuestDnsReadinessResult<'a> {
    /// Terminal process state.
    pub termination: GuestDnsReadinessTermination,
    /// Guest-observed operation duration in milliseconds.
    pub duration_ms: u32,
    /// Retained raw stdout containing resolver answers.
    pub answer: &'a [u8],
    /// Whether stdout or stderr exceeded its retained bound.
    pub output_truncated: bool,
    /// Bounded UTF-8 process or internal diagnostic.
    pub diagnostic: &'a str,
}

/// Encode a guest DNS readiness request payload.
pub fn encode_guest_dns_readiness_request(
    timeout_ms: u32,
    hostname: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let hostname_len = validate_request(timeout_ms, hostname)?;
    let mut payload = Vec::with_capacity(6 + hostname.len());
    append_request_payload(&mut payload, timeout_ms, hostname_len, hostname);
    Ok(payload)
}

/// Encode a full guest DNS readiness request frame into `frame`.
pub fn encode_guest_dns_readiness_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    timeout_ms: u32,
    hostname: &str,
) -> Result<(), ProtocolError> {
    let hostname_len = validate_request(timeout_ms, hostname)?;
    let payload_len = 6 + hostname.len();
    encode_into(frame, MSG_GUEST_DNS_READINESS, seq, payload_len, |frame| {
        append_request_payload(frame, timeout_ms, hostname_len, hostname)
    })
}

/// Decode a guest DNS readiness request payload.
pub fn decode_guest_dns_readiness_request(
    payload: &[u8],
) -> Result<DecodedGuestDnsReadinessRequest<'_>, ProtocolError> {
    let mut offset = 0;
    let timeout_ms = read_u32(
        payload,
        &mut offset,
        "guest_dns_readiness timeout_ms truncated",
    )?;
    let hostname_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_dns_readiness hostname_len truncated",
    )?);
    let hostname = read_str(
        payload,
        &mut offset,
        hostname_len,
        "guest_dns_readiness hostname truncated",
        "guest_dns_readiness hostname invalid UTF-8",
    )?;
    expect_consumed(payload, offset, "guest_dns_readiness trailing bytes")?;
    validate_request(timeout_ms, hostname)?;
    Ok(DecodedGuestDnsReadinessRequest {
        timeout_ms,
        hostname,
    })
}

/// Encode a guest DNS readiness result payload.
pub fn encode_guest_dns_readiness_result(
    termination: GuestDnsReadinessTermination,
    duration_ms: u32,
    answer: &[u8],
    output_truncated: bool,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let encoded = validate_result(answer, diagnostic)?;
    let mut payload = Vec::with_capacity(result_payload_len(termination, answer, diagnostic));
    append_result_payload(
        &mut payload,
        termination,
        duration_ms,
        answer,
        output_truncated,
        diagnostic,
        encoded,
    );
    Ok(payload)
}

/// Decode a guest DNS readiness result payload.
pub fn decode_guest_dns_readiness_result(
    payload: &[u8],
) -> Result<DecodedGuestDnsReadinessResult<'_>, ProtocolError> {
    let mut offset = 0;
    let termination = decode_termination(payload, &mut offset)?;
    let duration_ms = read_u32(
        payload,
        &mut offset,
        "guest_dns_readiness_result duration_ms truncated",
    )?;
    let flags = read_u8(
        payload,
        &mut offset,
        "guest_dns_readiness_result flags truncated",
    )?;
    if flags & !RESULT_FLAG_OUTPUT_TRUNCATED != 0 {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result unknown flags",
        ));
    }
    let answer_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_dns_readiness_result answer_len truncated",
    )?);
    if answer_len > GUEST_DNS_READINESS_MAX_ANSWER_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result answer exceeds limit",
        ));
    }
    let answer = read_slice(
        payload,
        &mut offset,
        answer_len,
        "guest_dns_readiness_result answer truncated",
    )?;
    let diagnostic_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_dns_readiness_result diagnostic_len truncated",
    )?);
    if diagnostic_len > GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result diagnostic exceeds limit",
        ));
    }
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        "guest_dns_readiness_result diagnostic truncated",
        "guest_dns_readiness_result diagnostic invalid UTF-8",
    )?;
    expect_consumed(payload, offset, "guest_dns_readiness_result trailing bytes")?;
    Ok(DecodedGuestDnsReadinessResult {
        termination,
        duration_ms,
        answer,
        output_truncated: flags & RESULT_FLAG_OUTPUT_TRUNCATED != 0,
        diagnostic,
    })
}

fn validate_request(timeout_ms: u32, hostname: &str) -> Result<u16, ProtocolError> {
    if timeout_ms == 0 {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness timeout_ms must be positive",
        ));
    }
    if hostname.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness hostname must not be empty",
        ));
    }
    if hostname.len() > GUEST_DNS_READINESS_MAX_HOSTNAME_BYTES {
        return Err(ProtocolError::PayloadTooLarge("hostname", hostname.len()));
    }
    if hostname.as_bytes().contains(&0) {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness hostname contains NUL",
        ));
    }
    u16::try_from(hostname.len())
        .map_err(|_| ProtocolError::PayloadTooLarge("hostname", hostname.len()))
}

fn append_request_payload(
    payload: &mut Vec<u8>,
    timeout_ms: u32,
    hostname_len: u16,
    hostname: &str,
) {
    payload.extend_from_slice(&timeout_ms.to_be_bytes());
    payload.extend_from_slice(&hostname_len.to_be_bytes());
    payload.extend_from_slice(hostname.as_bytes());
}

#[derive(Clone, Copy)]
struct EncodedResultLengths {
    answer_len: u16,
    diagnostic_len: u16,
}

fn validate_result(answer: &[u8], diagnostic: &str) -> Result<EncodedResultLengths, ProtocolError> {
    if answer.len() > GUEST_DNS_READINESS_MAX_ANSWER_BYTES {
        return Err(ProtocolError::PayloadTooLarge("answer", answer.len()));
    }
    if diagnostic.len() > GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES {
        return Err(ProtocolError::PayloadTooLarge(
            "diagnostic",
            diagnostic.len(),
        ));
    }
    Ok(EncodedResultLengths {
        answer_len: u16::try_from(answer.len())
            .map_err(|_| ProtocolError::PayloadTooLarge("answer", answer.len()))?,
        diagnostic_len: u16::try_from(diagnostic.len())
            .map_err(|_| ProtocolError::PayloadTooLarge("diagnostic", diagnostic.len()))?,
    })
}

fn result_payload_len(
    termination: GuestDnsReadinessTermination,
    answer: &[u8],
    diagnostic: &str,
) -> usize {
    let termination_len = match termination {
        GuestDnsReadinessTermination::Exited { .. } => 5,
        GuestDnsReadinessTermination::TimedOut
        | GuestDnsReadinessTermination::Cancelled
        | GuestDnsReadinessTermination::StartFailed
        | GuestDnsReadinessTermination::WaitFailed => 1,
    };
    termination_len + 4 + 1 + 2 + answer.len() + 2 + diagnostic.len()
}

fn append_result_payload(
    payload: &mut Vec<u8>,
    termination: GuestDnsReadinessTermination,
    duration_ms: u32,
    answer: &[u8],
    output_truncated: bool,
    diagnostic: &str,
    encoded: EncodedResultLengths,
) {
    match termination {
        GuestDnsReadinessTermination::Exited { exit_code } => {
            payload.push(TERMINATION_EXITED);
            payload.extend_from_slice(&exit_code.to_be_bytes());
        }
        GuestDnsReadinessTermination::TimedOut => payload.push(TERMINATION_TIMED_OUT),
        GuestDnsReadinessTermination::Cancelled => payload.push(TERMINATION_CANCELLED),
        GuestDnsReadinessTermination::StartFailed => payload.push(TERMINATION_START_FAILED),
        GuestDnsReadinessTermination::WaitFailed => payload.push(TERMINATION_WAIT_FAILED),
    }
    payload.extend_from_slice(&duration_ms.to_be_bytes());
    payload.push(u8::from(output_truncated) * RESULT_FLAG_OUTPUT_TRUNCATED);
    payload.extend_from_slice(&encoded.answer_len.to_be_bytes());
    payload.extend_from_slice(answer);
    payload.extend_from_slice(&encoded.diagnostic_len.to_be_bytes());
    payload.extend_from_slice(diagnostic.as_bytes());
}

fn decode_termination(
    payload: &[u8],
    offset: &mut usize,
) -> Result<GuestDnsReadinessTermination, ProtocolError> {
    match read_u8(
        payload,
        offset,
        "guest_dns_readiness_result termination truncated",
    )? {
        TERMINATION_EXITED => Ok(GuestDnsReadinessTermination::Exited {
            exit_code: read_i32(
                payload,
                offset,
                "guest_dns_readiness_result exit_code truncated",
            )?,
        }),
        TERMINATION_TIMED_OUT => Ok(GuestDnsReadinessTermination::TimedOut),
        TERMINATION_CANCELLED => Ok(GuestDnsReadinessTermination::Cancelled),
        TERMINATION_START_FAILED => Ok(GuestDnsReadinessTermination::StartFailed),
        TERMINATION_WAIT_FAILED => Ok(GuestDnsReadinessTermination::WaitFailed),
        _ => Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result unknown termination",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrips() {
        let payload = encode_guest_dns_readiness_request(1_100, "vm0-readiness.invalid").unwrap();
        assert_eq!(
            decode_guest_dns_readiness_request(&payload).unwrap(),
            DecodedGuestDnsReadinessRequest {
                timeout_ms: 1_100,
                hostname: "vm0-readiness.invalid",
            }
        );
    }

    #[test]
    fn request_frame_matches_payload_encoding() {
        let payload = encode_guest_dns_readiness_request(1_100, "example.invalid").unwrap();
        let expected = crate::encode(MSG_GUEST_DNS_READINESS, 42, &payload).unwrap();
        let mut frame = Vec::new();
        encode_guest_dns_readiness_request_frame_into(&mut frame, 42, 1_100, "example.invalid")
            .unwrap();
        assert_eq!(frame, expected);
    }

    #[test]
    fn request_rejects_invalid_values_and_shape() {
        assert!(encode_guest_dns_readiness_request(0, "example.invalid").is_err());
        assert!(encode_guest_dns_readiness_request(1, "").is_err());
        assert!(encode_guest_dns_readiness_request(1, &"x".repeat(254)).is_err());
        assert!(encode_guest_dns_readiness_request(1, "bad\0name").is_err());

        let valid = encode_guest_dns_readiness_request(1, "example.invalid").unwrap();
        for malformed in [valid[..5].to_vec(), [&valid[..], &[0]].concat()] {
            assert!(decode_guest_dns_readiness_request(&malformed).is_err());
        }
    }

    #[test]
    fn result_roundtrips_each_termination() {
        for termination in [
            GuestDnsReadinessTermination::Exited { exit_code: 0 },
            GuestDnsReadinessTermination::Exited { exit_code: 2 },
            GuestDnsReadinessTermination::TimedOut,
            GuestDnsReadinessTermination::Cancelled,
            GuestDnsReadinessTermination::StartFailed,
            GuestDnsReadinessTermination::WaitFailed,
        ] {
            let payload = encode_guest_dns_readiness_result(
                termination,
                17,
                b"192.0.2.1 STREAM\n",
                true,
                "diagnostic",
            )
            .unwrap();
            assert_eq!(
                decode_guest_dns_readiness_result(&payload).unwrap(),
                DecodedGuestDnsReadinessResult {
                    termination,
                    duration_ms: 17,
                    answer: b"192.0.2.1 STREAM\n",
                    output_truncated: true,
                    diagnostic: "diagnostic",
                }
            );
        }
    }

    #[test]
    fn result_enforces_bounds() {
        assert!(
            encode_guest_dns_readiness_result(
                GuestDnsReadinessTermination::TimedOut,
                1,
                &vec![0; GUEST_DNS_READINESS_MAX_ANSWER_BYTES + 1],
                false,
                "",
            )
            .is_err()
        );
        assert!(
            encode_guest_dns_readiness_result(
                GuestDnsReadinessTermination::TimedOut,
                1,
                b"",
                false,
                &"x".repeat(GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES + 1),
            )
            .is_err()
        );
    }

    #[test]
    fn result_rejects_unknown_and_malformed_values() {
        let valid = encode_guest_dns_readiness_result(
            GuestDnsReadinessTermination::Exited { exit_code: 0 },
            1,
            b"answer",
            false,
            "",
        )
        .unwrap();

        let mut unknown_termination = valid.clone();
        unknown_termination[0] = 0xFF;
        assert!(decode_guest_dns_readiness_result(&unknown_termination).is_err());

        let mut unknown_flags = valid.clone();
        unknown_flags[9] = 0x80;
        assert!(decode_guest_dns_readiness_result(&unknown_flags).is_err());

        for malformed in [
            valid[..valid.len() - 1].to_vec(),
            [&valid[..], &[0]].concat(),
        ] {
            assert!(decode_guest_dns_readiness_result(&malformed).is_err());
        }
    }
}
