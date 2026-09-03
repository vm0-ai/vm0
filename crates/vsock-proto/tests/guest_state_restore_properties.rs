use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};
use vsock_proto::{
    DecodedExecResult, DecodedGuestStateRestoreRequest, ExecCapturedOutput, ExecTermination,
    GUEST_STATE_RESTORE_ENTROPY_BYTES, GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES,
    GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES, GuestStateRestoreTimezone, MSG_GUEST_STATE_RESTORE,
    MSG_GUEST_STATE_RESTORE_RESULT, ProtocolError, decode_guest_state_restore_request,
    decode_guest_state_restore_result, encode, encode_exec_result,
    encode_guest_state_restore_request, encode_guest_state_restore_request_frame_into,
    encode_guest_state_restore_result, encode_guest_state_restore_result_frame_into,
};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0x6E57_57A7_2026_0903;
const MAX_GENERATED_TIMEZONE_BYTES: usize = 32;
const MAX_GENERATED_OUTPUT_BYTES: usize = 64;
const MAX_GENERATED_TEXT_CHARS: usize = 12;
const MAX_ARBITRARY_PAYLOAD_BYTES: usize = 512;

const TIMEOUT_OFFSET: usize = 0;
const UNIX_SECONDS_OFFSET: usize = 4;
const UNIX_NANOSECONDS_OFFSET: usize = 12;
const TIMEZONE_MODE_OFFSET: usize = 16;
const TIMEZONE_LENGTH_OFFSET: usize = 17;
const TIMEZONE_NAME_OFFSET: usize = 19;

const TIMEZONE_NONE: u8 = 0;
const TIMEZONE_REQUIRED: u8 = 2;

#[derive(Clone, Debug)]
enum OwnedTimezone {
    None,
    BestEffort(String),
    Required(String),
}

impl OwnedTimezone {
    fn borrowed(&self) -> GuestStateRestoreTimezone<'_> {
        match self {
            Self::None => GuestStateRestoreTimezone::None,
            Self::BestEffort(name) => GuestStateRestoreTimezone::BestEffort(name),
            Self::Required(name) => GuestStateRestoreTimezone::Required(name),
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::None => "",
            Self::BestEffort(name) | Self::Required(name) => name,
        }
    }
}

#[derive(Clone, Debug)]
struct OwnedRequest {
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: Vec<u8>,
    timezone: OwnedTimezone,
}

impl OwnedRequest {
    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        encode_guest_state_restore_request(
            self.timeout_ms,
            self.unix_seconds,
            self.unix_nanoseconds,
            &self.entropy,
            self.timezone.borrowed(),
        )
    }

    fn assert_decoded(&self, decoded: &DecodedGuestStateRestoreRequest<'_>) -> TestCaseResult {
        prop_assert_eq!(decoded.timeout_ms, self.timeout_ms);
        prop_assert_eq!(decoded.unix_seconds, self.unix_seconds);
        prop_assert_eq!(decoded.unix_nanoseconds, self.unix_nanoseconds);
        prop_assert_eq!(decoded.entropy, self.entropy.as_slice());
        prop_assert_eq!(decoded.timezone, self.timezone.borrowed());
        Ok(())
    }

    fn invalid_mutations(
        &self,
        payload: &[u8],
    ) -> Result<Vec<(&'static str, Vec<u8>)>, TestCaseError> {
        let mut invalid_utf8 = payload.to_vec();
        invalid_utf8.insert(TIMEZONE_NAME_OFFSET, u8::MAX);
        invalid_utf8 = with_u16(
            &invalid_utf8,
            TIMEZONE_LENGTH_OFFSET,
            u16::try_from(self.timezone.name().len() + 1)
                .map_err(|_| TestCaseError::fail("timezone mutation length overflow"))?,
        )?;

        let mut unsafe_timezone = payload.to_vec();
        if self.timezone.name().is_empty() {
            unsafe_timezone.insert(TIMEZONE_NAME_OFFSET, b'.');
            unsafe_timezone = with_byte(&unsafe_timezone, TIMEZONE_MODE_OFFSET, TIMEZONE_REQUIRED)?;
            unsafe_timezone = with_u16(&unsafe_timezone, TIMEZONE_LENGTH_OFFSET, 1)?;
        } else {
            unsafe_timezone = with_byte(&unsafe_timezone, TIMEZONE_NAME_OFFSET, b'.')?;
        }

        let mismatched_mode = match self.timezone {
            OwnedTimezone::None => TIMEZONE_REQUIRED,
            OwnedTimezone::BestEffort(_) | OwnedTimezone::Required(_) => TIMEZONE_NONE,
        };

        let mut short_entropy = payload.to_vec();
        short_entropy.pop();
        let mut extra_entropy = payload.to_vec();
        extra_entropy.push(0);

        Ok(vec![
            ("zero timeout", with_u32(payload, TIMEOUT_OFFSET, 0)?),
            (
                "unix seconds outside signed range",
                with_u64(payload, UNIX_SECONDS_OFFSET, i64::MAX as u64 + 1)?,
            ),
            (
                "nanoseconds at one second",
                with_u32(payload, UNIX_NANOSECONDS_OFFSET, 1_000_000_000)?,
            ),
            (
                "invalid timezone mode",
                with_byte(payload, TIMEZONE_MODE_OFFSET, u8::MAX)?,
            ),
            (
                "mismatched timezone mode",
                with_byte(payload, TIMEZONE_MODE_OFFSET, mismatched_mode)?,
            ),
            (
                "timezone length beyond remaining payload",
                with_u16(payload, TIMEZONE_LENGTH_OFFSET, u16::MAX)?,
            ),
            ("invalid timezone UTF-8", invalid_utf8),
            ("unsafe timezone character", unsafe_timezone),
            ("short entropy", short_entropy),
            ("extra entropy byte", extra_entropy),
        ])
    }
}

