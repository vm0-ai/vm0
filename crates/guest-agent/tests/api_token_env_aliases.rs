//! Sensitive API-token aliases are resolved once at the process-env boundary.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::run_context::GuestRuntime;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_TOKEN: &str = "canonical-token-must-not-leak";
const LEGACY_TOKEN: &str = "legacy-token-must-not-leak";
const SHARED_TOKEN: &str = "shared-token-must-not-leak";
const TOKEN_VALUES: [&str; 3] = [CANONICAL_TOKEN, LEGACY_TOKEN, SHARED_TOKEN];
const SOURCE_EVENT: &str = "api_token_env_source";

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
        canonical: AliasInput::Readable(CANONICAL_TOKEN),
        legacy: AliasInput::Absent,
        expected_value: CANONICAL_TOKEN,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(LEGACY_TOKEN),
        expected_value: LEGACY_TOKEN,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual",
        canonical: AliasInput::Readable(SHARED_TOKEN),
        legacy: AliasInput::Readable(SHARED_TOKEN),
        expected_value: SHARED_TOKEN,
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
        canonical: AliasInput::Readable(CANONICAL_TOKEN),
        legacy: AliasInput::NonUnicode,
        expected_value: CANONICAL_TOKEN,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(LEGACY_TOKEN),
        expected_value: LEGACY_TOKEN,
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
        name: "different-non-empty-values",
        canonical: CANONICAL_TOKEN,
        legacy: LEGACY_TOKEN,
    },
    ConflictCase {
        name: "canonical-empty-legacy-non-empty",
        canonical: "",
        legacy: LEGACY_TOKEN,
    },
    ConflictCase {
        name: "canonical-non-empty-legacy-empty",
        canonical: CANONICAL_TOKEN,
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

fn clear_api_token_env() {
    remove_test_env(guest_contracts::env::CANONICAL_API_TOKEN_ENV);
    remove_test_env(guest_contracts::env::API_TOKEN_ENV);
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
    for token in TOKEN_VALUES {
        assert!(
            !text.contains(token),
            "{context} exposed API token material"
        );
    }
}

fn assert_source_evidence(log: &str, case: SuccessCase) {
    assert_value_free(log, case.name);
    let source_lines = log
        .lines()
        .filter(|line| line.contains(SOURCE_EVENT))
        .collect::<Vec<_>>();
    match case.expected_source {
        Some(source) => {
            let expected = format!(
                "{SOURCE_EVENT} key={} source={source}",
                guest_contracts::env::CANONICAL_API_TOKEN_ENV
            );
            assert!(
                source_lines.len() == 1
                    && source_lines
                        .first()
                        .and_then(|line| line.rsplit_once("] "))
                        .is_some_and(|(_, message)| message == expected),
                "{} emitted incorrect fixed source evidence",
                case.name
            );
        }
        None => assert!(
            source_lines.is_empty(),
            "{} emitted source evidence for unreadable aliases",
            case.name
        ),
    }
}

fn assert_http_mode(tmp: &Path, case: SuccessCase, raw: GuestConfigRaw) -> TestResult {
    let runtime_dir = tmp.join(format!("{}-runtime", case.name));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)?;
    std::fs::write(
        &payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    let raw = GuestConfigRaw {
        run_id: format!("api-token-alias-{}", case.name),
        api_url: "http://127.0.0.1:1".to_string(),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    };
    let config = match GuestConfig::from_raw(raw) {
        Ok(config) => config,
        Err(error) => {
            assert_value_free(&error, case.name);
            return Err(std::io::Error::other(format!(
                "{} failed to materialize guest config",
                case.name
            ))
            .into());
        }
    };
    let http = match HttpClient::for_config(&config) {
        Ok(http) => http,
        Err(error) => {
            assert_value_free(&error.to_string(), case.name);
            return Err(std::io::Error::other(format!(
                "{} failed to construct HTTP client mode",
                case.name
            ))
            .into());
        }
    };
    assert!(
        http.has_api() != case.expected_value.is_empty(),
        "{} constructed the wrong HTTP client mode",
        case.name
    );
    Ok(())
}

fn expected_conflict_error() -> String {
    format!(
        "conflicting API token environment aliases: canonical_key={} legacy_key={} state=conflict",
        guest_contracts::env::CANONICAL_API_TOKEN_ENV,
        guest_contracts::env::API_TOKEN_ENV
    )
}

#[test]
fn process_env_dual_reads_api_token_aliases_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for case in SUCCESS_CASES {
        apply_alias(
            guest_contracts::env::CANONICAL_API_TOKEN_ENV,
            case.canonical,
        );
        apply_alias(guest_contracts::env::API_TOKEN_ENV, case.legacy);
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
        assert!(
            raw.api_token == case.expected_value,
            "{} resolved the wrong token state",
            case.name
        );
        assert_source_evidence(&log, case);
        assert_http_mode(tmp.path(), case, raw)?;
    }

    let expected_error = expected_conflict_error();
    for case in CONFLICT_CASES {
        set_test_env(
            guest_contracts::env::CANONICAL_API_TOKEN_ENV,
            case.canonical,
        );
        set_test_env(guest_contracts::env::API_TOKEN_ENV, case.legacy);
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
        assert_value_free(&error, case.name);
        assert_value_free(&log, case.name);
        assert!(
            error == expected_error,
            "{} returned the wrong value-free conflict error",
            case.name
        );
        assert!(
            !log.contains(SOURCE_EVENT),
            "{} emitted success evidence for a conflict",
            case.name
        );
    }

    set_test_env(
        guest_contracts::env::CANONICAL_API_TOKEN_ENV,
        CANONICAL_TOKEN,
    );
    set_test_env(guest_contracts::env::API_TOKEN_ENV, LEGACY_TOKEN);
    for key in [
        process_control_ipc::BOOTSTRAP_ENV,
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
    ] {
        remove_test_env(key);
    }
    let runtime_error = match GuestRuntime::from_process_env() {
        Ok(_) => return Err("production runtime accepted conflicting API token aliases".into()),
        Err(error) => error,
    };
    assert_value_free(&runtime_error, "production-runtime-conflict");
    assert!(
        runtime_error == expected_error,
        "production runtime did not fail at API token capture"
    );

    clear_api_token_env();
    Ok(())
}
