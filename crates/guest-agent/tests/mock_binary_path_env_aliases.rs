//! Mock binary path aliases are resolved once at the process-env boundary.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{
    DEFAULT_MOCK_CLAUDE_PATH, DEFAULT_MOCK_CODEX_PATH, GuestConfig, GuestConfigRaw,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_PATH: &str = "/tmp/canonical-mock-path-must-not-leak";
const LEGACY_PATH: &str = "/tmp/legacy-mock-path-must-not-leak";
const SHARED_PATH: &str = "/tmp/shared-mock-path-must-not-leak";
const PATH_VALUES: [&str; 3] = [CANONICAL_PATH, LEGACY_PATH, SHARED_PATH];
const SOURCE_EVENT: &str = "mock_binary_path_env_source";

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
    expected_raw: Option<&'static str>,
    expected_source: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct ConflictCase {
    name: &'static str,
    canonical: &'static str,
    legacy: &'static str,
}

#[derive(Clone, Copy)]
struct MockPathEnvPair {
    name: &'static str,
    canonical: &'static str,
    legacy: &'static str,
    raw_value: for<'a> fn(&'a GuestConfigRaw) -> Option<&'a str>,
    configured_value: for<'a> fn(&'a GuestConfig) -> &'a str,
    default_path: &'static str,
}

const SUCCESS_CASES: [SuccessCase; 14] = [
    SuccessCase {
        name: "both-absent",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Absent,
        expected_raw: None,
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-only",
        canonical: AliasInput::Readable(CANONICAL_PATH),
        legacy: AliasInput::Absent,
        expected_raw: Some(CANONICAL_PATH),
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(LEGACY_PATH),
        expected_raw: Some(LEGACY_PATH),
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual",
        canonical: AliasInput::Readable(SHARED_PATH),
        legacy: AliasInput::Readable(SHARED_PATH),
        expected_raw: Some(SHARED_PATH),
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-empty-only",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Absent,
        expected_raw: Some(""),
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(""),
        expected_raw: Some(""),
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(""),
        expected_raw: Some(""),
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-non-unicode-only",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Absent,
        expected_raw: None,
        expected_source: None,
    },
    SuccessCase {
        name: "legacy-non-unicode-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::NonUnicode,
        expected_raw: None,
        expected_source: None,
    },
    SuccessCase {
        name: "both-non-unicode",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::NonUnicode,
        expected_raw: None,
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-with-unreadable-legacy",
        canonical: AliasInput::Readable(CANONICAL_PATH),
        legacy: AliasInput::NonUnicode,
        expected_raw: Some(CANONICAL_PATH),
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(LEGACY_PATH),
        expected_raw: Some(LEGACY_PATH),
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "canonical-empty-with-unreadable-legacy",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::NonUnicode,
        expected_raw: Some(""),
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-empty-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(""),
        expected_raw: Some(""),
        expected_source: Some("legacy-only"),
    },
];

const CONFLICT_CASES: [ConflictCase; 3] = [
    ConflictCase {
        name: "different-readable-values",
        canonical: CANONICAL_PATH,
        legacy: LEGACY_PATH,
    },
    ConflictCase {
        name: "canonical-empty-legacy-non-empty",
        canonical: "",
        legacy: LEGACY_PATH,
    },
    ConflictCase {
        name: "canonical-non-empty-legacy-empty",
        canonical: CANONICAL_PATH,
        legacy: "",
    },
];

fn raw_mock_claude_path(raw: &GuestConfigRaw) -> Option<&str> {
    raw.mock_claude_path.as_deref()
}

fn configured_mock_claude_path(config: &GuestConfig) -> &str {
    &config.mock_claude_path
}

fn raw_mock_codex_path(raw: &GuestConfigRaw) -> Option<&str> {
    raw.mock_codex_path.as_deref()
}

fn configured_mock_codex_path(config: &GuestConfig) -> &str {
    &config.mock_codex_path
}

