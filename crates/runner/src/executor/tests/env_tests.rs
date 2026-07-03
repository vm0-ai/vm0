use std::collections::{HashMap, HashSet};

use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use api_contracts::generated::types::runners::storage::{
    ArtifactEntryMissingRootPolicy, StorageManifest,
};
use sandbox::SandboxId;
use sandbox_mock::MockSandbox;

use super::super::cli_framework::{
    EffectiveCliFramework, effective_cli_framework, normalized_cli_agent_type,
};
use super::super::env::{
    HostEnv, build_env_json_with_host_env, build_run_payload_for_run, build_user_env_json,
    guest_run_payload_file_path, guest_user_env_file_path, is_runner_owned_env_key,
    validate_execution_context_before_sandbox, validate_model_provider_env_placeholders,
    write_run_payload_file, write_user_env_file,
};
use super::super::{USER_ENV_FILE_ENV_KEY, guest_runtime_dir};
use super::support::{
    api_artifact, api_storage, build_env_for_test, build_env_for_test_result,
    build_env_for_test_with_active_input, build_env_for_test_with_host_env, context_with_env,
    minimal_context, sandbox_write_file_error,
};
use crate::error::{RunnerError, RunnerResult};
use crate::host_env::{
    RUNNER_CONCURRENCY_FACTOR_ENV, RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV, RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV, RUNNER_NET_TX_MIB_PER_SEC_ENV,
};
use crate::ids::RunId;
use crate::types::{ExecutionContext, ResumeSession, SandboxReuseResult};

fn validate_context_for_test(ctx: &ExecutionContext) -> Result<(), String> {
    let sandbox_id = SandboxId::new_v4().to_string();
    validate_execution_context_before_sandbox(
        ctx,
        "http://localhost",
        &sandbox_id,
        SandboxReuseResult::Reused,
    )
}

#[test]
fn effective_cli_framework_matches_guest_agent_fallback_semantics() {
    assert_eq!(normalized_cli_agent_type(""), "claude-code");
    assert_eq!(normalized_cli_agent_type("claude-code"), "claude-code");
    assert_eq!(normalized_cli_agent_type("custom-agent"), "custom-agent");

    assert_eq!(
        effective_cli_framework(""),
        EffectiveCliFramework::ClaudeCode
    );
    assert_eq!(
        effective_cli_framework("claude-code"),
        EffectiveCliFramework::ClaudeCode
    );
    assert_eq!(
        effective_cli_framework("custom-agent"),
        EffectiveCliFramework::ClaudeCode
    );
    assert_eq!(
        effective_cli_framework("codex"),
        EffectiveCliFramework::Codex
    );
}

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
fn model_provider_env_placeholder_validation_accepts_local_secret_env_key() {
    let secret = "sk-ant-api03-real-secret-value";
    let mut ctx = context_with_env(HashMap::from([("ANTHROPIC_API_KEY".into(), secret.into())]));
    ctx.local_secret_env_keys = Some(HashSet::from(["ANTHROPIC_API_KEY".into()]));

    assert!(validate_model_provider_env_placeholders(&ctx).is_ok());
}

#[test]
fn model_provider_env_placeholder_validation_rejects_unmarked_protected_key() {
    let anthropic_secret = "sk-ant-api03-real-secret-value";
    let openai_secret = "sk-proj-real-openai-secret";
    let mut ctx = context_with_env(HashMap::from([
        ("ANTHROPIC_API_KEY".into(), anthropic_secret.into()),
        ("OPENAI_API_KEY".into(), openai_secret.into()),
    ]));
    ctx.local_secret_env_keys = Some(HashSet::from(["ANTHROPIC_API_KEY".into()]));

    let error = validate_model_provider_env_placeholders(&ctx).unwrap_err();

    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains("ANTHROPIC_API_KEY"));
    assert!(!error.contains(anthropic_secret));
    assert!(!error.contains(openai_secret));
}

#[test]
fn execution_context_validation_accepts_minimal_context() {
    let ctx = minimal_context();

    assert!(validate_context_for_test(&ctx).is_ok());
}

