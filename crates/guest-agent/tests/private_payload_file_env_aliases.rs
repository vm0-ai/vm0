//! Private payload file aliases are resolved before destructive file loading.

#![cfg(unix)]

mod common;

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use guest_agent::env::{GuestConfig, GuestConfigRaw};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CANONICAL_POINTER: &str = "/private/canonical-pointer-must-not-leak";
const LEGACY_POINTER: &str = "/private/legacy-pointer-must-not-leak";
const SHARED_POINTER: &str = "/private/shared-pointer-must-not-leak";
const POINTER_VALUES: [&str; 3] = [CANONICAL_POINTER, LEGACY_POINTER, SHARED_POINTER];
const SOURCE_EVENT: &str = "private_payload_file_env_source";

#[derive(Clone, Copy, PartialEq, Eq)]
enum PrivateFileKind {
    UserEnv,
    RunPayload,
}

#[derive(Clone, Copy)]
struct PrivateFileEnvPair {
    kind: PrivateFileKind,
    canonical: &'static str,
    legacy: &'static str,
    value: fn(&GuestConfigRaw) -> &str,
}

const PRIVATE_FILE_ENV_PAIRS: [PrivateFileEnvPair; 2] = [
    PrivateFileEnvPair {
        kind: PrivateFileKind::UserEnv,
        canonical: guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        legacy: guest_contracts::env::USER_ENV_FILE_ENV,
        value: |raw| &raw.user_env_file,
    },
    PrivateFileEnvPair {
        kind: PrivateFileKind::RunPayload,
        canonical: guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        legacy: guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
        value: |raw| &raw.run_payload_file,
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
    expected_value: &'static str,
    expected_source: Option<&'static str>,
}

const SUCCESS_CASES: [SuccessCase; 14] = [
    SuccessCase {
        name: "absent",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Absent,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Absent,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "legacy-empty",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(""),
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "dual-empty",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(""),
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-only",
        canonical: AliasInput::Readable(CANONICAL_POINTER),
        legacy: AliasInput::Absent,
        expected_value: CANONICAL_POINTER,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-only",
        canonical: AliasInput::Absent,
        legacy: AliasInput::Readable(LEGACY_POINTER),
        expected_value: LEGACY_POINTER,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "equal-dual",
        canonical: AliasInput::Readable(SHARED_POINTER),
        legacy: AliasInput::Readable(SHARED_POINTER),
        expected_value: SHARED_POINTER,
        expected_source: Some("dual"),
    },
    SuccessCase {
        name: "canonical-empty-with-legacy",
        canonical: AliasInput::Readable(""),
        legacy: AliasInput::Readable(LEGACY_POINTER),
        expected_value: LEGACY_POINTER,
        expected_source: Some("legacy-only"),
    },
    SuccessCase {
        name: "canonical-with-legacy-empty",
        canonical: AliasInput::Readable(CANONICAL_POINTER),
        legacy: AliasInput::Readable(""),
        expected_value: CANONICAL_POINTER,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "canonical-non-unicode",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Absent,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "legacy-non-unicode",
        canonical: AliasInput::Absent,
        legacy: AliasInput::NonUnicode,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "dual-non-unicode",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::NonUnicode,
        expected_value: "",
        expected_source: None,
    },
    SuccessCase {
        name: "canonical-with-unreadable-legacy",
        canonical: AliasInput::Readable(CANONICAL_POINTER),
        legacy: AliasInput::NonUnicode,
        expected_value: CANONICAL_POINTER,
        expected_source: Some("canonical-only"),
    },
    SuccessCase {
        name: "legacy-with-unreadable-canonical",
        canonical: AliasInput::NonUnicode,
        legacy: AliasInput::Readable(LEGACY_POINTER),
        expected_value: LEGACY_POINTER,
        expected_source: Some("legacy-only"),
    },
];

#[derive(Clone, Copy)]
enum Spelling {
    Canonical,
    Legacy,
}

impl Spelling {
    fn name(self) -> &'static str {
        match self {
            Self::Canonical => "canonical",
            Self::Legacy => "legacy",
        }
    }

    fn source(self) -> &'static str {
        match self {
            Self::Canonical => "canonical-only",
            Self::Legacy => "legacy-only",
        }
    }
}

