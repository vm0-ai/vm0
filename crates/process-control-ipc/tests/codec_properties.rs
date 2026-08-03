use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::thread;

use process_control_ipc::{
    ControlRequest, ControlResponse, ControlResponseStatus, MAX_CONTROL_PAYLOAD_BYTES,
    read_request, read_response, write_request, write_response,
};
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xC017_C0DE_2026_0803;
const MAX_GENERATED_TEXT_CHARS: usize = 16;
const MAX_GENERATED_PAYLOAD_BYTES: usize = 64;
const MAX_GENERATED_CHUNK_BYTES: usize = 8;
const MAX_GENERATED_CHUNKS: usize = 16;
const MAX_ARBITRARY_FRAME_BYTES: usize = 128;
const MAX_ARBITRARY_BODY_BYTES: usize = 128;

const LENGTH_PREFIX_BYTES: usize = 4;
const VERSION_OFFSET: usize = LENGTH_PREFIX_BYTES;
const KIND_OFFSET: usize = VERSION_OFFSET + 1;
const MESSAGE_ID_LENGTH_OFFSET: usize = KIND_OFFSET + 1;
const MESSAGE_ID_OFFSET: usize = MESSAGE_ID_LENGTH_OFFSET + 2;
const FRAME_VERSION: u8 = 1;
const FRAME_REQUEST: u8 = 0x02;
const FRAME_RESPONSE: u8 = 0x03;
const MAX_FRAME_BODY_BYTES: usize = 1 + 1 + 2 + u16::MAX as usize + 4 + MAX_CONTROL_PAYLOAD_BYTES;

type Mutation = (&'static str, Vec<u8>);

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

fn message_id_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(text_char_strategy(), 1..=MAX_GENERATED_TEXT_CHARS)
        .prop_map(|chars| chars.into_iter().collect())
}

fn diagnostic_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(text_char_strategy(), 0..=MAX_GENERATED_TEXT_CHARS)
        .prop_map(|chars| chars.into_iter().collect())
}

fn request_strategy() -> impl Strategy<Value = ControlRequest> {
    (
        message_id_strategy(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_PAYLOAD_BYTES),
    )
        .prop_map(|(message_id, payload)| ControlRequest {
            message_id,
            payload,
        })
}

fn response_status_strategy() -> impl Strategy<Value = ControlResponseStatus> {
    prop_oneof![
        Just(ControlResponseStatus::Accepted),
        Just(ControlResponseStatus::Rejected),
        Just(ControlResponseStatus::Error),
        Just(ControlResponseStatus::QueueFull),
    ]
}

fn response_strategy() -> impl Strategy<Value = ControlResponse> {
    (
        message_id_strategy(),
        response_status_strategy(),
        diagnostic_strategy(),
    )
        .prop_map(|(message_id, status, diagnostic)| ControlResponse {
            message_id,
            status,
            diagnostic,
        })
}

fn chunk_sizes_strategy() -> impl Strategy<Value = Vec<usize>> {
    proptest::collection::vec(1..=MAX_GENERATED_CHUNK_BYTES, 1..=MAX_GENERATED_CHUNKS)
}

fn arbitrary_frame_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        1 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_FRAME_BYTES),
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_BODY_BYTES)
            .prop_map(frame_from_body),
    ]
}

fn invalid_envelope_length_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![0_u32..2, (MAX_FRAME_BODY_BYTES as u32 + 1)..=u32::MAX,]
}

