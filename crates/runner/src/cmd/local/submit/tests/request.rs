use std::process::ExitCode;

use super::super::{SubmitArgs, run_submit_with_home};
use super::support::{submit_args_for_test, wait_for_job_and_write_success};
use crate::paths::HomePaths;

#[tokio::test]
async fn submit_defaults_profile_and_writes_default_partition() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let group_dir = home.groups_dir().join(group);
    let watcher = tokio::spawn(wait_for_job_and_write_success(
        group_dir,
        crate::profile::DEFAULT_PROFILE.to_owned(),
    ));

    let code = run_submit_with_home(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            chat_thread_id: None,
            session_id: None,
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();
    let request = watcher.await.unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.prompt, "hello");
    assert_eq!(request.cli_agent_type, "claude-code");
    assert_eq!(
        request.profile.as_deref(),
        Some(crate::profile::DEFAULT_PROFILE)
    );
}

#[tokio::test]
async fn submit_writes_non_default_profile_partition() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let profile = "vm0/large";
    let group_dir = home.groups_dir().join(group);
    let watcher = tokio::spawn(wait_for_job_and_write_success(
        group_dir,
        profile.to_owned(),
    ));

    let code = run_submit_with_home(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: Some(profile.into()),
            chat_thread_id: None,
            session_id: None,
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();
    let request = watcher.await.unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.profile.as_deref(), Some(profile));
}

#[tokio::test]
async fn submit_serializes_feature_flags_and_identity_fields() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let group_dir = home.groups_dir().join(group);
    let watcher = tokio::spawn(wait_for_job_and_write_success(
        group_dir,
        crate::profile::DEFAULT_PROFILE.to_owned(),
    ));

    let code = run_submit_with_home(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "codex".into(),
            profile: None,
            chat_thread_id: Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".parse().unwrap()),
            session_id: Some("sess-123".into()),
            feature_flags: vec!["alpha=true".into(), "beta=false".into()],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();
    let request = watcher.await.unwrap();
    let flags = request.feature_flags.as_ref().unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.prompt, "hello");
    assert_eq!(request.cli_agent_type, "codex");
    assert_eq!(
        request.reuse_key.as_deref(),
        Some("thread:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    );
    assert_eq!(request.session_id.as_deref(), Some("sess-123"));
    assert_eq!(flags.get("alpha"), Some(&true));
    assert_eq!(flags.get("beta"), Some(&false));
}

#[tokio::test]
async fn submit_keeps_session_only_job_without_reuse_key() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let group_dir = home.groups_dir().join(group);
    let watcher = tokio::spawn(wait_for_job_and_write_success(
        group_dir,
        crate::profile::DEFAULT_PROFILE.to_owned(),
    ));

    let code = run_submit_with_home(
        SubmitArgs {
            group: group.into(),
            prompt: "hello".into(),
            cli_agent_type: "claude-code".into(),
            profile: None,
            chat_thread_id: None,
            session_id: Some("sess-123".into()),
            feature_flags: vec![],
            env: vec![],
            secret_env: vec![],
            timeout: 5,
            active_inputs: vec![],
        },
        home,
    )
    .await
    .unwrap();
    let request = watcher.await.unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(request.session_id.as_deref(), Some("sess-123"));
    assert!(request.reuse_key.is_none());
}

#[tokio::test]
async fn submit_serializes_env_and_secret_env() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group = "test/group";
    let group_dir = home.groups_dir().join(group);
    let watcher = tokio::spawn(wait_for_job_and_write_success(
        group_dir,
        crate::profile::DEFAULT_PROFILE.to_owned(),
    ));

    let mut args = submit_args_for_test();
    args.group = group.into();
    args.timeout = 5;
    args.env = vec![
        "FOO=bar".into(),
        "URL=https://example.test/path?a=1&b=2".into(),
        "EMPTY=".into(),
        "MULTILINE=line1\nline2".into(),
        "VM0_STUCK_TOOL_TIMEOUT_SECS=3".into(),
    ];
    args.secret_env = vec![
        "ANTHROPIC_API_KEY=sk-ant-local-secret".into(),
        "PRIVATE_KEY=-----BEGIN KEY-----\r\nsecret\r\n-----END KEY-----".into(),
    ];

    let code = run_submit_with_home(args, home).await.unwrap();
    let request = watcher.await.unwrap();
    let environment = request.environment.as_ref().unwrap();
    let secret_environment = request.secret_environment.as_ref().unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(environment.get("FOO").map(String::as_str), Some("bar"));
    assert_eq!(
        environment.get("URL").map(String::as_str),
        Some("https://example.test/path?a=1&b=2")
    );
    assert_eq!(environment.get("EMPTY").map(String::as_str), Some(""));
    assert_eq!(
        environment.get("MULTILINE").map(String::as_str),
        Some("line1\nline2")
    );
    assert_eq!(
        environment
            .get("VM0_STUCK_TOOL_TIMEOUT_SECS")
            .map(String::as_str),
        Some("3")
    );
    assert_eq!(
        secret_environment
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some("sk-ant-local-secret")
    );
    assert_eq!(
        secret_environment.get("PRIVATE_KEY").map(String::as_str),
        Some("-----BEGIN KEY-----\r\nsecret\r\n-----END KEY-----")
    );
}

#[tokio::test]
async fn rejects_invalid_env_entries_before_submit() {
    let cases = vec![
        (vec!["FOO".to_string()], Vec::new(), "expected KEY=VALUE"),
        (vec!["=VALUE".to_string()], Vec::new(), "expected KEY=VALUE"),
        (
            vec!["BAD-KEY=value".to_string()],
            Vec::new(),
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            vec!["1KEY=value".to_string()],
            Vec::new(),
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            vec!["KEY SPACE=value".to_string()],
            Vec::new(),
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            Vec::new(),
            vec!["ÅKEY=value".to_string()],
            "expected [_A-Za-z][_A-Za-z0-9]*",
        ),
        (
            Vec::new(),
            vec!["KEY=with\0nul".to_string()],
            "NUL characters",
        ),
        (
            vec!["VM0_PROMPT=value".to_string()],
            Vec::new(),
            "runner-owned environment variables",
        ),
        (
            Vec::new(),
            vec!["CLI_AGENT_TYPE=codex".to_string()],
            "runner-owned environment variables",
        ),
        (
            Vec::new(),
            vec!["VM0_STUCK_TOOL_TIMEOUT_SECS=3".to_string()],
            "must be passed with --env",
        ),
        (
            vec!["FOO=1".to_string(), "FOO=2".to_string()],
            Vec::new(),
            "duplicate --env key 'FOO'",
        ),
        (
            vec!["FOO=1".to_string()],
            vec!["FOO=2".to_string()],
            "across --env and --secret-env",
        ),
    ];

    for (env, secret_env, expected) in cases {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let mut args = submit_args_for_test();
        args.env = env;
        args.secret_env = secret_env;

        let err = run_submit_with_home(args, home).await.unwrap_err();

        assert!(err.to_string().contains(expected), "got: {err}");
    }
}
