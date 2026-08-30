//! Guest Agent timing aliases are resolved once at the process-env boundary.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{GuestConfig, GuestConfigRaw};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const VALID_VALUE: &str = "37";
const OUT_OF_RANGE_VALUE: &str = "3601";
const CANONICAL_CONFLICT_VALUE: &str = "canonical-tuning-value-must-not-leak";
const LEGACY_CONFLICT_VALUE: &str = "legacy-tuning-value-must-not-leak";
const SOURCE_EVENT: &str = "guest_agent_tuning_env_source";

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
    expected_source: Option<&'static str>,
}

const SUCCESS_CASES: [SuccessCase; 14] = [
    SuccessCase {
        name: "both-absent",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Absent,
        expected_raw: "",
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-only",
        canonical: AliasInput::Readable(VALID_VALUE),
        legacy: AliasInput::Absent,
        expected_raw: VALID_VALUE,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(VALID_VALUE),
        expected_raw: VALID_VALUE,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual",
        canonical: AliasInput::Readable(VALID_VALUE),
        legacy: AliasInput::Readable(VALID_VALUE),
        expected_raw: VALID_VALUE,
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-empty-only",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Absent,
        expected_raw: "",
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(""),
        expected_raw: "",
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(""),
        expected_raw: "",
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-non-unicode-only",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Absent,
        expected_raw: "",
        expected_source: None,
    },
    SuccessCase {
        name: "legacy-non-unicode-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::NonUnicode,
        expected_raw: "",
        expected_source: None,
    },
    SuccessCase {
        name: "both-non-unicode",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::NonUnicode,
        expected_raw: "",
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-with-unreadable-legacy",
        canonical: AliasInput::Readable(VALID_VALUE),
        legacy: AliasInput::NonUnicode,
        expected_raw: VALID_VALUE,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(VALID_VALUE),
        expected_raw: VALID_VALUE,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "canonical-empty-with-unreadable-legacy",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::NonUnicode,
        expected_raw: "",
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(""),
        expected_raw: "",
        expected_source: Some("legacy-only"),
    },
];

#[derive(Clone, Copy)]
struct RawSemanticsCase {
    name: &'static str,
    canonical: AliasInput,
    legacy: AliasInput,
    expected_raw: &'static str,
    expected_source: &'static str,
    expectation: ConfigExpectation,
}

#[derive(Clone, Copy)]
enum ConfigExpectation {
    Default,
    OutOfRange,
}

const RAW_SEMANTICS_CASES: [RawSemanticsCase; 7] = [
    RawSemanticsCase {
        name: "canonical-whitespace",
        canonical: AliasInput::Readable(" 37 "),
        legacy: AliasInput::Absent,
        expected_raw: " 37 ",
        expected_source: "canonical-only",
        expectation: ConfigExpectation::Default,
    },
    RawSemanticsCase {
        name: "legacy-whitespace",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable("37 "),
        expected_raw: "37 ",
        expected_source: "legacy-only",
        expectation: ConfigExpectation::Default,
    },
    RawSemanticsCase {
        name: "equal-dual-whitespace",
        canonical: AliasInput::Readable(" 37 "),
        legacy: AliasInput::Readable(" 37 "),
        expected_raw: " 37 ",
        expected_source: "dual",
        expectation: ConfigExpectation::Default,
    },
    RawSemanticsCase {
        name: "canonical-invalid",
        canonical: AliasInput::Readable("canonical-invalid-tuning"),
        legacy: AliasInput::Absent,
        expected_raw: "canonical-invalid-tuning",
        expected_source: "canonical-only",
        expectation: ConfigExpectation::Default,
    },
    RawSemanticsCase {
        name: "legacy-invalid",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable("legacy-invalid-tuning"),
        expected_raw: "legacy-invalid-tuning",
        expected_source: "legacy-only",
        expectation: ConfigExpectation::Default,
    },
    RawSemanticsCase {
        name: "canonical-out-of-range",
        canonical: AliasInput::Readable(OUT_OF_RANGE_VALUE),
        legacy: AliasInput::Absent,
        expected_raw: OUT_OF_RANGE_VALUE,
        expected_source: "canonical-only",
        expectation: ConfigExpectation::OutOfRange,
    },
    RawSemanticsCase {
        name: "legacy-out-of-range",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(OUT_OF_RANGE_VALUE),
        expected_raw: OUT_OF_RANGE_VALUE,
        expected_source: "legacy-only",
        expectation: ConfigExpectation::OutOfRange,
    },
];