#[test]
fn execution_context_validation_rejects_invalid_user_env_key_before_sandbox() {
    let secret = "secret-value";
    let ctx = context_with_env(HashMap::from([("BAD-KEY".into(), secret.into())]));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("invalid env key"));
    assert!(error.contains("BAD-KEY"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_user_env_nul_value_before_sandbox() {
    let secret = "secret\0value";
    let ctx = context_with_env(HashMap::from([("CUSTOM_ENV".into(), secret.into())]));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("NUL byte"));
    assert!(error.contains("CUSTOM_ENV"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_user_timezone_nul_before_sandbox() {
    let secret = "Asia\0Shanghai";
    let mut ctx = minimal_context();
    ctx.user_timezone = Some(secret.into());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("NUL byte"));
    assert!(error.contains("TZ"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_tuning_env_nul_before_sandbox() {
    let secret = "3\0";
    let ctx = context_with_env(HashMap::from([(
        "VM0_STUCK_TOOL_TIMEOUT_SECS".into(),
        secret.into(),
    )]));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("bootstrap environment"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("VM0_STUCK_TOOL_TIMEOUT_SECS"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_bootstrap_env_nul_before_sandbox() {
    let secret = "before\0after";
    let mut ctx = minimal_context();
    ctx.prompt = secret.into();

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("VM0_PROMPT"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_invalid_codex_resume_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.resume_session = Some(ResumeSession::inline("not-a-thread-id".into(), "{}".into()));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("invalid codex session_id"));
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
        env.get(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV)
            .unwrap(),
        &guest_runtime_dir(ctx.run_id).unwrap()
    );
    assert!(!env.contains_key("VM0_PROMPT"));
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
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    assert!(!env.contains_key("VM0_TOOLS"));
    assert!(!env.contains_key("VM0_SETTINGS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.disallowed_tools, "CronCreate,CronDelete");
    assert_eq!(payload.tools, "Bash,Edit");
    assert_eq!(payload.settings, r#"{"hooks":{}}"#);
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
    assert!(!env.contains_key(guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV));
    assert!(!env.contains_key("USE_MOCK_CLAUDE"));
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    assert!(!env.contains_key("VM0_TOOLS"));
    assert!(!env.contains_key("VM0_SETTINGS"));
}

#[test]
fn build_env_json_codex_without_active_input_does_not_enable_app_server_backend() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();

    let env = build_env_for_test(&ctx, "http://localhost");

    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert!(!env.contains_key(guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV));
}

#[test]
fn build_env_json_codex_with_active_input_enables_app_server_backend() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();

    let env = build_env_for_test_with_active_input(&ctx, "http://localhost");

    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert_eq!(
        env.get(guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV)
            .unwrap(),
        "1"
    );
}

#[test]
fn build_env_json_claude_with_active_input_does_not_enable_codex_app_server_backend() {
    let ctx = minimal_context();

    let env = build_env_for_test_with_active_input(&ctx, "http://localhost");

    assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "claude-code");
    assert!(!env.contains_key(guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV));
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
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    assert!(!env.contains_key("VM0_TOOLS"));
    assert!(!env.contains_key("VM0_SETTINGS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.disallowed_tools, "CronCreate");
    assert_eq!(payload.tools, "Bash");
    assert_eq!(payload.settings, r#"{"hooks":{}}"#);
    assert!(!env.contains_key("USE_MOCK_CODEX"));
}

#[test]
fn build_env_json_scrubs_user_provided_runner_owned_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_ENV".into(), "kept".into()),
        (
            guest_contracts::env::PROMPT_ENV.into(),
            "user prompt".into(),
        ),
        (guest_contracts::env::API_TOKEN_ENV.into(), "stolen".into()),
        (
            guest_contracts::env::WORKING_DIR_ENV.into(),
            "/legacy".into(),
        ),
        (
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV.into(),
            "/user/controlled/runtime".into(),
        ),
        (
            guest_contracts::env::FEATURE_FLAGS_ENV.into(),
            r#"{"bad":true}"#.into(),
        ),
        (
            guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV.into(),
            "1".into(),
        ),
        ("VM0_FUTURE_RUNNER_KEY".into(), "future".into()),
        (RUNNER_CONCURRENCY_FACTOR_ENV.into(), "99".into()),
        (RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV.into(), "999".into()),
        (RUNNER_DISK_IOPS_ENV.into(), "999".into()),
        (RUNNER_NET_RX_MIB_PER_SEC_ENV.into(), "999".into()),
        (RUNNER_NET_TX_MIB_PER_SEC_ENV.into(), "999".into()),
        (
            guest_contracts::env::CLI_AGENT_TYPE_ENV.into(),
            "claude-code".into(),
        ),
        (
            guest_contracts::env::USE_MOCK_CLAUDE_ENV.into(),
            "true".into(),
        ),
        (guest_contracts::env::USE_MOCK_CODEX_ENV.into(), "1".into()),
        (
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
            "user-bypass".into(),
        ),
        (
            guest_contracts::env::DISALLOWED_TOOLS_ENV.into(),
            "CronCreate".into(),
        ),
        (guest_contracts::env::TOOLS_ENV.into(), "Bash".into()),
        (
            guest_contracts::env::SETTINGS_ENV.into(),
            r#"{"hooks":{}}"#.into(),
        ),
        (
            guest_contracts::env::MOCK_CLAUDE_PATH_ENV.into(),
            "/tmp/mock-claude".into(),
        ),
        (
            guest_contracts::env::MOCK_CODEX_PATH_ENV.into(),
            "/tmp/mock-codex".into(),
        ),
        (USER_ENV_FILE_ENV_KEY.into(), "/tmp/user-env".into()),
        (
            guest_contracts::env::RUN_PAYLOAD_FILE_ENV.into(),
            "/tmp/run-payload".into(),
        ),
    ]));

    let bootstrap_env = build_env_for_test(&ctx, "http://localhost");
    let user_env = build_user_env_json(&ctx);

    assert!(!bootstrap_env.contains_key("CUSTOM_ENV"));
    assert!(!bootstrap_env.contains_key("VM0_PROMPT"));
    assert_eq!(
        build_run_payload_for_run(&ctx).unwrap().prompt,
        "test prompt"
    );
    assert_eq!(bootstrap_env.get("VM0_API_TOKEN").unwrap(), "tok");
    assert_eq!(
        bootstrap_env
            .get(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV)
            .unwrap(),
        &guest_runtime_dir(ctx.run_id).unwrap()
    );
    assert_eq!(bootstrap_env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    for key in [
        guest_contracts::env::PROMPT_ENV,
        guest_contracts::env::API_TOKEN_ENV,
        guest_contracts::env::WORKING_DIR_ENV,
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        guest_contracts::env::FEATURE_FLAGS_ENV,
        guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV,
        "VM0_FUTURE_RUNNER_KEY",
        RUNNER_CONCURRENCY_FACTOR_ENV,
        RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
        RUNNER_DISK_IOPS_ENV,
        RUNNER_NET_RX_MIB_PER_SEC_ENV,
        RUNNER_NET_TX_MIB_PER_SEC_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
        guest_contracts::env::DISALLOWED_TOOLS_ENV,
        guest_contracts::env::TOOLS_ENV,
        guest_contracts::env::SETTINGS_ENV,
        guest_contracts::env::MOCK_CLAUDE_PATH_ENV,
        guest_contracts::env::MOCK_CODEX_PATH_ENV,
        USER_ENV_FILE_ENV_KEY,
        guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
    ] {
        assert!(!user_env.contains_key(key), "{key} should be scrubbed");
    }
}

#[test]
fn emitted_bootstrap_env_keys_classify_as_runner_owned() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        (
            guest_contracts::env::STUCK_TOOL_TIMEOUT_SECS_ENV.into(),
            "3".into(),
        ),
        (
            guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV.into(),
            "1".into(),
        ),
        (
            guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV.into(),
            "2".into(),
        ),
    ]));
    ctx.append_system_prompt = Some("Use terse answers.".into());
    ctx.resume_session = Some(ResumeSession::inline("sess-123".into(), "{}".into()));
    ctx.disallowed_tools = Some(vec!["CronCreate".into()]);
    ctx.tools = Some(vec!["Bash".into()]);
    ctx.settings = Some(r#"{"hooks":{}}"#.into());
    ctx.feature_flags = Some(HashMap::from([("runnerEnvKeyTest".into(), true)]));
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![],
        artifacts: vec![api_artifact(
            "artifact",
            "/workspace",
            "storage-id",
            "version-id",
            "https://example.com/artifact.tar.gz",
        )],
    });

    let env = build_env_for_test_with_host_env(
        &ctx,
        "http://localhost",
        &HostEnv {
            vercel_automation_bypass_secret: Some("bypass".into()),
            use_mock_claude: Some("true".into()),
            ..HostEnv::default()
        },
    );

    for key in env.keys() {
        assert!(
            is_runner_owned_env_key(key),
            "emitted bootstrap key {key} should be runner-owned"
        );
    }
    for key in [
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
    ] {
        assert!(
            is_runner_owned_env_key(key),
            "non-VM0 runner key {key} should be runner-owned"
        );
    }
}

#[test]
fn build_env_json_preserves_guest_agent_tuning_env() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("VM0_STUCK_TOOL_TIMEOUT_SECS".into(), "3".into()),
        ("VM0_POST_RESULT_SIGTERM_GRACE_SECS".into(), "1".into()),
        ("VM0_POST_RESULT_TOTAL_CAP_SECS".into(), "4".into()),
        ("VM0_POST_RESULT_SIGKILL_GRACE_SECS".into(), "2".into()),
    ]));

    let env = build_env_for_test(&ctx, "http://localhost");

    assert_eq!(env.get("VM0_STUCK_TOOL_TIMEOUT_SECS").unwrap(), "3");
    assert_eq!(env.get("VM0_POST_RESULT_SIGTERM_GRACE_SECS").unwrap(), "1");
    assert_eq!(env.get("VM0_POST_RESULT_TOTAL_CAP_SECS").unwrap(), "4");
    assert_eq!(env.get("VM0_POST_RESULT_SIGKILL_GRACE_SECS").unwrap(), "2");
}

