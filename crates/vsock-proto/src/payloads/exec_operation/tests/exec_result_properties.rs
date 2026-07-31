use super::super::*;
use super::shared::{ExecResultLayout, set_byte_at, write_u16_at, write_u32_at};
use crate::wire::MAX_PAYLOAD_SIZE;
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseResult};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xEC5A_7E57_2026_0731;
const MAX_GENERATED_OUTPUT_BYTES: usize = 64;
const MAX_GENERATED_TEXT_CHARS: usize = 12;
const MAX_ARBITRARY_PAYLOAD_BYTES: usize = 512;

#[derive(Debug, Clone)]
enum OwnedExecCapturedOutput {
    Discarded,
    Captured { bytes: Vec<u8>, truncated: bool },
}

impl OwnedExecCapturedOutput {
    fn as_borrowed(&self) -> ExecCapturedOutput<'_> {
        match self {
            Self::Discarded => ExecCapturedOutput::Discarded,
            Self::Captured { bytes, truncated } => ExecCapturedOutput::Captured {
                bytes,
                truncated: *truncated,
            },
        }
    }
}

#[derive(Debug, Clone)]
struct OwnedExecResult {
    termination: ExecTermination,
    duration_ms: u32,
    stdout: OwnedExecCapturedOutput,
    stderr: OwnedExecCapturedOutput,
    diagnostic: String,
}

impl OwnedExecResult {
    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        encode_exec_result(
            self.termination,
            self.duration_ms,
            self.stdout.as_borrowed(),
            self.stderr.as_borrowed(),
            &self.diagnostic,
        )
    }

    fn assert_decoded(&self, decoded: &DecodedExecResult<'_>) -> TestCaseResult {
        prop_assert_eq!(decoded.termination, self.termination);
        prop_assert_eq!(decoded.duration_ms, self.duration_ms);
        prop_assert_eq!(decoded.stdout, self.stdout.as_borrowed());
        prop_assert_eq!(decoded.stderr, self.stderr.as_borrowed());
        prop_assert_eq!(decoded.diagnostic, self.diagnostic.as_str());
        Ok(())
    }

    fn layout(&self) -> ExecResultLayout {
        ExecResultLayout::new(
            self.termination,
            self.stdout.as_borrowed(),
            self.stderr.as_borrowed(),
            &self.diagnostic,
        )
    }

    fn invalid_mutations(&self, payload: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
        let layout = self.layout();
        let stdout_flags_offset = layout.stdout.flags_offset.unwrap();
        let stdout_bytes_len_offset = layout.stdout.bytes_len_offset.unwrap();
        let stderr_flags_offset = layout.stderr.flags_offset.unwrap();
        let stderr_bytes_len_offset = layout.stderr.bytes_len_offset.unwrap();

        let mut invalid_diagnostic_utf8 = payload.to_vec();
        set_byte_at(
            &mut invalid_diagnostic_utf8,
            layout.diagnostic_offset,
            u8::MAX,
        );

        let mut trailing = payload.to_vec();
        trailing.push(0);

        vec![
            (
                "invalid termination tag",
                with_byte(payload, layout.termination_tag_offset, u8::MAX),
            ),
            (
                "invalid stdout tag",
                with_byte(payload, layout.stdout.tag_offset, u8::MAX),
            ),
            (
                "invalid stderr tag",
                with_byte(payload, layout.stderr.tag_offset, u8::MAX),
            ),
            (
                "unknown stdout flags",
                with_byte(payload, stdout_flags_offset, 0x80),
            ),
            (
                "unknown stderr flags",
                with_byte(payload, stderr_flags_offset, 0x80),
            ),
            (
                "stdout length beyond remaining payload",
                with_u32(payload, stdout_bytes_len_offset, u32::MAX),
            ),
            (
                "stderr length beyond remaining payload",
                with_u32(payload, stderr_bytes_len_offset, u32::MAX),
            ),
            (
                "diagnostic length beyond remaining payload",
                with_u16(payload, layout.diagnostic_len_offset, u16::MAX),
            ),
            ("invalid diagnostic UTF-8", invalid_diagnostic_utf8),
            ("trailing byte", trailing),
        ]
    }
}

