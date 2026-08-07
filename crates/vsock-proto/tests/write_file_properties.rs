use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};
use vsock_proto::{
    MSG_WRITE_FILE, MSG_WRITE_FILES, ProtocolError, WriteFileBatchEntry, decode_write_file,
    decode_write_file_result, decode_write_files, decode_write_files_result, encode,
    encode_private_write_file, encode_private_write_file_frame_into, encode_write_file,
    encode_write_file_frame_into, encode_write_file_result, encode_write_files,
    encode_write_files_frame_into, encode_write_files_result,
};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xF11E_C0DE_2026_0803;
const MAX_GENERATED_TEXT_CHARS: usize = 12;
const MAX_GENERATED_CONTENT_BYTES: usize = 64;
const MIN_GENERATED_BATCH_FILES: usize = 2;
const MAX_GENERATED_BATCH_FILES: usize = 4;
const MAX_ARBITRARY_PAYLOAD_BYTES: usize = 512;

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
        1 => Just("路径/🧪".to_owned()),
        4 => proptest::collection::vec(text_char_strategy(), 0..=MAX_GENERATED_TEXT_CHARS)
            .prop_map(|characters| characters.into_iter().collect()),
    ]
}

fn content_strategy() -> impl Strategy<Value = Vec<u8>> {
    proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_CONTENT_BYTES)
}

fn batch_strategy() -> impl Strategy<Value = Vec<(String, Vec<u8>)>> {
    proptest::collection::vec(
        (text_strategy(), content_strategy()),
        MIN_GENERATED_BATCH_FILES..=MAX_GENERATED_BATCH_FILES,
    )
}

fn borrow_batch(files: &[(String, Vec<u8>)]) -> Vec<WriteFileBatchEntry<'_>> {
    files
        .iter()
        .map(|(path, content)| WriteFileBatchEntry {
            path,
            content: content.as_slice(),
        })
        .collect()
}

fn standard_payload_strategy() -> impl Strategy<Value = Result<Vec<u8>, ProtocolError>> {
    (
        text_strategy(),
        content_strategy(),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(|(path, content, sudo, append)| encode_write_file(&path, &content, sudo, append))
}

fn private_payload_strategy() -> impl Strategy<Value = Result<Vec<u8>, ProtocolError>> {
    (text_strategy(), content_strategy(), any::<bool>())
        .prop_map(|(path, content, append)| encode_private_write_file(&path, &content, append))
}

fn batch_payload_strategy() -> impl Strategy<Value = Result<Vec<u8>, ProtocolError>> {
    batch_strategy().prop_map(|files| {
        let borrowed = borrow_batch(&files);
        encode_write_files(&borrowed)
    })
}

fn result_payload_strategy() -> impl Strategy<Value = Vec<u8>> {
    (any::<bool>(), text_strategy())
        .prop_map(|(success, diagnostic)| encode_write_file_result(success, &diagnostic))
}

fn arbitrary_or_valid_single_payload_strategy()
-> impl Strategy<Value = Result<Vec<u8>, ProtocolError>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES)
            .prop_map(Ok),
        1 => standard_payload_strategy(),
        1 => private_payload_strategy(),
    ]
}

fn arbitrary_or_valid_batch_payload_strategy()
-> impl Strategy<Value = Result<Vec<u8>, ProtocolError>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES)
            .prop_map(Ok),
        1 => batch_payload_strategy(),
    ]
}

fn arbitrary_or_valid_result_payload_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        3 => proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_PAYLOAD_BYTES),
        1 => result_payload_strategy(),
    ]
}

