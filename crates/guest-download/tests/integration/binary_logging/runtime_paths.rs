use super::{
    BinaryLoggingFixture, RuntimeLogPaths, assert_default_zero_task_attribution,
    assert_single_download_total_success, guest_download_command, process,
};
use crate::support::{unique_run_id, write_manifest};
use std::ffi::OsStr;
#[cfg(unix)]
use std::ffi::OsString;
#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;

const RETIRED_GUEST_RUNTIME_DIR_ENV: &str = "VM0_GUEST_RUNTIME_DIR";
const RETIRED_SOURCE_EVENT: &str = "guest_runtime_dir_env_source";

fn apply_runtime_env(
    command: &mut std::process::Command,
    canonical: Option<&OsStr>,
    retired: Option<&OsStr>,
) {
    command
        .env_remove(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV)
        .env_remove(RETIRED_GUEST_RUNTIME_DIR_ENV);
    if let Some(value) = canonical {
        command.env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            value,
        );
    }
    if let Some(value) = retired {
        command.env(RETIRED_GUEST_RUNTIME_DIR_ENV, value);
    }
}

#[test]
fn binary_writes_system_log_to_explicit_runtime_path() {
    let fixture = BinaryLoggingFixture::new("success").unwrap();
    let manifest_path = write_manifest(&fixture.dir, &[], None).unwrap();

    let output = fixture.run_manifest_path(&manifest_path).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[INFO] [sandbox:download] Download completed"),
        "unexpected system log: {content:?}"
    );
    assert_eq!(content.matches("Download completed").count(), 1);
    assert!(!content.contains(RETIRED_SOURCE_EVENT));
    assert!(!content.contains(fixture.logs.runtime_dir.to_string_lossy().as_ref()));

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("[INFO] [sandbox:download] Download completed"));
    let actions = fixture.action_types().unwrap();
    assert_default_zero_task_attribution(&actions);
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, true);
}