#[test]
fn build_env_json_codex_keeps_shared_runner_env() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.append_system_prompt = Some("Use terse answers.".into());
    ctx.resume_session = Some(ResumeSession::inline(
        "019E9154C30470F0ADDE36EFB1BE1701".into(),
        "{}".into(),
    ));

    let env = build_env_for_test(&ctx, "http://localhost");
    let payload = build_run_payload_for_run(&ctx).unwrap();

    assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    assert_eq!(payload.append_system_prompt, "Use terse answers.");
    assert_eq!(
        env.get("VM0_RESUME_SESSION_ID").unwrap(),
        "019e9154-c304-70f0-adde-36efb1be1701"
    );
    assert!(!env.contains_key("VM0_WORKING_DIR"));
}

#[test]
fn build_env_json_rejects_invalid_codex_resume_session_id() {
    for session_id in ["abc", "urn:uuid:019e9154-c304-70f0-adde-36efb1be1701"] {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "codex".into();
        ctx.resume_session = Some(ResumeSession::inline(session_id.into(), "{}".into()));

        let error = build_env_for_test_result(&ctx, "http://localhost").unwrap_err();
        let message = error.to_string();

        assert!(message.contains("invalid codex session_id"), "got: {error}");
        assert!(
            !message.contains(session_id),
            "invalid codex error must not echo raw session id: {message}"
        );
    }
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
    assert!(!env.contains_key("VM0_ARTIFACTS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.artifacts;
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
    assert!(!env.contains_key("VM0_ARTIFACTS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.artifacts;
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
    assert!(!env.contains_key("VM0_ARTIFACTS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.artifacts;
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
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.artifacts.is_empty());
}

#[test]
fn build_env_json_with_secrets() {
    let mut ctx = minimal_context();
    // Raw delimiters in secret values must survive base64 transport.
    ctx.secret_values = Some(vec!["secret1".into(), "secret,with\nnewline".into()]);

    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_SECRET_VALUES"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let val = &payload.secret_values;

    use base64::Engine as _;
    let parts: Vec<&str> = val.split(',').collect();
    assert_eq!(parts.len(), 3);
    let decoded: Vec<String> = parts
        .iter()
        .map(|part| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(part)
                .unwrap();
            String::from_utf8(bytes).unwrap()
        })
        .collect();
    assert_eq!(
        decoded,
        vec![
            "tok".to_string(),
            "secret1".to_string(),
            "secret,with\nnewline".to_string(),
        ]
    );
}

#[test]
fn build_env_json_with_resume_session() {
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession::inline("sess-123".into(), "{}".into()));

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
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let user_env = build_user_env_json(&ctx);
    // System variables take precedence over user environment
    assert!(!env.contains_key("VM0_PROMPT"));
    assert_eq!(payload.prompt, "test prompt");
    assert!(!env.contains_key("CUSTOM"));
    assert_eq!(user_env.get("CUSTOM").unwrap(), "value");
    assert!(!user_env.contains_key("VM0_PROMPT"));
}

#[tokio::test]
async fn write_user_env_file_skips_empty_env() {
    let sandbox = MockSandbox::new("test");
    let run_id = RunId::nil();

    let path = write_user_env_file(&sandbox, run_id, &HashMap::new())
        .await
        .unwrap();

    assert!(path.is_none());
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
    assert!(sandbox.private_write_file_calls().is_empty());
}

#[tokio::test]
async fn write_user_env_file_uses_private_write_for_small_env() {
    let sandbox = MockSandbox::new("test");
    let run_id = RunId::nil();
    let user_env = HashMap::from([
        ("CUSTOM_ENV".to_string(), "value".to_string()),
        ("TZ".to_string(), "Asia/Shanghai".to_string()),
    ]);

    let path = write_user_env_file(&sandbox, run_id, &user_env)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(path, guest_user_env_file_path(run_id).unwrap());
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
    let writes = sandbox.private_write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, path);
    let decoded: HashMap<String, String> = serde_json::from_slice(&writes[0].content).unwrap();
    assert_eq!(decoded, user_env);
}

#[tokio::test]
async fn write_user_env_file_uses_private_write_for_large_env() {
    let sandbox = MockSandbox::new("test");
    let run_id = RunId::nil();
    let user_env = HashMap::from([(
        "CUSTOM_ENV".to_string(),
        "x".repeat(vsock_proto::MAX_EXEC_STDIN_BYTES),
    )]);
    let payload = serde_json::to_vec(&user_env).unwrap();
    assert!(payload.len() > vsock_proto::MAX_EXEC_STDIN_BYTES);

    let path = write_user_env_file(&sandbox, run_id, &user_env)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(path, guest_user_env_file_path(run_id).unwrap());
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
    let writes = sandbox.private_write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, path);
    assert_eq!(writes[0].content, payload);
}

#[tokio::test]
async fn write_user_env_file_returns_private_write_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_private_write_file_result(Err(sandbox_write_file_error("private write failed")));
    let run_id = RunId::nil();
    let user_env = HashMap::from([("CUSTOM_ENV".to_string(), "value".to_string())]);

    let err = write_user_env_file(&sandbox, run_id, &user_env)
        .await
        .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("private write failed"), "got: {message}");
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
    let writes = sandbox.private_write_file_calls();
    assert_eq!(writes.len(), 1);
}

