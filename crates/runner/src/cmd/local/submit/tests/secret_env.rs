use std::time::Duration;

use clap::{CommandFactory, Parser};

use super::super::{SubmitArgs, run_submit_with_home};
use super::support::{submit_args_for_test, wait_for_job_and_write_success};
use crate::paths::HomePaths;
use crate::test_fixtures::{ignored_child_test_env_guard_enabled, run_ignored_child_test};

const CHILD_SCENARIO_ENV: &str = "VM0_RUNNER_LOCAL_SUBMIT_SECRET_ENV_TEST_SCENARIO";
const CHILD_TEST: &str = "cmd::local::submit::tests::secret_env::secret_env_child";
const SUCCESS_SCENARIO: &str = "success";
const MISSING_SCENARIO: &str = "missing";
const CONFLICT_SCENARIO: &str = "conflict";

const PRIMARY_KEY: &str = "LOCAL_SUBMIT_PRIMARY_SECRET";
const PRIMARY_VALUE: &str = "line1\nline2=密钥";
const SECONDARY_KEY: &str = "LOCAL_SUBMIT_SECONDARY_SECRET";
const SECONDARY_VALUE: &str = "second-secret-value";
const EMPTY_KEY: &str = "LOCAL_SUBMIT_EMPTY_SECRET";
const MISSING_KEY: &str = "LOCAL_SUBMIT_MISSING_SECRET";
const CONFLICT_KEY: &str = "LOCAL_SUBMIT_CONFLICT";
const CONFLICT_VALUE: &str = "conflict-secret-value";

#[derive(Parser)]
struct TestSubmitCli {
    #[command(flatten)]
    args: SubmitArgs,
}

#[test]
fn help_describes_secret_environment_name_lookup() {
    let help = TestSubmitCli::command().render_help().to_string();
    let normalized_help = help.split_whitespace().collect::<Vec<_>>().join(" ");

    assert!(normalized_help.contains("--secret-env <NAME>"));
    assert!(normalized_help.contains(
        "Names of inherited environment variables to pass to the local job and register for masking"
    ));
}

#[tokio::test]
async fn resolves_secret_environment_names_without_argv_values() {
    run_secret_env_child(
        SUCCESS_SCENARIO,
        &[
            (PRIMARY_KEY, Some(PRIMARY_VALUE)),
            (SECONDARY_KEY, Some(SECONDARY_VALUE)),
            (EMPTY_KEY, Some("")),
        ],
    )
    .await;
}

#[tokio::test]
async fn rejects_missing_secret_environment_variable() {
    run_secret_env_child(MISSING_SCENARIO, &[(MISSING_KEY, None)]).await;
}

#[tokio::test]
async fn rejects_key_shared_with_ordinary_environment() {
    run_secret_env_child(CONFLICT_SCENARIO, &[(CONFLICT_KEY, Some(CONFLICT_VALUE))]).await;
}

