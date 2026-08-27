//! Run-metadata bootstrap aliases are resolved at the process-env boundary.

use std::ffi::OsStr;
use std::path::Path;

use guest_agent::env::GuestConfigRaw;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy)]
struct RunMetadataEnvPair {
    canonical: &'static str,
    legacy: &'static str,
    value: fn(&GuestConfigRaw) -> &str,
}

const RUN_METADATA_ENV_PAIRS: [RunMetadataEnvPair; 5] = [
    RunMetadataEnvPair {
        canonical: guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
        legacy: guest_contracts::env::SANDBOX_ID_ENV,
        value: |raw| &raw.sandbox_id,
    },
    RunMetadataEnvPair {
        canonical: guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
        legacy: guest_contracts::env::SANDBOX_REUSE_RESULT_ENV,
        value: |raw| &raw.sandbox_reuse_result,
    },
    RunMetadataEnvPair {
        canonical: guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
        legacy: guest_contracts::env::WORKSPACE_REUSE_RESULT_ENV,
        value: |raw| &raw.workspace_reuse_result,
    },
    RunMetadataEnvPair {
        canonical: guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
        legacy: guest_contracts::env::RESUME_SESSION_ID_ENV,
        value: |raw| &raw.resume_session_id,
    },
    RunMetadataEnvPair {
        canonical: guest_contracts::env::CANONICAL_API_START_TIME_ENV,
        legacy: guest_contracts::env::API_START_TIME_ENV,
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
    for pair in RUN_METADATA_ENV_PAIRS {
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

fn assert_source_log(
    log: &str,
    pair: RunMetadataEnvPair,
    source: &str,
    forbidden_value: Option<&str>,
) {
    assert!(
        log.contains(&format!(
            "run_metadata_env_source key={} source={source}",
            pair.canonical
        )),
        "missing fixed source evidence for {}: {log}",
        pair.canonical
    );
    if let Some(value) = forbidden_value {
        assert!(!log.contains(value), "source evidence leaked the value");
    }
}

fn assert_missing_and_single_source_behaviors(
    tmp: &Path,
    index: usize,
    pair: RunMetadataEnvPair,
) -> TestResult {
    clear_run_metadata_env();
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-absent.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), "");
    assert!(!log.contains("run_metadata_env_source"));

    let legacy_value = format!("legacy-value-{index}");
    set_test_env(pair.legacy, &legacy_value);
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-legacy.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), legacy_value);
    assert_source_log(&log, pair, "legacy-only", Some(&legacy_value));

    clear_run_metadata_env();
    set_test_env(pair.legacy, "");
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-legacy-empty.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), "");
    assert_source_log(&log, pair, "legacy-only", None);

    clear_run_metadata_env();
    set_test_env(pair.canonical, "");
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-canonical-empty.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), "");
    assert_source_log(&log, pair, "canonical-only", None);

    let canonical_value = format!("canonical-value-{index}");
    clear_run_metadata_env();
    set_test_env(pair.canonical, &canonical_value);
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-canonical.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), canonical_value);
    assert_source_log(&log, pair, "canonical-only", Some(&canonical_value));
    Ok(())
}

fn assert_dual_and_conflict_behaviors(
    tmp: &Path,
    index: usize,
    pair: RunMetadataEnvPair,
) -> TestResult {
    let dual_value = format!("dual-value-{index}");
    clear_run_metadata_env();
    set_test_env(pair.canonical, &dual_value);
    set_test_env(pair.legacy, &dual_value);
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-dual.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), dual_value);
    assert_source_log(&log, pair, "dual", Some(&dual_value));

    clear_run_metadata_env();
    set_test_env(pair.canonical, "");
    set_test_env(pair.legacy, "");
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-dual-empty.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), "");
    assert_source_log(&log, pair, "dual", None);

    let canonical_conflict = format!("canonical-secret-{index}");
    let legacy_conflict = format!("legacy-secret-{index}");
    clear_run_metadata_env();
    set_test_env(pair.canonical, &canonical_conflict);
    set_test_env(pair.legacy, &legacy_conflict);
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-conflict.log")))?;
    let error = match raw {
        Ok(_) => {
            return Err(std::io::Error::other("conflicting aliases should fail closed").into());
        }
        Err(error) => error,
    };
    assert!(error.contains(pair.canonical));
    assert!(error.contains(pair.legacy));
    assert!(error.contains("state=conflict"));
    assert!(!error.contains(&canonical_conflict));
    assert!(!error.contains(&legacy_conflict));
    assert!(!log.contains(&canonical_conflict));
    assert!(!log.contains(&legacy_conflict));
    Ok(())
}