#[tokio::test]
async fn write_run_payload_file_uses_private_write_for_large_payload() {
    let sandbox = MockSandbox::new("test");
    let run_id = RunId::nil();
    let payload = guest_contracts::env::RunPayload {
        prompt: "x".repeat(vsock_proto::MAX_EXEC_STDIN_BYTES),
        append_system_prompt: "system".to_string(),
        secret_values: "secret".to_string(),
        ..guest_contracts::env::RunPayload::default()
    };

    let path = write_run_payload_file(&sandbox, run_id, &payload)
        .await
        .unwrap();

    assert_eq!(path, guest_run_payload_file_path(run_id).unwrap());
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
    let writes = sandbox.private_write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, path);
    let decoded: guest_contracts::env::RunPayload =
        serde_json::from_slice(&writes[0].content).unwrap();
    assert_eq!(decoded, payload);
}

#[tokio::test]
async fn write_run_payload_file_returns_private_write_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_private_write_file_result(Err(sandbox_write_file_error("private write failed")));
    let run_id = RunId::nil();
    let payload = guest_contracts::env::RunPayload {
        prompt: "test prompt".to_string(),
        ..guest_contracts::env::RunPayload::default()
    };

    let err = write_run_payload_file(&sandbox, run_id, &payload)
        .await
        .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("private write failed"), "got: {message}");
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
    assert_eq!(sandbox.private_write_file_calls().len(), 1);
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
    assert!(!env.contains_key("VM0_SECRET_VALUES"));
    // VM0_SECRET_VALUES payload always includes the sandbox token for masking.
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let val = &payload.secret_values;
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
    assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.append_system_prompt, "Your name is Aria.");
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
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let user_env = build_user_env_json(&ctx);
    // System variables take precedence over user environment
    assert!(!env.contains_key("VM0_PROMPT"));
    assert_eq!(payload.prompt, "test prompt");
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
            "kind": "inline",
            "firewall": {
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
            }
        }]
    });
    let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
    let svcs = ctx.firewalls.unwrap();
    assert_eq!(svcs.len(), 1);
    let crate::types::FirewallEntry::Inline { firewall } = &svcs[0] else {
        panic!("expected inline firewall entry");
    };
    assert_eq!(firewall.name, "github");
    assert_eq!(firewall.apis.len(), 1);
    assert_eq!(firewall.apis[0].base, "https://api.github.com");
    let perms = firewall.apis[0].permissions.as_ref().unwrap();
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
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.disallowed_tools, "CronCreate,CronDelete");
}

