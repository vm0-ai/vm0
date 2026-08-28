use std::path::Path;

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};
use vsock_proto::{
    DecodedExecResult, DecodedGuestStorageManifestRequest, ExecCapturedOutput, ExecTermination,
    GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES, GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES,
    GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES, MAX_EXEC_STDIN_BYTES, MSG_GUEST_STORAGE_MANIFEST,
    MSG_GUEST_STORAGE_MANIFEST_RESULT, ProtocolError, decode_guest_storage_manifest_request,
    decode_guest_storage_manifest_result, encode, encode_exec_result,
    encode_guest_storage_manifest_request, encode_guest_storage_manifest_request_frame_into,
    encode_guest_storage_manifest_result, encode_guest_storage_manifest_result_frame_into,
};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0x570A_6E57_2026_0828;
const MAX_GENERATED_TEXT_CHARS: usize = 12;
const MAX_GENERATED_MANIFEST_BYTES: usize = 64;
const MAX_GENERATED_OUTPUT_BYTES: usize = 64;
const MAX_ARBITRARY_PAYLOAD_BYTES: usize = 512;

#[derive(Clone, Debug)]
struct OwnedRequest {
    timeout_ms: u32,
    run_id: String,
    runtime_dir: String,
    manifest_json: Vec<u8>,
}

impl OwnedRequest {
    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        encode_guest_storage_manifest_request(
            self.timeout_ms,
            &self.run_id,
            &self.runtime_dir,
            &self.manifest_json,
        )
    }

    fn assert_decoded(&self, decoded: &DecodedGuestStorageManifestRequest<'_>) -> TestCaseResult {
        prop_assert_eq!(decoded.timeout_ms, self.timeout_ms);
        prop_assert_eq!(decoded.run_id, self.run_id.as_str());
        prop_assert_eq!(decoded.runtime_dir, self.runtime_dir.as_str());
        prop_assert_eq!(decoded.manifest_json, self.manifest_json.as_slice());
        Ok(())
    }

    fn layout(&self) -> RequestLayout {
        let run_id_len_offset = 4;
        let run_id_offset = run_id_len_offset + 2;
        let runtime_dir_len_offset = run_id_offset + self.run_id.len();
        let runtime_dir_offset = runtime_dir_len_offset + 2;
        let manifest_len_offset = runtime_dir_offset + self.runtime_dir.len();
        RequestLayout {
            run_id_len_offset,
            run_id_offset,
            runtime_dir_len_offset,
            runtime_dir_offset,
            manifest_len_offset,
        }
    }

    fn invalid_mutations(
        &self,
        payload: &[u8],
    ) -> Result<Vec<(&'static str, Vec<u8>)>, TestCaseError> {
        let layout = self.layout();
        let mut trailing = payload.to_vec();
        trailing.push(0);

        Ok(vec![
            ("zero timeout", with_u32(payload, 0, 0)?),
            (
                "run_id length beyond remaining payload",
                with_u16(payload, layout.run_id_len_offset, u16::MAX)?,
            ),
            (
                "runtime_dir length beyond remaining payload",
                with_u16(payload, layout.runtime_dir_len_offset, u16::MAX)?,
            ),
            (
                "manifest length beyond remaining payload",
                with_u32(payload, layout.manifest_len_offset, u32::MAX)?,
            ),
            (
                "invalid run_id UTF-8",
                with_byte(payload, layout.run_id_offset, u8::MAX)?,
            ),
            (
                "invalid runtime_dir UTF-8",
                with_byte(payload, layout.runtime_dir_offset + 1, u8::MAX)?,
            ),
            (
                "run_id embedded NUL",
                with_byte(payload, layout.run_id_offset, 0)?,
            ),
            (
                "runtime_dir embedded NUL",
                with_byte(payload, layout.runtime_dir_offset + 1, 0)?,
            ),
            ("trailing byte", trailing),
        ])
    }
}

#[derive(Clone, Copy)]
struct RequestLayout {
    run_id_len_offset: usize,
    run_id_offset: usize,
    runtime_dir_len_offset: usize,
    runtime_dir_offset: usize,
    manifest_len_offset: usize,
}

