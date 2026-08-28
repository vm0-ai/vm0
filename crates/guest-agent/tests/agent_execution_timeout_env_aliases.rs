//! Agent execution timeout aliases are resolved once at the process-env boundary.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std::time::Duration;

use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::run_context::GuestRuntime;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const VALID_TIMEOUT: &str = "37";
const CANONICAL_CONFLICT_TIMEOUT: &str = "41";
const LEGACY_CONFLICT_TIMEOUT: &str = "43";
const CANONICAL_INVALID_TIMEOUT: &str = "canonical-invalid-timeout-must-not-leak";
const LEGACY_INVALID_TIMEOUT: &str = "legacy-invalid-timeout-must-not-leak";
const TOO_LARGE_TIMEOUT: &str = "18446744073709551615";
const SOURCE_EVENT: &str = "agent_execution_timeout_env_source";
const PARSE_ERROR: &str = "agent execution timeout must be a positive integer number of seconds";
const ZERO_ERROR: &str = "agent execution timeout must be greater than zero";
const TOO_LARGE_ERROR: &str = "agent execution timeout is too large";

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
    expected_raw: &'static str,
    expected_timeout_secs: Option<u64>,
    expected_source: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct ConflictCase {
    name: &'static str,
    canonical: &'static str,
    legacy: &'static str,
}

#[derive(Clone, Copy)]
struct ValidationCase {
    name: &'static str,
    canonical: AliasInput,
    legacy: AliasInput,
    expected_raw: &'static str,
    expected_source: &'static str,
    expected_error: &'static str,
}

const SUCCESS_CASES: [SuccessCase; 14] = [
    SuccessCase {
        name: "both-absent",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Absent,
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-only",
        canonical: AliasInput::Readable(VALID_TIMEOUT),
        legacy: AliasInput::Absent,
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(VALID_TIMEOUT),
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual",
        canonical: AliasInput::Readable(VALID_TIMEOUT),
        legacy: AliasInput::Readable(VALID_TIMEOUT),
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-empty-only",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Absent,
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(""),
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(""),
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-non-unicode-only",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Absent,
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: None,
    },
    SuccessCase {
        name: "legacy-non-unicode-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::NonUnicode,
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: None,
    },
    SuccessCase {
        name: "both-non-unicode",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::NonUnicode,
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-with-unreadable-legacy",
        canonical: AliasInput::Readable(VALID_TIMEOUT),
        legacy: AliasInput::NonUnicode,
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(VALID_TIMEOUT),
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "canonical-empty-with-unreadable-legacy",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::NonUnicode,
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(""),
        expected_raw: "",
        expected_timeout_secs: None,
        expected_source: Some("legacy-only"),
    },
];

const CONFLICT_CASES: [ConflictCase; 3] = [
    ConflictCase {
        name: "different-non-empty-values",
        canonical: CANONICAL_CONFLICT_TIMEOUT,
        legacy: LEGACY_CONFLICT_TIMEOUT,
    },
    ConflictCase {
        name: "canonical-empty-legacy-non-empty",
        canonical: "",
        legacy: LEGACY_CONFLICT_TIMEOUT,
    },
    ConflictCase {
        name: "canonical-non-empty-legacy-empty",
        canonical: CANONICAL_CONFLICT_TIMEOUT,
        legacy: "",
    },
];

