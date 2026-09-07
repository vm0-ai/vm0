use super::super::*;
use crate::{MSG_EXEC_CONTROL, encode};
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseResult};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xEC5A_C017_2026_0906;
const MAX_GENERATED_TEXT_CHARS: usize = 12;
const MAX_GENERATED_PAYLOAD_BYTES: usize = 64;
const MAX_ARBITRARY_PAYLOAD_BYTES: usize = 512;

const EXEC_CONTROL_STATUSES: [ExecControlStatus; 9] = [
    ExecControlStatus::Delivered,
    ExecControlStatus::Inactive,
    ExecControlStatus::NonceMismatch,
    ExecControlStatus::Unsupported,
    ExecControlStatus::Rejected,
    ExecControlStatus::SinkUnavailable,
    ExecControlStatus::SinkTimeout,
    ExecControlStatus::QueueFull,
    ExecControlStatus::SinkError,
];

#[derive(Debug, Clone)]
struct OwnedExecControl {
    target_seq: u32,
    request_timeout_ms: u32,
    control_nonce: ExecControlNonce,
    message_id: String,
    payload: Vec<u8>,
}

impl OwnedExecControl {
    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        encode_exec_control(
            self.target_seq,
            self.control_nonce,
            &self.message_id,
            &self.payload,
            self.request_timeout_ms,
        )
    }

    fn encode_frame(&self, frame: &mut Vec<u8>, frame_seq: u32) -> Result<(), ProtocolError> {
        encode_exec_control_frame_into(
            frame,
            frame_seq,
            self.target_seq,
            self.control_nonce,
            &self.message_id,
            &self.payload,
            self.request_timeout_ms,
        )
    }

    fn assert_decoded(&self, decoded: &DecodedExecControl<'_>) -> TestCaseResult {
        prop_assert_eq!(decoded.target_seq, self.target_seq);
        prop_assert_eq!(decoded.request_timeout_ms, self.request_timeout_ms);
        prop_assert_eq!(decoded.control_nonce, self.control_nonce);
        prop_assert_eq!(decoded.message_id, self.message_id.as_str());
        prop_assert_eq!(decoded.payload, self.payload.as_slice());
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct OwnedExecControlResultFields {
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: String,
    diagnostic: String,
}

impl OwnedExecControlResultFields {
    fn encode(&self, status: ExecControlStatus) -> Result<Vec<u8>, ProtocolError> {
        encode_exec_control_result(
            self.target_seq,
            self.control_nonce,
            &self.message_id,
            status,
            &self.diagnostic,
        )
    }

    fn assert_decoded(
        &self,
        status: ExecControlStatus,
        decoded: &DecodedExecControlResult<'_>,
    ) -> TestCaseResult {
        prop_assert_eq!(decoded.target_seq, self.target_seq);
        prop_assert_eq!(decoded.control_nonce, self.control_nonce);
        prop_assert_eq!(decoded.message_id, self.message_id.as_str());
        prop_assert_eq!(decoded.status, status);
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

fn text_char_strategy() -> impl Strategy<Value = char> {
    prop_oneof![
        4 => proptest::char::range(' ', '~'),
        1 => Just('界'),
        1 => any::<char>(),
    ]
}

fn text_strategy() -> impl Strategy<Value = String> {
    prop_oneof![
        1 => Just(String::new()),
        1 => Just("诊断/🧪".to_owned()),
        4 => proptest::collection::vec(text_char_strategy(), 0..=MAX_GENERATED_TEXT_CHARS)
            .prop_map(|characters| characters.into_iter().collect()),
    ]
}

fn nonempty_text_strategy() -> impl Strategy<Value = String> {
    prop_oneof![
        1 => Just("message".to_owned()),
        1 => Just("消息/🧪".to_owned()),
        4 => proptest::collection::vec(text_char_strategy(), 1..=MAX_GENERATED_TEXT_CHARS)
            .prop_map(|characters| characters.into_iter().collect()),
    ]
}

fn nonzero_u32_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![Just(1), Just(u32::MAX), 1..u32::MAX]
}

fn u32_edge_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![Just(0), Just(1), Just(u32::MAX), any::<u32>()]
}

fn status_strategy() -> impl Strategy<Value = ExecControlStatus> {
    proptest::sample::select(&EXEC_CONTROL_STATUSES)
}

fn exec_control_strategy() -> impl Strategy<Value = OwnedExecControl> {
    (
        nonzero_u32_strategy(),
        u32_edge_strategy(),
        any::<ExecControlNonce>(),
        nonempty_text_strategy(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_PAYLOAD_BYTES),
    )
        .prop_map(
            |(target_seq, request_timeout_ms, control_nonce, message_id, payload)| {
                OwnedExecControl {
                    target_seq,
                    request_timeout_ms,
                    control_nonce,
                    message_id,
                    payload,
                }
            },
        )
}

fn exec_control_result_fields_strategy() -> impl Strategy<Value = OwnedExecControlResultFields> {
    (
        nonzero_u32_strategy(),
        any::<ExecControlNonce>(),
        nonempty_text_strategy(),
        text_strategy(),
    )
        .prop_map(|(target_seq, control_nonce, message_id, diagnostic)| {
            OwnedExecControlResultFields {
                target_seq,
                control_nonce,
                message_id,
                diagnostic,
            }
        })
}

fn arbitrary_or_valid_exec_control_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES),
        1 => exec_control_strategy().prop_map(|request| request.encode().unwrap()),
    ]
}

