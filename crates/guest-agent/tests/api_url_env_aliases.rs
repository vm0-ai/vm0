//! Guest root captures only the canonical API URL in this process-isolated test binary.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_URL: &str =
    "https://canonical-api-url-must-not-leak.example.test/%2F?raw=%20#fragment";
const RETIRED_URL: &str = "https://retired-api-url-must-not-leak.example.test/private-path";
const API_TOKEN: &str = "api-url-test-token-must-not-leak";
const VALUE_MARKERS: [&str; 3] = [
    "canonical-api-url-must-not-leak",
    "retired-api-url-must-not-leak",
    API_TOKEN,
];
const SOURCE_EVENT: &str = "api_url_env_source";
const CONFLICT_DIAGNOSTIC: &str = "conflicting API backend URL environment aliases";

#[derive(Clone, Copy)]
enum EnvInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
struct CaptureCase {
    name: &'static str,
    canonical: EnvInput,
    retired: EnvInput,
    expected_value: &'static str,
}

const CAPTURE_CASES: [CaptureCase; 9] = [
    CaptureCase {
        name: "both-absent",
        canonical: EnvInput::Absent,
        retired: EnvInput::Absent,
        expected_value: "",
    },
    CaptureCase {
        name: "canonical-readable",
        canonical: EnvInput::Readable(CANONICAL_URL),
        retired: EnvInput::Absent,
        expected_value: CANONICAL_URL,
    },
    CaptureCase {
        name: "canonical-present-empty",
        canonical: EnvInput::Readable(""),
        retired: EnvInput::Absent,
        expected_value: "",
    },
    CaptureCase {
        name: "canonical-non-unicode",
        canonical: EnvInput::NonUnicode,
        retired: EnvInput::Absent,
        expected_value: "",
    },
    CaptureCase {
        name: "retired-readable-only",
        canonical: EnvInput::Absent,
        retired: EnvInput::Readable(RETIRED_URL),
        expected_value: "",
    },
    CaptureCase {
        name: "canonical-readable-with-different-retired",
        canonical: EnvInput::Readable(CANONICAL_URL),
        retired: EnvInput::Readable(RETIRED_URL),
        expected_value: CANONICAL_URL,
    },
    CaptureCase {
        name: "canonical-readable-with-non-unicode-retired",
        canonical: EnvInput::Readable(CANONICAL_URL),
        retired: EnvInput::NonUnicode,
        expected_value: CANONICAL_URL,
    },
    CaptureCase {
        name: "canonical-empty-with-readable-retired",
        canonical: EnvInput::Readable(""),
        retired: EnvInput::Readable(RETIRED_URL),
        expected_value: "",
    },
    CaptureCase {
        name: "canonical-non-unicode-with-readable-retired",
        canonical: EnvInput::NonUnicode,
        retired: EnvInput::Readable(RETIRED_URL),
        expected_value: "",
    },
];

fn set_test_env(key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test does not start threads while configuring or capturing process env.
    unsafe {
        std::env::set_var(key, value);
    }
}

fn remove_test_env(key: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test does not start threads while configuring or capturing process env.
    unsafe {
        std::env::remove_var(key);
    }
}

fn apply_input(key: &str, input: EnvInput) {
    remove_test_env(key);
    match input {
        EnvInput::Absent => {}
        EnvInput::Readable(value) => set_test_env(key, value),
        EnvInput::NonUnicode => set_test_env(key, OsString::from_vec(vec![0xff])),
    }
}

fn clear_api_url_env() {
    remove_test_env(guest_contracts::env::CANONICAL_API_URL_ENV);
    remove_test_env(guest_contracts::env::API_URL_ENV);
}

fn clear_api_token_env() {
    remove_test_env(guest_contracts::env::CANONICAL_API_TOKEN_ENV);
    remove_test_env("VM0_API_TOKEN");
}