#[derive(Clone, Copy)]
struct ConflictCase {
    name: &'static str,
    canonical: &'static str,
    legacy: &'static str,
}

const CONFLICT_CASES: [ConflictCase; 3] = [
    ConflictCase {
        name: "different-readable-values",
        canonical: CANONICAL_CONFLICT_VALUE,
        legacy: LEGACY_CONFLICT_VALUE,
    },
    ConflictCase {
        name: "canonical-empty-legacy-non-empty",
        canonical: "",
        legacy: LEGACY_CONFLICT_VALUE,
    },
    ConflictCase {
        name: "canonical-non-empty-legacy-empty",
        canonical: CANONICAL_CONFLICT_VALUE,
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

fn clear_tuning_env() {
    for pair in TUNING_ENV_PAIRS {
        remove_test_env(pair.canonical);
        remove_test_env(pair.legacy);
    }
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

fn assert_source_evidence(
    log: &str,
    pair: TuningEnvPair,
    case_name: &str,
    expected_source: Option<&str>,
) {
    let source_messages = log
        .lines()
        .filter(|line| line.contains(SOURCE_EVENT))
        .filter_map(|line| line.rsplit_once("] ").map(|(_, message)| message))
        .collect::<Vec<_>>();

    match expected_source {
        Some(source) => {
            let expected = format!("{SOURCE_EVENT} key={} source={source}", pair.canonical);
            assert_eq!(
                source_messages,
                [expected.as_str()],
                "{} {case_name} emitted incorrect fixed source evidence",
                pair.name
            );
        }
        None => assert!(
            source_messages.is_empty(),
            "{} {case_name} emitted source evidence for unreadable aliases",
            pair.name
        ),
    }
}

fn materialize_config(
    tmp: &Path,
    pair: TuningEnvPair,
    case_name: &str,
    raw: GuestConfigRaw,
) -> Result<GuestConfig, String> {
    let runtime_dir = tmp.join(format!("{}-{case_name}-runtime", pair.name));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)
        .map_err(|error| format!("create payload directory: {error}"))?;
    let payload = serde_json::to_vec(&guest_contracts::env::RunPayload::default())
        .map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&payload_path, payload)
        .map_err(|error| format!("write run payload: {error}"))?;

    GuestConfig::from_raw(GuestConfigRaw {
        run_id: format!("guest-agent-tuning-alias-{}-{case_name}", pair.name),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    })
}

fn expected_conflict_error(pair: TuningEnvPair) -> String {
    format!(
        "conflicting guest agent tuning environment aliases: canonical_key={} \
         legacy_key={} state=conflict",
        pair.canonical, pair.legacy
    )
}

fn assert_success_matrix(tmp: &Path, pair: TuningEnvPair) -> TestResult {
    for case in SUCCESS_CASES {
        clear_tuning_env();
        apply_alias(pair.canonical, case.canonical);
        apply_alias(pair.legacy, case.legacy);
        let log_path = tmp.join(format!("{}-{}.log", pair.name, case.name));
        let (raw, log) = capture_raw(&log_path)?;
        let raw = raw.map_err(std::io::Error::other)?;

        assert_eq!(
            (pair.raw_value)(&raw),
            case.expected_raw,
            "{} {} resolved the wrong raw value",
            pair.name,
            case.name
        );
        assert_source_evidence(&log, pair, case.name, case.expected_source);

        let config =
            materialize_config(tmp, pair, case.name, raw).map_err(std::io::Error::other)?;
        let expected_secs = if case.expected_raw.is_empty() {
            pair.default_secs
        } else {
            VALID_VALUE.parse::<u64>()?
        };
        assert_eq!(
            (pair.configured_secs)(&config),
            expected_secs,
            "{} {} changed existing default or parsing behavior",
            pair.name,
            case.name
        );
    }
    Ok(())
}

fn assert_raw_semantics(tmp: &Path, pair: TuningEnvPair) -> TestResult {
    for case in RAW_SEMANTICS_CASES {
        clear_tuning_env();
        apply_alias(pair.canonical, case.canonical);
        apply_alias(pair.legacy, case.legacy);
        let log_path = tmp.join(format!("{}-{}.log", pair.name, case.name));
        let (raw, log) = capture_raw(&log_path)?;
        let raw = raw.map_err(std::io::Error::other)?;

        assert_eq!(
            (pair.raw_value)(&raw),
            case.expected_raw,
            "{} {} trimmed or normalized the selected raw value",
            pair.name,
            case.name
        );
        assert_source_evidence(&log, pair, case.name, Some(case.expected_source));

        let config =
            materialize_config(tmp, pair, case.name, raw).map_err(std::io::Error::other)?;
        let expected_secs = match case.expectation {
            ConfigExpectation::Default => pair.default_secs,
            ConfigExpectation::OutOfRange if pair.bounded => pair.default_secs,
            ConfigExpectation::OutOfRange => OUT_OF_RANGE_VALUE.parse::<u64>()?,
        };
        assert_eq!(
            (pair.configured_secs)(&config),
            expected_secs,
            "{} {} changed existing bounds or parsing behavior",
            pair.name,
            case.name
        );
    }
    Ok(())
}

fn assert_conflicts_fail_closed(tmp: &Path, pair: TuningEnvPair) -> TestResult {
    let expected_error = expected_conflict_error(pair);
    for case in CONFLICT_CASES {
        clear_tuning_env();
        set_test_env(pair.canonical, case.canonical);
        set_test_env(pair.legacy, case.legacy);
        let log_path = tmp.join(format!("{}-{}.log", pair.name, case.name));
        let (raw, log) = capture_raw(&log_path)?;
        let error = match raw {
            Ok(_) => {
                return Err(std::io::Error::other(format!(
                    "{} {} accepted conflicting readable aliases",
                    pair.name, case.name
                ))
                .into());
            }
            Err(error) => error,
        };

        assert_eq!(
            error, expected_error,
            "{} {} returned the wrong fixed conflict error",
            pair.name, case.name
        );
        for value in [CANONICAL_CONFLICT_VALUE, LEGACY_CONFLICT_VALUE] {
            assert!(
                !error.contains(value) && !log.contains(value),
                "{} {} exposed conflicting value material",
                pair.name,
                case.name
            );
        }
        assert!(
            !log.contains(SOURCE_EVENT),
            "{} {} emitted success evidence for a conflict",
            pair.name,
            case.name
        );
    }
    Ok(())
}

fn assert_conflict_precedes_private_file_consumption(
    tmp: &Path,
    pair: TuningEnvPair,
) -> TestResult {
    clear_tuning_env();
    let runtime_dir = tmp.join(format!("{}-capture-boundary-runtime", pair.name));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)?;
    std::fs::write(
        &payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    for key in [
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
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
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &payload_path,
    );
    set_test_env(pair.canonical, CANONICAL_CONFLICT_VALUE);
    set_test_env(pair.legacy, LEGACY_CONFLICT_VALUE);

    let error = match GuestConfig::from_process_env() {
        Ok(_) => {
            return Err(std::io::Error::other(format!(
                "{} conflict reached configuration materialization",
                pair.name
            ))
            .into());
        }
        Err(error) => error,
    };
    assert_eq!(error, expected_conflict_error(pair));
    assert!(
        payload_path.exists(),
        "{} conflict consumed the private run payload",
        pair.name
    );
    Ok(())
}

#[test]
fn process_env_dual_reads_guest_agent_tuning_aliases_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for pair in TUNING_ENV_PAIRS {
        assert_success_matrix(tmp.path(), pair)?;
        assert_raw_semantics(tmp.path(), pair)?;
        assert_conflicts_fail_closed(tmp.path(), pair)?;
        assert_conflict_precedes_private_file_consumption(tmp.path(), pair)?;
    }

    clear_tuning_env();
    Ok(())
}
