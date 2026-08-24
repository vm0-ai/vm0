//! Run-metadata bootstrap aliases are resolved at the process-env boundary.

use std::path::Path;

use guest_agent::env::GuestConfigRaw;

#[derive(Clone, Copy)]
struct RunMetadataEnvPair {
    canonical: &'static str,
    legacy: &'static str,
    value: fn(&GuestConfigRaw) -> &str,
}

const RUN_METADATA_ENV_PAIRS: [RunMetadataEnvPair; 4] = [
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
        canonical: guest_contracts::env::CANONICAL_API_START_TIME_ENV,
        legacy: guest_contracts::env::API_START_TIME_ENV,
        value: |raw| &raw.api_start_time,
    },
];

unsafe fn clear_run_metadata_env() {
    for pair in RUN_METADATA_ENV_PAIRS {
        unsafe {
            std::env::remove_var(pair.canonical);
            std::env::remove_var(pair.legacy);
        }
    }
}

fn capture_raw(log_path: &Path) -> std::io::Result<(Result<GuestConfigRaw, String>, String)> {
    guest_common::log::set_system_log_file(log_path);
    let raw = GuestConfigRaw::from_process_env();
    guest_common::log::clear_system_log_file();
    let log = match std::fs::read_to_string(log_path) {
        Ok(log) => log,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    Ok((raw, log))
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

#[test]
fn process_env_dual_reads_run_metadata_without_value_leaks() {
    let tmp = tempfile::tempdir().unwrap();

    // SAFETY: this integration test is the only test in its process and does
    // not start threads while it configures and captures the process env.
    unsafe {
        clear_run_metadata_env();
    }

    for (index, pair) in RUN_METADATA_ENV_PAIRS.into_iter().enumerate() {
        unsafe {
            clear_run_metadata_env();
        }
        let (raw, log) = capture_raw(&tmp.path().join(format!("{index}-absent.log"))).unwrap();
        assert_eq!((pair.value)(&raw.unwrap()), "");
        assert!(!log.contains("run_metadata_env_source"));

        let legacy_value = format!("legacy-value-{index}");
        unsafe {
            std::env::set_var(pair.legacy, &legacy_value);
        }
        let (raw, log) = capture_raw(&tmp.path().join(format!("{index}-legacy.log"))).unwrap();
        assert_eq!((pair.value)(&raw.unwrap()), legacy_value);
        assert_source_log(&log, pair, "legacy-only", Some(&legacy_value));

        unsafe {
            clear_run_metadata_env();
            std::env::set_var(pair.legacy, "");
        }
        let (raw, log) =
            capture_raw(&tmp.path().join(format!("{index}-legacy-empty.log"))).unwrap();
        assert_eq!((pair.value)(&raw.unwrap()), "");
        assert_source_log(&log, pair, "legacy-only", None);

        unsafe {
            clear_run_metadata_env();
            std::env::set_var(pair.canonical, "");
        }
        let (raw, log) =
            capture_raw(&tmp.path().join(format!("{index}-canonical-empty.log"))).unwrap();
        assert_eq!((pair.value)(&raw.unwrap()), "");
        assert_source_log(&log, pair, "canonical-only", None);

        let canonical_value = format!("canonical-value-{index}");
        unsafe {
            clear_run_metadata_env();
            std::env::set_var(pair.canonical, &canonical_value);
        }
        let (raw, log) = capture_raw(&tmp.path().join(format!("{index}-canonical.log"))).unwrap();
        assert_eq!((pair.value)(&raw.unwrap()), canonical_value);
        assert_source_log(&log, pair, "canonical-only", Some(&canonical_value));

        let dual_value = format!("dual-value-{index}");
        unsafe {
            clear_run_metadata_env();
            std::env::set_var(pair.canonical, &dual_value);
            std::env::set_var(pair.legacy, &dual_value);
        }
        let (raw, log) = capture_raw(&tmp.path().join(format!("{index}-dual.log"))).unwrap();
        assert_eq!((pair.value)(&raw.unwrap()), dual_value);
        assert_source_log(&log, pair, "dual", Some(&dual_value));

        unsafe {
            clear_run_metadata_env();
            std::env::set_var(pair.canonical, "");
            std::env::set_var(pair.legacy, "");
        }
        let (raw, log) = capture_raw(&tmp.path().join(format!("{index}-dual-empty.log"))).unwrap();
        assert_eq!((pair.value)(&raw.unwrap()), "");
        assert_source_log(&log, pair, "dual", None);

        let canonical_conflict = format!("canonical-secret-{index}");
        let legacy_conflict = format!("legacy-secret-{index}");
        unsafe {
            clear_run_metadata_env();
            std::env::set_var(pair.canonical, &canonical_conflict);
            std::env::set_var(pair.legacy, &legacy_conflict);
        }
        let (raw, log) = capture_raw(&tmp.path().join(format!("{index}-conflict.log"))).unwrap();
        let error = match raw {
            Ok(_) => panic!("conflicting aliases should fail closed"),
            Err(error) => error,
        };
        assert!(error.contains(pair.canonical));
        assert!(error.contains(pair.legacy));
        assert!(error.contains("state=conflict"));
        assert!(!error.contains(&canonical_conflict));
        assert!(!error.contains(&legacy_conflict));
        assert!(!log.contains(&canonical_conflict));
        assert!(!log.contains(&legacy_conflict));

        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;

            unsafe {
                clear_run_metadata_env();
                std::env::set_var(pair.legacy, OsString::from_vec(vec![0xff]));
            }
            let (raw, log) =
                capture_raw(&tmp.path().join(format!("{index}-legacy-unicode.log"))).unwrap();
            assert_eq!((pair.value)(&raw.unwrap()), "");
            assert!(!log.contains("run_metadata_env_source"));

            unsafe {
                clear_run_metadata_env();
                std::env::set_var(pair.canonical, OsString::from_vec(vec![0xff]));
            }
            let (raw, log) =
                capture_raw(&tmp.path().join(format!("{index}-canonical-unicode.log"))).unwrap();
            assert_eq!((pair.value)(&raw.unwrap()), "");
            assert!(!log.contains("run_metadata_env_source"));
        }
    }

    unsafe {
        clear_run_metadata_env();
    }

    let runtime_dir = tmp.path().join("legacy-config-runtime");
    let payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let payload_path = payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&payload_dir).unwrap();
    std::fs::write(
        &payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default()).unwrap(),
    )
    .unwrap();

    let legacy_values = [
        "legacy-sandbox-id",
        "reused",
        "sandboxReused",
        "1700000000000",
    ];
    unsafe {
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, "legacy-config-run");
        std::env::set_var("HOME", tmp.path().join("home"));
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
        std::env::set_var(guest_contracts::env::RUN_PAYLOAD_FILE_ENV, &payload_path);
        std::env::remove_var(guest_contracts::env::USER_ENV_FILE_ENV);
        for (pair, value) in RUN_METADATA_ENV_PAIRS.into_iter().zip(legacy_values) {
            std::env::set_var(pair.legacy, value);
        }
    }

    let config_log_path = tmp.path().join("legacy-config.log");
    guest_common::log::set_system_log_file(&config_log_path);
    let config = guest_agent::env::GuestConfig::from_process_env().unwrap();
    guest_common::log::clear_system_log_file();

    assert_eq!(config.sandbox_id, legacy_values[0]);
    assert_eq!(config.sandbox_reuse_result, legacy_values[1]);
    assert_eq!(config.workspace_reuse_result, legacy_values[2]);
    assert_eq!(config.api_start_time, legacy_values[3]);
    let config_log = std::fs::read_to_string(config_log_path).unwrap();
    for (pair, value) in RUN_METADATA_ENV_PAIRS.into_iter().zip(legacy_values) {
        assert_source_log(&config_log, pair, "legacy-only", Some(value));
    }

    unsafe {
        clear_run_metadata_env();
    }
}