#[derive(Clone, Debug)]
struct OwnedResult {
    termination: ExecTermination,
    duration_ms: u32,
    stdout: Vec<u8>,
    stdout_truncated: bool,
    stderr: Vec<u8>,
    stderr_truncated: bool,
    diagnostic: String,
}

impl OwnedResult {
    fn stdout(&self) -> ExecCapturedOutput<'_> {
        ExecCapturedOutput::Captured {
            bytes: &self.stdout,
            truncated: self.stdout_truncated,
        }
    }

    fn stderr(&self) -> ExecCapturedOutput<'_> {
        ExecCapturedOutput::Captured {
            bytes: &self.stderr,
            truncated: self.stderr_truncated,
        }
    }

    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        encode_guest_storage_manifest_result(
            self.termination,
            self.duration_ms,
            self.stdout(),
            self.stderr(),
            &self.diagnostic,
        )
    }

    fn assert_decoded(&self, decoded: &DecodedExecResult<'_>) -> TestCaseResult {
        prop_assert_eq!(decoded.termination, self.termination);
        prop_assert_eq!(decoded.duration_ms, self.duration_ms);
        prop_assert_eq!(decoded.stdout, self.stdout());
        prop_assert_eq!(decoded.stderr, self.stderr());
        prop_assert_eq!(decoded.diagnostic, self.diagnostic.as_str());
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
enum OutputStream {
    Stdout,
    Stderr,
}

impl OutputStream {
    fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
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
        5 => proptest::char::range('a', 'z'),
        1 => Just('-'),
        1 => Just('界'),
        1 => Just('🧪'),
    ]
}

fn nonempty_text_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(text_char_strategy(), 1..=MAX_GENERATED_TEXT_CHARS)
        .prop_map(|characters| characters.into_iter().collect())
}

fn text_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(text_char_strategy(), 0..=MAX_GENERATED_TEXT_CHARS)
        .prop_map(|characters| characters.into_iter().collect())
}