fn arbitrary_or_valid_exec_control_result_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES),
        1 => (exec_control_result_fields_strategy(), status_strategy())
            .prop_map(|(fields, status)| fields.encode(status).unwrap()),
    ]
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_exec_control_requests_roundtrip_reject_prefixes_and_match_frames(
        request in exec_control_strategy(),
        frame_seq in any::<u32>(),
    ) {
        let payload = request.encode();
        prop_assert!(payload.is_ok(), "generated request failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_exec_control(&payload);
        prop_assert!(decoded.is_ok(), "encoded request failed to decode: {decoded:?}");
        request.assert_decoded(&decoded.unwrap())?;

        for prefix_len in 0..payload.len() {
            prop_assert!(
                decode_exec_control(&payload[..prefix_len]).is_err(),
                "accepted strict request prefix ending at {prefix_len} of {} bytes",
                payload.len(),
            );
        }

        let expected_frame = encode(MSG_EXEC_CONTROL, frame_seq, &payload);
        prop_assert!(
            expected_frame.is_ok(),
            "generated request failed generic frame encoding: {expected_frame:?}",
        );
        let mut actual_frame = b"stale frame bytes".to_vec();
        let direct_frame = request.encode_frame(&mut actual_frame, frame_seq);
        prop_assert!(
            direct_frame.is_ok(),
            "generated request failed direct frame encoding: {direct_frame:?}",
        );
        prop_assert_eq!(actual_frame, expected_frame.unwrap());
    }

    #[test]
    fn generated_exec_control_results_roundtrip_and_reject_strict_prefixes(
        fields in exec_control_result_fields_strategy(),
    ) {
        for status in EXEC_CONTROL_STATUSES {
            let payload = fields.encode(status);
            prop_assert!(payload.is_ok(), "generated result failed to encode: {payload:?}");
            let payload = payload.unwrap();

            let decoded = decode_exec_control_result(&payload);
            prop_assert!(decoded.is_ok(), "encoded result failed to decode: {decoded:?}");
            fields.assert_decoded(status, &decoded.unwrap())?;

            for prefix_len in 0..payload.len() {
                prop_assert!(
                    decode_exec_control_result(&payload[..prefix_len]).is_err(),
                    "accepted strict result prefix ending at {prefix_len} of {} bytes for {status:?}",
                    payload.len(),
                );
            }
        }
    }

    #[test]
    fn arbitrary_exec_control_payloads_never_panic_and_reencode_canonically(
        payload in arbitrary_or_valid_exec_control_strategy(),
    ) {
        if let Ok(decoded) = decode_exec_control(&payload) {
            prop_assert_ne!(decoded.target_seq, 0);
            prop_assert!(!decoded.message_id.is_empty());
            prop_assert!(decoded.payload.len() <= EXEC_CONTROL_MAX_PAYLOAD_BYTES);

            let reencoded = encode_exec_control(
                decoded.target_seq,
                decoded.control_nonce,
                decoded.message_id,
                decoded.payload,
                decoded.request_timeout_ms,
            );
            prop_assert!(
                reencoded.is_ok(),
                "decoded request failed to re-encode: {reencoded:?}",
            );
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }

    #[test]
    fn arbitrary_exec_control_result_payloads_never_panic_and_reencode_canonically(
        payload in arbitrary_or_valid_exec_control_result_strategy(),
    ) {
        if let Ok(decoded) = decode_exec_control_result(&payload) {
            prop_assert_ne!(decoded.target_seq, 0);
            prop_assert!(!decoded.message_id.is_empty());
            prop_assert!(decoded.message_id.len() <= usize::from(u16::MAX));
            prop_assert!(decoded.diagnostic.len() <= usize::from(u16::MAX));

            let reencoded = encode_exec_control_result(
                decoded.target_seq,
                decoded.control_nonce,
                decoded.message_id,
                decoded.status,
                decoded.diagnostic,
            );
            prop_assert!(
                reencoded.is_ok(),
                "decoded result failed to re-encode: {reencoded:?}",
            );
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }
}