#[cfg(unix)]
fn assert_non_unicode_behaviors(tmp: &Path, index: usize, pair: RunMetadataEnvPair) -> TestResult {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    clear_run_metadata_env();
    set_test_env(pair.legacy, OsString::from_vec(vec![0xff]));
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-legacy-unicode.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), "");
    assert!(!log.contains("run_metadata_env_source"));

    clear_run_metadata_env();
    set_test_env(pair.canonical, OsString::from_vec(vec![0xff]));
    let (raw, log) = capture_raw(&tmp.join(format!("{index}-canonical-unicode.log")))?;
    let raw = raw.map_err(std::io::Error::other)?;
    assert_eq!((pair.value)(&raw), "");
    assert!(!log.contains("run_metadata_env_source"));
    Ok(())
}

fn assert_guest_config_for_source(tmp: &Path, canonical: bool) -> TestResult {
    clear_run_metadata_env();
    let source = if canonical { "canonical" } else { "legacy" };
    let source_label = if canonical {
        "canonical-only"
    } else {
        "legacy-only"
    };
    let runtime_dir = tmp.join(format!("{source}-config-runtime"));
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
    set_test_env(
        guest_contracts::env::RUN_ID_ENV,
        format!("{source}-config-run"),
    );
    set_test_env("HOME", tmp.join("home"));
    set_test_env(
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        &runtime_dir,
    );
    set_test_env(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        &payload_path,
    );
    remove_test_env(guest_contracts::env::USER_ENV_FILE_ENV);
    for (pair, value) in RUN_METADATA_ENV_PAIRS.into_iter().zip(values) {
        let key = if canonical {
            pair.canonical
        } else {
            pair.legacy
        };
        set_test_env(key, value);
    }

    let config_log_path = tmp.join(format!("{source}-config.log"));
    guest_common::log::clear_system_log_file();
    let raw = GuestConfigRaw::from_process_env().map_err(std::io::Error::other)?;
    let config_log = raw
        .bootstrap_alias_source_events()
        .map(|(family, key, source)| format!("[captured] {family} key={key} source={source}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !config_log_path.exists(),
        "raw capture installed or wrote a system-log sink"
    );
    let config = guest_agent::env::GuestConfig::from_raw(raw).map_err(std::io::Error::other)?;

    assert_eq!(config.sandbox_id, values[0]);
    assert_eq!(config.sandbox_reuse_result, values[1]);
    assert_eq!(config.workspace_reuse_result, values[2]);
    assert_eq!(config.resume_session_id, values[3]);
    assert_eq!(config.api_start_time, values[4]);
    for (pair, value) in RUN_METADATA_ENV_PAIRS.into_iter().zip(values) {
        assert_source_log(&config_log, pair, source_label, Some(value));
    }

    clear_run_metadata_env();
    Ok(())
}

#[test]
fn process_env_dual_reads_run_metadata_without_value_leaks() -> TestResult {
    let tmp = tempfile::tempdir()?;

    for (index, pair) in RUN_METADATA_ENV_PAIRS.into_iter().enumerate() {
        assert_missing_and_single_source_behaviors(tmp.path(), index, pair)?;
        assert_dual_and_conflict_behaviors(tmp.path(), index, pair)?;
        #[cfg(unix)]
        assert_non_unicode_behaviors(tmp.path(), index, pair)?;
    }

    assert_guest_config_for_source(tmp.path(), false)?;
    assert_guest_config_for_source(tmp.path(), true)
}