fn frame_from_body(body: Vec<u8>) -> Vec<u8> {
    let mut frame = Vec::with_capacity(LENGTH_PREFIX_BYTES + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    frame
}

fn encode_frame<T>(
    value: &T,
    write: fn(&mut UnixStream, &T) -> io::Result<()>,
) -> io::Result<Vec<u8>> {
    let (mut writer, mut reader) = UnixStream::pair()?;
    write(&mut writer, value)?;
    drop(writer);

    let mut frame = Vec::new();
    reader.read_to_end(&mut frame)?;
    Ok(frame)
}

fn encode_request_frame(request: &ControlRequest) -> io::Result<Vec<u8>> {
    encode_frame(request, write_request)
}

fn encode_response_frame(response: &ControlResponse) -> io::Result<Vec<u8>> {
    encode_frame(response, write_response)
}

fn decode_bytes<T>(bytes: &[u8], read: fn(&mut UnixStream) -> io::Result<T>) -> io::Result<T> {
    let (mut writer, mut reader) = UnixStream::pair()?;
    writer.write_all(bytes)?;
    drop(writer);
    read(&mut reader)
}

fn decode_request_bytes(bytes: &[u8]) -> io::Result<ControlRequest> {
    decode_bytes(bytes, read_request)
}

fn decode_response_bytes(bytes: &[u8]) -> io::Result<ControlResponse> {
    decode_bytes(bytes, read_response)
}

fn decode_in_chunks<T>(
    frame: &[u8],
    chunk_sizes: &[usize],
    read: fn(&mut UnixStream) -> io::Result<T>,
) -> io::Result<T> {
    let (writer, mut reader) = UnixStream::pair()?;
    let frame = frame.to_vec();
    let chunk_sizes = chunk_sizes.to_vec();
    let writer = thread::spawn(move || -> io::Result<()> {
        let mut writer = writer;
        let mut offset = 0;
        for chunk_size in chunk_sizes {
            if offset == frame.len() {
                break;
            }
            let end = offset.saturating_add(chunk_size).min(frame.len());
            let chunk = frame
                .get(offset..end)
                .ok_or_else(|| io::Error::other("generated chunk bounds exceed frame"))?;
            writer.write_all(chunk)?;
            offset = end;
        }
        let remainder = frame
            .get(offset..)
            .ok_or_else(|| io::Error::other("generated remainder starts beyond frame"))?;
        for chunk in remainder.chunks(MAX_GENERATED_CHUNK_BYTES) {
            writer.write_all(chunk)?;
        }
        Ok(())
    });

    let result = read(&mut reader);
    let writer_result = writer
        .join()
        .map_err(|_| io::Error::other("chunk writer panicked"))?;
    writer_result?;
    result
}

fn property_io<T>(result: io::Result<T>, context: &str) -> Result<T, TestCaseError> {
    result.map_err(|error| TestCaseError::fail(format!("{context}: {error}")))
}

fn assert_strict_prefixes_rejected<T>(
    frame: &[u8],
    decode: fn(&[u8]) -> io::Result<T>,
    label: &str,
) -> TestCaseResult {
    for prefix_len in 0..frame.len() {
        let prefix = frame.get(..prefix_len).ok_or_else(|| {
            TestCaseError::fail("strict prefix bounds must stay inside the frame")
        })?;
        prop_assert!(
            decode(prefix).is_err(),
            "accepted {label} strict prefix ending at {prefix_len} of {} bytes",
            frame.len(),
        );
    }
    Ok(())
}

fn assert_request_decode_invariant(bytes: &[u8]) -> TestCaseResult {
    if let Ok(request) = decode_request_bytes(bytes) {
        let canonical = property_io(
            encode_request_frame(&request),
            "decoded request failed to re-encode",
        )?;
        prop_assert!(
            bytes.starts_with(&canonical),
            "decoded request did not reproduce the consumed frame prefix",
        );
    }
    Ok(())
}

fn assert_response_decode_invariant(bytes: &[u8]) -> TestCaseResult {
    if let Ok(response) = decode_response_bytes(bytes) {
        let canonical = property_io(
            encode_response_frame(&response),
            "decoded response failed to re-encode",
        )?;
        prop_assert!(
            bytes.starts_with(&canonical),
            "decoded response did not reproduce the consumed frame prefix",
        );
    }
    Ok(())
}

fn with_byte(frame: &[u8], offset: usize, value: u8) -> Result<Vec<u8>, TestCaseError> {
    let mut mutation = frame.to_vec();
    let Some(byte) = mutation.get_mut(offset) else {
        return Err(TestCaseError::fail(
            "mutation byte offset must stay inside the frame",
        ));
    };
    *byte = value;
    Ok(mutation)
}

fn with_bytes(frame: &[u8], offset: usize, value: &[u8]) -> Result<Vec<u8>, TestCaseError> {
    let mut mutation = frame.to_vec();
    let Some(target) = mutation.get_mut(offset..offset + value.len()) else {
        return Err(TestCaseError::fail(
            "mutation field must stay inside the frame",
        ));
    };
    target.copy_from_slice(value);
    Ok(mutation)
}

fn with_u16(frame: &[u8], offset: usize, value: u16) -> Result<Vec<u8>, TestCaseError> {
    with_bytes(frame, offset, &value.to_be_bytes())
}

fn with_u32(frame: &[u8], offset: usize, value: u32) -> Result<Vec<u8>, TestCaseError> {
    with_bytes(frame, offset, &value.to_be_bytes())
}

fn append_declared_body_byte(frame: &[u8], value: u8) -> Result<Vec<u8>, TestCaseError> {
    let length_prefix = frame
        .get(..LENGTH_PREFIX_BYTES)
        .ok_or_else(|| TestCaseError::fail("canonical frame must contain a length prefix"))?;
    let length_prefix = <[u8; LENGTH_PREFIX_BYTES]>::try_from(length_prefix).map_err(|_| {
        TestCaseError::fail("canonical frame length prefix must contain four bytes")
    })?;
    let body_len = u32::from_be_bytes(length_prefix);
    let mut mutation = with_u32(frame, 0, body_len + 1)?;
    mutation.push(value);
    Ok(mutation)
}

fn request_invalid_mutations(
    request: &ControlRequest,
    frame: &[u8],
) -> Result<Vec<Mutation>, TestCaseError> {
    let payload_length_offset = MESSAGE_ID_OFFSET + request.message_id.len();
    let payload_offset = payload_length_offset + 4;
    let message_id_past_body = (frame.len() - MESSAGE_ID_OFFSET + 1) as u16;
    let payload_past_body = (frame.len() - payload_offset + 1) as u32;

    Ok(vec![
        (
            "unsupported version",
            with_byte(frame, VERSION_OFFSET, FRAME_VERSION + 1)?,
        ),
        (
            "wrong frame kind",
            with_byte(frame, KIND_OFFSET, FRAME_RESPONSE)?,
        ),
        (
            "unknown frame kind",
            with_byte(frame, KIND_OFFSET, u8::MAX)?,
        ),
        (
            "message id length beyond remaining body",
            with_u16(frame, MESSAGE_ID_LENGTH_OFFSET, message_id_past_body)?,
        ),
        (
            "payload length beyond remaining body",
            with_u32(frame, payload_length_offset, payload_past_body)?,
        ),
        (
            "invalid message id UTF-8",
            with_byte(frame, MESSAGE_ID_OFFSET, u8::MAX)?,
        ),
        (
            "trailing byte inside declared frame",
            append_declared_body_byte(frame, 0xA5)?,
        ),
    ])
}

fn response_invalid_mutations(
    response: &ControlResponse,
    frame: &[u8],
) -> Result<Vec<Mutation>, TestCaseError> {
    let status_offset = MESSAGE_ID_OFFSET + response.message_id.len();
    let diagnostic_length_offset = status_offset + 1;
    let diagnostic_offset = diagnostic_length_offset + 2;
    let message_id_past_body = (frame.len() - MESSAGE_ID_OFFSET + 1) as u16;
    let diagnostic_past_body = (frame.len() - diagnostic_offset + 1) as u16;
    let invalid_diagnostic = if response.diagnostic.is_empty() {
        let mut mutation = with_u16(frame, diagnostic_length_offset, 1)?;
        mutation = append_declared_body_byte(&mutation, u8::MAX)?;
        mutation
    } else {
        with_byte(frame, diagnostic_offset, u8::MAX)?
    };

    Ok(vec![
        (
            "unsupported version",
            with_byte(frame, VERSION_OFFSET, FRAME_VERSION + 1)?,
        ),
        (
            "wrong frame kind",
            with_byte(frame, KIND_OFFSET, FRAME_REQUEST)?,
        ),
        (
            "unknown frame kind",
            with_byte(frame, KIND_OFFSET, u8::MAX)?,
        ),
        (
            "message id length beyond remaining body",
            with_u16(frame, MESSAGE_ID_LENGTH_OFFSET, message_id_past_body)?,
        ),
        (
            "invalid message id UTF-8",
            with_byte(frame, MESSAGE_ID_OFFSET, u8::MAX)?,
        ),
        (
            "unknown response status",
            with_byte(frame, status_offset, u8::MAX)?,
        ),
        (
            "diagnostic length beyond remaining body",
            with_u16(frame, diagnostic_length_offset, diagnostic_past_body)?,
        ),
        ("invalid diagnostic UTF-8", invalid_diagnostic),
        (
            "trailing byte inside declared frame",
            append_declared_body_byte(frame, 0xA5)?,
        ),
    ])
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_requests_roundtrip_across_chunks_and_reject_strict_prefixes(
        expected in request_strategy(),
        chunk_sizes in chunk_sizes_strategy(),
    ) {
        let frame = property_io(
            encode_request_frame(&expected),
            "generated request failed to encode",
        )?;
        let decoded = property_io(
            decode_request_bytes(&frame),
            "generated request failed to decode",
        )?;
        prop_assert_eq!(&decoded, &expected);

        let chunked = property_io(
            decode_in_chunks(&frame, &chunk_sizes, read_request),
            "chunked request failed to decode",
        )?;
        prop_assert_eq!(&chunked, &expected);

        assert_strict_prefixes_rejected(&frame, decode_request_bytes, "request")?;
    }

    #[test]
    fn generated_responses_roundtrip_across_chunks_and_reject_strict_prefixes(
        expected in response_strategy(),
        chunk_sizes in chunk_sizes_strategy(),
    ) {
        let frame = property_io(
            encode_response_frame(&expected),
            "generated response failed to encode",
        )?;
        let decoded = property_io(
            decode_response_bytes(&frame),
            "generated response failed to decode",
        )?;
        prop_assert_eq!(&decoded, &expected);

        let chunked = property_io(
            decode_in_chunks(&frame, &chunk_sizes, read_response),
            "chunked response failed to decode",
        )?;
        prop_assert_eq!(&chunked, &expected);

        assert_strict_prefixes_rejected(&frame, decode_response_bytes, "response")?;
    }

    #[test]
    fn invalid_envelope_lengths_are_rejected(declared_len in invalid_envelope_length_strategy()) {
        let bytes = declared_len.to_be_bytes();
        prop_assert!(decode_request_bytes(&bytes).is_err());
        prop_assert!(decode_response_bytes(&bytes).is_err());
    }

    #[test]
    fn arbitrary_bounded_frames_never_panic_and_preserve_successful_decodes(
        bytes in arbitrary_frame_strategy(),
    ) {
        assert_request_decode_invariant(&bytes)?;
        assert_response_decode_invariant(&bytes)?;
    }

    #[test]
    fn generated_invalid_request_mutations_are_rejected(request in request_strategy()) {
        let frame = property_io(
            encode_request_frame(&request),
            "generated request failed to encode",
        )?;

        for (name, mutation) in request_invalid_mutations(&request, &frame)? {
            prop_assert!(
                decode_request_bytes(&mutation).is_err(),
                "accepted {name} mutation: {mutation:?}",
            );
        }
    }

    #[test]
    fn generated_invalid_response_mutations_are_rejected(response in response_strategy()) {
        let frame = property_io(
            encode_response_frame(&response),
            "generated response failed to encode",
        )?;

        for (name, mutation) in response_invalid_mutations(&response, &frame)? {
            prop_assert!(
                decode_response_bytes(&mutation).is_err(),
                "accepted {name} mutation: {mutation:?}",
            );
        }
    }
}
