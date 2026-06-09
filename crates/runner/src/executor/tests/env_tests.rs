use std::collections::HashMap;

use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use api_contracts::generated::types::runners::storage::{
    ArtifactEntryMissingRootPolicy, StorageManifest,
};
use sandbox::SandboxId;

use super::super::env::{
    HostEnv, build_env_json_with_host_env, build_user_env_json,
    validate_model_provider_env_placeholders,
};
use super::super::{USER_ENV_FILE_ENV_KEY, guest_runtime_dir};
use super::support::{
    api_artifact, api_storage, build_env_for_test, build_env_for_test_result,
    build_env_for_test_with_host_env, context_with_env, minimal_context,
};
use crate::error::{RunnerError, RunnerResult};
use crate::host_env::{
    RUNNER_CONCURRENCY_FACTOR_ENV, RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV, RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV, RUNNER_NET_TX_MIB_PER_SEC_ENV,
};
use crate::ids::RunId;
use crate::types::{ExecutionContext, ResumeSession, SandboxReuseResult};

#[test]
fn model_provider_env_placeholder_validation_accepts_env_without_protected_keys() {
    let ctx = context_with_env(HashMap::from([("PROJECT_ID".into(), "vm0".into())]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_accepts_anthropic_api_key_placeholder() {
    let ctx = context_with_env(HashMap::from([(
        "ANTHROPIC_API_KEY".into(),
        model_provider_placeholders::ANTHROPIC_API_KEY.into(),
    )]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_rejects_real_anthropic_api_key() {
    let secret = "sk-ant-api03-real-secret-value";
    let ctx = context_with_env(HashMap::from([("ANTHROPIC_API_KEY".into(), secret.into())]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("ANTHROPIC_API_KEY"));
    assert!(!error.contains(secret));
}

#[test]
fn model_provider_env_placeholder_validation_accepts_empty_anthropic_api_key_with_auth_token() {
    let ctx = context_with_env(HashMap::from([
        ("ANTHROPIC_API_KEY".into(), String::new()),
        (
            "ANTHROPIC_AUTH_TOKEN".into(),
            model_provider_placeholders::ANTHROPIC_AUTH_TOKEN.into(),
        ),
    ]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_rejects_real_anthropic_auth_token() {
    let secret = "sk-real-openrouter-token";
    let ctx = context_with_env(HashMap::from([(
        "ANTHROPIC_AUTH_TOKEN".into(),
        secret.into(),
    )]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("ANTHROPIC_AUTH_TOKEN"));
    assert!(!error.contains(secret));
}

#[test]
fn model_provider_env_placeholder_validation_accepts_claude_oauth_placeholder() {
    let ctx = context_with_env(HashMap::from([(
        "CLAUDE_CODE_OAUTH_TOKEN".into(),
        model_provider_placeholders::CLAUDE_CODE_OAUTH_TOKEN.into(),
    )]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_accepts_openai_api_key_placeholder() {
    let ctx = context_with_env(HashMap::from([(
        "OPENAI_API_KEY".into(),
        model_provider_placeholders::OPENAI_API_KEY.into(),
    )]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_rejects_real_openai_api_key() {
    let secret = "sk-proj-real-openai-secret";
    let ctx = context_with_env(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains(secret));
}

#[test]
fn model_provider_env_placeholder_validation_accepts_codex_oauth_placeholders() {
    let ctx = context_with_env(HashMap::from([
        (
            "CHATGPT_ACCESS_TOKEN".into(),
            model_provider_placeholders::CHATGPT_ACCESS_TOKEN.into(),
        ),
        (
            "CHATGPT_ACCOUNT_ID".into(),
            model_provider_placeholders::CHATGPT_ACCOUNT_ID.into(),
        ),
        (
            "CHATGPT_REFRESH_TOKEN".into(),
            model_provider_placeholders::CHATGPT_REFRESH_TOKEN.into(),
        ),
    ]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_rejects_real_chatgpt_access_token() {
    let secret = "ey-real-chatgpt-access-token";
    let ctx = context_with_env(HashMap::from([(
        "CHATGPT_ACCESS_TOKEN".into(),
        secret.into(),
    )]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("CHATGPT_ACCESS_TOKEN"));
    assert!(!error.contains(secret));
}

#[test]
fn model_provider_env_placeholder_validation_rejects_real_chatgpt_refresh_token() {
    let secret = "rt_real_chatgpt_refresh_token";
    let ctx = context_with_env(HashMap::from([(
        "CHATGPT_REFRESH_TOKEN".into(),
        secret.into(),
    )]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("CHATGPT_REFRESH_TOKEN"));
    assert!(!error.contains(secret));
}

#[test]
fn model_provider_env_placeholder_validation_rejects_chatgpt_id_token() {
    let secret = "hdr.real-chatgpt-id-token.sig";
    let ctx = context_with_env(HashMap::from([("CHATGPT_ID_TOKEN".into(), secret.into())]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("CHATGPT_ID_TOKEN"));
    assert!(!error.contains(secret));
}

#[test]
fn build_env_json_required_keys() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "https://api.example.com");

    assert_eq!(env.get("VM0_API_URL").unwrap(), "https://api.example.com");
    assert_eq!(env.get("VM0_RUN_ID").unwrap(), &RunId::nil().to_string());
    assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
    assert_eq!(
        env.get(guest_runtime_paths::GUEST_RUNTIME_DIR_ENV).unwrap(),
        &guest_runtime_dir(ctx.run_id).unwrap()
    );
    assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
    assert!(!env.contains_key("VM0_WORKING_DIR"));
    // Guest-agent needs these to post /complete with full metadata when
    // checkpoint lands before VM teardown.
    assert!(
        env.get("VM0_SANDBOX_ID")
            .unwrap()
            .parse::<uuid::Uuid>()
            .is_ok()
    );
    assert_eq!(env.get("VM0_SANDBOX_REUSE_RESULT").unwrap(), "reused");
}

#[test]
fn build_env_json_sandbox_reuse_result_wire_format() {
    let ctx = minimal_context();
    let sid = SandboxId::new_v4().to_string();
    for (variant, expected) in [
        (SandboxReuseResult::Reused, "reused"),
        (SandboxReuseResult::NoSessionId, "noSessionId"),
        (SandboxReuseResult::PoolMiss, "poolMiss"),
        (SandboxReuseResult::ProfileMismatch, "profileMismatch"),
        (
            SandboxReuseResult::DeviceLimitMismatch,
            "deviceLimitMismatch",
        ),
        (SandboxReuseResult::UnparkFailed, "unparkFailed"),
    ] {
        let env = build_env_json_with_host_env(
            &ctx,
            "http://localhost",
            &sid,
            variant,
            &HostEnv::default(),
        )
        .expect("test env should build");
        assert_eq!(env.get("VM0_SANDBOX_REUSE_RESULT").unwrap(), expected);
    }
}

#[test]
fn build_env_json_empty_cli_agent_type_defaults_to_claude_code() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "claude-code");
}

#[test]
fn build_env_json_custom_cli_agent_type() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
}

#[test]
fn build_env_json_claude_code_gets_only_claude_framework_env() {
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
    ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
    ctx.settings = Some(r#"{"hooks":{}}"#.into());

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );

    assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
    assert_eq!(
        env.get("VM0_DISALLOWED_TOOLS").unwrap(),
        "CronCreate,CronDelete"
    );
    assert_eq!(env.get("VM0_TOOLS").unwrap(), "Bash,Edit");
    assert_eq!(env.get("VM0_SETTINGS").unwrap(), r#"{"hooks":{}}"#);
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn build_env_json_codex_gets_only_codex_framework_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
    ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
    ctx.settings = Some(r#"{"hooks":{}}"#.into());

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );

    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert_eq!(env.get("USE_MOCK_CODEX").unwrap(), "1");
    assert!(!env.contains_key("USE_MOCK_CLAUDE"));
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    assert!(!env.contains_key("VM0_TOOLS"));
    assert!(!env.contains_key("VM0_SETTINGS"));
}

#[test]
fn build_env_json_unknown_framework_preserves_claude_compatible_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    ctx.disallowed_tools = Some(vec!["CronCreate".into()]);
    ctx.tools = Some(vec!["Bash".into()]);
    ctx.settings = Some(r#"{"hooks":{}}"#.into());

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );

    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
    assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
    assert_eq!(env.get("VM0_DISALLOWED_TOOLS").unwrap(), "CronCreate");
    assert_eq!(env.get("VM0_TOOLS").unwrap(), "Bash");
    assert_eq!(env.get("VM0_SETTINGS").unwrap(), r#"{"hooks":{}}"#);
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn build_env_json_scrubs_user_provided_runner_owned_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_ENV".into(), "kept".into()),
        ("VM0_PROMPT".into(), "user prompt".into()),
        ("VM0_API_TOKEN".into(), "stolen".into()),
        ("VM0_WORKING_DIR".into(), "/legacy".into()),
        (
            guest_runtime_paths::GUEST_RUNTIME_DIR_ENV.into(),
            "/user/controlled/runtime".into(),
        ),
        ("VM0_FEATURE_FLAGS".into(), r#"{"bad":true}"#.into()),
        ("VM0_FUTURE_RUNNER_KEY".into(), "future".into()),
        (RUNNER_CONCURRENCY_FACTOR_ENV.into(), "99".into()),
        (RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV.into(), "999".into()),
        (RUNNER_DISK_IOPS_ENV.into(), "999".into()),
        (RUNNER_NET_RX_MIB_PER_SEC_ENV.into(), "999".into()),
        (RUNNER_NET_TX_MIB_PER_SEC_ENV.into(), "999".into()),
        ("CLI_AGENT_TYPE".into(), "claude-code".into()),
        ("USE_MOCK_CLAUDE".into(), "true".into()),
        ("USE_MOCK_CODEX".into(), "1".into()),
        ("VERCEL_PROTECTION_BYPASS".into(), "user-bypass".into()),
        ("VM0_DISALLOWED_TOOLS".into(), "CronCreate".into()),
        ("VM0_TOOLS".into(), "Bash".into()),
        ("VM0_SETTINGS".into(), r#"{"hooks":{}}"#.into()),
        ("VM0_MOCK_CLAUDE_PATH".into(), "/tmp/mock-claude".into()),
        ("VM0_MOCK_CODEX_PATH".into(), "/tmp/mock-codex".into()),
        (USER_ENV_FILE_ENV_KEY.into(), "/tmp/user-env".into()),
    ]));

    let bootstrap_env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);

    assert!(!bootstrap_env.contains_key("CUSTOM_ENV"));
    assert_eq!(bootstrap_env.get("VM0_PROMPT").unwrap(), "test prompt");
    assert_eq!(bootstrap_env.get("VM0_API_TOKEN").unwrap(), "tok");
    assert_eq!(
        bootstrap_env
            .get(guest_runtime_paths::GUEST_RUNTIME_DIR_ENV)
            .unwrap(),
        &guest_runtime_dir(ctx.run_id).unwrap()
    );
    assert_eq!(bootstrap_env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    for key in [
        "VM0_PROMPT",
        "VM0_API_TOKEN",
        "VM0_WORKING_DIR",
        guest_runtime_paths::GUEST_RUNTIME_DIR_ENV,
        "VM0_FEATURE_FLAGS",
        "VM0_FUTURE_RUNNER_KEY",
        RUNNER_CONCURRENCY_FACTOR_ENV,
        RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
        RUNNER_DISK_IOPS_ENV,
        RUNNER_NET_RX_MIB_PER_SEC_ENV,
        RUNNER_NET_TX_MIB_PER_SEC_ENV,
        "CLI_AGENT_TYPE",
        "USE_MOCK_CLAUDE",
        "USE_MOCK_CODEX",
        "VERCEL_PROTECTION_BYPASS",
        "VM0_DISALLOWED_TOOLS",
        "VM0_TOOLS",
        "VM0_SETTINGS",
        "VM0_MOCK_CLAUDE_PATH",
        "VM0_MOCK_CODEX_PATH",
        USER_ENV_FILE_ENV_KEY,
    ] {
        assert!(!user_env.contains_key(key), "{key} should be scrubbed");
    }
}

#[test]
fn build_env_json_preserves_guest_agent_tuning_env() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("VM0_STUCK_TOOL_TIMEOUT_SECS".into(), "3".into()),
        ("VM0_POST_RESULT_SIGTERM_GRACE_SECS".into(), "1".into()),
        ("VM0_POST_RESULT_SIGKILL_GRACE_SECS".into(), "2".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");

    assert_eq!(env.get("VM0_STUCK_TOOL_TIMEOUT_SECS").unwrap(), "3");
    assert_eq!(env.get("VM0_POST_RESULT_SIGTERM_GRACE_SECS").unwrap(), "1");
    assert_eq!(env.get("VM0_POST_RESULT_SIGKILL_GRACE_SECS").unwrap(), "2");
}

#[test]
fn build_env_json_codex_keeps_shared_runner_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.append_system_prompt = Some("Use terse answers.".into());
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-123".into(),
        session_history: "{}".into(),
    });

    let env = build_env_for_test(&ctx, "http://localhost");

    assert_eq!(
        env.get("VM0_APPEND_SYSTEM_PROMPT").unwrap(),
        "Use terse answers."
    );
    assert_eq!(env.get("VM0_RESUME_SESSION_ID").unwrap(), "sess-123");
    assert!(!env.contains_key("VM0_WORKING_DIR"));
}

#[test]
fn build_env_json_with_single_artifact() {
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "data",
            "/data",
            "v1",
            "https://example.com/data.tar.gz",
        )],
        artifacts: vec![api_artifact(
            "my-vol",
            "/artifacts",
            "sid-1",
            "v1",
            "https://example.com/artifacts.tar.gz",
        )],
    });

    let env = build_env_for_test(&ctx, "http://localhost");
    let raw = env.get("VM0_ARTIFACTS").expect("VM0_ARTIFACTS must be set");
    let parsed: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0]["name"], "my-vol");
    assert_eq!(parsed[0]["mountPath"], "/artifacts");
    assert_eq!(parsed[0]["storageId"], "sid-1");
    assert_eq!(parsed[0]["versionId"], "v1");
    assert!(parsed[0].get("missingRootPolicy").is_none());
    // Legacy singleton env vars must no longer be emitted.
    assert!(!env.contains_key("VM0_ARTIFACT_DRIVER"));
    assert!(!env.contains_key("VM0_ARTIFACT_MOUNT_PATH"));
    assert!(!env.contains_key("VM0_ARTIFACT_VOLUME_NAME"));
    assert!(!env.contains_key("VM0_ARTIFACT_VERSION_ID"));
}

#[test]
fn build_env_json_with_artifact_missing_root_policy() {
    let mut ctx = minimal_context();
    let mut artifact = api_artifact(
        "memory",
        "/home/user/.claude/projects/-home-user-workspace/memory",
        "sid-memory",
        "v1",
        "https://example.com/memory.tar.gz",
    );
    artifact.missing_root_policy = Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion);
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![artifact],
    });

    let env = build_env_for_test(&ctx, "http://localhost");
    let raw = env.get("VM0_ARTIFACTS").expect("VM0_ARTIFACTS must be set");
    let parsed: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();

    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0]["name"], "memory");
    assert_eq!(parsed[0]["missingRootPolicy"], "preserveParentVersion");
}

#[test]
fn build_env_json_with_two_artifacts() {
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![
            api_artifact(
                "art-a",
                "/workspace",
                "sid-a",
                "v1",
                "https://example.com/art-a.tar.gz",
            ),
            api_artifact(
                "art-b",
                "/data",
                "sid-b",
                "v2",
                "https://example.com/art-b.tar.gz",
            ),
        ],
    });

    let env = build_env_for_test(&ctx, "http://localhost");
    let raw = env.get("VM0_ARTIFACTS").unwrap();
    let parsed: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0]["name"], "art-a");
    assert_eq!(parsed[0]["mountPath"], "/workspace");
    assert_eq!(parsed[0]["storageId"], "sid-a");
    assert_eq!(parsed[1]["name"], "art-b");
    assert_eq!(parsed[1]["mountPath"], "/data");
    assert_eq!(parsed[1]["storageId"], "sid-b");
}