fn assert_strict_prefixes_rejected(
    payload: &[u8],
    is_rejected: impl Fn(&[u8]) -> bool,
) -> TestCaseResult {
    for prefix_len in 0..payload.len() {
        let prefix = payload.get(..prefix_len).ok_or_else(|| {
            TestCaseError::fail(format!(
                "failed to read strict prefix ending at {prefix_len} of {} bytes",
                payload.len(),
            ))
        })?;
        prop_assert!(
            is_rejected(prefix),
            "accepted strict prefix ending at {prefix_len} of {} bytes",
            payload.len(),
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_standard_write_file_requests_roundtrip_reject_prefixes_and_match_frames(
        path in text_strategy(),
        content in content_strategy(),
        sudo in any::<bool>(),
        append in any::<bool>(),
        seq in any::<u32>(),
    ) {
        let payload = encode_write_file(&path, &content, sudo, append);
        prop_assert!(payload.is_ok(), "generated write_file failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_write_file(&payload);
        prop_assert!(decoded.is_ok(), "encoded write_file failed to decode: {decoded:?}");
        let (decoded_path, decoded_content, decoded_sudo, decoded_append, decoded_private) =
            decoded.unwrap();
        prop_assert_eq!(decoded_path, path.as_str());
        prop_assert_eq!(decoded_content, content.as_slice());
        prop_assert_eq!(decoded_sudo, sudo);
        prop_assert_eq!(decoded_append, append);
        prop_assert!(!decoded_private);

        assert_strict_prefixes_rejected(&payload, |prefix| decode_write_file(prefix).is_err())?;

        let expected_frame = encode(MSG_WRITE_FILE, seq, &payload);
        prop_assert!(expected_frame.is_ok(), "generated write_file frame failed: {expected_frame:?}");
        let mut direct_frame = Vec::new();
        let direct_result = encode_write_file_frame_into(
            &mut direct_frame,
            seq,
            &path,
            &content,
            sudo,
            append,
        );
        prop_assert!(direct_result.is_ok(), "direct write_file frame failed: {direct_result:?}");
        prop_assert_eq!(direct_frame, expected_frame.unwrap());
    }

    #[test]
    fn generated_private_write_file_requests_roundtrip_reject_prefixes_and_match_frames(
        path in text_strategy(),
        content in content_strategy(),
        append in any::<bool>(),
        seq in any::<u32>(),
    ) {
        let payload = encode_private_write_file(&path, &content, append);
        prop_assert!(payload.is_ok(), "generated private write_file failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_write_file(&payload);
        prop_assert!(decoded.is_ok(), "encoded private write_file failed to decode: {decoded:?}");
        let (decoded_path, decoded_content, decoded_sudo, decoded_append, decoded_private) =
            decoded.unwrap();
        prop_assert_eq!(decoded_path, path.as_str());
        prop_assert_eq!(decoded_content, content.as_slice());
        prop_assert!(!decoded_sudo);
        prop_assert_eq!(decoded_append, append);
        prop_assert!(decoded_private);

        assert_strict_prefixes_rejected(&payload, |prefix| decode_write_file(prefix).is_err())?;

        let expected_frame = encode(MSG_WRITE_FILE, seq, &payload);
        prop_assert!(expected_frame.is_ok(), "generated private write_file frame failed: {expected_frame:?}");
        let mut direct_frame = Vec::new();
        let direct_result = encode_private_write_file_frame_into(
            &mut direct_frame,
            seq,
            &path,
            &content,
            append,
        );
        prop_assert!(direct_result.is_ok(), "direct private write_file frame failed: {direct_result:?}");
        prop_assert_eq!(direct_frame, expected_frame.unwrap());
    }

    #[test]
    fn generated_write_file_batches_roundtrip_reject_prefixes_and_match_frames(
        files in batch_strategy(),
        seq in any::<u32>(),
    ) {
        let borrowed = borrow_batch(&files);
        let payload = encode_write_files(&borrowed);
        prop_assert!(payload.is_ok(), "generated write_files failed to encode: {payload:?}");
        let payload = payload.unwrap();

        let decoded = decode_write_files(&payload);
        prop_assert!(decoded.is_ok(), "encoded write_files failed to decode: {decoded:?}");
        let decoded = decoded.unwrap();
        prop_assert_eq!(decoded.as_slice(), borrowed.as_slice());

        assert_strict_prefixes_rejected(&payload, |prefix| decode_write_files(prefix).is_err())?;

        let expected_frame = encode(MSG_WRITE_FILES, seq, &payload);
        prop_assert!(expected_frame.is_ok(), "generated write_files frame failed: {expected_frame:?}");
        let mut direct_frame = Vec::new();
        let direct_result = encode_write_files_frame_into(&mut direct_frame, seq, &borrowed);
        prop_assert!(direct_result.is_ok(), "direct write_files frame failed: {direct_result:?}");
        prop_assert_eq!(direct_frame, expected_frame.unwrap());
    }

    #[test]
    fn generated_write_file_results_roundtrip_and_reject_prefixes(
        success in any::<bool>(),
        diagnostic in text_strategy(),
    ) {
        let payload = encode_write_file_result(success, &diagnostic);
        let batch_payload = encode_write_files_result(success, &diagnostic);
        prop_assert_eq!(batch_payload.as_slice(), payload.as_slice());

        let decoded = decode_write_file_result(&payload);
        prop_assert!(decoded.is_ok(), "encoded write_file_result failed to decode: {decoded:?}");
        prop_assert_eq!(decoded.unwrap(), (success, diagnostic.as_str()));

        let decoded_batch = decode_write_files_result(&payload);
        prop_assert!(
            decoded_batch.is_ok(),
            "encoded write_files_result failed to decode: {decoded_batch:?}",
        );
        prop_assert_eq!(decoded_batch.unwrap(), (success, diagnostic.as_str()));

        assert_strict_prefixes_rejected(&payload, |prefix| {
            decode_write_file_result(prefix).is_err()
                && decode_write_files_result(prefix).is_err()
        })?;
    }

    #[test]
    fn arbitrary_single_write_file_payloads_never_panic_and_reencode_canonically(
        payload_result in arbitrary_or_valid_single_payload_strategy(),
    ) {
        let payload = payload_result.map_err(|error| {
            TestCaseError::fail(format!("generated single write_file failed to encode: {error}"))
        })?;
        if let Ok((path, content, sudo, append, private)) = decode_write_file(&payload) {
            prop_assert!(!(private && sudo));
            let reencoded = if private {
                encode_private_write_file(path, content, append)
            } else {
                encode_write_file(path, content, sudo, append)
            };
            prop_assert!(reencoded.is_ok(), "decoded write_file failed to re-encode: {reencoded:?}");
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }

    #[test]
    fn arbitrary_write_file_batch_payloads_never_panic_and_reencode_canonically(
        payload_result in arbitrary_or_valid_batch_payload_strategy(),
    ) {
        let payload = payload_result.map_err(|error| {
            TestCaseError::fail(format!("generated write_files failed to encode: {error}"))
        })?;
        if let Ok(files) = decode_write_files(&payload) {
            prop_assert!(!files.is_empty());
            let reencoded = encode_write_files(&files);
            prop_assert!(reencoded.is_ok(), "decoded write_files failed to re-encode: {reencoded:?}");
            prop_assert_eq!(reencoded.unwrap(), payload);
        }
    }

    #[test]
    fn arbitrary_write_file_result_payloads_never_panic_and_reencode_canonically(
        payload in arbitrary_or_valid_result_payload_strategy(),
    ) {
        let decoded = decode_write_file_result(&payload);
        let decoded_batch = decode_write_files_result(&payload);
        prop_assert_eq!(decoded.is_ok(), decoded_batch.is_ok());

        if let (Ok((success, diagnostic)), Ok(batch_result)) = (decoded, decoded_batch) {
            prop_assert_eq!(batch_result, (success, diagnostic));
            let reencoded = encode_write_file_result(success, diagnostic);
            let reencoded_batch = encode_write_files_result(success, diagnostic);
            prop_assert_eq!(reencoded.as_slice(), payload.as_slice());
            prop_assert_eq!(reencoded_batch.as_slice(), payload.as_slice());
        }
    }
}
