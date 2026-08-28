//! Process-control aliases are resolved once at the guest startup boundary.

#![cfg(unix)]

mod common;

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use guest_agent::run_context::GuestRuntime;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_ENDPOINT: &str = "canonical-endpoint-must-not-leak";
const LEGACY_ENDPOINT: &str = "legacy-endpoint-must-not-leak";
const SHARED_ENDPOINT: &str = "shared-endpoint-must-not-leak";
const ENDPOINT_VALUES: [&str; 3] = [CANONICAL_ENDPOINT, LEGACY_ENDPOINT, SHARED_ENDPOINT];
const SOURCE_EVENT: &str = "process_control_env_source";

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
    expected_endpoint: Option<&'static str>,
    expected_source: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct InvalidEncodingCase {
    name: &'static str,
    canonical: AliasInput,
    legacy: AliasInput,
    expected_key: &'static str,
}

const SUCCESS_CASES: [SuccessCase; 9] = [
    SuccessCase {
        name: "absent",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Absent,
        expected_endpoint: None,
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Absent,
        expected_endpoint: None,
        expected_source: None,
    },
    SuccessCase {
        name: "legacy-empty",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(""),
        expected_endpoint: None,
        expected_source: None,
    },
    SuccessCase {
        name: "dual-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(""),
        expected_endpoint: None,
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-only",
        canonical: AliasInput::Readable(CANONICAL_ENDPOINT),
        legacy: AliasInput::Absent,
        expected_endpoint: Some(CANONICAL_ENDPOINT),
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(LEGACY_ENDPOINT),
        expected_endpoint: Some(LEGACY_ENDPOINT),
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual",
        canonical: AliasInput::Readable(SHARED_ENDPOINT),
        legacy: AliasInput::Readable(SHARED_ENDPOINT),
        expected_endpoint: Some(SHARED_ENDPOINT),
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-empty-with-legacy",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(LEGACY_ENDPOINT),
        expected_endpoint: Some(LEGACY_ENDPOINT),
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "canonical-with-legacy-empty",
        canonical: AliasInput::Readable(CANONICAL_ENDPOINT),
        legacy: AliasInput::Readable(""),
        expected_endpoint: Some(CANONICAL_ENDPOINT),
        expected_source: Some("canonical-only"),
    },
];

const INVALID_ENCODING_CASES: [InvalidEncodingCase; 4] = [
    InvalidEncodingCase {
        name: "canonical-non-unicode",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Absent,
        expected_key: process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
    },
    InvalidEncodingCase {
        name: "legacy-non-unicode",
        canonical: AliasInput::Absent,
        legacy: AliasInput::NonUnicode,
        expected_key: process_control_ipc::BOOTSTRAP_ENV,
    },
    InvalidEncodingCase {
        name: "canonical-with-non-unicode-legacy",
        canonical: AliasInput::Readable(CANONICAL_ENDPOINT),
        legacy: AliasInput::NonUnicode,
        expected_key: process_control_ipc::BOOTSTRAP_ENV,
    },
    InvalidEncodingCase {
        name: "non-unicode-canonical-with-legacy",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(LEGACY_ENDPOINT),
        expected_key: process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
    },
];

fn set_test_env(key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test starts no threads while configuring or capturing process env.
    unsafe {
        std::env::set_var(key, value);
    }
}

fn remove_test_env(key: impl AsRef<OsStr>) {
    // SAFETY: this integration test binary contains exactly one test, and the
    // test starts no threads while configuring or capturing process env.
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

fn configure_case(
    root: &Path,
    name: &str,
    canonical: AliasInput,
    legacy: AliasInput,
) -> Result<PathBuf, String> {
    let runtime_dir = root.join(format!("{name}-runtime"));
    guest_common::log::clear_system_log_file();
    guest_common::telemetry::clear_sandbox_ops_log_file();
    // SAFETY: the integration binary contains one test and has not started
    // threads while configuring the next startup snapshot.
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(
            guest_contracts::env::RUN_ID_ENV,
            format!("process-control-alias-{name}"),
        );
        std::env::set_var("HOME", root.join(format!("{name}-home")));
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
        std::env::set_var("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true");
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload::default(),
        )?;
    }
    apply_alias(process_control_ipc::CANONICAL_BOOTSTRAP_ENV, canonical);
    apply_alias(process_control_ipc::BOOTSTRAP_ENV, legacy);
    Ok(runtime_dir)
}

fn read_system_log(runtime_dir: &Path) -> std::io::Result<String> {
    let path = guest_contracts::runtime_paths::system_log_file(runtime_dir);
    match std::fs::read_to_string(path) {
        Ok(log) => Ok(log),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

fn assert_value_free(text: &str, context: &str) {
    for endpoint in ENDPOINT_VALUES {
        assert!(
            !text.contains(endpoint),
            "{context} exposed process-control endpoint material"
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
                process_control_ipc::CANONICAL_BOOTSTRAP_ENV
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
            "{} emitted source evidence without an endpoint",
            case.name
        ),
    }
}

fn expected_conflict_error() -> String {
    format!(
        "conflicting process control environment aliases: canonical_key={} legacy_key={} state=conflict",
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        process_control_ipc::BOOTSTRAP_ENV
    )
}

#[test]
fn startup_dual_reads_process_control_aliases_without_value_leaks() -> TestResult {
    assert_eq!(
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        "OKOU_PROCESS_CONTROL_ENDPOINT"
    );
    assert_eq!(
        process_control_ipc::BOOTSTRAP_ENV,
        "VM0_PROCESS_CONTROL_ENDPOINT"
    );
    let tmp = tempfile::tempdir()?;

    for case in SUCCESS_CASES {
        let runtime_dir = configure_case(tmp.path(), case.name, case.canonical, case.legacy)?;
        let runtime = GuestRuntime::from_process_env().map_err(std::io::Error::other)?;
        assert_eq!(
            runtime.process_control_endpoint.as_deref(),
            case.expected_endpoint,
            "{} resolved the wrong endpoint",
            case.name
        );
        assert!(
            runtime.workload_containment.is_none(),
            "{} unexpectedly initialized workload containment",
            case.name
        );
        assert_source_evidence(&read_system_log(&runtime_dir)?, case);
    }

    configure_case(
        tmp.path(),
        "conflict",
        AliasInput::Readable(CANONICAL_ENDPOINT),
        AliasInput::Readable(LEGACY_ENDPOINT),
    )?;
    set_test_env(
        guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
        OsString::from_vec(vec![0xff]),
    );
    set_test_env(
        guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
        "must-not-be-consumed",
    );
    let conflict_error = match GuestRuntime::from_process_env() {
        Ok(_) => return Err("conflicting process-control aliases were accepted".into()),
        Err(error) => error,
    };
    assert_eq!(conflict_error, expected_conflict_error());
    assert_value_free(&conflict_error, "conflict");
    assert!(
        std::env::var_os(guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV)
            .is_some(),
        "conflict reached workload-containment initialization"
    );

    for case in INVALID_ENCODING_CASES {
        configure_case(tmp.path(), case.name, case.canonical, case.legacy)?;
        let error = match GuestRuntime::from_process_env() {
            Ok(_) => return Err(format!("{} accepted a non-Unicode alias", case.name).into()),
            Err(error) => error,
        };
        assert_eq!(error, format!("{} must be valid UTF-8", case.expected_key));
        assert_value_free(&error, case.name);
    }

    // SAFETY: the single test has not started threads and is finished reading
    // the process environment.
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
    }
    Ok(())
}