#[test]
fn build_env_json_empty_artifacts_emits_no_env_var() {
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![],
    });

    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_ARTIFACTS"));
}

#[test]
fn build_env_json_with_secrets() {
    let mut ctx = minimal_context();
    ctx.secret_values = Some(vec!["secret1".into(), "secret2".into()]);

    let env = build_env_for_test(&ctx, "http://localhost");
    let val = env.get("VM0_SECRET_VALUES").unwrap();

    use base64::Engine as _;
    let parts: Vec<&str> = val.split(',').collect();
    // sandbox_token ("tok") + secret1 + secret2
    assert_eq!(parts.len(), 3);
    let decoded0 = base64::engine::general_purpose::STANDARD
        .decode(parts[0])
        .unwrap();
    assert_eq!(decoded0, b"tok");
    let decoded1 = base64::engine::general_purpose::STANDARD
        .decode(parts[1])
        .unwrap();
    assert_eq!(decoded1, b"secret1");
}

#[test]
fn build_env_json_with_resume_session() {
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-123".into(),
        session_history: "{}".into(),
    });

    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("VM0_RESUME_SESSION_ID").unwrap(), "sess-123");
}

#[test]
fn build_env_json_user_vars_cannot_override_system() {
    let mut ctx = minimal_context();
    // vars are expanded into environment at compose time, so test via environment
    ctx.environment = Some(HashMap::from([
        ("VM0_PROMPT".into(), "overridden".into()),
        ("CUSTOM".into(), "value".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    // System variables take precedence over user environment
    assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
    assert!(!env.contains_key("CUSTOM"));
    assert_eq!(user_env.get("CUSTOM").unwrap(), "value");
    assert!(!user_env.contains_key("VM0_PROMPT"));
}

#[test]
fn build_env_json_with_environment() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("MY_VAR".into(), "123".into()),
        ("OTHER".into(), "abc".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    assert!(!env.contains_key("MY_VAR"));
    assert!(!env.contains_key("OTHER"));
    assert_eq!(user_env.get("MY_VAR").unwrap(), "123");
    assert_eq!(user_env.get("OTHER").unwrap(), "abc");
}

#[test]
fn build_env_json_with_api_start_time() {
    let mut ctx = minimal_context();
    ctx.api_start_time = Some(1_700_000_000_500);

    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("VM0_API_START_TIME").unwrap(), "1700000000500");
}

#[test]
fn build_env_json_empty_secrets_still_has_sandbox_token() {
    let mut ctx = minimal_context();
    ctx.secret_values = Some(vec![]);

    let env = build_env_for_test(&ctx, "http://localhost");
    // VM0_SECRET_VALUES always present because sandbox_token is included
    let val = env.get("VM0_SECRET_VALUES").unwrap();
    use base64::Engine as _;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(val)
        .unwrap();
    assert_eq!(decoded, b"tok");
}

#[test]
fn build_env_json_with_append_system_prompt() {
    let mut ctx = minimal_context();
    ctx.append_system_prompt = Some("Your name is Aria.".into());
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(
        env.get("VM0_APPEND_SYSTEM_PROMPT").unwrap(),
        "Your name is Aria."
    );
}

#[test]
fn build_env_json_without_append_system_prompt() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
}

#[test]
fn build_env_json_empty_append_system_prompt_omitted() {
    let mut ctx = minimal_context();
    ctx.append_system_prompt = Some("".into());
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
}

#[test]
fn build_env_json_with_user_timezone() {
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    assert!(!env.contains_key("TZ"));
    assert_eq!(user_env.get("TZ").unwrap(), "Asia/Shanghai");
}

#[test]
fn build_env_json_user_timezone_not_override_environment() {
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    ctx.environment = Some(HashMap::from([("TZ".into(), "America/New_York".into())]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    // User environment TZ takes precedence
    assert!(!env.contains_key("TZ"));
    assert_eq!(user_env.get("TZ").unwrap(), "America/New_York");
}

#[test]
fn build_env_json_environment_cannot_override_system() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("VM0_PROMPT".into(), "hacked".into()),
        ("VM0_API_TOKEN".into(), "stolen".into()),
        ("CUSTOM_ENV".into(), "kept".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    // System variables take precedence over user environment
    assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
    assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
    assert!(!env.contains_key("CUSTOM_ENV"));
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    assert!(!user_env.contains_key("VM0_PROMPT"));
    assert!(!user_env.contains_key("VM0_API_TOKEN"));
}

#[test]
fn build_env_json_vars_not_injected_directly() {
    let mut ctx = minimal_context();
    // vars should NOT be injected as env vars — they are expanded into
    // environment at compose time via ${{ vars.XXX }} templates.
    ctx.vars = Some(HashMap::from([("ONLY_VARS".into(), "vars-value".into())]));
    ctx.environment = Some(HashMap::from([("ONLY_ENV".into(), "env-value".into())]));

    let env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);
    assert!(!env.contains_key("ONLY_VARS"));
    assert!(!env.contains_key("ONLY_ENV"));
    assert_eq!(user_env.get("ONLY_ENV").unwrap(), "env-value");
}

#[test]
fn build_env_json_with_mock_claude() {
    let ctx = minimal_context();
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            ..HostEnv::default()
        },
    );
    assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn build_env_json_mock_claude_suppressed_by_debug_flag() {
    let mut ctx = minimal_context();
    ctx.debug_no_mock_claude = Some(true);
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_claude: Some("true".into()),
            ..HostEnv::default()
        },
    );
    assert!(!env.contains_key("USE_MOCK_CLAUDE"));
}