struct PrivateFiles {
    runtime_dir: PathBuf,
    user_env_dir: PathBuf,
    user_env_path: PathBuf,
    run_payload_dir: PathBuf,
    run_payload_path: PathBuf,
    prompt: String,
    model: String,
}

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

fn reset_bootstrap_env() {
    guest_common::log::clear_system_log_file();
    guest_common::telemetry::clear_sandbox_ops_log_file();
    // SAFETY: the integration binary contains exactly one synchronous test and
    // no thread is reading the environment while scenarios are configured.
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
    }
}

fn clear_private_file_env() {
    for pair in PRIVATE_FILE_ENV_PAIRS {
        remove_test_env(pair.canonical);
        remove_test_env(pair.legacy);
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

fn capture_config(log_path: &Path) -> std::io::Result<(Result<GuestConfig, String>, String)> {
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
    Ok((raw.and_then(GuestConfig::from_raw), evidence))
}

fn assert_value_free(text: &str, forbidden_values: &[&str], context: &str) {
    for value in forbidden_values {
        assert!(
            !text.contains(value),
            "{context} exposed private file pointer material"
        );
    }
}

fn source_messages(log: &str) -> Vec<&str> {
    log.lines()
        .filter_map(|line| line.rsplit_once("] ").map(|(_, message)| message))
        .filter(|message| message.starts_with(SOURCE_EVENT))
        .collect()
}

fn assert_source_evidence(
    log: &str,
    expected: &[(&str, &str)],
    forbidden_values: &[&str],
    context: &str,
) {
    assert_value_free(log, forbidden_values, context);
    let messages = source_messages(log);
    assert!(
        messages.len() == expected.len(),
        "{context} emitted the wrong number of source records"
    );
    for (key, source) in expected {
        let expected_message = format!("{SOURCE_EVENT} key={key} source={source}");
        assert!(
            messages.contains(&expected_message.as_str()),
            "{context} omitted fixed source evidence for {key}"
        );
    }
}

fn expected_conflict_error(pair: PrivateFileEnvPair) -> String {
    format!(
        "conflicting private payload file environment aliases: canonical_key={} legacy_key={} state=conflict",
        pair.canonical, pair.legacy
    )
}

fn write_private_files(root: &Path, name: &str) -> TestResult<PrivateFiles> {
    let runtime_dir = root.join(format!("{name}-runtime"));
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let prompt = format!("prompt-{name}");
    let model = format!("model-{name}");

    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "HOME": root.join(format!("{name}-user-home")),
            "OPENAI_MODEL": model,
        }))?,
    )?;
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload {
            prompt: prompt.clone(),
            tools: "Bash".to_string(),
            ..guest_contracts::env::RunPayload::default()
        })?,
    )?;

    Ok(PrivateFiles {
        runtime_dir,
        user_env_dir,
        user_env_path,
        run_payload_dir,
        run_payload_path,
        prompt,
        model,
    })
}

fn configure_private_files(files: &PrivateFiles, name: &str) -> TestResult {
    reset_bootstrap_env();
    let root = files
        .runtime_dir
        .parent()
        .ok_or("test runtime directory must have a parent")?;
    set_test_env(
        guest_contracts::env::RUN_ID_ENV,
        format!("private-payload-{name}"),
    );
    set_test_env("HOME", root.join(format!("{name}-process-home")));
    set_test_env(
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        &files.runtime_dir,
    );
    Ok(())
}

fn pair_path(pair: PrivateFileEnvPair, files: &PrivateFiles) -> &Path {
    match pair.kind {
        PrivateFileKind::UserEnv => &files.user_env_path,
        PrivateFileKind::RunPayload => &files.run_payload_path,
    }
}

fn set_selected_pointer(spelling: Spelling, pair: PrivateFileEnvPair, value: &Path) {
    match spelling {
        Spelling::Canonical => set_test_env(pair.canonical, value),
        Spelling::Legacy => set_test_env(pair.legacy, value),
    }
}