fn capture_raw(log_path: &Path) -> (Result<GuestConfigRaw, String>, String) {
    guest_common::log::clear_system_log_file();
    let raw = GuestConfigRaw::from_process_env();
    assert!(
        !log_path.exists(),
        "raw capture installed or wrote a system-log sink"
    );
    let evidence = raw
        .as_ref()
        .map(|raw| {
            raw.bootstrap_alias_source_events()
                .map(|(family, key, source)| {
                    format!("[captured] {family} key={key} source={source}")
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    (raw, evidence)
}

fn assert_value_free(text: &str, context: &str) {
    for marker in VALUE_MARKERS {
        assert!(
            !text.contains(marker),
            "{context} exposed API URL or token value material"
        );
    }
}

fn assert_no_retired_reader_evidence(evidence: &str, case: CaptureCase) {
    assert_value_free(evidence, case.name);
    assert!(
        !evidence.contains(SOURCE_EVENT),
        "{} emitted retired API URL source evidence: {evidence}",
        case.name
    );
    assert!(
        !evidence.contains(CONFLICT_DIAGNOSTIC),
        "{} emitted the retired API URL conflict diagnostic: {evidence}",
        case.name
    );
}

fn materialize_config(
    tmp: &Path,
    scenario: &str,
    raw: GuestConfigRaw,
) -> Result<GuestConfig, String> {
    let runtime_dir = tmp.join(format!("{scenario}-runtime"));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)
        .map_err(|error| format!("create payload directory: {error}"))?;
    let payload = serde_json::to_vec(&guest_contracts::env::RunPayload::default())
        .map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&payload_path, payload)
        .map_err(|error| format!("write run payload: {error}"))?;

    GuestConfig::from_raw(GuestConfigRaw {
        run_id: format!("api-url-capture-{scenario}"),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    })
}

fn assert_http_semantics(tmp: &Path, case: CaptureCase, raw: GuestConfigRaw) -> TestResult {
    let mut without_token = raw.clone();
    without_token.api_token.clear();
    let disabled_config =
        materialize_config(tmp, &format!("{}-http-disabled", case.name), without_token)
            .map_err(std::io::Error::other)?;
    assert_eq!(
        disabled_config.api_url, case.expected_value,
        "{}",
        case.name
    );
    let disabled = HttpClient::for_config(&disabled_config)?;
    assert!(
        !disabled.has_api(),
        "{} enabled API HTTP without a token",
        case.name
    );

    let mut with_token = raw;
    with_token.api_token = API_TOKEN.to_string();
    let enabled_config =
        materialize_config(tmp, &format!("{}-http-enabled", case.name), with_token)
            .map_err(std::io::Error::other)?;
    assert_eq!(enabled_config.api_url, case.expected_value, "{}", case.name);
    if case.expected_value.is_empty() {
        let error = match HttpClient::for_config(&enabled_config) {
            Ok(_) => {
                return Err(std::io::Error::other(format!(
                    "{} enabled API HTTP without a URL",
                    case.name
                ))
                .into());
            }
            Err(error) => error.to_string(),
        };
        assert_value_free(&error, case.name);
        assert!(
            error.contains(guest_contracts::env::CANONICAL_API_URL_ENV),
            "{} changed the canonical missing API URL diagnostic: {error}",
            case.name
        );
        assert!(
            !error.contains(CONFLICT_DIAGNOSTIC),
            "{} emitted the retired conflict diagnostic: {error}",
            case.name
        );
    } else {
        let enabled = HttpClient::for_config(&enabled_config)?;
        assert!(enabled.has_api(), "{} disabled valid API HTTP", case.name);
    }
    Ok(())
}

#[test]
fn process_env_captures_only_canonical_api_url_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;
    clear_api_token_env();

    for case in CAPTURE_CASES {
        apply_input(guest_contracts::env::CANONICAL_API_URL_ENV, case.canonical);
        apply_input(guest_contracts::env::API_URL_ENV, case.retired);
        let (raw, evidence) = capture_raw(&tmp.path().join(format!("{}.log", case.name)));
        let raw = match raw {
            Ok(raw) => raw,
            Err(error) => {
                assert_value_free(&error, case.name);
                assert!(
                    !error.contains(CONFLICT_DIAGNOSTIC),
                    "{} retained the API URL conflict reader: {error}",
                    case.name
                );
                return Err(std::io::Error::other(format!(
                    "{} unexpectedly rejected root API URL input: {error}",
                    case.name
                ))
                .into());
            }
        };
        assert_eq!(
            raw.api_url, case.expected_value,
            "{} captured the wrong root API URL",
            case.name
        );
        assert_no_retired_reader_evidence(&evidence, case);
        assert_http_semantics(tmp.path(), case, raw)?;
    }

    clear_api_url_env();
    clear_api_token_env();
    Ok(())
}