#[test]
fn build_env_json_with_mock_codex() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );
    assert_eq!(env.get("USE_MOCK_CODEX").unwrap(), "1");
    assert!(!env.contains_key("USE_MOCK_CLAUDE"));
}

#[test]
fn build_env_json_mock_codex_suppressed_by_debug_flag() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.debug_no_mock_codex = Some(true);
    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            use_mock_codex: Some("1".into()),
            ..HostEnv::default()
        },
    );
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn build_env_json_does_not_inject_vm0_token() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_TOKEN"));
}

#[test]
fn execution_context_deserializes_with_firewalls() {
    let json = serde_json::json!({
        "runId": "00000000-0000-0000-0000-000000000001",
        "prompt": "test",
        "sandboxToken": "tok",
        "cliAgentType": "claude-code",
        "billableFirewalls": [],
        "firewalls": [{
            "name": "github",
            "apis": [{
                "base": "https://api.github.com",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"
                    }
                },
                "permissions": [
                    {
                        "name": "issues-read",
                        "rules": [
                            "GET /repos/{owner}/{repo}/issues",
                            "GET /repos/{owner}/{repo}/issues/{issue_number}"
                        ]
                    }
                ]
            }]
        }]
    });
    let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
    let svcs = ctx.firewalls.unwrap();
    assert_eq!(svcs.len(), 1);
    assert_eq!(svcs[0].name, "github");
    assert_eq!(svcs[0].apis.len(), 1);
    assert_eq!(svcs[0].apis[0].base, "https://api.github.com");
    let perms = svcs[0].apis[0].permissions.as_ref().unwrap();
    assert_eq!(perms.len(), 1);
    assert_eq!(perms[0].name, "issues-read");
    assert_eq!(perms[0].rules.len(), 2);
    assert_eq!(perms[0].rules[0], "GET /repos/{owner}/{repo}/issues");
}