#[test]
fn binary_reads_only_the_canonical_runtime_override() {
    for (name, canonical, retired, use_canonical) in [
        ("absent", None, false, false),
        ("canonical-empty", Some(""), false, false),
        ("canonical-absolute", Some("selected"), false, true),
        ("retired-only-is-ignored", None, true, false),
        (
            "canonical-is-not-overridden-by-retired",
            Some("selected"),
            true,
            true,
        ),
        (
            "canonical-empty-does-not-fall-back-to-retired",
            Some(""),
            true,
            false,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let manifest_path = write_manifest(&dir, &[], None).unwrap();
        let run_id = unique_run_id(name);
        let home = dir.path().join("home");
        let fallback_dir =
            guest_contracts::runtime_paths::run_dir_for_home(&home, &run_id).unwrap();
        let canonical_dir = dir.path().join(format!("{name}-canonical-must-not-leak"));
        let retired_dir = dir.path().join(format!("{name}-retired-must-not-leak"));
        let expected_dir = if use_canonical {
            &canonical_dir
        } else {
            &fallback_dir
        };
        let mut command = guest_download_command();
        command
            .arg(&manifest_path)
            .env(guest_contracts::env::RUN_ID_ENV, &run_id)
            .env("HOME", &home);
        apply_runtime_env(
            &mut command,
            canonical.map(|value| {
                if value.is_empty() {
                    OsStr::new("")
                } else {
                    canonical_dir.as_os_str()
                }
            }),
            retired.then_some(retired_dir.as_os_str()),
        );

        let output = process::run(&mut command).unwrap();
        assert!(
            output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let log = std::fs::read_to_string(guest_contracts::runtime_paths::system_log_file(
            expected_dir,
        ))
        .unwrap();
        assert!(!log.contains(RETIRED_SOURCE_EVENT), "{name}");
        assert!(!log.contains("must-not-leak"), "{name}");
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("must-not-leak"),
            "{name}"
        );
        if !use_canonical {
            assert!(!guest_contracts::runtime_paths::system_log_file(&canonical_dir).exists());
        }
        assert!(!guest_contracts::runtime_paths::system_log_file(&retired_dir).exists());
    }
}

#[cfg(unix)]
#[test]
fn binary_accepts_non_unicode_runtime_override_and_home_fallback() {
    let dir = tempfile::tempdir().unwrap();

    let override_manifest = write_manifest(&dir, &[], None).unwrap();
    let override_dir = dir
        .path()
        .join(OsString::from_vec(b"override-\xff".to_vec()));
    let mut override_command = guest_download_command();
    override_command
        .arg(&override_manifest)
        .env(guest_contracts::env::RUN_ID_ENV, "invalid/run-id");
    let retired_dir = dir.path().join("retired-non-unicode-runtime");
    apply_runtime_env(
        &mut override_command,
        Some(override_dir.as_os_str()),
        Some(retired_dir.as_os_str()),
    );
    let override_output = process::run(&mut override_command).unwrap();
    assert!(
        override_output.status.success(),
        "{}",
        String::from_utf8_lossy(&override_output.stderr)
    );
    let override_log = std::fs::read_to_string(guest_contracts::runtime_paths::system_log_file(
        &override_dir,
    ))
    .unwrap();
    assert!(!override_log.contains(RETIRED_SOURCE_EVENT));
    assert!(!guest_contracts::runtime_paths::system_log_file(retired_dir).exists());

    let fallback_manifest = write_manifest(&dir, &[], None).unwrap();
    let home = dir.path().join(OsString::from_vec(b"home-\xfe".to_vec()));
    let run_id = unique_run_id("non-unicode-home");
    let fallback_dir = guest_contracts::runtime_paths::run_dir_for_home(&home, &run_id).unwrap();
    let mut fallback_command = guest_download_command();
    fallback_command
        .arg(&fallback_manifest)
        .env(guest_contracts::env::RUN_ID_ENV, &run_id)
        .env("HOME", &home);
    apply_runtime_env(&mut fallback_command, None, None);
    let fallback_output = process::run(&mut fallback_command).unwrap();
    assert!(
        fallback_output.status.success(),
        "{}",
        String::from_utf8_lossy(&fallback_output.stderr)
    );
    let fallback_log = std::fs::read_to_string(guest_contracts::runtime_paths::system_log_file(
        fallback_dir,
    ))
    .unwrap();
    assert!(!fallback_log.contains(RETIRED_SOURCE_EVENT));
}

#[test]
fn binary_fails_without_run_id_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env_remove(guest_contracts::env::RUN_ID_ENV),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("OKOU_RUN_ID is required for guest-download runtime paths"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_fails_with_empty_run_id_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env(guest_contracts::env::RUN_ID_ENV, ""),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("OKOU_RUN_ID is required for guest-download runtime paths"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_fails_with_relative_runtime_dir_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("relative-runtime-dir");
    let retired_dir = dir.path().join("retired-runtime-must-not-leak");
    let mut command = guest_download_command();
    command
        .arg(&manifest_path)
        .env(guest_contracts::env::RUN_ID_ENV, run_id);
    apply_runtime_env(
        &mut command,
        Some(OsStr::new("relative-runtime-dir")),
        Some(retired_dir.as_os_str()),
    );

    let output = process::run(&mut command).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(
            "failed to resolve guest-download runtime paths: OKOU_GUEST_RUNTIME_DIR must be an absolute path"
        ),
        "unexpected stderr: {stderr}"
    );
    assert!(!stderr.contains("retired-runtime-must-not-leak"));
    assert!(!stderr.contains(RETIRED_SOURCE_EVENT));
    assert!(!guest_contracts::runtime_paths::system_log_file(retired_dir).exists());
    assert!(manifest_path.exists());
}

#[test]
fn binary_fails_with_invalid_run_id_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env(guest_contracts::env::RUN_ID_ENV, "invalid/run/id"),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(
            "failed to resolve guest-download runtime paths: OKOU_RUN_ID must be a single safe path segment"
        ),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_uses_absolute_runtime_dir_without_validating_run_id_as_path_segment() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let logs = RuntimeLogPaths::new(&dir);

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env(
                guest_contracts::env::RUN_ID_ENV,
                "ignored/when/runtime-dir/is-set",
            )
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &logs.runtime_dir,
            ),
    )
    .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[INFO] [sandbox:download] Download completed"),
        "unexpected system log: {content:?}"
    );
}

#[test]
fn binary_fails_without_home_or_runtime_dir_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("missing-home");

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env(guest_contracts::env::RUN_ID_ENV, run_id)
            .env_remove("HOME"),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("failed to resolve guest-download runtime paths: HOME is required for guest runtime paths"),
        "unexpected stderr: {stderr}"
    );
}