fn with_byte(payload: &[u8], offset: usize, value: u8) -> Vec<u8> {
    let mut mutation = payload.to_vec();
    set_byte_at(&mut mutation, offset, value);
    mutation
}

fn with_u16(payload: &[u8], offset: usize, value: u16) -> Vec<u8> {
    let mut mutation = payload.to_vec();
    write_u16_at(&mut mutation, offset, value);
    mutation
}

fn with_u32(payload: &[u8], offset: usize, value: u32) -> Vec<u8> {
    let mut mutation = payload.to_vec();
    write_u32_at(&mut mutation, offset, value);
    mutation
}

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn text_char_strategy() -> impl Strategy<Value = char> {
    prop_oneof![
        4 => proptest::char::range(' ', '~'),
        1 => Just('界'),
        1 => any::<char>(),
    ]
}

fn text_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(text_char_strategy(), 0..=MAX_GENERATED_TEXT_CHARS)
        .prop_map(|chars| chars.into_iter().collect())
}

fn nonempty_text_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(text_char_strategy(), 1..=MAX_GENERATED_TEXT_CHARS)
        .prop_map(|chars| chars.into_iter().collect())
}

fn exit_code_strategy() -> impl Strategy<Value = i32> {
    prop_oneof![
        Just(i32::MIN),
        Just(-1),
        Just(0),
        Just(1),
        Just(i32::MAX),
        any::<i32>(),
    ]
}

fn duration_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![Just(0), Just(1), Just(u32::MAX), any::<u32>()]
}

fn termination_strategy() -> impl Strategy<Value = ExecTermination> {
    prop_oneof![
        exit_code_strategy().prop_map(|exit_code| ExecTermination::Exited { exit_code }),
        Just(ExecTermination::TimedOut),
        Just(ExecTermination::Cancelled),
        Just(ExecTermination::StartFailed),
        Just(ExecTermination::WaitFailed),
    ]
}

fn captured_output_strategy() -> impl Strategy<Value = OwnedExecCapturedOutput> {
    prop_oneof![
        Just(OwnedExecCapturedOutput::Discarded),
        (
            proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_OUTPUT_BYTES),
            any::<bool>(),
        )
            .prop_map(|(bytes, truncated)| OwnedExecCapturedOutput::Captured { bytes, truncated }),
    ]
}

fn exec_result_strategy() -> impl Strategy<Value = OwnedExecResult> {
    (
        termination_strategy(),
        duration_strategy(),
        captured_output_strategy(),
        captured_output_strategy(),
        text_strategy(),
    )
        .prop_map(
            |(termination, duration_ms, stdout, stderr, diagnostic)| OwnedExecResult {
                termination,
                duration_ms,
                stdout,
                stderr,
                diagnostic,
            },
        )
}

fn malformed_exec_result_strategy() -> impl Strategy<Value = OwnedExecResult> {
    (
        termination_strategy(),
        duration_strategy(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_OUTPUT_BYTES),
        any::<bool>(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_OUTPUT_BYTES),
        any::<bool>(),
        nonempty_text_strategy(),
    )
        .prop_map(
            |(
                termination,
                duration_ms,
                stdout,
                stdout_truncated,
                stderr,
                stderr_truncated,
                diagnostic,
            )| OwnedExecResult {
                termination,
                duration_ms,
                stdout: OwnedExecCapturedOutput::Captured {
                    bytes: stdout,
                    truncated: stdout_truncated,
                },
                stderr: OwnedExecCapturedOutput::Captured {
                    bytes: stderr,
                    truncated: stderr_truncated,
                },
                diagnostic,
            },
        )
}