const VALIDATION_CASES: [ValidationCase; 8] = [
    ValidationCase {
        name: "canonical-invalid",
        canonical: AliasInput::Readable(CANONICAL_INVALID_TIMEOUT),
        legacy: AliasInput::Absent,
        expected_raw: CANONICAL_INVALID_TIMEOUT,
        expected_source: "canonical-only",
        expected_error: PARSE_ERROR,
    },
    ValidationCase {
        name: "legacy-invalid",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(LEGACY_INVALID_TIMEOUT),
        expected_raw: LEGACY_INVALID_TIMEOUT,
        expected_source: "legacy-only",
        expected_error: PARSE_ERROR,
    },
    ValidationCase {
        name: "canonical-whitespace",
        canonical: AliasInput::Readable(" 37 "),
        legacy: AliasInput::Absent,
        expected_raw: " 37 ",
        expected_source: "canonical-only",
        expected_error: PARSE_ERROR,
    },
    ValidationCase {
        name: "legacy-whitespace",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable("37 "),
        expected_raw: "37 ",
        expected_source: "legacy-only",
        expected_error: PARSE_ERROR,
    },
    ValidationCase {
        name: "canonical-zero",
        canonical: AliasInput::Readable("0"),
        legacy: AliasInput::Absent,
        expected_raw: "0",
        expected_source: "canonical-only",
        expected_error: ZERO_ERROR,
    },
    ValidationCase {
        name: "legacy-zero",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable("0"),
        expected_raw: "0",
        expected_source: "legacy-only",
        expected_error: ZERO_ERROR,
    },
    ValidationCase {
        name: "canonical-too-large",
        canonical: AliasInput::Readable(TOO_LARGE_TIMEOUT),
        legacy: AliasInput::Absent,
        expected_raw: TOO_LARGE_TIMEOUT,
        expected_source: "canonical-only",
        expected_error: TOO_LARGE_ERROR,
    },
    ValidationCase {
        name: "legacy-too-large",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(TOO_LARGE_TIMEOUT),
        expected_raw: TOO_LARGE_TIMEOUT,
        expected_source: "legacy-only",
        expected_error: TOO_LARGE_ERROR,
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

fn clear_timeout_env() {
    remove_test_env(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV);
    remove_test_env(guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV);
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

fn assert_source_evidence(log: &str, case_name: &str, expected_source: Option<&str>) {
    let source_messages = log
        .lines()
        .filter(|line| line.contains(SOURCE_EVENT))
        .filter_map(|line| line.rsplit_once("] ").map(|(_, message)| message))
        .collect::<Vec<_>>();

    match expected_source {
        Some(source) => {
            let expected = format!(
                "{SOURCE_EVENT} key={} source={source}",
                guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV
            );
            assert_eq!(
                source_messages,
                [expected.as_str()],
                "{case_name} emitted incorrect fixed source evidence"
            );
        }
        None => assert!(
            source_messages.is_empty(),
            "{case_name} emitted source evidence for unreadable aliases"
        ),
    }
}

fn materialize_config(
    tmp: &Path,
    case_name: &str,
    raw: GuestConfigRaw,
) -> Result<GuestConfig, String> {
    let runtime_dir = tmp.join(format!("{case_name}-runtime"));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)
        .map_err(|error| format!("create payload directory: {error}"))?;
    let payload = serde_json::to_vec(&guest_contracts::env::RunPayload::default())
        .map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&payload_path, payload)
        .map_err(|error| format!("write run payload: {error}"))?;

    GuestConfig::from_raw(GuestConfigRaw {
        run_id: format!("agent-execution-timeout-alias-{case_name}"),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    })
}

fn expected_conflict_error() -> String {
    format!(
        "conflicting agent execution timeout environment aliases: canonical_key={} \
         legacy_key={} state=conflict",
        guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV
    )
}

fn assert_source_neutral_validation_error(error: &str, case: ValidationCase) {
    assert_eq!(
        error, case.expected_error,
        "{} returned the wrong validation category",
        case.name
    );
    assert!(
        !error.contains(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV),
        "{} named the canonical alias",
        case.name
    );
    assert!(
        !error.contains(guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV),
        "{} named the legacy alias",
        case.name
    );
    if !case.expected_raw.is_empty() {
        assert!(
            !error.contains(case.expected_raw),
            "{} exposed the raw timeout input",
            case.name
        );
    }
}

#[test]
fn process_env_dual_reads_agent_execution_timeout_aliases_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for case in SUCCESS_CASES {
        apply_alias(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            case.canonical,
        );
        apply_alias(
            guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            case.legacy,
        );
        let (raw, log) = capture_raw(&tmp.path().join(format!("success-{}.log", case.name)))?;
        let raw = raw.map_err(std::io::Error::other)?;
        assert_eq!(
            raw.agent_execution_timeout_secs, case.expected_raw,
            "{} resolved the wrong raw timeout",
            case.name
        );
        assert_source_evidence(&log, case.name, case.expected_source);

        let config = materialize_config(tmp.path(), &format!("success-{}", case.name), raw)
            .map_err(std::io::Error::other)?;
        assert_eq!(
            config.agent_execution_timeout,
            case.expected_timeout_secs.map(Duration::from_secs),
            "{} produced the wrong configured duration",
            case.name
        );
    }

    let expected_conflict = expected_conflict_error();
    for case in CONFLICT_CASES {
        set_test_env(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            case.canonical,
        );
        set_test_env(
            guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            case.legacy,
        );
        let (raw, log) = capture_raw(&tmp.path().join(format!("conflict-{}.log", case.name)))?;
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
        assert_eq!(
            error, expected_conflict,
            "{} returned the wrong fixed conflict diagnostic",
            case.name
        );
        assert!(
            !log.contains(SOURCE_EVENT),
            "{} emitted success evidence for a conflict",
            case.name
        );
    }

    for case in VALIDATION_CASES {
        apply_alias(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            case.canonical,
        );
        apply_alias(
            guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            case.legacy,
        );
        let (raw, log) = capture_raw(&tmp.path().join(format!("validation-{}.log", case.name)))?;
        let raw = raw.map_err(std::io::Error::other)?;
        assert_eq!(
            raw.agent_execution_timeout_secs, case.expected_raw,
            "{} changed the selected raw timeout before validation",
            case.name
        );
        assert_source_evidence(&log, case.name, Some(case.expected_source));

        let error = match materialize_config(tmp.path(), &format!("validation-{}", case.name), raw)
        {
            Ok(_) => {
                return Err(std::io::Error::other(format!(
                    "{} accepted an invalid timeout",
                    case.name
                ))
                .into());
            }
            Err(error) => error,
        };
        assert_source_neutral_validation_error(&error, case);
    }

    set_test_env(
        guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        CANONICAL_CONFLICT_TIMEOUT,
    );
    set_test_env(
        guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        LEGACY_CONFLICT_TIMEOUT,
    );
    for key in [
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
    ] {
        remove_test_env(key);
    }
    let runtime_error = match GuestRuntime::from_process_env() {
        Ok(_) => {
            return Err(
                "production runtime accepted conflicting agent execution timeout aliases".into(),
            );
        }
        Err(error) => error,
    };
    assert_eq!(
        runtime_error, expected_conflict,
        "production runtime did not fail at timeout capture"
    );

    clear_timeout_env();
    Ok(())
}
