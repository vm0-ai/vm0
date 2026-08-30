use std::path::Path;
use std::time::Duration;

use super::super::detect_system_timezone;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const TIMEZONE_CHILD_SCENARIO: &str = "OKOU_RUNNER_TIMEZONE_TEST_SCENARIO";
const TIMEZONE_CHILD_FILE: &str = "OKOU_RUNNER_TIMEZONE_TEST_FILE";
const TIMEZONE_CHILD_TEST: &str =
    "cmd::local::submit::tests::timezone::detect_system_timezone_child";
const TIMEZONE_FROM_ENV_SCENARIO: &str = "from-env";
const TIMEZONE_EMPTY_ENV_SCENARIO: &str = "empty-env";
const TIMEZONE_ABSENT_ENV_SCENARIO: &str = "absent-env";
const TIMEZONE_WHITESPACE_FILE_SCENARIO: &str = "whitespace-file";
const TIMEZONE_MISSING_FILE_SCENARIO: &str = "missing-file";

// `/etc/timezone` cannot be varied through the local-submit interface without changing host
// state. The ignored child isolates `TZ` while this internal seam reads a real temporary file.
#[tokio::test]
async fn detect_system_timezone_from_env() {
    run_timezone_child(
        TIMEZONE_FROM_ENV_SCENARIO,
        Some("America/New_York"),
        Some("Asia/Shanghai\n"),
    )
    .await;
}

#[tokio::test]
async fn detect_system_timezone_empty_env() {
    run_timezone_child(
        TIMEZONE_EMPTY_ENV_SCENARIO,
        Some(""),
        Some("  Asia/Shanghai \n"),
    )
    .await;
}

#[tokio::test]
async fn detect_system_timezone_absent_env() {
    run_timezone_child(TIMEZONE_ABSENT_ENV_SCENARIO, None, Some("\nEtc/UTC\n")).await;
}

#[tokio::test]
async fn detect_system_timezone_whitespace_file() {
    run_timezone_child(TIMEZONE_WHITESPACE_FILE_SCENARIO, None, Some(" \n\t")).await;
}

#[tokio::test]
async fn detect_system_timezone_missing_file() {
    run_timezone_child(TIMEZONE_MISSING_FILE_SCENARIO, None, None).await;
}

async fn run_timezone_child(
    scenario: &'static str,
    timezone: Option<&str>,
    timezone_file_content: Option<&str>,
) {
    let dir = tempfile::tempdir().unwrap();
    let timezone_file = dir.path().join("timezone");
    if let Some(content) = timezone_file_content {
        std::fs::write(&timezone_file, content).unwrap();
    }
    let timezone_file = timezone_file
        .to_str()
        .expect("temporary timezone path must be UTF-8");
    run_ignored_child_test(
        TIMEZONE_CHILD_TEST,
        (TIMEZONE_CHILD_SCENARIO, scenario),
        &[("TZ", timezone), (TIMEZONE_CHILD_FILE, Some(timezone_file))],
        Duration::from_secs(5),
    )
    .await;
}

#[test]
#[ignore = "spawned by timezone environment scenario tests"]
fn detect_system_timezone_child() {
    let Ok(scenario) = std::env::var(TIMEZONE_CHILD_SCENARIO) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((TIMEZONE_CHILD_SCENARIO, &scenario)) {
        return;
    }
    let timezone_file = std::env::var(TIMEZONE_CHILD_FILE)
        .expect("timezone child file must be supplied by the parent test");
    let timezone_file = Path::new(&timezone_file);

    match scenario.as_str() {
        TIMEZONE_FROM_ENV_SCENARIO => {
            assert_eq!(
                detect_system_timezone(timezone_file),
                Some("America/New_York".to_string())
            );
        }
        TIMEZONE_EMPTY_ENV_SCENARIO => {
            assert_eq!(
                detect_system_timezone(timezone_file),
                Some("Asia/Shanghai".to_string())
            );
        }
        TIMEZONE_ABSENT_ENV_SCENARIO => {
            assert_eq!(
                detect_system_timezone(timezone_file),
                Some("Etc/UTC".to_string())
            );
        }
        TIMEZONE_WHITESPACE_FILE_SCENARIO | TIMEZONE_MISSING_FILE_SCENARIO => {
            assert_eq!(detect_system_timezone(timezone_file), None);
        }
        other => panic!("unknown timezone test scenario: {other}"),
    }
}
