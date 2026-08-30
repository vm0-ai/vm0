//! Mock binary paths are resolved only from canonical keys at the process-env boundary.

#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use guest_agent::env::{
    DEFAULT_MOCK_CLAUDE_PATH, DEFAULT_MOCK_CODEX_PATH, GuestConfig, GuestConfigRaw,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_PATH: &str = "/tmp/canonical-mock-path";
const RETIRED_PATH: &str = "/tmp/retired-mock-path";

#[derive(Clone, Copy)]
enum EnvInput {
    Absent,
    Readable(&'static str),
    NonUnicode,
}

#[derive(Clone, Copy)]
struct PathCase {
    name: &'static str,
    canonical: EnvInput,
    retired: EnvInput,
    expected_raw: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct MockPathEnv {
    name: &'static str,
    canonical: &'static str,
    retired: &'static str,
    raw_value: for<'a> fn(&'a GuestConfigRaw) -> Option<&'a str>,
    configured_value: for<'a> fn(&'a GuestConfig) -> &'a str,
    default_path: &'static str,
}

const PATH_CASES: [PathCase; 8] = [
    PathCase {
        name: "canonical-absent",
        canonical: EnvInput::Absent,
        retired: EnvInput::Absent,
        expected_raw: None,
    },
    PathCase {
        name: "canonical-readable",
        canonical: EnvInput::Readable(CANONICAL_PATH),
        retired: EnvInput::Absent,
        expected_raw: Some(CANONICAL_PATH),
    },
    PathCase {
        name: "canonical-empty",
        canonical: EnvInput::Readable(""),
        retired: EnvInput::Absent,
        expected_raw: Some(""),
    },
    PathCase {
        name: "canonical-non-unicode",
        canonical: EnvInput::NonUnicode,
        retired: EnvInput::Absent,
        expected_raw: None,
    },
    PathCase {
        name: "retired-only-is-ignored",
        canonical: EnvInput::Absent,
        retired: EnvInput::Readable(RETIRED_PATH),
        expected_raw: None,
    },
    PathCase {
        name: "canonical-readable-is-not-overridden-by-retired",
        canonical: EnvInput::Readable(CANONICAL_PATH),
        retired: EnvInput::Readable(RETIRED_PATH),
        expected_raw: Some(CANONICAL_PATH),
    },
    PathCase {
        name: "canonical-empty-is-not-overridden-by-retired",
        canonical: EnvInput::Readable(""),
        retired: EnvInput::Readable(RETIRED_PATH),
        expected_raw: Some(""),
    },
    PathCase {
        name: "canonical-non-unicode-does-not-fall-back-to-retired",
        canonical: EnvInput::NonUnicode,
        retired: EnvInput::Readable(RETIRED_PATH),
        expected_raw: None,
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

const MOCK_PATH_ENVS: [MockPathEnv; 2] = [
    MockPathEnv {
        name: "claude",
        canonical: guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
        retired: "VM0_MOCK_CLAUDE_PATH",
        raw_value: raw_mock_claude_path,
        configured_value: configured_mock_claude_path,
        default_path: DEFAULT_MOCK_CLAUDE_PATH,
    },
    MockPathEnv {
        name: "codex",
        canonical: guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
        retired: "VM0_MOCK_CODEX_PATH",
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

fn apply_input(key: &str, input: EnvInput) {
    remove_test_env(key);
    match input {
        EnvInput::Absent => {}
        EnvInput::Readable(value) => set_test_env(key, value),
        EnvInput::NonUnicode => set_test_env(key, OsString::from_vec(vec![0xff])),
    }
}

fn clear_mock_path_env() {
    for path_env in MOCK_PATH_ENVS {
        remove_test_env(path_env.canonical);
        remove_test_env(path_env.retired);
    }
}

fn materialize_config(
    tmp: &Path,
    path_env: MockPathEnv,
    case_name: &str,
    raw: GuestConfigRaw,
) -> Result<GuestConfig, String> {
    let runtime_dir = tmp.join(format!("{}-{case_name}-runtime", path_env.name));
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)
        .map_err(|error| format!("create payload directory: {error}"))?;
    let payload = serde_json::to_vec(&guest_contracts::env::RunPayload::default())
        .map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&payload_path, payload)
        .map_err(|error| format!("write run payload: {error}"))?;

    GuestConfig::from_raw(GuestConfigRaw {
        run_id: format!("mock-path-{}-{case_name}", path_env.name),
        home: Some(tmp.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        ..raw
    })
}

fn assert_path_matrix(tmp: &Path, path_env: MockPathEnv) -> TestResult {
    for case in PATH_CASES {
        clear_mock_path_env();
        apply_input(path_env.canonical, case.canonical);
        apply_input(path_env.retired, case.retired);

        let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;
        assert_eq!(
            (path_env.raw_value)(&raw),
            case.expected_raw,
            "{} {} resolved the wrong raw path state",
            path_env.name,
            case.name
        );
        let config =
            materialize_config(tmp, path_env, case.name, raw).map_err(std::io::Error::other)?;
        let expected_configured = case.expected_raw.unwrap_or(path_env.default_path);
        assert_eq!(
            (path_env.configured_value)(&config),
            expected_configured,
            "{} {} changed canonical/default/empty behavior",
            path_env.name,
            case.name
        );
    }
    Ok(())
}

#[test]
fn process_env_reads_only_canonical_mock_binary_paths() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for path_env in MOCK_PATH_ENVS {
        assert_path_matrix(tmp.path(), path_env)?;
    }

    clear_mock_path_env();
    Ok(())
}
