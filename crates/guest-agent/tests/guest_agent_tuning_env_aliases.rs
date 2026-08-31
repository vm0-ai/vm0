//! Guest Agent timing controls are captured only from canonical bootstrap keys.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{GuestConfig, GuestConfigRaw};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const VALID_VALUE: &str = "37";
const LEGACY_VALUE: &str = "91";
const OUT_OF_RANGE_VALUE: &str = "3601";
const INVALID_VALUE: &str = "canonical-invalid-tuning";
#[derive(Clone, Copy)]
struct TuningEnvPair {
    name: &'static str,
    canonical: &'static str,
    legacy: &'static str,
    raw_value: fn(&GuestConfigRaw) -> &str,
    configured_secs: fn(&GuestConfig) -> u64,
    default_secs: u64,
    bounded: bool,
}

const TUNING_ENV_PAIRS: [TuningEnvPair; 4] = [
    TuningEnvPair {
        name: "stuck-tool-timeout",
        canonical: guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        legacy: guest_contracts::env::STUCK_TOOL_TIMEOUT_SECS_ENV,
        raw_value: |raw| &raw.stuck_tool_timeout_secs,
        configured_secs: |config| config.stuck_tool_timeout_secs,
        default_secs: 300,
        bounded: false,
    },
    TuningEnvPair {
        name: "post-result-sigterm-grace",
        canonical: guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        legacy: guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        raw_value: |raw| &raw.post_result_sigterm_grace_secs,
        configured_secs: |config| config.post_result_sigterm_grace.as_secs(),
        default_secs: 10,
        bounded: true,
    },
    TuningEnvPair {
        name: "post-result-total-cap",
        canonical: guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        legacy: guest_contracts::env::POST_RESULT_TOTAL_CAP_SECS_ENV,
        raw_value: |raw| &raw.post_result_total_cap_secs,
        configured_secs: |config| config.post_result_total_cap.as_secs(),
        default_secs: 120,
        bounded: true,
    },
    TuningEnvPair {
        name: "post-result-sigkill-grace",
        canonical: guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        legacy: guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
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
    legacy: EnvInput,
    expected_raw: &'static str,
    config: ConfigExpectation,
    diagnostic: DiagnosticExpectation,
}

const CANONICAL_CASES: [CanonicalCase; 9] = [
    CanonicalCase {
        name: "both-absent",
        canonical: EnvInput::Absent,
        legacy: EnvInput::Absent,
        expected_raw: "",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "legacy-only-is-inert",
        canonical: EnvInput::Absent,
        legacy: EnvInput::Readable(LEGACY_VALUE),
        expected_raw: "",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "canonical-only-exact-value",
        canonical: EnvInput::Readable(VALID_VALUE),
        legacy: EnvInput::Absent,
        expected_raw: VALID_VALUE,
        config: ConfigExpectation::Exact(37),
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "canonical-wins-unequal-dual",
        canonical: EnvInput::Readable(VALID_VALUE),
        legacy: EnvInput::Readable(LEGACY_VALUE),
        expected_raw: VALID_VALUE,
        config: ConfigExpectation::Exact(37),
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "canonical-empty-does-not-fallback",
        canonical: EnvInput::Readable(""),
        legacy: EnvInput::Readable(LEGACY_VALUE),
        expected_raw: "",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "canonical-non-unicode-does-not-fallback",
        canonical: EnvInput::NonUnicode,
        legacy: EnvInput::Readable(LEGACY_VALUE),
        expected_raw: "",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::None,
    },
    CanonicalCase {
        name: "canonical-whitespace-is-not-normalized",
        canonical: EnvInput::Readable(" 37 "),
        legacy: EnvInput::Readable(LEGACY_VALUE),
        expected_raw: " 37 ",
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::Invalid,
    },
    CanonicalCase {
        name: "canonical-invalid-uses-default",
        canonical: EnvInput::Readable(INVALID_VALUE),
        legacy: EnvInput::Readable(LEGACY_VALUE),
        expected_raw: INVALID_VALUE,
        config: ConfigExpectation::Default,
        diagnostic: DiagnosticExpectation::Invalid,
    },
    CanonicalCase {
        name: "canonical-out-of-range-preserves-existing-bound",
        canonical: EnvInput::Readable(OUT_OF_RANGE_VALUE),
        legacy: EnvInput::Readable(VALID_VALUE),
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
    for pair in TUNING_ENV_PAIRS {
        remove_test_env(pair.canonical);
        remove_test_env(pair.legacy);
    }
}

fn materialize_config(
    tmp: &Path,
    pair: TuningEnvPair,
    case: CanonicalCase,
    raw: GuestConfigRaw,
) -> Result<(GuestConfig, String), String> {
    let runtime_dir = tmp.join(format!("{}-{}-runtime", pair.name, case.name));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)
        .map_err(|error| format!("create payload directory: {error}"))?;
    let payload = serde_json::to_vec(&guest_contracts::env::RunPayload::default())
        .map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&payload_path, payload)
        .map_err(|error| format!("write run payload: {error}"))?;

    let log_path = tmp.join(format!("{}-{}.log", pair.name, case.name));
    guest_common::log::clear_system_log_file();
    guest_common::log::set_system_log_file(&log_path);
    let config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: format!("guest-agent-canonical-tuning-{}-{}", pair.name, case.name),
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

fn assert_diagnostic(log: &str, pair: TuningEnvPair, case: CanonicalCase) {
    let mut diagnostic_lines = log.lines().filter(|line| line.contains(pair.legacy));
    let diagnostic_line = diagnostic_lines.next();
    let expected_message = match case.diagnostic {
        DiagnosticExpectation::None => None,
        DiagnosticExpectation::Invalid => Some("is not a valid u64"),
        DiagnosticExpectation::OutOfRange if pair.bounded => Some("exceeds maximum 3600s"),
        DiagnosticExpectation::OutOfRange => None,
    };

    match expected_message {
        Some(message) => {
            assert!(
                diagnostic_line.is_some_and(|line| line.contains(message)),
                "{} {} omitted or changed the operator diagnostic: {diagnostic_line:?}",
                pair.name,
                case.name
            );
            assert!(
                diagnostic_lines.next().is_none(),
                "{} {} emitted duplicate operator diagnostics",
                pair.name,
                case.name
            );
        }
        None => assert!(
            diagnostic_line.is_none(),
            "{} {} emitted an unexpected operator diagnostic: {diagnostic_line:?}",
            pair.name,
            case.name
        ),
    }
    assert!(
        !log.contains(pair.canonical),
        "{} {} replaced the retained local-input diagnostic label",
        pair.name,
        case.name
    );
}

#[test]
fn process_env_reads_only_canonical_guest_agent_tuning_keys() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for pair in TUNING_ENV_PAIRS {
        for case in CANONICAL_CASES {
            clear_tuning_env();
            apply_input(pair.canonical, case.canonical);
            apply_input(pair.legacy, case.legacy);
            let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;

            assert_eq!(
                (pair.raw_value)(&raw),
                case.expected_raw,
                "{} {} captured the wrong raw value",
                pair.name,
                case.name
            );
            let (config, log) =
                materialize_config(tmp.path(), pair, case, raw).map_err(std::io::Error::other)?;
            let expected_secs = match case.config {
                ConfigExpectation::Default => pair.default_secs,
                ConfigExpectation::Exact(value) => value,
                ConfigExpectation::OutOfRange if pair.bounded => pair.default_secs,
                ConfigExpectation::OutOfRange => OUT_OF_RANGE_VALUE.parse::<u64>()?,
            };
            assert_eq!(
                (pair.configured_secs)(&config),
                expected_secs,
                "{} {} changed parsing, defaults, or bounds",
                pair.name,
                case.name
            );
            assert_diagnostic(&log, pair, case);
        }
    }

    clear_tuning_env();
    guest_common::log::clear_system_log_file();
    Ok(())
}