#[derive(Clone, Debug)]
struct OwnedResult {
    termination: ExecTermination,
    duration_ms: u32,
    stderr: Vec<u8>,
    stderr_truncated: bool,
    diagnostic: String,
}

impl OwnedResult {
    fn stderr(&self) -> ExecCapturedOutput<'_> {
        ExecCapturedOutput::Captured {
            bytes: &self.stderr,
            truncated: self.stderr_truncated,
        }
    }

    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        encode_guest_state_restore_result(
            self.termination,
            self.duration_ms,
            self.stderr(),
            &self.diagnostic,
        )
    }

    fn assert_decoded(&self, decoded: &DecodedExecResult<'_>) -> TestCaseResult {
        prop_assert_eq!(decoded.termination, self.termination);
        prop_assert_eq!(decoded.duration_ms, self.duration_ms);
        prop_assert_eq!(decoded.stdout, empty_stdout());
        prop_assert_eq!(decoded.stderr, self.stderr());
        prop_assert_eq!(decoded.diagnostic, self.diagnostic.as_str());
        Ok(())
    }
}

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn safe_timezone_char_strategy() -> impl Strategy<Value = char> {
    prop_oneof![
        8 => proptest::char::range('a', 'z'),
        2 => proptest::char::range('A', 'Z'),
        2 => proptest::char::range('0', '9'),
        1 => Just('/'),
        1 => Just('_'),
        1 => Just('-'),
        1 => Just('+'),
    ]
}

fn timezone_name_strategy() -> impl Strategy<Value = String> {
    prop_oneof![
        1 => Just("A".to_owned()),
        1 => Just("A".repeat(GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES)),
        6 => proptest::collection::vec(
            safe_timezone_char_strategy(),
            1..=MAX_GENERATED_TIMEZONE_BYTES,
        )
        .prop_map(|characters| characters.into_iter().collect()),
    ]
}

fn timezone_strategy() -> impl Strategy<Value = OwnedTimezone> {
    prop_oneof![
        1 => Just(OwnedTimezone::None),
        2 => timezone_name_strategy().prop_map(OwnedTimezone::BestEffort),
        2 => timezone_name_strategy().prop_map(OwnedTimezone::Required),
    ]
}

fn request_strategy() -> impl Strategy<Value = OwnedRequest> {
    (
        prop_oneof![Just(1), Just(u32::MAX), 1..=u32::MAX],
        prop_oneof![Just(0), Just(i64::MAX as u64), 0..=i64::MAX as u64],
        prop_oneof![Just(0), Just(999_999_999), 0..1_000_000_000u32],
        proptest::collection::vec(
            any::<u8>(),
            GUEST_STATE_RESTORE_ENTROPY_BYTES..=GUEST_STATE_RESTORE_ENTROPY_BYTES,
        ),
        timezone_strategy(),
    )
        .prop_map(
            |(timeout_ms, unix_seconds, unix_nanoseconds, entropy, timezone)| OwnedRequest {
                timeout_ms,
                unix_seconds,
                unix_nanoseconds,
                entropy,
                timezone,
            },
        )
}

fn arbitrary_or_valid_request_payload_strategy()
-> impl Strategy<Value = Result<Vec<u8>, ProtocolError>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES)
            .prop_map(Ok),
        1 => request_strategy().prop_map(|request| request.encode()),
    ]
}

