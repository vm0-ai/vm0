//! API backend URL aliases are resolved once in this process-isolated test binary.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_URL: &str = "https://canonical-api-url-must-not-leak.example.test/private-path";
const LEGACY_URL: &str = "https://legacy-api-url-must-not-leak.example.test/private-path";
const SHARED_URL: &str = "https://shared-api-url-must-not-leak.example.test/private-path";
const API_TOKEN: &str = "api-url-test-token-must-not-leak";
const VALUE_MARKERS: [&str; 4] = [
    "canonical-api-url-must-not-leak",
    "legacy-api-url-must-not-leak",
    "shared-api-url-must-not-leak",
    API_TOKEN,
];
const SOURCE_EVENT: &str = "api_url_env_source";

#[derive(Clone, Copy)]
enum AliasInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
struct SuccessCase {
    name: &'static str,
    canonical: AliasInput,
    legacy: AliasInput,
    expected_value: &'static str,
    expected_source: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct ConflictCase {
    name: &'static str,
    canonical: &'static str,
    legacy: &'static str,
}

const SUCCESS_CASES: [SuccessCase; 14] = [
    SuccessCase {
        name: "both-absent",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Absent,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-only",
        canonical: AliasInput::Readable(CANONICAL_URL),
        legacy: AliasInput::Absent,
        expected_value: CANONICAL_URL,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(LEGACY_URL),
        expected_value: LEGACY_URL,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual",
        canonical: AliasInput::Readable(SHARED_URL),
        legacy: AliasInput::Readable(SHARED_URL),
        expected_value: SHARED_URL,
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-empty-only",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Absent,
        expected_value: "",
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(""),
        expected_value: "",
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(""),
        expected_value: "",
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-non-unicode-only",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Absent,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "legacy-non-unicode-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::NonUnicode,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "both-non-unicode",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::NonUnicode,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-with-unreadable-legacy",
        canonical: AliasInput::Readable(CANONICAL_URL),
        legacy: AliasInput::NonUnicode,
        expected_value: CANONICAL_URL,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(LEGACY_URL),
        expected_value: LEGACY_URL,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "canonical-empty-with-unreadable-legacy",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::NonUnicode,
        expected_value: "",
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(""),
        expected_value: "",
        expected_source: Some("legacy-only"),
    },
];

const CONFLICT_CASES: [ConflictCase; 3] = [
    ConflictCase {
        name: "different-readable-values",
        canonical: CANONICAL_URL,
        legacy: LEGACY_URL,
    },
    ConflictCase {
        name: "canonical-empty-legacy-non-empty",
        canonical: "",
        legacy: LEGACY_URL,
    },
    ConflictCase {
        name: "canonical-non-empty-legacy-empty",
        canonical: CANONICAL_URL,
        legacy: "",
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

fn apply_alias(key: &str, input: AliasInput) {
    remove_test_env(key);
    match input {
        AliasInput::Absent => {}
        AliasInput::Readable(value) => set_test_env(key, value),
        AliasInput::NonUnicode => set_test_env(key, OsString::from_vec(vec![0xff])),
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

fn capture_raw(log_path: &Path) -> std::io::Result<(Result<GuestConfigRaw, String>, String)> {
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
    Ok((raw, evidence))
}

fn assert_value_free(text: &str, context: &str) {
    for marker in VALUE_MARKERS {
        assert!(
            !text.contains(marker),
            "{context} exposed API URL or token value material"
        );
    }
}

fn assert_source_evidence(log: &str, case: SuccessCase) {
    assert_value_free(log, case.name);
    let source_messages = log
        .lines()
        .filter(|line| line.contains(SOURCE_EVENT))
        .filter_map(|line| line.rsplit_once("] ").map(|(_, message)| message))
        .collect::<Vec<_>>();

    match case.expected_source {
        Some(source) => {
            let expected = format!(
                "{SOURCE_EVENT} key={} source={source}",
                guest_contracts::env::CANONICAL_API_URL_ENV
            );
            assert_eq!(
                source_messages,
                [expected.as_str()],
                "{} emitted incorrect fixed source evidence",
                case.name
            );
        }
        None => assert!(
            source_messages.is_empty(),
            "{} emitted source evidence for unreadable aliases",
            case.name
        ),
    }
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
        run_id: format!("api-url-alias-{scenario}"),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    })
}

fn assert_http_semantics(tmp: &Path, case: SuccessCase, raw: GuestConfigRaw) -> TestResult {
    let mut without_token = raw.clone();
    without_token.api_token.clear();
    let disabled_config =
        materialize_config(tmp, &format!("{}-http-disabled", case.name), without_token)
            .map_err(std::io::Error::other)?;
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
            error.contains(guest_contracts::env::API_URL_ENV),
            "{} changed the missing API URL diagnostic: {error}",
            case.name
        );
    } else {
        let enabled = HttpClient::for_config(&enabled_config)?;
        assert!(enabled.has_api(), "{} disabled valid API HTTP", case.name);
    }
    Ok(())
}

fn expected_conflict_error() -> String {
    format!(
        "conflicting API backend URL environment aliases: canonical_key={} \
         legacy_key={} state=conflict",
        guest_contracts::env::CANONICAL_API_URL_ENV,
        guest_contracts::env::API_URL_ENV
    )
}

fn assert_conflict_precedes_private_payload_consumption(tmp: &Path) -> TestResult {
    let runtime_dir = tmp.join("conflict-private-payload-runtime");
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&std::collections::HashMap::from([(
            "CUSTOM_USER_ENV",
            "private-user-value",
        )]))?,
    )?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    for key in [
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        "VM0_USER_ENV_FILE",
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        "VM0_RUN_PAYLOAD_FILE",
    ] {
        remove_test_env(key);
    }
    set_test_env(
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        &runtime_dir,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        &user_env_path,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &run_payload_path,
    );
    set_test_env(guest_contracts::env::RUN_ID_ENV, "api-url-conflict");
    set_test_env("HOME", tmp);
    set_test_env(guest_contracts::env::CANONICAL_API_URL_ENV, CANONICAL_URL);
    set_test_env(guest_contracts::env::API_URL_ENV, LEGACY_URL);

    let log_path = tmp.join("conflict-before-private-payload.log");
    guest_common::log::set_system_log_file(&log_path);
    let error = match GuestConfig::from_process_env() {
        Ok(_) => return Err("API URL conflict consumed private payloads".into()),
        Err(error) => error,
    };
    guest_common::log::clear_system_log_file();
    let log = std::fs::read_to_string(log_path).unwrap_or_default();

    assert_eq!(error, expected_conflict_error());
    assert_value_free(&error, "private-payload-conflict-error");
    assert_value_free(&log, "private-payload-conflict-log");
    assert!(!log.contains(SOURCE_EVENT));
    assert!(user_env_path.exists(), "conflict consumed private user env");
    assert!(
        run_payload_path.exists(),
        "conflict consumed private run payload"
    );
    Ok(())
}