fn arbitrary_or_valid_payload_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES),
        1 => exec_result_strategy().prop_map(|result| result.encode().unwrap()),
    ]
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_exec_results_roundtrip_and_reject_strict_prefixes(
        result in exec_result_strategy(),
    ) {
        let payload = result.encode();
        prop_assert!(payload.is_ok(), "generated result failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_exec_result(&payload);
        prop_assert!(decoded.is_ok(), "encoded result failed to decode: {decoded:?}");
        result.assert_decoded(&decoded.unwrap())?;

        for prefix_len in 0..payload.len() {
            prop_assert!(
                decode_exec_result(&payload[..prefix_len]).is_err(),
                "accepted strict prefix ending at {prefix_len} of {} bytes",
                payload.len(),
            );
        }
    }

    #[test]
    fn arbitrary_exec_result_payloads_never_panic_and_reencode_canonically(
        payload in arbitrary_or_valid_payload_strategy(),
    ) {
        if let Ok(decoded) = decode_exec_result(&payload) {
            let reencoded = encode_exec_result(
                decoded.termination,
                decoded.duration_ms,
                decoded.stdout,
                decoded.stderr,
                decoded.diagnostic,
            );
            prop_assert!(
                reencoded.is_ok(),
                "decoded result failed to re-encode: {reencoded:?}",
            );
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }

    #[test]
    fn generated_invalid_exec_result_mutations_are_rejected(
        result in malformed_exec_result_strategy(),
    ) {
        let payload = result.encode();
        prop_assert!(payload.is_ok(), "generated result failed to encode: {payload:?}");
        let payload = payload.unwrap();

        for (name, mutation) in result.invalid_mutations(&payload) {
            prop_assert!(
                decode_exec_result(&mutation).is_err(),
                "accepted {name} mutation: {mutation:?}",
            );
        }
    }
}

#[test]
fn exec_result_roundtrips_structural_and_scalar_boundaries() {
    let terminations = [
        ExecTermination::Exited {
            exit_code: i32::MIN,
        },
        ExecTermination::Exited {
            exit_code: i32::MAX,
        },
        ExecTermination::TimedOut,
        ExecTermination::Cancelled,
        ExecTermination::StartFailed,
        ExecTermination::WaitFailed,
    ];
    let durations = [0, u32::MAX];
    let outputs = [
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Captured {
            bytes: b"\0\xff",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: b"\0\xff",
            truncated: true,
        },
    ];

    for termination in terminations {
        for duration_ms in durations {
            for stdout in outputs {
                for stderr in outputs {
                    let payload =
                        encode_exec_result(termination, duration_ms, stdout, stderr, "边界")
                            .unwrap();
                    assert_eq!(
                        decode_exec_result(&payload).unwrap(),
                        DecodedExecResult {
                            termination,
                            duration_ms,
                            stdout,
                            stderr,
                            diagnostic: "边界",
                        }
                    );
                }
            }
        }
    }
}

#[test]
fn exec_result_roundtrips_max_diagnostic_length() {
    let diagnostic = "界".repeat(u16::MAX as usize / "界".len());
    assert_eq!(diagnostic.len(), u16::MAX as usize);

    let payload = encode_exec_result(
        ExecTermination::WaitFailed,
        u32::MAX,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        &diagnostic,
    )
    .unwrap();

    assert_eq!(decode_exec_result(&payload).unwrap().diagnostic, diagnostic);
}

#[test]
fn exec_result_roundtrips_max_payload_length() {
    let empty_payload = encode_exec_result(
        ExecTermination::Cancelled,
        0,
        ExecCapturedOutput::Captured {
            bytes: &[],
            truncated: true,
        },
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    let stdout = vec![0xA5; MAX_PAYLOAD_SIZE - empty_payload.len()];

    let payload = encode_exec_result(
        ExecTermination::Cancelled,
        0,
        ExecCapturedOutput::Captured {
            bytes: &stdout,
            truncated: true,
        },
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();

    assert_eq!(payload.len(), MAX_PAYLOAD_SIZE);
    assert_eq!(
        decode_exec_result(&payload).unwrap(),
        DecodedExecResult {
            termination: ExecTermination::Cancelled,
            duration_ms: 0,
            stdout: ExecCapturedOutput::Captured {
                bytes: &stdout,
                truncated: true,
            },
            stderr: ExecCapturedOutput::Discarded,
            diagnostic: "",
        }
    );
}