fn assert_alias_state_matrix(root: &Path) -> TestResult {
    reset_bootstrap_env();
    for (pair_index, pair) in PRIVATE_FILE_ENV_PAIRS.into_iter().enumerate() {
        for case in SUCCESS_CASES {
            clear_private_file_env();
            apply_alias(pair.canonical, case.canonical);
            apply_alias(pair.legacy, case.legacy);
            let log_path = root.join(format!("matrix-{pair_index}-{}.log", case.name));
            let (raw, log) = capture_raw(&log_path)?;
            let raw = raw.map_err(std::io::Error::other)?;
            assert!(
                (pair.value)(&raw) == case.expected_value,
                "{} resolved the wrong pointer for {}",
                case.name,
                pair.canonical
            );
            let expected = case
                .expected_source
                .map(|source| vec![(pair.canonical, source)])
                .unwrap_or_default();
            assert_source_evidence(&log, &expected, &POINTER_VALUES, case.name);
        }

        clear_private_file_env();
        set_test_env(pair.canonical, CANONICAL_POINTER);
        set_test_env(pair.legacy, LEGACY_POINTER);
        let conflict_name = format!("matrix-conflict-{pair_index}");
        let (raw, log) = capture_raw(&root.join(format!("{conflict_name}.log")))?;
        let error = match raw {
            Ok(_) => return Err(format!("{} accepted conflicting aliases", pair.canonical).into()),
            Err(error) => error,
        };
        assert!(
            error == expected_conflict_error(pair),
            "{conflict_name} returned the wrong conflict diagnostic"
        );
        assert_value_free(&error, &POINTER_VALUES, &conflict_name);
        assert_source_evidence(&log, &[], &POINTER_VALUES, &conflict_name);
    }
    Ok(())
}

fn assert_single_spelling_success(root: &Path) -> TestResult {
    for spelling in [Spelling::Canonical, Spelling::Legacy] {
        let name = format!("{}-success", spelling.name());
        let files = write_private_files(root, &name)?;
        configure_private_files(&files, &name)?;
        for pair in PRIVATE_FILE_ENV_PAIRS {
            set_selected_pointer(spelling, pair, pair_path(pair, &files));
        }
        let user_path = files.user_env_path.to_string_lossy().into_owned();
        let payload_path = files.run_payload_path.to_string_lossy().into_owned();
        let forbidden = [user_path.as_str(), payload_path.as_str()];
        let (config, log) = capture_config(&root.join(format!("{name}.log")))?;
        let config = match config {
            Ok(config) => config,
            Err(error) => {
                assert_value_free(&error, &forbidden, &name);
                return Err(format!("{name} failed to build GuestConfig").into());
            }
        };

        assert!(
            config.prompt == files.prompt,
            "{name} parsed the wrong prompt"
        );
        assert!(
            config.tools == "Bash",
            "{name} parsed the wrong tools value"
        );
        assert!(
            config.user_env.get("OPENAI_MODEL") == Some(&files.model),
            "{name} parsed the wrong user environment"
        );
        assert!(
            !files.user_env_path.exists(),
            "{name} kept the user-env file"
        );
        assert!(
            !files.user_env_dir.exists(),
            "{name} kept the user-env directory"
        );
        assert!(
            !files.run_payload_path.exists(),
            "{name} kept the run-payload file"
        );
        assert!(
            !files.run_payload_dir.exists(),
            "{name} kept the run-payload directory"
        );
        assert_source_evidence(
            &log,
            &[
                (
                    guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
                    spelling.source(),
                ),
                (
                    guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
                    spelling.source(),
                ),
            ],
            &forbidden,
            &name,
        );
    }
    Ok(())
}