#[test]
fn build_env_json_empty_disallowed_tools_omitted() {
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec![]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.disallowed_tools.is_empty());
}

#[test]
fn build_env_json_no_disallowed_tools() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.disallowed_tools.is_empty());
}

#[test]
fn build_env_json_with_tools() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_TOOLS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.tools, "Bash,Edit");
}

#[test]
fn build_env_json_empty_tools_omitted() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec![]);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_TOOLS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.tools.is_empty());
}

#[test]
fn build_env_json_no_tools() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_TOOLS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.tools.is_empty());
}

fn assert_tool_env_error<T: std::fmt::Debug>(
    result: RunnerResult<T>,
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
        let result = build_run_payload_for_run(&ctx);
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
        let result = build_run_payload_for_run(&ctx);
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
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.disallowed_tools.is_empty());
    assert!(payload.tools.is_empty());
}

#[test]
fn build_env_json_with_settings() {
    let mut ctx = minimal_context();
    ctx.settings = Some(r#"{"hooks":{}}"#.into());
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_SETTINGS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert_eq!(payload.settings, r#"{"hooks":{}}"#);
}

#[test]
fn build_env_json_empty_settings_omitted() {
    let mut ctx = minimal_context();
    ctx.settings = Some("".into());
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_SETTINGS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.settings.is_empty());
}

#[test]
fn build_env_json_no_settings() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_SETTINGS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.settings.is_empty());
}

#[test]
fn build_env_json_with_feature_flags() {
    let mut ctx = minimal_context();
    let mut flags = HashMap::new();
    flags.insert("computerUse".into(), true);
    flags.insert("audioOutput".into(), false);
    ctx.feature_flags = Some(flags);
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let raw = &payload.feature_flags;
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
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.feature_flags.is_empty());
}

#[test]
fn build_env_json_no_feature_flags() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "http://localhost");
    assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(payload.feature_flags.is_empty());
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
    assert!(!env.contains_key("VM0_ARTIFACTS"));
    let payload = build_run_payload_for_run(&ctx).unwrap();
    let artifacts = &payload.artifacts;
    assert!(artifacts.contains("\"memory\""));
    assert!(artifacts.contains("\"/memory\""));
    assert!(artifacts.contains("\"v2\""));
}