fn termination_strategy() -> impl Strategy<Value = ExecTermination> {
    prop_oneof![
        any::<i32>().prop_map(|exit_code| ExecTermination::Exited { exit_code }),
        Just(ExecTermination::TimedOut),
        Just(ExecTermination::Cancelled),
        Just(ExecTermination::StartFailed),
        Just(ExecTermination::WaitFailed),
    ]
}

fn text_char_strategy() -> impl Strategy<Value = char> {
    prop_oneof![
        5 => proptest::char::range('a', 'z'),
        1 => Just('-'),
        1 => Just('界'),
        1 => Just('🧪'),
    ]
}

fn text_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(text_char_strategy(), 0..=MAX_GENERATED_TEXT_CHARS)
        .prop_map(|characters| characters.into_iter().collect())
}

fn result_strategy() -> impl Strategy<Value = OwnedResult> {
    (
        termination_strategy(),
        prop_oneof![Just(0), Just(u32::MAX), any::<u32>()],
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_OUTPUT_BYTES),
        any::<bool>(),
        text_strategy(),
    )
        .prop_map(
            |(termination, duration_ms, stderr, stderr_truncated, diagnostic)| OwnedResult {
                termination,
                duration_ms,
                stderr,
                stderr_truncated,
                diagnostic,
            },
        )
}

fn arbitrary_or_valid_result_payload_strategy()
-> impl Strategy<Value = Result<Vec<u8>, ProtocolError>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES)
            .prop_map(Ok),
        1 => result_strategy().prop_map(|result| result.encode()),
    ]
}

fn empty_stdout() -> ExecCapturedOutput<'static> {
    ExecCapturedOutput::Captured {
        bytes: b"",
        truncated: false,
    }
}

fn is_safe_timezone_name(timezone: &str) -> bool {
    timezone.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || byte == b'/' || byte == b'_' || byte == b'-' || byte == b'+'
    })
}

fn with_byte(payload: &[u8], offset: usize, value: u8) -> Result<Vec<u8>, TestCaseError> {
    let mut mutation = payload.to_vec();
    let byte = mutation.get_mut(offset).ok_or_else(|| {
        TestCaseError::fail(format!(
            "failed to read mutation byte at {offset} of {} bytes",
            payload.len(),
        ))
    })?;
    *byte = value;
    Ok(mutation)
}

fn with_u16(payload: &[u8], offset: usize, value: u16) -> Result<Vec<u8>, TestCaseError> {
    let mut mutation = payload.to_vec();
    let field = mutation.get_mut(offset..offset + 2).ok_or_else(|| {
        TestCaseError::fail(format!(
            "failed to read u16 mutation at {offset} of {} bytes",
            payload.len(),
        ))
    })?;
    field.copy_from_slice(&value.to_be_bytes());
    Ok(mutation)
}

fn with_u32(payload: &[u8], offset: usize, value: u32) -> Result<Vec<u8>, TestCaseError> {
    let mut mutation = payload.to_vec();
    let field = mutation.get_mut(offset..offset + 4).ok_or_else(|| {
        TestCaseError::fail(format!(
            "failed to read u32 mutation at {offset} of {} bytes",
            payload.len(),
        ))
    })?;
    field.copy_from_slice(&value.to_be_bytes());
    Ok(mutation)
}

fn with_u64(payload: &[u8], offset: usize, value: u64) -> Result<Vec<u8>, TestCaseError> {
    let mut mutation = payload.to_vec();
    let field = mutation.get_mut(offset..offset + 8).ok_or_else(|| {
        TestCaseError::fail(format!(
            "failed to read u64 mutation at {offset} of {} bytes",
            payload.len(),
        ))
    })?;
    field.copy_from_slice(&value.to_be_bytes());
    Ok(mutation)
}