fn assert_equal_dual_consumes_once(root: &Path) -> TestResult {
    let name = "equal-dual-consume";
    let files = write_private_files(root, name)?;
    configure_private_files(&files, name)?;
    for pair in PRIVATE_FILE_ENV_PAIRS {
        let path = pair_path(pair, &files);
        set_test_env(pair.canonical, path);
        set_test_env(pair.legacy, path);
    }
    let user_path = files.user_env_path.to_string_lossy().into_owned();
    let payload_path = files.run_payload_path.to_string_lossy().into_owned();
    let forbidden = [user_path.as_str(), payload_path.as_str()];
    let (config, log) = capture_config(&root.join(format!("{name}.log")))?;
    let config = match config {
        Ok(config) => config,
        Err(error) => {
            assert_value_free(&error, &forbidden, name);
            return Err("equal dual aliases failed to build GuestConfig".into());
        }
    };

    assert!(
        config.prompt == files.prompt,
        "equal dual parsed the wrong prompt"
    );
    assert!(
        config.user_env.get("OPENAI_MODEL") == Some(&files.model),
        "equal dual parsed the wrong user environment"
    );
    assert!(!files.user_env_path.exists());
    assert!(!files.user_env_dir.exists());
    assert!(!files.run_payload_path.exists());
    assert!(!files.run_payload_dir.exists());
    assert_source_evidence(
        &log,
        &[
            (guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV, "dual"),
            (guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV, "dual"),
        ],
        &forbidden,
        name,
    );
    Ok(())
}

fn assert_conflicts_precede_private_file_io(root: &Path) -> TestResult {
    for (index, conflict_pair) in PRIVATE_FILE_ENV_PAIRS.into_iter().enumerate() {
        let name = format!("conflict-before-io-{index}");
        let files = write_private_files(root, &name)?;
        configure_private_files(&files, &name)?;
        let other_pair = PRIVATE_FILE_ENV_PAIRS
            .into_iter()
            .find(|pair| pair.kind != conflict_pair.kind)
            .ok_or("each private file pair must have a counterpart")?;
        set_test_env(other_pair.legacy, pair_path(other_pair, &files));

        let conflicting_path = root.join(format!("{name}-pointer-must-not-leak"));
        std::fs::write(&conflicting_path, "must remain unread")?;
        set_test_env(conflict_pair.canonical, pair_path(conflict_pair, &files));
        set_test_env(conflict_pair.legacy, &conflicting_path);

        let user_path = files.user_env_path.to_string_lossy().into_owned();
        let payload_path = files.run_payload_path.to_string_lossy().into_owned();
        let conflict_path = conflicting_path.to_string_lossy().into_owned();
        let forbidden = [
            user_path.as_str(),
            payload_path.as_str(),
            conflict_path.as_str(),
        ];
        let (config, log) = capture_config(&root.join(format!("{name}.log")))?;
        let error = match config {
            Ok(_) => return Err(format!("{name} accepted conflicting aliases").into()),
            Err(error) => error,
        };
        assert!(
            error == expected_conflict_error(conflict_pair),
            "{name} returned the wrong conflict diagnostic"
        );
        assert_value_free(&error, &forbidden, &name);
        assert_source_evidence(&log, &[], &forbidden, &name);
        assert!(
            files.run_payload_path.exists(),
            "{name} consumed the required run payload before conflict rejection"
        );
        assert!(
            files.user_env_path.exists(),
            "{name} consumed the optional user env before conflict rejection"
        );
        assert!(
            conflicting_path.exists(),
            "{name} consumed a conflicting path"
        );
    }
    Ok(())
}

fn assert_missing_run_payload_preserves_private_files(root: &Path) -> TestResult {
    let name = "missing-run-payload";
    let files = write_private_files(root, name)?;
    configure_private_files(&files, name)?;
    set_test_env(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        &files.user_env_path,
    );
    set_test_env(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV, "");
    set_test_env(
        guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
        OsString::from_vec(vec![0xff]),
    );

    let user_path = files.user_env_path.to_string_lossy().into_owned();
    let payload_path = files.run_payload_path.to_string_lossy().into_owned();
    let forbidden = [user_path.as_str(), payload_path.as_str()];
    let (config, log) = capture_config(&root.join(format!("{name}.log")))?;
    let error = match config {
        Ok(_) => return Err("empty/unreadable run-payload aliases were accepted".into()),
        Err(error) => error,
    };
    assert!(
        error == format!("{} is required", guest_contracts::env::RUN_PAYLOAD_FILE_ENV),
        "missing run payload returned the wrong diagnostic"
    );
    assert_value_free(&error, &forbidden, name);
    assert_source_evidence(
        &log,
        &[(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            "canonical-only",
        )],
        &forbidden,
        name,
    );
    assert!(files.run_payload_path.exists());
    assert!(files.user_env_path.exists());
    Ok(())
}

