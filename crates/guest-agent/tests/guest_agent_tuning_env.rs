//! Guest Agent timing controls use canonical bootstrap keys and preserve parsing semantics.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{GuestConfig, GuestConfigRaw};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const VALID_VALUE: &str = "37";
const OUT_OF_RANGE_VALUE: &str = "3601";
const INVALID_VALUE: &str = "canonical-invalid-tuning";
#[derive(Clone, Copy)]
struct TuningEnvKey {
    name: &'static str,
    canonical: &'static str,
    raw_value: fn(&GuestConfigRaw) -> &str,
    configured_secs: fn(&GuestConfig) -> u64,
    default_secs: u64,
    bounded: bool,
}

const TUNING_ENV_KEYS: [TuningEnvKey; 4] = [
    TuningEnvKey {
        name: "stuck-tool-timeout",
        canonical: guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        raw_value: |raw| &raw.stuck_tool_timeout_secs,
        configured_secs: |config| config.stuck_tool_timeout_secs,
        default_secs: 300,
        bounded: false,
    },
    TuningEnvKey {
        name: "post-result-sigterm-grace",
        canonical: guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        raw_value: |raw| &raw.post_result_sigterm_grace_secs,
        configured_secs: |config| config.post_result_sigterm_grace.as_secs(),
        default_secs: 10,
        bounded: true,
    },
    TuningEnvKey {
        name: "post-result-total-cap",
        canonical: guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        raw_value: |raw| &raw.post_result_total_cap_secs,
        configured_secs: |config| config.post_result_total_cap.as_secs(),
        default_secs: 120,
        bounded: true,
    },
    TuningEnvKey {
        name: "post-result-sigkill-grace",
        canonical: guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        raw_value: |raw| &raw.post_result_sigkill_grace_secs,
        configured_secs: |config| config.post_result_sigkill_grace.as_secs(),
        default_secs: 5,
        bounded: true,
    },
];

#[derive(Clone, Copy)]
enum EnvInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
enum ConfigExpectation {
    Default,
    Exact(u64),
    OutOfRange,
}

#[derive(Clone, Copy)]
enum DiagnosticExpectation {
    None,
    Invalid,
    OutOfRange,
}

#[derive(Clone, Copy)]
struct CanonicalCase {
    name: &'static str,
    canonical: EnvInput,
    expected_raw: &'static str,
    config: ConfigExpectation,
    diagnostic: DiagnosticExpectation,
}

const CANONICAL_CASES: [CanonicalCase; 7] = [
    CanonicalCase {
        name: "absent",
        canonical: EnvInput::Absent,
        expected_raw: "",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "exact-value",
        canonical: EnvInput::Readable(VALID_VALUE),
        expected_raw: VALID_VALUE,
        config: ConfigExpectation::Exact(37),
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "empty-uses-default",
        canonical: EnvInput::Readable(""),
        expected_raw: "",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "non-unicode-uses-default",
        canonical: EnvInput::NonUnicode,
        expected_raw: "",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "whitespace-is-not-normalized",
        canonical: EnvInput::Readable(" 37 "),
        expected_raw: " 37 ",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::Invalid,
    },
    CanonicalCase {
        name: "invalid-uses-default",
        canonical: EnvInput::Readable(INVALID_VALUE),
        expected_raw: INVALID_VALUE,
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::Invalid,
    },
    CanonicalCase {
        name: "out-of-range-preserves-existing-bound",
        canonical: EnvInput::Readable(OUT_OF_RANGE_VALUE),
        expected_raw: OUT_OF_RANGE_VALUE,
        config: ConfigExpectation::OutOfRange,
        diagnostic: DiagnosticExpectation::OutOfRange,
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

fn clear_tuning_env() {
    for key in TUNING_ENV_KEYS {
        remove_test_env(key.canonical);
    }
}

fn materialize_config(
    tmp: &Path,
    key: TuningEnvKey,
    case: CanonicalCase,
    raw: GuestConfigRaw,
) -> Result<(GuestConfig, String), String> {
    let runtime_dir = tmp.join(format!("{}-{}-runtime", key.name, case.name));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)
        .map_err(|error| format!("create payload directory: {error}"))?;
    let payload = serde_json::to_vec(&guest_contracts::env::RunPayload::default())
        .map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&payload_path, payload)
        .map_err(|error| format!("write run payload: {error}"))?;

    let log_path = tmp.join(format!("{}-{}.log", key.name, case.name));
    guest_common::log::clear_system_log_file();
    guest_common::log::set_system_log_file(&log_path);
    let config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: format!("guest-agent-canonical-tuning-{}-{}", key.name, case.name),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    });
    guest_common::log::clear_system_log_file();
    let config = config?;
    let log = match std::fs::read_to_string(log_path) {
        Ok(log) => log,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("read diagnostic log: {error}")),
    };
    Ok((config, log))
}

fn assert_diagnostic(log: &str, key: TuningEnvKey, case: CanonicalCase) {
    let mut diagnostic_lines = log.lines().filter(|line| line.contains(key.canonical));
    let diagnostic_line = diagnostic_lines.next();
    let expected_message = match case.diagnostic {
        DiagnosticExpectation::None => None,
        DiagnosticExpectation::Invalid => Some("is not a valid u64"),
        DiagnosticExpectation::OutOfRange if key.bounded => Some("exceeds maximum 3600s"),
        DiagnosticExpectation::OutOfRange => None,
    };

    match expected_message {
        Some(message) => {
            assert!(
                diagnostic_line.is_some_and(|line| line.contains(message)),
                "{} {} omitted or changed the operator diagnostic: {diagnostic_line:?}",
                key.name,
                case.name
            );
            assert!(
                diagnostic_lines.next().is_none(),
                "{} {} emitted duplicate operator diagnostics",
                key.name,
                case.name
            );
        }
        None => assert!(
            diagnostic_line.is_none(),
            "{} {} emitted an unexpected operator diagnostic: {diagnostic_line:?}",
            key.name,
            case.name
        ),
    }
}

#[test]
fn process_env_reads_only_canonical_guest_agent_tuning_keys() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for key in TUNING_ENV_KEYS {
        for case in CANONICAL_CASES {
            clear_tuning_env();
            apply_input(key.canonical, case.canonical);
            let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;

            assert_eq!(
                (key.raw_value)(&raw),
                case.expected_raw,
                "{} {} captured the wrong raw value",
                key.name,
                case.name
            );
            let (config, log) =
                materialize_config(tmp.path(), key, case, raw).map_err(std::io::Error::other)?;
            let expected_secs = match case.config {
                ConfigExpectation::Default => key.default_secs,
                ConfigExpectation::Exact(value) => value,
                ConfigExpectation::OutOfRange if key.bounded => key.default_secs,
                ConfigExpectation::OutOfRange => OUT_OF_RANGE_VALUE.parse::<u64>()?,
            };
            assert_eq!(
                (key.configured_secs)(&config),
                expected_secs,
                "{} {} changed parsing, defaults, or bounds",
                key.name,
                case.name
            );
            assert_diagnostic(&log, key, case);
        }
    }

    clear_tuning_env();
    guest_common::log::clear_system_log_file();
    Ok(())
}