#[test]
fn process_env_dual_reads_api_url_aliases_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;
    clear_api_token_env();

    for case in SUCCESS_CASES {
        apply_alias(guest_contracts::env::CANONICAL_API_URL_ENV, case.canonical);
        apply_alias(guest_contracts::env::API_URL_ENV, case.legacy);
        let (raw, log) = capture_raw(&tmp.path().join(format!("{}.log", case.name)))?;
        let raw = match raw {
            Ok(raw) => raw,
            Err(error) => {
                assert_value_free(&error, case.name);
                return Err(std::io::Error::other(format!(
                    "{} unexpectedly rejected a readable state",
                    case.name
                ))
                .into());
            }
        };
        assert_eq!(
            raw.api_url, case.expected_value,
            "{} resolved the wrong API URL state",
            case.name
        );
        assert_source_evidence(&log, case);
        assert_http_semantics(tmp.path(), case, raw)?;
    }

    let expected_error = expected_conflict_error();
    for case in CONFLICT_CASES {
        set_test_env(guest_contracts::env::CANONICAL_API_URL_ENV, case.canonical);
        set_test_env(guest_contracts::env::API_URL_ENV, case.legacy);
        let (raw, log) = capture_raw(&tmp.path().join(format!("{}.log", case.name)))?;
        let error = match raw {
            Ok(_) => {
                return Err(std::io::Error::other(format!(
                    "{} accepted conflicting readable aliases",
                    case.name
                ))
                .into());
            }
            Err(error) => error,
        };
        assert_eq!(error, expected_error);
        assert_value_free(&error, case.name);
        assert_value_free(&log, case.name);
        assert!(
            !log.contains(SOURCE_EVENT),
            "{} emitted success evidence for a conflict",
            case.name
        );
    }

    assert_conflict_precedes_private_payload_consumption(tmp.path())?;
    clear_api_url_env();
    clear_api_token_env();
    Ok(())
}