#[test]
fn execution_context_deserializes_without_firewalls() {
    let json = serde_json::json!({
        "runId": "00000000-0000-0000-0000-000000000001",
        "prompt": "test",
        "sandboxToken": "tok",
        "cliAgentType": "claude-code",
        "billableFirewalls": []
    });
    let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
    assert!(ctx.firewalls.is_none());
}

#[test]
fn build_env_json_with_disallowed_tools() {
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(
        env.get("VM0_DISALLOWED_TOOLS").unwrap(),
        "CronCreate,CronDelete"
    );
}

#[test]
fn build_env_json_empty_disallowed_tools_omitted() {
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec![]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
}

#[test]
fn build_env_json_no_disallowed_tools() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
}

#[test]
fn build_env_json_with_tools() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("VM0_TOOLS").unwrap(), "Bash,Edit");
}

#[test]
fn build_env_json_empty_tools_omitted() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec![]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_TOOLS"));
}

#[test]
fn build_env_json_no_tools() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_TOOLS"));
}

fn assert_tool_env_error(
    result: RunnerResult<HashMap<String, String>>,
    env_name: &str,
    expected: &str,
) {
    let message = match result {
        Err(RunnerError::Internal(message)) => message,
        other => panic!("expected internal error, got {other:?}"),
    };
    assert!(message.contains(env_name), "message: {message}");
    assert!(message.contains(expected), "message: {message}");
}