fn assert_path_validation_and_consumption_parity(root: &Path) -> TestResult {
    let mut run_payload_errors = Vec::new();
    let mut user_env_errors = Vec::new();

    for spelling in [Spelling::Canonical, Spelling::Legacy] {
        let run_name = format!("{}-invalid-run-payload", spelling.name());
        let run_files = write_private_files(root, &run_name)?;
        configure_private_files(&run_files, &run_name)?;
        let invalid_run_path = root.join(format!("{run_name}-must-not-leak"));
        std::fs::write(&invalid_run_path, "not a payload")?;
        set_selected_pointer(spelling, PRIVATE_FILE_ENV_PAIRS[1], &invalid_run_path);
        let invalid_run = invalid_run_path.to_string_lossy().into_owned();
        let (config, log) = capture_config(&root.join(format!("{run_name}.log")))?;
        let error = match config {
            Ok(_) => return Err(format!("{run_name} accepted an invalid path").into()),
            Err(error) => error,
        };
        assert_value_free(&error, &[invalid_run.as_str()], &run_name);
        assert_value_free(&log, &[invalid_run.as_str()], &run_name);
        assert!(invalid_run_path.exists());
        assert!(run_files.run_payload_path.exists());
        assert!(run_files.user_env_path.exists());
        run_payload_errors.push(error);

        let user_name = format!("{}-invalid-user-env", spelling.name());
        let user_files = write_private_files(root, &user_name)?;
        configure_private_files(&user_files, &user_name)?;
        let invalid_user_path = root.join(format!("{user_name}-must-not-leak"));
        std::fs::write(&invalid_user_path, "not a user environment")?;
        set_selected_pointer(spelling, PRIVATE_FILE_ENV_PAIRS[0], &invalid_user_path);
        set_selected_pointer(
            spelling,
            PRIVATE_FILE_ENV_PAIRS[1],
            &user_files.run_payload_path,
        );
        let invalid_user = invalid_user_path.to_string_lossy().into_owned();
        let (config, log) = capture_config(&root.join(format!("{user_name}.log")))?;
        let error = match config {
            Ok(_) => return Err(format!("{user_name} accepted an invalid path").into()),
            Err(error) => error,
        };
        assert_value_free(&error, &[invalid_user.as_str()], &user_name);
        assert_value_free(&log, &[invalid_user.as_str()], &user_name);
        assert!(invalid_user_path.exists());
        assert!(user_files.user_env_path.exists());
        assert!(
            !user_files.run_payload_path.exists(),
            "{user_name} changed run-payload-first destructive consumption"
        );
        assert!(!user_files.run_payload_dir.exists());
        user_env_errors.push(error);
    }

    assert!(
        matches!(
            run_payload_errors.as_slice(),
            [canonical, legacy] if canonical == legacy
        ),
        "canonical and legacy run-payload pointers changed path validation"
    );
    assert!(
        matches!(
            user_env_errors.as_slice(),
            [canonical, legacy] if canonical == legacy
        ),
        "canonical and legacy user-env pointers changed path validation"
    );
    Ok(())
}

#[test]
fn private_payload_file_aliases_fail_closed_before_destructive_loading() -> TestResult {
    assert_eq!(
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        "OKOU_USER_ENV_FILE"
    );
    assert_eq!(guest_contracts::env::USER_ENV_FILE_ENV, "VM0_USER_ENV_FILE");
    assert_eq!(
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        "OKOU_RUN_PAYLOAD_FILE"
    );
    assert_eq!(
        guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
        "VM0_RUN_PAYLOAD_FILE"
    );

    let tmp = tempfile::tempdir()?;
    assert_alias_state_matrix(tmp.path())?;
    assert_conflicts_precede_private_file_io(tmp.path())?;
    assert_missing_run_payload_preserves_private_files(tmp.path())?;
    assert_single_spelling_success(tmp.path())?;
    assert_equal_dual_consumes_once(tmp.path())?;
    assert_path_validation_and_consumption_parity(tmp.path())?;
    reset_bootstrap_env();
    Ok(())
}
