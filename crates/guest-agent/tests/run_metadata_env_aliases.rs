//! Canonical run-metadata bootstrap values are captured at the process-env boundary.

use std::ffi::OsStr;
use std::path::Path;

use guest_agent::env::GuestConfigRaw;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy)]
struct RunMetadataEnvSpec {
    canonical: &'static str,
    retired: &'static str,
    value: fn(&GuestConfigRaw) -> &str,
}

const RUN_METADATA_ENV_SPECS: [RunMetadataEnvSpec; 5] = [
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
        retired: "VM0_SANDBOX_ID",
        value: |raw| &raw.sandbox_id,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
        retired: "VM0_SANDBOX_REUSE_RESULT",
        value: |raw| &raw.sandbox_reuse_result,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
        retired: "VM0_WORKSPACE_REUSE_RESULT",
        value: |raw| &raw.workspace_reuse_result,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
        retired: "VM0_RESUME_SESSION_ID",
        value: |raw| &raw.resume_session_id,
    },
    RunMetadataEnvSpec {
        canonical: guest_contracts::env::CANONICAL_API_START_TIME_ENV,
        retired: "VM0_API_START_TIME",
        value: |raw| &raw.api_start_time,
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

fn clear_run_metadata_env() {
    for spec in RUN_METADATA_ENV_SPECS {
        remove_test_env(spec.canonical);
        remove_test_env(spec.retired);
    }
}

fn capture_raw(log_path: &Path) -> TestResult<GuestConfigRaw> {
    guest_common::log::clear_system_log_file();
    let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;
    assert!(
        !log_path.exists(),
        "raw capture installed or wrote a system-log sink"
    );
    assert!(
        raw.bootstrap_alias_source_events()
            .all(|(family, _, _)| family != "run_metadata_env_source"),
        "raw capture retained run-metadata source evidence"
    );
    Ok(raw)
}

fn assert_canonical_capture_behaviors(
    tmp: &Path,
    index: usize,
    spec: RunMetadataEnvSpec,
) -> TestResult {
    clear_run_metadata_env();
    let raw = capture_raw(&tmp.join(format!("{index}-absent.log")))?;
    assert_eq!((spec.value)(&raw), "");

    set_test_env(spec.retired, format!("retired-only-{index}"));
    let raw = capture_raw(&tmp.join(format!("{index}-retired-only.log")))?;
    assert_eq!((spec.value)(&raw), "");

    clear_run_metadata_env();
    set_test_env(spec.canonical, "");
    let raw = capture_raw(&tmp.join(format!("{index}-canonical-empty.log")))?;
    assert_eq!((spec.value)(&raw), "");

    set_test_env(spec.retired, format!("retired-beside-empty-{index}"));
    let raw = capture_raw(&tmp.join(format!("{index}-canonical-empty-retired.log")))?;
    assert_eq!((spec.value)(&raw), "");

    let canonical_value = format!("canonical-value-值-{index}");
    clear_run_metadata_env();
    set_test_env(spec.canonical, &canonical_value);
    let raw = capture_raw(&tmp.join(format!("{index}-canonical.log")))?;
    assert_eq!((spec.value)(&raw), canonical_value);

    set_test_env(spec.retired, format!("different-retired-value-{index}"));
    let raw = capture_raw(&tmp.join(format!("{index}-canonical-retired.log")))?;
    assert_eq!((spec.value)(&raw), canonical_value);
    Ok(())
}

#[cfg(unix)]
fn assert_non_unicode_behaviors(tmp: &Path, index: usize, spec: RunMetadataEnvSpec) -> TestResult {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    clear_run_metadata_env();
    set_test_env(spec.retired, format!("retired-value-{index}"));
    set_test_env(spec.canonical, OsString::from_vec(vec![0xff]));
    let raw = capture_raw(&tmp.join(format!("{index}-canonical-non-unicode.log")))?;
    assert_eq!((spec.value)(&raw), "");

    let canonical_value = format!("canonical-beside-retired-non-unicode-{index}");
    clear_run_metadata_env();
    set_test_env(spec.canonical, &canonical_value);
    set_test_env(spec.retired, OsString::from_vec(vec![0xff]));
    let raw = capture_raw(&tmp.join(format!("{index}-retired-non-unicode.log")))?;
    assert_eq!((spec.value)(&raw), canonical_value);
    Ok(())
}

fn assert_guest_config_uses_canonical_values(tmp: &Path) -> TestResult {
    clear_run_metadata_env();
    let runtime_dir = tmp.join("canonical-config-runtime");
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir)?;
    std::fs::write(
        &payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
    )?;

    let values = [
        "shared-sandbox-id",
        "reused",
        "sandboxReused",
        "resume-session-id",
        "1700000000000",
    ];
    set_test_env(guest_contracts::env::RUN_ID_ENV, "canonical-config-run");
    set_test_env("HOME", tmp.join("home"));
    set_test_env(
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        &runtime_dir,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &payload_path,
    );
    remove_test_env("VM0_USER_ENV_FILE");
    remove_test_env(guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV);
    for (index, (spec, value)) in RUN_METADATA_ENV_SPECS.into_iter().zip(values).enumerate() {
        set_test_env(spec.canonical, value);
        set_test_env(spec.retired, format!("retired-config-value-{index}"));
    }

    let raw = capture_raw(&tmp.join("canonical-config.log"))?;
    let config = guest_agent::env::GuestConfig::from_raw(raw).map_err(std::io::Error::other)?;

    assert_eq!(config.sandbox_id, values[0]);
    assert_eq!(config.sandbox_reuse_result, values[1]);
    assert_eq!(config.workspace_reuse_result, values[2]);
    assert_eq!(config.resume_session_id, values[3]);
    assert_eq!(config.api_start_time, values[4]);

    clear_run_metadata_env();
    Ok(())
}

#[test]
fn process_env_reads_only_canonical_run_metadata() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for (index, spec) in RUN_METADATA_ENV_SPECS.into_iter().enumerate() {
        assert_canonical_capture_behaviors(tmp.path(), index, spec)?;
        #[cfg(unix)]
        assert_non_unicode_behaviors(tmp.path(), index, spec)?;
    }

    assert_guest_config_uses_canonical_values(tmp.path())
}