async fn run_secret_env_child(
    scenario: &'static str,
    child_env: &[(&'static str, Option<&'static str>)],
) {
    run_ignored_child_test(
        CHILD_TEST,
        (CHILD_SCENARIO_ENV, scenario),
        child_env,
        Duration::from_secs(5),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by local-submit secret environment scenario tests"]
async fn secret_env_child() {
    let Ok(scenario) = std::env::var(CHILD_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((CHILD_SCENARIO_ENV, &scenario)) {
        return;
    }

    match scenario.as_str() {
        SUCCESS_SCENARIO => submit_selected_secret_environment().await,
        MISSING_SCENARIO => reject_missing_secret_environment().await,
        CONFLICT_SCENARIO => reject_conflicting_secret_environment().await,
        other => panic!("unknown local-submit secret environment scenario: {other}"),
    }
}

async fn submit_selected_secret_environment() {
    let cli = TestSubmitCli::try_parse_from([
        "runner-local-submit",
        "--group",
        "test/group",
        "--prompt",
        "hello",
        "--env",
        "ORDINARY=value",
        "--secret-env",
        PRIMARY_KEY,
        "--secret-env",
        SECONDARY_KEY,
        "--secret-env",
        EMPTY_KEY,
        "--timeout",
        "5",
    ])
    .unwrap();
    assert_eq!(cli.args.secret_env, [PRIMARY_KEY, SECONDARY_KEY, EMPTY_KEY]);

    let cmdline = std::fs::read("/proc/self/cmdline").unwrap();
    let cmdline = String::from_utf8_lossy(&cmdline);
    for secret in [PRIMARY_VALUE, SECONDARY_VALUE] {
        assert!(
            !cmdline.contains(secret),
            "secret value must not appear in the child process argument vector"
        );
    }

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    let watcher = tokio::spawn(wait_for_job_and_write_success(
        group_dir,
        crate::profile::DEFAULT_PROFILE.to_owned(),
    ));

    run_submit_with_home(cli.args, home).await.unwrap();
    let request = watcher.await.unwrap();
    let environment = request.environment.as_ref().unwrap();
    let secret_environment = request.secret_environment.as_ref().unwrap();

    assert_eq!(
        environment.get("ORDINARY").map(String::as_str),
        Some("value")
    );
    assert_eq!(
        secret_environment.get(PRIMARY_KEY).map(String::as_str),
        Some(PRIMARY_VALUE)
    );
    assert_eq!(
        secret_environment.get(SECONDARY_KEY).map(String::as_str),
        Some(SECONDARY_VALUE)
    );
    assert_eq!(
        secret_environment.get(EMPTY_KEY).map(String::as_str),
        Some("")
    );
}

async fn reject_missing_secret_environment() {
    let mut args = submit_args_for_test();
    args.secret_env = vec![MISSING_KEY.to_string()];

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let error = run_submit_with_home(args, home).await.unwrap_err();
    let message = error.to_string();

    assert!(message.contains(MISSING_KEY), "got: {message}");
    assert!(message.contains("not set or is not valid Unicode"));
}

async fn reject_conflicting_secret_environment() {
    let mut args = submit_args_for_test();
    args.env = vec![format!("{CONFLICT_KEY}=ordinary-value")];
    args.secret_env = vec![CONFLICT_KEY.to_string()];

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let error = run_submit_with_home(args, home).await.unwrap_err();
    let message = error.to_string();

    assert!(
        message.contains("across --env and --secret-env"),
        "got: {message}"
    );
    assert!(
        !message.contains(CONFLICT_VALUE),
        "error must not expose the resolved secret value: {message}"
    );
}

#[tokio::test]
async fn rejects_legacy_secret_value_without_echoing_it() {
    const SENTINEL: &str = "legacy-argv-secret-sentinel";

    let mut args = submit_args_for_test();
    args.secret_env = vec![format!("OPENAI_API_KEY={SENTINEL}")];

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let error = run_submit_with_home(args, home).await.unwrap_err();
    let message = error.to_string();

    assert!(
        message.contains("expected an environment variable name without a value"),
        "got: {message}"
    );
    assert!(
        !message.contains(SENTINEL),
        "error must not echo the legacy secret value: {message}"
    );
}

#[tokio::test]
async fn rejects_invalid_secret_environment_names_before_lookup() {
    let cases = [
        (vec!["".to_string()], "expected [_A-Za-z]"),
        (vec!["BAD-KEY".to_string()], "expected [_A-Za-z]"),
        (vec!["1KEY".to_string()], "expected [_A-Za-z]"),
        (vec!["KEY SPACE".to_string()], "expected [_A-Za-z]"),
        (vec!["ÅKEY".to_string()], "expected [_A-Za-z]"),
        (
            vec!["KEY\0WITH_NUL".to_string()],
            "expected an environment variable name",
        ),
        (
            vec!["CLI_AGENT_TYPE".to_string()],
            "runner-owned environment variables",
        ),
        (
            vec!["VM0_STUCK_TOOL_TIMEOUT_SECS".to_string()],
            "must be passed with --env",
        ),
        (
            vec!["DUPLICATE_KEY".to_string(), "DUPLICATE_KEY".to_string()],
            "duplicate --secret-env key 'DUPLICATE_KEY'",
        ),
    ];

    for (secret_env, expected) in cases {
        let mut args = submit_args_for_test();
        args.secret_env = secret_env;
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());

        let error = run_submit_with_home(args, home).await.unwrap_err();

        assert!(error.to_string().contains(expected), "got: {error}");
    }
}
