//! Agent execution timeout is captured only from its canonical process env key.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std::time::Duration;

use guest_agent::env::{GuestConfig, GuestConfigRaw};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const RETIRED_AGENT_EXECUTION_TIMEOUT_SECS_ENV: &str = "VM0_AGENT_EXECUTION_TIMEOUT_SECS";
const VALID_TIMEOUT: &str = "37";
const STALE_TIMEOUT: &str = "43";
const INVALID_TIMEOUT: &str = "canonical-invalid-timeout-must-not-leak";
const TOO_LARGE_TIMEOUT: &str = "18446744073709551615";
const PARSE_ERROR: &str = "agent execution timeout must be a positive integer number of seconds";
const ZERO_ERROR: &str = "agent execution timeout must be greater than zero";
const TOO_LARGE_ERROR: &str = "agent execution timeout is too large";

#[derive(Clone, Copy)]
enum EnvInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
struct SuccessCase {
    name: &'static str,
    canonical: EnvInput,
    retired: EnvInput,
    expected_raw: &'static str,
    expected_timeout_secs: Option<u64>,
}

#[derive(Clone, Copy)]
struct ValidationCase {
    name: &'static str,
    canonical: &'static str,
    retired: EnvInput,
    expected_error: &'static str,
}

const SUCCESS_CASES: [SuccessCase; 9] = [
    SuccessCase {
        name: "both-absent",
        canonical: EnvInput::Absent,
        retired: EnvInput::Absent,
        expected_raw: "",
        expected_timeout_secs: None,
    },
    SuccessCase {
        name: "retired-only",
        canonical: EnvInput::Absent,
        retired: EnvInput::Readable(STALE_TIMEOUT),
        expected_raw: "",
        expected_timeout_secs: None,
    },
    SuccessCase {
        name: "canonical-empty-with-stale-retired",
        canonical: EnvInput::Readable(""),
        retired: EnvInput::Readable(STALE_TIMEOUT),
        expected_raw: "",
        expected_timeout_secs: None,
    },
    SuccessCase {
        name: "canonical-non-unicode",
        canonical: EnvInput::NonUnicode,
        retired: EnvInput::Absent,
        expected_raw: "",
        expected_timeout_secs: None,
    },
    SuccessCase {
        name: "canonical-non-unicode-with-stale-retired",
        canonical: EnvInput::NonUnicode,
        retired: EnvInput::Readable(STALE_TIMEOUT),
        expected_raw: "",
        expected_timeout_secs: None,
    },
    SuccessCase {
        name: "canonical-valid",
        canonical: EnvInput::Readable(VALID_TIMEOUT),
        retired: EnvInput::Absent,
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
    },
    SuccessCase {
        name: "canonical-valid-with-equal-retired",
        canonical: EnvInput::Readable(VALID_TIMEOUT),
        retired: EnvInput::Readable(VALID_TIMEOUT),
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
    },
    SuccessCase {
        name: "canonical-valid-with-different-retired",
        canonical: EnvInput::Readable(VALID_TIMEOUT),
        retired: EnvInput::Readable(STALE_TIMEOUT),
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
    },
    SuccessCase {
        name: "canonical-valid-with-non-unicode-retired",
        canonical: EnvInput::Readable(VALID_TIMEOUT),
        retired: EnvInput::NonUnicode,
        expected_raw: VALID_TIMEOUT,
        expected_timeout_secs: Some(37),
    },
];

const VALIDATION_CASES: [ValidationCase; 4] = [
    ValidationCase {
        name: "canonical-invalid-with-stale-retired",
        canonical: INVALID_TIMEOUT,
        retired: EnvInput::Readable(VALID_TIMEOUT),
        expected_error: PARSE_ERROR,
    },
    ValidationCase {
        name: "canonical-whitespace-with-stale-retired",
        canonical: " 37 ",
        retired: EnvInput::Readable(VALID_TIMEOUT),
        expected_error: PARSE_ERROR,
    },
    ValidationCase {
        name: "canonical-zero-with-stale-retired",
        canonical: "0",
        retired: EnvInput::Readable(VALID_TIMEOUT),
        expected_error: ZERO_ERROR,
    },
    ValidationCase {
        name: "canonical-too-large-with-stale-retired",
        canonical: TOO_LARGE_TIMEOUT,
        retired: EnvInput::Readable(VALID_TIMEOUT),
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

fn apply_env(key: &str, input: EnvInput) {
    remove_test_env(key);
    match input {
        EnvInput::Absent => {}
        EnvInput::Readable(value) => set_test_env(key, value),
        EnvInput::NonUnicode => set_test_env(key, OsString::from_vec(vec![0xff])),
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
        run_id: format!("agent-execution-timeout-{case_name}"),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    })
}

fn assert_validation_error(error: &str, case: ValidationCase) {
    assert_eq!(
        error, case.expected_error,
        "{} returned the wrong validation category",
        case.name
    );
    assert!(
        !error.contains(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV),
        "{} named the canonical key",
        case.name
    );
    assert!(
        !error.contains(RETIRED_AGENT_EXECUTION_TIMEOUT_SECS_ENV),
        "{} named the retired key",
        case.name
    );
    assert!(
        !error.contains(case.canonical),
        "{} exposed the raw canonical input",
        case.name
    );
}

#[test]
fn process_env_uses_only_canonical_agent_execution_timeout() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for case in SUCCESS_CASES {
        apply_env(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            case.canonical,
        );
        apply_env(RETIRED_AGENT_EXECUTION_TIMEOUT_SECS_ENV, case.retired);

        let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;
        assert_eq!(
            raw.agent_execution_timeout_secs, case.expected_raw,
            "{} captured the wrong raw timeout",
            case.name
        );

        let config =
            materialize_config(tmp.path(), case.name, raw).map_err(std::io::Error::other)?;
        assert_eq!(
            config.agent_execution_timeout,
            case.expected_timeout_secs.map(Duration::from_secs),
            "{} produced the wrong configured duration",
            case.name
        );
    }

    for case in VALIDATION_CASES {
        apply_env(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            EnvInput::Readable(case.canonical),
        );
        apply_env(RETIRED_AGENT_EXECUTION_TIMEOUT_SECS_ENV, case.retired);

        let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;
        assert_eq!(
            raw.agent_execution_timeout_secs, case.canonical,
            "{} changed the canonical raw timeout before validation",
            case.name
        );

        let error = match materialize_config(tmp.path(), case.name, raw) {
            Ok(_) => {
                return Err(std::io::Error::other(format!(
                    "{} accepted an invalid canonical timeout",
                    case.name
                ))
                .into());
            }
            Err(error) => error,
        };
        assert_validation_error(&error, case);
    }

    remove_test_env(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV);
    remove_test_env(RETIRED_AGENT_EXECUTION_TIMEOUT_SECS_ENV);
    Ok(())
}