#[test]
fn build_env_json_rejects_invalid_disallowed_tools_entries() {
    for (tool, expected) in [
        ("", "must not be empty"),
        ("   ", "must not be empty"),
        ("CronCreate,CronDelete", "must not contain commas"),
        ("--help", "must not start with a hyphen"),
        (" -v", "must not start with a hyphen"),
    ] {
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec![tool.into()]);
        let result = build_env_for_test_result(&ctx, "http://localhost");
        assert_tool_env_error(result, "VM0_DISALLOWED_TOOLS", expected);
    }
}

#[test]
fn build_env_json_rejects_invalid_tools_entries() {
    for (tool, expected) in [
        ("", "must not be empty"),
        ("   ", "must not be empty"),
        ("Bash,Read", "must not contain commas"),
        ("--help", "must not start with a hyphen"),
        (" -x", "must not start with a hyphen"),
    ] {
        let mut ctx = minimal_context();
        ctx.tools = Some(vec![tool.into()]);
        let result = build_env_for_test_result(&ctx, "http://localhost");
        assert_tool_env_error(result, "VM0_TOOLS", expected);
    }
}

#[test]
fn build_env_json_codex_ignores_claude_tool_lists() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.disallowed_tools = Some(vec!["".into()]);
    ctx.tools = Some(vec!["Bash,Read".into()]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    assert!(!env.contains_key("VM0_TOOLS"));
}