fn assert_strict_prefixes_rejected(payload: &[u8]) -> TestCaseResult {
    for prefix_len in 0..payload.len() {
        let prefix = payload.get(..prefix_len).ok_or_else(|| {
            TestCaseError::fail(format!(
                "failed to read strict prefix ending at {prefix_len} of {} bytes",
                payload.len(),
            ))
        })?;
        prop_assert!(
            decode_guest_state_restore_request(prefix).is_err(),
            "accepted strict prefix ending at {prefix_len} of {} bytes",
            payload.len(),
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_requests_roundtrip_reject_prefixes_and_match_frames(
        request in request_strategy(),
        seq in any::<u32>(),
    ) {
        let payload = request.encode();
        prop_assert!(payload.is_ok(), "generated request failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_guest_state_restore_request(&payload);
        prop_assert!(decoded.is_ok(), "encoded request failed to decode: {decoded:?}");
        let decoded = decoded.unwrap();
        request.assert_decoded(&decoded)?;

        let reencoded = encode_guest_state_restore_request(
            decoded.timeout_ms,
            decoded.unix_seconds,
            decoded.unix_nanoseconds,
            decoded.entropy,
            decoded.timezone,
        );
        prop_assert!(reencoded.is_ok(), "decoded request failed to re-encode: {reencoded:?}");
        prop_assert_eq!(reencoded.unwrap(), payload.as_slice());

        assert_strict_prefixes_rejected(&payload)?;

        let expected_frame = encode(MSG_GUEST_STATE_RESTORE, seq, &payload);
        prop_assert!(expected_frame.is_ok(), "generic request frame failed: {expected_frame:?}");
        let mut direct_frame = Vec::new();
        let direct_result = encode_guest_state_restore_request_frame_into(
            &mut direct_frame,
            seq,
            request.timeout_ms,
            request.unix_seconds,
            request.unix_nanoseconds,
            &request.entropy,
            request.timezone.borrowed(),
        );
        prop_assert!(direct_result.is_ok(), "direct request frame failed: {direct_result:?}");
        prop_assert_eq!(direct_frame, expected_frame.unwrap());
    }

    #[test]
    fn arbitrary_request_payloads_never_panic_and_reencode_canonically(
        payload_result in arbitrary_or_valid_request_payload_strategy(),
    ) {
        let payload = payload_result.map_err(|error| {
            TestCaseError::fail(format!("generated request failed to encode: {error}"))
        })?;
        if let Ok(decoded) = decode_guest_state_restore_request(&payload) {
            prop_assert!(decoded.timeout_ms > 0);
            prop_assert!(decoded.unix_seconds <= i64::MAX as u64);
            prop_assert!(decoded.unix_nanoseconds < 1_000_000_000);
            prop_assert_eq!(decoded.entropy.len(), GUEST_STATE_RESTORE_ENTROPY_BYTES);
            match decoded.timezone {
                GuestStateRestoreTimezone::None => {}
                GuestStateRestoreTimezone::BestEffort(name)
                | GuestStateRestoreTimezone::Required(name) => {
                    prop_assert!(!name.is_empty());
                    prop_assert!(name.len() <= GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES);
                    prop_assert!(is_safe_timezone_name(name));
                }
            }

            let reencoded = encode_guest_state_restore_request(
                decoded.timeout_ms,
                decoded.unix_seconds,
                decoded.unix_nanoseconds,
                decoded.entropy,
                decoded.timezone,
            );
            prop_assert!(reencoded.is_ok(), "decoded request failed to re-encode: {reencoded:?}");
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }

    #[test]
    fn generated_invalid_request_mutations_are_rejected(request in request_strategy()) {
        let payload = request.encode();
        prop_assert!(payload.is_ok(), "generated request failed to encode: {payload:?}");
        let payload = payload.unwrap();

        for (name, mutation) in request.invalid_mutations(&payload)? {
            prop_assert!(
                decode_guest_state_restore_request(&mutation).is_err(),
                "accepted {name} mutation: {mutation:?}",
            );
        }
    }

    #[test]
    fn generated_results_roundtrip_canonically_and_match_frames(
        result in result_strategy(),
        seq in any::<u32>(),
    ) {
        let payload = result.encode();
        prop_assert!(payload.is_ok(), "generated result failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_guest_state_restore_result(&payload);
        prop_assert!(decoded.is_ok(), "encoded result failed to decode: {decoded:?}");
        let decoded = decoded.unwrap();
        result.assert_decoded(&decoded)?;

        let reencoded = encode_guest_state_restore_result(
            decoded.termination,
            decoded.duration_ms,
            decoded.stderr,
            decoded.diagnostic,
        );
        prop_assert!(reencoded.is_ok(), "decoded result failed to re-encode: {reencoded:?}");
        prop_assert_eq!(reencoded.unwrap(), payload.as_slice());

        let expected_frame = encode(MSG_GUEST_STATE_RESTORE_RESULT, seq, &payload);
        prop_assert!(expected_frame.is_ok(), "generic result frame failed: {expected_frame:?}");
        let mut direct_frame = Vec::new();
        let direct_result = encode_guest_state_restore_result_frame_into(
            &mut direct_frame,
            seq,
            result.termination,
            result.duration_ms,
            result.stderr(),
            &result.diagnostic,
        );
        prop_assert!(direct_result.is_ok(), "direct result frame failed: {direct_result:?}");
        prop_assert_eq!(direct_frame, expected_frame.unwrap());
    }

    #[test]
    fn arbitrary_result_payloads_never_panic_and_reencode_canonically(
        payload_result in arbitrary_or_valid_result_payload_strategy(),
    ) {
        let payload = payload_result.map_err(|error| {
            TestCaseError::fail(format!("generated result failed to encode: {error}"))
        })?;
        if let Ok(decoded) = decode_guest_state_restore_result(&payload) {
            prop_assert_eq!(decoded.stdout, empty_stdout());
            let ExecCapturedOutput::Captured { bytes, .. } = decoded.stderr else {
                return Err(TestCaseError::fail("accepted discarded stderr"));
            };
            prop_assert!(bytes.len() <= GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES);

            let reencoded = encode_guest_state_restore_result(
                decoded.termination,
                decoded.duration_ms,
                decoded.stderr,
                decoded.diagnostic,
            );
            prop_assert!(reencoded.is_ok(), "decoded result failed to re-encode: {reencoded:?}");
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }

    #[test]
    fn generated_noncanonical_result_shapes_are_rejected(
        termination in termination_strategy(),
        duration_ms in any::<u32>(),
        invalid_stdout_kind in 0u8..3,
        stdout_bytes in proptest::collection::vec(any::<u8>(), 1..=MAX_GENERATED_OUTPUT_BYTES),
        stdout_truncated in any::<bool>(),
        stderr_bytes in proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_OUTPUT_BYTES),
        stderr_truncated in any::<bool>(),
        diagnostic in text_strategy(),
    ) {
        let invalid_stdout = match invalid_stdout_kind {
            0 => ExecCapturedOutput::Discarded,
            1 => ExecCapturedOutput::Captured {
                bytes: &stdout_bytes,
                truncated: stdout_truncated,
            },
            _ => ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: true,
            },
        };
        let valid_stderr = ExecCapturedOutput::Captured {
            bytes: &stderr_bytes,
            truncated: stderr_truncated,
        };
        let invalid_stdout_payload = encode_exec_result(
            termination,
            duration_ms,
            invalid_stdout,
            valid_stderr,
            &diagnostic,
        );
        prop_assert!(
            invalid_stdout_payload.is_ok(),
            "generic invalid-stdout result failed to encode: {invalid_stdout_payload:?}",
        );
        prop_assert!(
            decode_guest_state_restore_result(&invalid_stdout_payload.unwrap()).is_err(),
            "accepted guest-state result with invalid stdout",
        );

        let discarded_stderr_payload = encode_exec_result(
            termination,
            duration_ms,
            empty_stdout(),
            ExecCapturedOutput::Discarded,
            &diagnostic,
        );
        prop_assert!(
            discarded_stderr_payload.is_ok(),
            "generic discarded-stderr result failed to encode: {discarded_stderr_payload:?}",
        );
        prop_assert!(
            decode_guest_state_restore_result(&discarded_stderr_payload.unwrap()).is_err(),
            "accepted guest-state result with discarded stderr",
        );
    }
}

#[test]
fn result_enforces_stderr_size_boundary() {
    let maximum_stderr = vec![0xA5; GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES];
    let stderr = ExecCapturedOutput::Captured {
        bytes: &maximum_stderr,
        truncated: true,
    };
    let payload = encode_guest_state_restore_result(
        ExecTermination::Exited { exit_code: 7 },
        u32::MAX,
        stderr,
        "boundary",
    )
    .unwrap();
    assert_eq!(
        decode_guest_state_restore_result(&payload).unwrap().stderr,
        stderr
    );

    let oversized_stderr = vec![0xA5; GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES + 1];
    let oversized = ExecCapturedOutput::Captured {
        bytes: &oversized_stderr,
        truncated: false,
    };
    assert!(matches!(
        encode_guest_state_restore_result(ExecTermination::WaitFailed, 0, oversized, ""),
        Err(ProtocolError::PayloadTooLarge("stderr", size))
            if size == GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES + 1
    ));

    let generic_payload = encode_exec_result(
        ExecTermination::WaitFailed,
        0,
        empty_stdout(),
        oversized,
        "",
    )
    .unwrap();
    assert!(matches!(
        decode_guest_state_restore_result(&generic_payload),
        Err(ProtocolError::PayloadTooLarge("stderr", size))
            if size == GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES + 1
    ));
}