fn request_strategy() -> impl Strategy<Value = OwnedRequest> {
    (
        prop_oneof![Just(1), Just(u32::MAX), 1..=u32::MAX],
        nonempty_text_strategy(),
        nonempty_text_strategy(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_MANIFEST_BYTES),
    )
        .prop_map(
            |(timeout_ms, run_id, runtime_suffix, manifest_json)| OwnedRequest {
                timeout_ms,
                run_id,
                runtime_dir: format!("/{runtime_suffix}"),
                manifest_json,
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

fn result_strategy() -> impl Strategy<Value = OwnedResult> {
    (
        termination_strategy(),
        any::<u32>(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_OUTPUT_BYTES),
        any::<bool>(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_GENERATED_OUTPUT_BYTES),
        any::<bool>(),
        text_strategy(),
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
            )| OwnedResult {
                termination,
                duration_ms,
                stdout,
                stdout_truncated,
                stderr,
                stderr_truncated,
                diagnostic,
            },
        )
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
    let end = offset
        .checked_add(2)
        .ok_or_else(|| TestCaseError::fail("u16 mutation offset overflow"))?;
    let field = mutation.get_mut(offset..end).ok_or_else(|| {
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
    let end = offset
        .checked_add(4)
        .ok_or_else(|| TestCaseError::fail("u32 mutation offset overflow"))?;
    let field = mutation.get_mut(offset..end).ok_or_else(|| {
        TestCaseError::fail(format!(
            "failed to read u32 mutation at {offset} of {} bytes",
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
            decode_guest_storage_manifest_request(prefix).is_err(),
            "accepted strict prefix ending at {prefix_len} of {} bytes",
            payload.len(),
        );
    }
    Ok(())
}

fn with_selected_output(
    stream: OutputStream,
    selected: ExecCapturedOutput<'_>,
) -> (ExecCapturedOutput<'_>, ExecCapturedOutput<'_>) {
    let empty = ExecCapturedOutput::Captured {
        bytes: b"",
        truncated: false,
    };
    match stream {
        OutputStream::Stdout => (selected, empty),
        OutputStream::Stderr => (empty, selected),
    }
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

        let decoded = decode_guest_storage_manifest_request(&payload);
        prop_assert!(decoded.is_ok(), "encoded request failed to decode: {decoded:?}");
        let decoded = decoded.unwrap();
        request.assert_decoded(&decoded)?;

        let reencoded = encode_guest_storage_manifest_request(
            decoded.timeout_ms,
            decoded.run_id,
            decoded.runtime_dir,
            decoded.manifest_json,
        );
        prop_assert!(reencoded.is_ok(), "decoded request failed to re-encode: {reencoded:?}");
        prop_assert_eq!(reencoded.unwrap(), payload.as_slice());

        assert_strict_prefixes_rejected(&payload)?;

        let expected_frame = encode(MSG_GUEST_STORAGE_MANIFEST, seq, &payload);
        prop_assert!(expected_frame.is_ok(), "generic request frame failed: {expected_frame:?}");
        let mut direct_frame = Vec::new();
        let direct_result = encode_guest_storage_manifest_request_frame_into(
            &mut direct_frame,
            seq,
            request.timeout_ms,
            &request.run_id,
            &request.runtime_dir,
            &request.manifest_json,
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
        if let Ok(decoded) = decode_guest_storage_manifest_request(&payload) {
            prop_assert!(decoded.timeout_ms > 0);
            prop_assert!(!decoded.run_id.is_empty());
            prop_assert!(decoded.run_id.len() <= GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES);
            prop_assert!(!decoded.run_id.as_bytes().contains(&0));
            prop_assert!(Path::new(decoded.runtime_dir).is_absolute());
            prop_assert!(decoded.runtime_dir.len() <= GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES);
            prop_assert!(!decoded.runtime_dir.as_bytes().contains(&0));
            prop_assert!(decoded.manifest_json.len() <= MAX_EXEC_STDIN_BYTES);

            let reencoded = encode_guest_storage_manifest_request(
                decoded.timeout_ms,
                decoded.run_id,
                decoded.runtime_dir,
                decoded.manifest_json,
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
                decode_guest_storage_manifest_request(&mutation).is_err(),
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

        let decoded = decode_guest_storage_manifest_result(&payload);
        prop_assert!(decoded.is_ok(), "encoded result failed to decode: {decoded:?}");
        let decoded = decoded.unwrap();
        result.assert_decoded(&decoded)?;

        let reencoded = encode_guest_storage_manifest_result(
            decoded.termination,
            decoded.duration_ms,
            decoded.stdout,
            decoded.stderr,
            decoded.diagnostic,
        );
        prop_assert!(reencoded.is_ok(), "decoded result failed to re-encode: {reencoded:?}");
        prop_assert_eq!(reencoded.unwrap(), payload.as_slice());

        let expected_frame = encode(MSG_GUEST_STORAGE_MANIFEST_RESULT, seq, &payload);
        prop_assert!(expected_frame.is_ok(), "generic result frame failed: {expected_frame:?}");
        let mut direct_frame = Vec::new();
        let direct_result = encode_guest_storage_manifest_result_frame_into(
            &mut direct_frame,
            seq,
            result.termination,
            result.duration_ms,
            result.stdout(),
            result.stderr(),
            &result.diagnostic,
        );
        prop_assert!(direct_result.is_ok(), "direct result frame failed: {direct_result:?}");
        prop_assert_eq!(direct_frame, expected_frame.unwrap());
    }
}

#[test]
fn request_enforces_context_and_size_boundaries() {
    assert!(encode_guest_storage_manifest_request(0, "run", "/run", b"{}").is_err());
    assert!(encode_guest_storage_manifest_request(1, "", "/run", b"{}").is_err());
    assert!(encode_guest_storage_manifest_request(1, "run\0id", "/run", b"{}").is_err());
    assert!(encode_guest_storage_manifest_request(1, "run", "", b"{}").is_err());
    assert!(encode_guest_storage_manifest_request(1, "run", "relative", b"{}").is_err());
    assert!(encode_guest_storage_manifest_request(1, "run", "/run\0directory", b"{}").is_err());

    let max_run_id = "r".repeat(GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES);
    let payload = encode_guest_storage_manifest_request(1, &max_run_id, "/run", b"{}").unwrap();
    assert_eq!(
        decode_guest_storage_manifest_request(&payload)
            .unwrap()
            .run_id,
        max_run_id,
    );
    let oversized_run_id = format!("{max_run_id}r");
    assert!(matches!(
        encode_guest_storage_manifest_request(1, &oversized_run_id, "/run", b"{}"),
        Err(ProtocolError::PayloadTooLarge("run_id", size))
            if size == GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES + 1
    ));

    let max_runtime_dir = format!(
        "/{}",
        "r".repeat(GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES - 1)
    );
    let payload = encode_guest_storage_manifest_request(1, "run", &max_runtime_dir, b"{}").unwrap();
    assert_eq!(
        decode_guest_storage_manifest_request(&payload)
            .unwrap()
            .runtime_dir,
        max_runtime_dir,
    );
    let oversized_runtime_dir = format!("{max_runtime_dir}r");
    assert!(matches!(
        encode_guest_storage_manifest_request(1, "run", &oversized_runtime_dir, b"{}"),
        Err(ProtocolError::PayloadTooLarge("runtime_dir", size))
            if size == GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES + 1
    ));

    let max_manifest = vec![0xA5; MAX_EXEC_STDIN_BYTES];
    let payload = encode_guest_storage_manifest_request(1, "run", "/run", &max_manifest).unwrap();
    assert_eq!(
        decode_guest_storage_manifest_request(&payload)
            .unwrap()
            .manifest_json,
        max_manifest,
    );
    let oversized_manifest = vec![0xA5; MAX_EXEC_STDIN_BYTES + 1];
    assert!(matches!(
        encode_guest_storage_manifest_request(1, "run", "/run", &oversized_manifest),
        Err(ProtocolError::PayloadTooLarge("manifest_json", size))
            if size == MAX_EXEC_STDIN_BYTES + 1
    ));
}

#[test]
fn result_enforces_capture_contract_for_each_stream() {
    for stream in [OutputStream::Stdout, OutputStream::Stderr] {
        let max_output = vec![0xA5; GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES];
        let selected = ExecCapturedOutput::Captured {
            bytes: &max_output,
            truncated: true,
        };
        let (stdout, stderr) = with_selected_output(stream, selected);
        let payload = encode_guest_storage_manifest_result(
            ExecTermination::Exited { exit_code: 7 },
            u32::MAX,
            stdout,
            stderr,
            "boundary",
        )
        .unwrap();
        let decoded = decode_guest_storage_manifest_result(&payload).unwrap();
        assert_eq!(decoded.stdout, stdout);
        assert_eq!(decoded.stderr, stderr);

        let oversized_output = vec![0xA5; GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES + 1];
        let selected = ExecCapturedOutput::Captured {
            bytes: &oversized_output,
            truncated: false,
        };
        let (stdout, stderr) = with_selected_output(stream, selected);
        let encode_error = encode_guest_storage_manifest_result(
            ExecTermination::WaitFailed,
            0,
            stdout,
            stderr,
            "",
        )
        .unwrap_err();
        assert!(matches!(
            encode_error,
            ProtocolError::PayloadTooLarge(field, size)
                if field == stream.name()
                    && size == GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES + 1
        ));
        let generic_payload =
            encode_exec_result(ExecTermination::WaitFailed, 0, stdout, stderr, "").unwrap();
        let decode_error = decode_guest_storage_manifest_result(&generic_payload).unwrap_err();
        assert!(matches!(
            decode_error,
            ProtocolError::PayloadTooLarge(field, size)
                if field == stream.name()
                    && size == GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES + 1
        ));

        let (stdout, stderr) = with_selected_output(stream, ExecCapturedOutput::Discarded);
        assert!(matches!(
            encode_guest_storage_manifest_result(ExecTermination::Cancelled, 0, stdout, stderr, "",),
            Err(ProtocolError::InvalidPayload(
                "guest_storage_manifest_result output must be captured"
            ))
        ));
        let generic_payload =
            encode_exec_result(ExecTermination::Cancelled, 0, stdout, stderr, "").unwrap();
        assert!(matches!(
            decode_guest_storage_manifest_result(&generic_payload),
            Err(ProtocolError::InvalidPayload(
                "guest_storage_manifest_result output must be captured"
            ))
        ));
    }
}