#[test]
fn build_env_json_with_settings() {
    let mut ctx = minimal_context();
    ctx.settings = Some(r#"{"hooks":{}}"#.into());
    let env = build_env_for_test(&ctx, "http://localhost");
    assert_eq!(env.get("VM0_SETTINGS").unwrap(), r#"{"hooks":{}}"#);
}

#[test]
fn build_env_json_empty_settings_omitted() {
    let mut ctx = minimal_context();
    ctx.settings = Some("".into());
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_SETTINGS"));
}

#[test]
fn build_env_json_no_settings() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_SETTINGS"));
}

#[test]
fn build_env_json_with_feature_flags() {
    let mut ctx = minimal_context();
    let mut flags = HashMap::new();
    flags.insert("computerUse".into(), true);
    flags.insert("audioOutput".into(), false);
    ctx.feature_flags = Some(flags);
    let env = build_env_for_test(&ctx, "http://localhost");
    let raw = env
        .get("VM0_FEATURE_FLAGS")
        .expect("VM0_FEATURE_FLAGS should be set");
    let parsed: HashMap<String, bool> = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.get("computerUse"), Some(&true));
    assert_eq!(parsed.get("audioOutput"), Some(&false));
}

#[test]
fn build_env_json_empty_feature_flags_omitted() {
    let mut ctx = minimal_context();
    ctx.feature_flags = Some(HashMap::new());
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
}

#[test]
fn build_env_json_no_feature_flags() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
}

#[tokio::test]
async fn build_env_json_with_memory_as_artifact() {
    // Post-#10602: memory rides in VM0_ARTIFACTS, not VM0_MEMORY_*.
    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![api_artifact(
            "memory",
            "/memory",
            "",
            "v2",
            "https://example.com/memory.tar.gz",
        )],
    });
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_MEMORY_DRIVER"));
    assert!(!env.contains_key("VM0_MEMORY_MOUNT_PATH"));
    assert!(!env.contains_key("VM0_MEMORY_NAME"));
    assert!(!env.contains_key("VM0_MEMORY_VERSION_ID"));
    let artifacts = env.get("VM0_ARTIFACTS").unwrap();
    assert!(artifacts.contains("\"memory\""));
    assert!(artifacts.contains("\"/memory\""));
    assert!(artifacts.contains("\"v2\""));
}
