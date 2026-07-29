use std::time::Duration;

use super::super::detect_system_timezone;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const TIMEZONE_CHILD_SCENARIO: &str = "VM0_RUNNER_TIMEZONE_TEST_SCENARIO";
const TIMEZONE_CHILD_TEST: &str =
    "cmd::local::submit::tests::timezone::detect_system_timezone_child";
const TIMEZONE_FROM_ENV_SCENARIO: &str = "from-env";
const TIMEZONE_EMPTY_ENV_SCENARIO: &str = "empty-env";

#[tokio::test]
async fn detect_system_timezone_from_env() {
    run_timezone_child(TIMEZONE_FROM_ENV_SCENARIO, "America/New_York").await;
}

#[tokio::test]
async fn detect_system_timezone_empty_env() {
    run_timezone_child(TIMEZONE_EMPTY_ENV_SCENARIO, "").await;
}

async fn run_timezone_child(scenario: &'static str, timezone: &'static str) {
    run_ignored_child_test(
        TIMEZONE_CHILD_TEST,
        (TIMEZONE_CHILD_SCENARIO, scenario),
        &[("TZ", Some(timezone))],
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

    match scenario.as_str() {
        TIMEZONE_FROM_ENV_SCENARIO => {
            assert_eq!(
                detect_system_timezone(),
                Some("America/New_York".to_string())
            );
        }
        TIMEZONE_EMPTY_ENV_SCENARIO => {
            // Empty TZ falls through to /etc/timezone.
            assert_ne!(detect_system_timezone(), Some("".to_string()));
        }
        other => panic!("unknown timezone test scenario: {other}"),
    }
}