const MOCK_PATH_ENV_PAIRS: [MockPathEnvPair; 2] = [
    MockPathEnvPair {
        name: "claude",
        canonical: guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
        legacy: guest_contracts::env::MOCK_CLAUDE_PATH_ENV,
        raw_value: raw_mock_claude_path,
        configured_value: configured_mock_claude_path,
        default_path: DEFAULT_MOCK_CLAUDE_PATH,
    },
    MockPathEnvPair {
        name: "codex",
        canonical: guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
        legacy: guest_contracts::env::MOCK_CODEX_PATH_ENV,
        raw_value: raw_mock_codex_path,
        configured_value: configured_mock_codex_path,
        default_path: DEFAULT_MOCK_CODEX_PATH,
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

fn clear_mock_path_env() {
    for pair in MOCK_PATH_ENV_PAIRS {
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

fn assert_value_free(text: &str, context: &str) {
    for path in PATH_VALUES {
        assert!(
            !text.contains(path),
            "{context} exposed mock binary path value material"
        );
    }
}

fn assert_source_evidence(log: &str, pair: MockPathEnvPair, case: SuccessCase) {
    assert_value_free(log, case.name);
    let source_messages = log
        .lines()
        .filter(|line| line.contains(SOURCE_EVENT))
        .filter_map(|line| line.rsplit_once("] ").map(|(_, message)| message))
        .collect::<Vec<_>>();

    match case.expected_source {
        Some(source) => {
            let expected = format!("{SOURCE_EVENT} key={} source={source}", pair.canonical);
            assert_eq!(
                source_messages,
                [expected.as_str()],
                "{} {} emitted incorrect fixed source evidence",
                pair.name,
                case.name
            );
        }
        None => assert!(
            source_messages.is_empty(),
            "{} {} emitted source evidence for unreadable aliases",
            pair.name,
            case.name
        ),
    }
}

fn materialize_config(
    tmp: &Path,
    pair: MockPathEnvPair,
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
        run_id: format!("mock-path-alias-{}-{case_name}", pair.name),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    })
}

fn expected_conflict_error(pair: MockPathEnvPair) -> String {
    format!(
        "conflicting mock binary path environment aliases: canonical_key={} \
         legacy_key={} state=conflict",
        pair.canonical, pair.legacy
    )
}

fn assert_success_matrix(tmp: &Path, pair: MockPathEnvPair) -> TestResult {
    for case in SUCCESS_CASES {
        clear_mock_path_env();
        apply_alias(pair.canonical, case.canonical);
        apply_alias(pair.legacy, case.legacy);
        let log_path = tmp.join(format!("{}-{}.log", pair.name, case.name));
        let (raw, log) = capture_raw(&log_path)?;
        let raw = raw.map_err(std::io::Error::other)?;

        assert_eq!(
            (pair.raw_value)(&raw),
            case.expected_raw,
            "{} {} resolved the wrong raw path state",
            pair.name,
            case.name
        );
        assert_source_evidence(&log, pair, case);

        let config =
            materialize_config(tmp, pair, case.name, raw).map_err(std::io::Error::other)?;
        let expected_configured = case.expected_raw.unwrap_or(pair.default_path);
        assert_eq!(
            (pair.configured_value)(&config),
            expected_configured,
            "{} {} changed existing default or empty-path behavior",
            pair.name,
            case.name
        );
    }
    Ok(())
}

fn assert_conflicts_fail_closed(tmp: &Path, pair: MockPathEnvPair) -> TestResult {
    let expected_error = expected_conflict_error(pair);
    for case in CONFLICT_CASES {
        clear_mock_path_env();
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
        assert_value_free(&error, case.name);
        assert_value_free(&log, case.name);
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
    pair: MockPathEnvPair,
) -> TestResult {
    clear_mock_path_env();
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
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
    ] {
        remove_test_env(key);
    }
    set_test_env(
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        &runtime_dir,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &payload_path,
    );
    set_test_env(pair.canonical, CANONICAL_PATH);
    set_test_env(pair.legacy, LEGACY_PATH);

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
    assert_value_free(&error, pair.name);
    assert!(
        payload_path.exists(),
        "{} conflict consumed the private run payload",
        pair.name
    );
    Ok(())
}

#[test]
fn process_env_dual_reads_mock_binary_path_aliases_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for pair in MOCK_PATH_ENV_PAIRS {
        assert_success_matrix(tmp.path(), pair)?;
        assert_conflicts_fail_closed(tmp.path(), pair)?;
        assert_conflict_precedes_private_file_consumption(tmp.path(), pair)?;
    }

    clear_mock_path_env();
    Ok(())
}
