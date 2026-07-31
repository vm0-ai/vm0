use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};
use std::convert::Infallible;
use vsock_proto::{
    BorrowedRawMessage, DecodeWithError, Decoder, MAX_MESSAGE_SIZE, MIN_BODY_SIZE, ProtocolError,
    RawMessage, encode,
};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xF24A_DEC0_2026_0731;
const MAX_GENERATED_FRAMES: usize = 8;
const MAX_GENERATED_PAYLOAD_BYTES: usize = 64;
const MAX_GENERATED_CHUNK_BYTES: usize = 64;
const MAX_GENERATED_CHUNKS: usize = 32;
const MAX_ARBITRARY_STREAM_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnedRawMessage {
    msg_type: u8,
    seq: u32,
    payload: Vec<u8>,
}

impl OwnedRawMessage {
    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        encode(self.msg_type, self.seq, &self.payload)
    }
}

impl From<RawMessage> for OwnedRawMessage {
    fn from(message: RawMessage) -> Self {
        Self {
            msg_type: message.msg_type,
            seq: message.seq,
            payload: message.payload,
        }
    }
}

impl From<BorrowedRawMessage<'_>> for OwnedRawMessage {
    fn from(message: BorrowedRawMessage<'_>) -> Self {
        Self {
            msg_type: message.msg_type,
            seq: message.seq,
            payload: message.payload.to_vec(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VisitorError {
    Stop,
}

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn raw_message_strategy() -> impl Strategy<Value = OwnedRawMessage> {
    (
        any::<u8>(),
        any::<u32>(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_PAYLOAD_BYTES),
    )
        .prop_map(|(msg_type, seq, payload)| OwnedRawMessage {
            msg_type,
            seq,
            payload,
        })
}

fn raw_messages_strategy() -> impl Strategy<Value = Vec<OwnedRawMessage>> {
    proptest::collection::vec(raw_message_strategy(), 1..=MAX_GENERATED_FRAMES)
}

fn chunk_sizes_strategy() -> impl Strategy<Value = Vec<usize>> {
    proptest::collection::vec(1..=MAX_GENERATED_CHUNK_BYTES, 0..=MAX_GENERATED_CHUNKS)
}

fn invalid_length_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![
        0_u32..MIN_BODY_SIZE as u32,
        (MAX_MESSAGE_SIZE as u32 + 1)..=u32::MAX,
    ]
}

fn encode_messages(messages: &[OwnedRawMessage]) -> Result<Vec<u8>, ProtocolError> {
    let mut encoded = Vec::new();
    for message in messages {
        encoded.extend_from_slice(&message.encode()?);
    }
    Ok(encoded)
}

fn recovery_message() -> OwnedRawMessage {
    OwnedRawMessage {
        msg_type: 0xA5,
        seq: 0x0102_0304,
        payload: b"recovered".to_vec(),
    }
}

fn assert_decoder_recovered(decoder: &mut Decoder) -> TestCaseResult {
    let expected = recovery_message();
    let encoded = expected.encode().map_err(|error| {
        TestCaseError::fail(format!("recovery frame failed to encode: {error}"))
    })?;
    let messages = decoder
        .decode(&encoded)
        .map_err(|error| TestCaseError::fail(format!("valid recovery frame failed: {error}")))?;
    let observed: Vec<_> = messages.into_iter().map(OwnedRawMessage::from).collect();
    prop_assert_eq!(observed, vec![expected]);
    Ok(())
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_frames_decode_independently_of_chunking(
        expected in raw_messages_strategy(),
        chunk_sizes in chunk_sizes_strategy(),
    ) {
        let encoded = encode_messages(&expected).map_err(|error| {
            TestCaseError::fail(format!("generated frame stream failed to encode: {error}"))
        })?;
        let mut decoder = Decoder::new();
        let mut observed = Vec::new();
        let mut offset = 0;

        for chunk_size in chunk_sizes {
            if offset == encoded.len() {
                break;
            }
            let end = (offset + chunk_size).min(encoded.len());
            let messages = decoder.decode(&encoded[offset..end]).map_err(|error| {
                TestCaseError::fail(format!("generated frame stream failed to decode: {error}"))
            })?;
            observed.extend(messages.into_iter().map(OwnedRawMessage::from));
            offset = end;
        }

        if offset < encoded.len() {
            let messages = decoder.decode(&encoded[offset..]).map_err(|error| {
                TestCaseError::fail(format!("generated frame remainder failed to decode: {error}"))
            })?;
            observed.extend(messages.into_iter().map(OwnedRawMessage::from));
        }

        prop_assert_eq!(observed, expected);
    }

    #[test]
    fn visitor_rejection_preserves_later_frames_and_partial_tail(
        complete in raw_messages_strategy(),
        tail in raw_message_strategy(),
        rejection_selector in any::<usize>(),
        tail_prefix_selector in any::<usize>(),
    ) {
        let tail_frame = tail.encode().map_err(|error| {
            TestCaseError::fail(format!("generated tail frame failed to encode: {error}"))
        })?;
        let tail_prefix_len = 1 + tail_prefix_selector % (tail_frame.len() - 1);
        let rejection_index = rejection_selector % complete.len();
        let mut buffered = encode_messages(&complete).map_err(|error| {
            TestCaseError::fail(format!("generated complete frames failed to encode: {error}"))
        })?;
        buffered.extend_from_slice(&tail_frame[..tail_prefix_len]);

        let mut decoder = Decoder::new();
        let mut visited = Vec::new();
        let result = decoder.decode_with(&buffered, |message| {
            visited.push(OwnedRawMessage::from(message));
            if visited.len() - 1 == rejection_index {
                Err(VisitorError::Stop)
            } else {
                Ok(())
            }
        });

        prop_assert!(matches!(
            result,
            Err(DecodeWithError::Visitor(VisitorError::Stop))
        ));
        prop_assert_eq!(visited.as_slice(), &complete[..=rejection_index]);

        let mut later_complete = Vec::new();
        let result = decoder.decode_with(&[], |message| {
            later_complete.push(OwnedRawMessage::from(message));
            Ok::<(), Infallible>(())
        });
        prop_assert!(result.is_ok(), "retained complete frames failed to decode: {result:?}");
        prop_assert_eq!(later_complete.as_slice(), &complete[rejection_index + 1..]);

        let mut completed_tail = Vec::new();
        let result = decoder.decode_with(&tail_frame[tail_prefix_len..], |message| {
            completed_tail.push(OwnedRawMessage::from(message));
            Ok::<(), Infallible>(())
        });
        prop_assert!(result.is_ok(), "retained partial frame failed to decode: {result:?}");
        prop_assert_eq!(completed_tail, vec![tail]);
    }

    #[test]
    fn malformed_length_after_valid_frames_prevalidates_and_recovers(
        valid in raw_messages_strategy(),
        invalid_length in invalid_length_strategy(),
    ) {
        let mut buffered = encode_messages(&valid).map_err(|error| {
            TestCaseError::fail(format!("generated valid frames failed to encode: {error}"))
        })?;
        buffered.extend_from_slice(&invalid_length.to_be_bytes());

        let mut decoder = Decoder::new();
        let mut visited = false;
        let result = decoder.decode_with(&buffered, |_message| {
            visited = true;
            Ok::<(), Infallible>(())
        });

        prop_assert!(matches!(result, Err(DecodeWithError::Protocol(_))));
        prop_assert!(!visited, "visitor ran before a buffered protocol error");
        assert_decoder_recovered(&mut decoder)?;
    }

    #[test]
    fn arbitrary_bounded_streams_never_panic_and_protocol_errors_recover(
        bytes in proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_STREAM_BYTES),
    ) {
        let mut decoder = Decoder::new();

        match decoder.decode(&bytes) {
            Ok(messages) => {
                let observed: Vec<_> = messages.into_iter().map(OwnedRawMessage::from).collect();
                let reencoded = encode_messages(&observed).map_err(|error| {
                    TestCaseError::fail(format!("decoded frames failed to re-encode: {error}"))
                })?;
                prop_assert!(
                    bytes.starts_with(&reencoded),
                    "decoded frames did not reproduce the consumed stream prefix",
                );
            }
            Err(_) => assert_decoder_recovered(&mut decoder)?,
        }
    }
}
