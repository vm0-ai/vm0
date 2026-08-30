use std::collections::{BTreeMap, HashMap, HashSet};

use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use api_contracts::generated::types::runners::{
    runs::CodexRuntimeConfig, storage::ArtifactEntryMissingRootPolicy,
};
use sandbox::SandboxId;
use sandbox_mock::MockSandbox;
use serde_json::json;

use super::super::cli_framework::{
    EffectiveCliFramework, effective_cli_framework, normalized_cli_agent_type,
};
use super::super::env::{
    HostEnv, build_env_json_with_host_env, build_env_json_with_host_env_for_run,
    build_run_payload_for_run, build_user_env_json, guest_connector_account_context_file_path,
    is_runner_owned_env_key, validate_execution_context_before_sandbox,
    validate_model_provider_env_placeholders, write_connector_account_context_file,
};
use super::super::{USER_ENV_FILE_ENV_KEY, guest_runtime_dir};
use super::support::{
    api_artifact, api_storage, build_env_for_test, build_env_for_test_result,
    build_env_for_test_with_host_env, context_with_env, minimal_context,
};
use crate::error::{RunnerError, RunnerResult};
use crate::host_env::{
    LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV, LEGACY_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    LEGACY_RUNNER_DISK_IOPS_ENV, LEGACY_RUNNER_NET_RX_MIB_PER_SEC_ENV,
    LEGACY_RUNNER_NET_TX_MIB_PER_SEC_ENV,
};
use crate::ids::RunId;
use crate::storage_manifest::StorageManifest;
use crate::types::{
    ConnectorRuntimeTargetRegistration, ExecutionContext, ResumeSession, SandboxReuseResult,
    WorkspaceReuseResult,
};

fn validate_context_for_test(ctx: &ExecutionContext) -> Result<(), String> {
    let sandbox_id = SandboxId::new_v4().to_string();
    validate_execution_context_before_sandbox(
        ctx,
        "http://localhost",
        &sandbox_id,
        SandboxReuseResult::Reused,
    )
    .map(drop)
}

fn codex_runtime_config_for_test(model_catalog: Option<serde_json::Value>) -> CodexRuntimeConfig {
    CodexRuntimeConfig {
        provider_id: "deepseek".into(),
        name: "DeepSeek".into(),
        base_url: "https://api.deepseek.com/".into(),
        env_key: "OPENAI_API_KEY".into(),
        http_headers: None,
        requires_openai_auth: None,
        wire_api: "responses".into(),
        supports_websockets: false,
        model_catalog,
    }
}

fn pi_launch_config_for_test(session_id: &str) -> serde_json::Value {
    json!({
        "schemaVersion": 2,
        "apiFirstTurn": {
            "schemaVersion": 1,
            "resourceSnapshotDigest": "a".repeat(64),
            "manifestUrl": "https://storage.example/manifest.json",
            "sessionUrl": "https://storage.example/session.jsonl",
            "deadlineAt": 2_000_000_000_000_u64,
            "baseSession": {
                "sessionId": session_id,
                "sha256": null
            },
            "sandboxEventSequenceStart": 1
        }
    })
}

fn pi_model_config_for_test() -> serde_json::Value {
    json!({
        "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com/",
        "model": "deepseek-v4-flash",
        "apiKeyEnv": "OPENAI_API_KEY",
        "credentialSecretName": "DEEPSEEK_API_KEY"
    })
}

fn pi_context_for_test() -> ExecutionContext {
    let mut context = minimal_context();
    context.cli_agent_type = "pi".to_string();
    context.pi_session_id = Some("22222222-2222-4222-8222-222222222222".to_string());
    context.pi_launch_config = Some(pi_launch_config_for_test(
        "22222222-2222-4222-8222-222222222222",
    ));
    context.pi_model_config = Some(pi_model_config_for_test());
    context
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
fn model_provider_env_placeholder_validation_rejects_non_placeholder_values() {
    let protected_values = [
        ("ANTHROPIC_API_KEY", "sk-ant-api03-rejected-test-value"),
        ("ANTHROPIC_AUTH_TOKEN", "sk-rejected-anthropic-auth-token"),
        (
            "CLAUDE_CODE_OAUTH_TOKEN",
            "sk-ant-oat01-rejected-test-value",
        ),
        ("OPENAI_API_KEY", "sk-proj-rejected-test-value"),
        ("CHATGPT_ACCESS_TOKEN", "chatgpt-token-rejected-test-value"),
        ("CHATGPT_ACCOUNT_ID", "ws_rejected_test_account"),
        ("CHATGPT_REFRESH_TOKEN", "rt_rejected_test_refresh_token"),
        ("CHATGPT_ID_TOKEN", "hdr.rejected-test-id-token.sig"),
    ];

    for (key, value) in protected_values {
        let ctx = context_with_env(HashMap::from([(key.to_owned(), value.to_owned())]));

        let Err(error) = validate_context_for_test(&ctx) else {
            panic!("validation unexpectedly accepted {key}");
        };

        assert!(
            error.contains(key),
            "validation error did not identify {key}"
        );
        assert!(
            !error.contains(value),
            "validation error for {key} echoed its rejected value"
        );
    }
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
fn execution_context_validation_ignores_runner_owned_user_env_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("VM0_PROMPT".into(), "ignored\0secret".into()),
        (
            guest_contracts::env::RUN_ID_ENV.into(),
            "ignored\0run-identity".into(),
        ),
        (
            guest_contracts::env::PI_SESSION_ID_ENV.into(),
            "ignored\0pi-session".into(),
        ),
        (
            guest_contracts::env::PI_LAUNCH_CONFIG_ENV.into(),
            "ignored\0pi-prompt".into(),
        ),
        (
            guest_contracts::env::PI_MODEL_CONFIG_ENV.into(),
            "ignored\0pi-model".into(),
        ),
        ("CUSTOM_ENV".into(), "kept".into()),
    ]));

    assert!(validate_context_for_test(&ctx).is_ok());
    let user_env = build_user_env_json(&ctx);
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    assert!(!user_env.contains_key("VM0_PROMPT"));
    assert!(!user_env.contains_key(guest_contracts::env::RUN_ID_ENV));
    assert!(!user_env.contains_key(guest_contracts::env::PI_SESSION_ID_ENV));
    assert!(!user_env.contains_key(guest_contracts::env::PI_LAUNCH_CONFIG_ENV));
    assert!(!user_env.contains_key(guest_contracts::env::PI_MODEL_CONFIG_ENV));
}

#[test]
fn execution_context_validation_rejects_translated_tuning_env_nul_before_sandbox() {
    let secret = "3\0";
    let ctx = context_with_env(HashMap::from([(
        "VM0_STUCK_TOOL_TIMEOUT_SECS".into(),
        secret.into(),
    )]));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("bootstrap environment"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains(guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_prompt_nul_before_sandbox() {
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
fn execution_context_validation_rejects_append_system_prompt_nul_before_sandbox() {
    let secret = "system\0prompt";
    let mut ctx = minimal_context();
    ctx.append_system_prompt = Some(secret.into());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("VM0_APPEND_SYSTEM_PROMPT"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_claude_settings_nul_before_sandbox() {
    let secret = "{\"hooks\":\"bad\0value\"}";
    let mut ctx = minimal_context();
    ctx.settings = Some(secret.into());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("VM0_SETTINGS"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_ignores_codex_settings_nul_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.settings = Some("{\"hooks\":\"bad\0value\"}".into());

    assert!(validate_context_for_test(&ctx).is_ok());
    assert!(build_run_payload_for_run(&ctx).unwrap().settings.is_empty());
}

#[test]
fn execution_context_validation_accepts_raw_secret_value_nul_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.secret_values = Some(vec!["secret\0value".into()]);

    assert!(validate_context_for_test(&ctx).is_ok());
    let payload = build_run_payload_for_run(&ctx).unwrap();
    assert!(!payload.secret_values.contains('\0'));
}

#[test]
fn execution_context_validation_rejects_tool_nul_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash\0Read".into()]);

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("VM0_TOOLS"));
    assert!(error.contains("NUL"));
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
fn build_env_json_required_keys() {
    let ctx = minimal_context();
    let sandbox_id = "00000000-0000-4000-8000-000000000abc";
    let env = build_env_json_with_host_env_for_run(
        &ctx,
        "https://api.example.com",
        sandbox_id,
        SandboxReuseResult::Reused,
        WorkspaceReuseResult::SandboxReused,
        &HostEnv::default(),
    )
    .expect("test env should build");

    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_URL_ENV)
            .unwrap(),
        "https://api.example.com"
    );
    assert!(!env.contains_key(guest_contracts::env::API_URL_ENV));
    assert_eq!(
        env.get(guest_contracts::env::RUN_ID_ENV).unwrap(),
        &RunId::nil().to_string()
    );
    assert!(!env.contains_key("VM0_RUN_ID"));
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_TOKEN_ENV)
            .unwrap(),
        "tok"
    );
    assert!(!env.contains_key(guest_contracts::env::API_TOKEN_ENV));
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV)
            .unwrap(),
        "7200"
    );
    assert!(!env.contains_key(guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV));
    assert_eq!(
        env.get(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV)
            .unwrap(),
        &guest_runtime_dir(ctx.run_id).unwrap()
    );
    assert!(!env.contains_key("VM0_GUEST_RUNTIME_DIR"));
    assert!(!env.contains_key("VM0_PROMPT"));
    assert!(!env.contains_key("VM0_WORKING_DIR"));
    // Guest-agent needs these to post /complete with full metadata when
    // checkpoint lands before sandbox teardown.
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_SANDBOX_ID_ENV)
            .map(String::as_str),
        Some(sandbox_id)
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV)
            .map(String::as_str),
        Some("reused")
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV)
            .map(String::as_str),
        Some("sandboxReused")
    );
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_START_TIME_ENV)
            .unwrap(),
        ""
    );
    assert!(!env.contains_key("VM0_API_START_TIME"));
    for legacy_key in [
        "VM0_SANDBOX_ID",
        "VM0_SANDBOX_REUSE_RESULT",
        "VM0_WORKSPACE_REUSE_RESULT",
    ] {
        assert!(
            !env.contains_key(legacy_key),
            "canonical writer emitted legacy key {legacy_key}"
        );
    }
}

#[test]
fn build_env_json_keeps_api_url_writer_canonical_only() {
    let ctx = minimal_context();
    let env = build_env_for_test(&ctx, "https://api.example.com");

    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_URL_ENV)
            .map(String::as_str),
        Some("https://api.example.com")
    );
    assert!(
        !env.contains_key(guest_contracts::env::API_URL_ENV),
        "canonical Runner bootstrap writer emitted the legacy API URL alias"
    );
}

#[test]
fn build_env_json_sandbox_reuse_result_wire_format() {
    let ctx = minimal_context();
    let sid = SandboxId::new_v4().to_string();
    for (variant, expected) in [
        (SandboxReuseResult::Reused, "reused"),
        (SandboxReuseResult::NoReuseKey, "noReuseKey"),
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
        assert_eq!(
            env.get(guest_contracts::env::CANONICAL_SANDBOX_ID_ENV)
                .map(String::as_str),
            Some(sid.as_str())
        );
        assert_eq!(
            env.get(guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV)
                .map(String::as_str),
            Some(expected)
        );
        assert!(
            !env.contains_key(guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV),
            "no-workspace builder emitted canonical workspace reuse metadata"
        );
        for legacy_key in [
            "VM0_SANDBOX_ID",
            "VM0_SANDBOX_REUSE_RESULT",
            "VM0_WORKSPACE_REUSE_RESULT",
        ] {
            assert!(
                !env.contains_key(legacy_key),
                "canonical writer emitted legacy key {legacy_key}"
            );
        }
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
fn platform_environment_claim_filters_untrusted_namespaces_and_applies_trusted_last() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_ENV".into(), "kept".into()),
        ("DUPLICATE".into(), "untrusted".into()),
        ("OKOU_TOKEN".into(), "untrusted-token".into()),
        ("OKOU_FUTURE_PLATFORM_KEY".into(), "untrusted".into()),
        ("VM0_FUTURE_RUNNER_KEY".into(), "untrusted".into()),
        (
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
            "untrusted-bypass".into(),
        ),
    ]));
    ctx.platform_environment = Some(HashMap::from([
        ("DUPLICATE".into(), "trusted".into()),
        ("OKOU_TOKEN".into(), "trusted-token".into()),
        ("OKOU_PLATFORM_ONLY".into(), "trusted-platform".into()),
        ("VM0_CODEX_SERVICE_TIER".into(), "fast".into()),
        (
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
            "trusted-bypass".into(),
        ),
    ]));

    assert_eq!(
        build_user_env_json(&ctx),
        HashMap::from([
            ("CUSTOM_ENV".into(), "kept".into()),
            ("DUPLICATE".into(), "trusted".into()),
            ("OKOU_TOKEN".into(), "trusted-token".into()),
            ("OKOU_PLATFORM_ONLY".into(), "trusted-platform".into()),
            ("VM0_CODEX_SERVICE_TIER".into(), "fast".into()),
            (
                guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
                "trusted-bypass".into(),
            ),
        ])
    );
}

#[test]
fn platform_environment_overlays_legacy_environment() {
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([
        ("DUPLICATE".into(), "legacy".into()),
        ("LEGACY_ONLY".into(), "legacy-only".into()),
    ]));
    ctx.platform_environment = Some(HashMap::from([
        ("DUPLICATE".into(), "trusted".into()),
        ("PLATFORM_ONLY".into(), "platform-only".into()),
    ]));

    let environment = build_user_env_json(&ctx);

    assert_eq!(environment["DUPLICATE"], "trusted");
    assert_eq!(environment["LEGACY_ONLY"], "legacy-only");
    assert_eq!(environment["PLATFORM_ONLY"], "platform-only");
}

#[test]
fn fieldless_context_preserves_pre_platform_environment_filtering() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_ENV".into(), "kept".into()),
        ("OKOU_TOKEN".into(), "legitimate-okou-token".into()),
        ("OKOU_UNRELATED".into(), "legacy-okou-value".into()),
        (
            guest_contracts::env::RUN_ID_ENV.into(),
            "user-controlled-run-id".into(),
        ),
        (
            guest_contracts::env::PI_SESSION_ID_ENV.into(),
            "user-controlled-pi-session".into(),
        ),
        (
            guest_contracts::env::PI_LAUNCH_CONFIG_ENV.into(),
            "user-controlled-pi-prompt".into(),
        ),
        (
            guest_contracts::env::PI_MODEL_CONFIG_ENV.into(),
            "user-controlled-pi-model".into(),
        ),
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
            "VM0_GUEST_RUNTIME_DIR".into(),
            "/user/controlled/runtime".into(),
        ),
        (
            guest_contracts::env::FEATURE_FLAGS_ENV.into(),
            r#"{"bad":true}"#.into(),
        ),
        ("VM0_FUTURE_RUNNER_KEY".into(), "future".into()),
        (LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV.into(), "99".into()),
        (
            LEGACY_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV.into(),
            "999".into(),
        ),
        (LEGACY_RUNNER_DISK_IOPS_ENV.into(), "999".into()),
        (LEGACY_RUNNER_NET_RX_MIB_PER_SEC_ENV.into(), "999".into()),
        (LEGACY_RUNNER_NET_TX_MIB_PER_SEC_ENV.into(), "999".into()),
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
        ("VM0_MOCK_CLAUDE_PATH".into(), "/tmp/mock-claude".into()),
        ("VM0_MOCK_CODEX_PATH".into(), "/tmp/mock-codex".into()),
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
    assert_eq!(
        bootstrap_env
            .get(guest_contracts::env::CANONICAL_API_TOKEN_ENV)
            .unwrap(),
        "tok"
    );
    assert!(!bootstrap_env.contains_key(guest_contracts::env::API_TOKEN_ENV));
    assert_eq!(
        bootstrap_env.get(guest_contracts::env::RUN_ID_ENV).unwrap(),
        &ctx.run_id.to_string()
    );
    assert_eq!(
        bootstrap_env
            .get(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV)
            .unwrap(),
        &guest_runtime_dir(ctx.run_id).unwrap()
    );
    assert!(!bootstrap_env.contains_key("VM0_GUEST_RUNTIME_DIR"));
    assert_eq!(bootstrap_env.get("CLI_AGENT_TYPE").unwrap(), "codex");
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    assert_eq!(user_env.get("OKOU_TOKEN").unwrap(), "legitimate-okou-token");
    assert_eq!(user_env.get("OKOU_UNRELATED").unwrap(), "legacy-okou-value");
    for key in [
        guest_contracts::env::RUN_ID_ENV,
        guest_contracts::env::PI_SESSION_ID_ENV,
        guest_contracts::env::PI_LAUNCH_CONFIG_ENV,
        guest_contracts::env::PI_MODEL_CONFIG_ENV,
        guest_contracts::env::PROMPT_ENV,
        guest_contracts::env::API_TOKEN_ENV,
        guest_contracts::env::WORKING_DIR_ENV,
        "VM0_GUEST_RUNTIME_DIR",
        guest_contracts::env::FEATURE_FLAGS_ENV,
        "VM0_FUTURE_RUNNER_KEY",
        LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV,
        LEGACY_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
        LEGACY_RUNNER_DISK_IOPS_ENV,
        LEGACY_RUNNER_NET_RX_MIB_PER_SEC_ENV,
        LEGACY_RUNNER_NET_TX_MIB_PER_SEC_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
        guest_contracts::env::DISALLOWED_TOOLS_ENV,
        guest_contracts::env::TOOLS_ENV,
        guest_contracts::env::SETTINGS_ENV,
        "VM0_MOCK_CLAUDE_PATH",
        "VM0_MOCK_CODEX_PATH",
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
        guest_contracts::env::RUN_ID_ENV,
        guest_contracts::env::PI_SESSION_ID_ENV,
        guest_contracts::env::PI_LAUNCH_CONFIG_ENV,
        guest_contracts::env::PI_MODEL_CONFIG_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
    ] {
        assert!(
            is_runner_owned_env_key(key),
            "explicit runner key {key} should be runner-owned"
        );
    }
    assert!(is_runner_owned_env_key("OKOU_TOKEN"));
    assert!(is_runner_owned_env_key("OKOU_UNRELATED"));
}

#[test]
fn build_env_json_translates_guest_agent_tuning_inputs_to_canonical_outputs() {
    let mut ctx = minimal_context();
    let expected_values = ["3", "", " 4 ", "not-a-duration"];
    let mut environment = HashMap::new();
    for ((legacy_input, canonical_bootstrap_output), expected_value) in
        guest_contracts::env::GUEST_AGENT_TUNING_ENV_MAPPINGS
            .into_iter()
            .zip(expected_values)
    {
        environment.insert(legacy_input.into(), expected_value.into());
        environment.insert(
            canonical_bootstrap_output.into(),
            "hostile-canonical-must-not-override".into(),
        );
    }
    ctx.environment = Some(environment);

    let env = build_env_for_test(&ctx, "http://localhost");

    for ((legacy_input, canonical_bootstrap_output), expected_value) in
        guest_contracts::env::GUEST_AGENT_TUNING_ENV_MAPPINGS
            .into_iter()
            .zip(expected_values)
    {
        assert_eq!(
            env.get(canonical_bootstrap_output).map(String::as_str),
            Some(expected_value)
        );
        assert!(
            !env.contains_key(legacy_input),
            "runner writer emitted legacy output {legacy_input}"
        );
    }
}

#[test]
fn build_env_json_does_not_author_guest_agent_tuning_output_without_legacy_inputs() {
    let canonical_only_environment = guest_contracts::env::GUEST_AGENT_TUNING_ENV_MAPPINGS
        .into_iter()
        .map(|(_, canonical_bootstrap_output)| {
            (
                canonical_bootstrap_output.into(),
                "hostile-canonical-must-not-author".into(),
            )
        })
        .collect();

    for environment in [None, Some(canonical_only_environment)] {
        let mut ctx = minimal_context();
        ctx.environment = environment;
        let env = build_env_for_test(&ctx, "http://localhost");

        for (legacy_input, canonical_bootstrap_output) in
            guest_contracts::env::GUEST_AGENT_TUNING_ENV_MAPPINGS
        {
            assert!(!env.contains_key(legacy_input));
            assert!(!env.contains_key(canonical_bootstrap_output));
        }
    }
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
        env.get(guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV)
            .unwrap(),
        "019e9154-c304-70f0-adde-36efb1be1701"
    );
    assert!(!env.contains_key("VM0_RESUME_SESSION_ID"));
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
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV)
            .unwrap(),
        "sess-123"
    );
    assert!(!env.contains_key("VM0_RESUME_SESSION_ID"));
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
async fn write_connector_account_context_file_projects_only_target_and_source() {
    let sandbox = MockSandbox::new("test");
    let mut context = minimal_context();
    context.connector_runtime_targets = vec![
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "github".to_string(),
            base_url_vars: Some(HashMap::from([(
                "API_ORIGIN".to_string(),
                "https://api.github.com".to_string(),
            )])),
            source_id: Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
        },
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
            base_url_vars: HashMap::from([(
                "CUSTOM_ORIGIN".to_string(),
                "https://custom.example.test".to_string(),
            )]),
            source_id: None,
        },
    ];

    let path = write_connector_account_context_file(&sandbox, &context)
        .await
        .unwrap();

    assert_eq!(
        path,
        guest_connector_account_context_file_path(context.run_id).unwrap()
    );
    let writes = sandbox.private_write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, path);
    let decoded: guest_contracts::connector_account_context::RunConnectorAccountContext =
        serde_json::from_slice(&writes[0].content).unwrap();
    assert_eq!(
        decoded,
        guest_contracts::connector_account_context::RunConnectorAccountContext {
            schema_version: guest_contracts::connector_account_context::SCHEMA_VERSION,
            targets: vec![
                guest_contracts::connector_account_context::RunConnectorAccountTarget::Builtin {
                    connector_slug: "github".to_string(),
                    connection_id: Some("550e8400-e29b-41d4-a716-446655440000".to_string(),),
                },
                guest_contracts::connector_account_context::RunConnectorAccountTarget::Custom {
                    custom_connector_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    connection_id: None,
                },
            ],
        }
    );
}

#[tokio::test]
async fn write_connector_account_context_file_writes_known_empty_projection() {
    let sandbox = MockSandbox::new("test");
    let context = minimal_context();

    let path = write_connector_account_context_file(&sandbox, &context)
        .await
        .unwrap();

    let writes = sandbox.private_write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, path);
    let decoded: guest_contracts::connector_account_context::RunConnectorAccountContext =
        serde_json::from_slice(&writes[0].content).unwrap();
    assert_eq!(
        decoded,
        guest_contracts::connector_account_context::RunConnectorAccountContext {
            schema_version: guest_contracts::connector_account_context::SCHEMA_VERSION,
            targets: Vec::new(),
        }
    );
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
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_START_TIME_ENV)
            .unwrap(),
        "1700000000500"
    );
    assert!(!env.contains_key("VM0_API_START_TIME"));
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
fn build_run_payload_for_run_rejects_prompt_nul() {
    let secret = "before\0after";
    let mut ctx = minimal_context();
    ctx.prompt = secret.into();

    let error = match build_run_payload_for_run(&ctx) {
        Err(RunnerError::Internal(error)) => error,
        other => panic!("expected internal error, got {other:?}"),
    };

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("VM0_PROMPT"));
    assert!(!error.contains(secret));
}

#[test]
fn build_run_payload_for_run_serializes_codex_runtime_config() {
    let mut ctx = minimal_context();
    let mut config = codex_runtime_config_for_test(Some(json!({
        "models": [{ "slug": "deepseek-v4-flash" }],
    })));
    config.http_headers = Some(BTreeMap::from([(
        "x-api-key".to_string(),
        "__VM0_OPENAI_API_KEY_PLACEHOLDER__".to_string(),
    )]));
    config.requires_openai_auth = Some(false);
    ctx.codex_runtime_config = Some(config);

    let payload = build_run_payload_for_run(&ctx).unwrap();
    let value: serde_json::Value = serde_json::from_str(&payload.codex_runtime_config).unwrap();

    assert_eq!(value["providerId"], "deepseek");
    assert_eq!(value["baseUrl"], "https://api.deepseek.com/");
    assert_eq!(value["envKey"], "OPENAI_API_KEY");
    assert_eq!(
        value["httpHeaders"]["x-api-key"],
        "__VM0_OPENAI_API_KEY_PLACEHOLDER__"
    );
    assert_eq!(value["requiresOpenaiAuth"], false);
    assert_eq!(value["wireApi"], "responses");
    assert_eq!(value["supportsWebsockets"], false);
    assert_eq!(
        value["modelCatalog"]["models"][0]["slug"],
        "deepseek-v4-flash"
    );
}

#[test]
fn build_run_payload_for_run_omits_absent_codex_runtime_config() {
    let ctx = minimal_context();

    let payload = build_run_payload_for_run(&ctx).unwrap();

    assert!(payload.codex_runtime_config.is_empty());
}

#[test]
fn non_pi_execution_contexts_do_not_require_pi_resources() {
    for framework in ["claude-code", "codex"] {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = framework.to_string();
        ctx.pi_session_id = None;
        ctx.pi_launch_config = None;
        ctx.pi_model_config = None;

        assert!(
            validate_context_for_test(&ctx).is_ok(),
            "{framework} context should not require Pi resources"
        );
        let payload = build_run_payload_for_run(&ctx).unwrap();
        assert!(payload.pi_session_id.is_empty());
        assert!(payload.pi_launch_config.is_empty());
        assert!(payload.pi_model_config.is_empty());
    }
}

#[test]
fn pi_execution_context_preserves_additive_fields_in_run_payload() {
    let mut ctx = pi_context_for_test();
    ctx.pi_launch_config.as_mut().unwrap()["futureLaunchField"] = json!("launch-root");
    ctx.pi_launch_config.as_mut().unwrap()["apiFirstTurn"]["futureFirstTurnField"] =
        json!("first-turn");
    ctx.pi_launch_config.as_mut().unwrap()["apiFirstTurn"]["sandboxEventSequenceStart"] = json!(4);
    ctx.pi_model_config.as_mut().unwrap()["futureModelField"] = json!("model-root");
    let sandbox_id = SandboxId::new_v4().to_string();
    let payload = validate_execution_context_before_sandbox(
        &ctx,
        "http://localhost",
        &sandbox_id,
        SandboxReuseResult::Reused,
    )
    .unwrap()
    .into_run_payload(&ctx)
    .unwrap();

    assert_eq!(
        payload.pi_session_id,
        "22222222-2222-4222-8222-222222222222"
    );
    let launch: serde_json::Value = serde_json::from_str(&payload.pi_launch_config).unwrap();
    assert_eq!(launch["schemaVersion"], 2);
    assert_eq!(launch["futureLaunchField"], "launch-root");
    assert_eq!(launch["apiFirstTurn"]["futureFirstTurnField"], "first-turn");
    assert_eq!(launch["apiFirstTurn"]["sandboxEventSequenceStart"], 4);
    let model: serde_json::Value = serde_json::from_str(&payload.pi_model_config).unwrap();
    assert_eq!(model["provider"], "deepseek");
    assert_eq!(model["apiKeyEnv"], "OPENAI_API_KEY");
    assert_eq!(model["credentialSecretName"], "DEEPSEEK_API_KEY");
    assert_eq!(model["futureModelField"], "model-root");
}

#[test]
fn pi_execution_context_rejects_missing_handoff_fields_before_sandbox() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "pi".to_string();
    ctx.pi_session_id = Some("22222222-2222-4222-8222-222222222222".to_string());
    ctx.pi_launch_config = Some(json!({ "schemaVersion": 2 }));
    ctx.pi_model_config = Some(pi_model_config_for_test());

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("apiFirstTurn"));
}

#[test]
fn pi_execution_context_rejects_mismatched_h0_before_sandbox() {
    let mut ctx = pi_context_for_test();
    ctx.pi_launch_config = Some(pi_launch_config_for_test(
        "33333333-3333-4333-8333-333333333333",
    ));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("H0 session id"));
}

#[test]
fn pi_execution_context_rejects_missing_required_base_hash_before_sandbox() {
    let mut context = pi_context_for_test();
    context
        .pi_launch_config
        .as_mut()
        .unwrap()
        .pointer_mut("/apiFirstTurn/baseSession")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("sha256");

    let error = validate_context_for_test(&context).unwrap_err();

    assert!(error.contains("H0 sha256 must be present"));
}

#[test]
fn pi_execution_context_rejects_invalid_launch_fields_before_sandbox() {
    let cases = [
        ("/schemaVersion", json!(3), "schemaVersion must be 2"),
        (
            "/apiFirstTurn/schemaVersion",
            json!(2),
            "schemaVersion must be 1",
        ),
        (
            "/apiFirstTurn/resourceSnapshotDigest",
            json!("not-a-digest"),
            "resource snapshot digest",
        ),
        (
            "/apiFirstTurn/manifestUrl",
            json!("ftp://storage.example/manifest.json"),
            "manifestUrl must use HTTP or HTTPS",
        ),
        (
            "/apiFirstTurn/sessionUrl",
            json!("not a URL"),
            "sessionUrl is invalid",
        ),
        (
            "/apiFirstTurn/deadlineAt",
            json!(-1),
            "deadlineAt must be positive",
        ),
        (
            "/apiFirstTurn/sandboxEventSequenceStart",
            json!(0),
            "event sequence start must be between 1 and 2147483647",
        ),
        (
            "/apiFirstTurn/sandboxEventSequenceStart",
            json!(i64::from(i32::MAX) + 1),
            "event sequence start must be between 1 and 2147483647",
        ),
        (
            "/apiFirstTurn/baseSession/sha256",
            json!("not-a-digest"),
            "H0 sha256",
        ),
    ];

    for (pointer, value, expected) in cases {
        let mut context = pi_context_for_test();
        *context
            .pi_launch_config
            .as_mut()
            .unwrap()
            .pointer_mut(pointer)
            .unwrap() = value;

        let error = validate_context_for_test(&context).unwrap_err();

        assert!(
            error.contains(expected),
            "{pointer} produced unexpected error: {error}"
        );
    }
}

#[test]
fn pi_execution_context_rejects_invalid_model_fields_before_sandbox() {
    let cases = [
        (
            "/provider",
            json!("future-provider"),
            "Pi model config is invalid",
        ),
        (
            "/apiKeyEnv",
            json!("FUTURE_API_KEY"),
            "Pi model config is invalid",
        ),
        ("/baseUrl", json!("not a URL"), "baseUrl is invalid"),
        ("/model", json!(""), "model must not be empty"),
        (
            "/credentialSecretName",
            json!("lowercase-secret"),
            "credentialSecretName is invalid",
        ),
    ];

    for (pointer, value, expected) in cases {
        let mut context = pi_context_for_test();
        *context
            .pi_model_config
            .as_mut()
            .unwrap()
            .pointer_mut(pointer)
            .unwrap() = value;

        let error = validate_context_for_test(&context).unwrap_err();

        assert!(
            error.contains(expected),
            "{pointer} produced unexpected error: {error}"
        );
    }
}

#[test]
fn execution_context_validation_rejects_codex_runtime_config_nul() {
    let secret = "Mini\0Max";
    let mut ctx = minimal_context();
    let mut config = codex_runtime_config_for_test(None);
    config.name = secret.into();
    ctx.codex_runtime_config = Some(config);

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("VM0_CODEX_RUNTIME_CONFIG"));
    assert!(!error.contains(secret));
}

#[test]
fn execution_context_validation_rejects_codex_runtime_config_catalog_nul() {
    let secret = "DeepSeek\0Flash";
    let mut ctx = minimal_context();
    ctx.codex_runtime_config = Some(codex_runtime_config_for_test(Some(json!({
        "models": [{ "slug": secret }],
    }))));

    let error = validate_context_for_test(&ctx).unwrap_err();

    assert!(error.contains("run payload"));
    assert!(error.contains("NUL byte"));
    assert!(error.contains("VM0_CODEX_RUNTIME_CONFIG"));
    assert!(!error.contains(secret));
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
    assert_eq!(
        env.get(guest_contracts::env::CANONICAL_API_TOKEN_ENV)
            .unwrap(),
        "tok"
    );
    assert!(!env.contains_key(guest_contracts::env::API_TOKEN_ENV));
    assert!(!env.contains_key("CUSTOM_ENV"));
    assert_eq!(user_env.get("CUSTOM_ENV").unwrap(), "kept");
    assert!(!user_env.contains_key("VM0_PROMPT"));
    assert!(!user_env.contains_key("VM0_API_TOKEN"));
    assert!(!user_env.contains_key(guest_contracts::env::CANONICAL_API_TOKEN_ENV));
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
fn build_env_json_mock_claude_suppressed_by_real_agent_preview_flag() {
    let mut ctx = minimal_context();
    ctx.real_agent_in_preview = Some(true);
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
fn build_env_json_mock_codex_suppressed_by_real_agent_preview_flag() {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.real_agent_in_preview = Some(true);
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
        "connectorRuntimeTargets": [],
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
    let crate::types::FirewallEntry::Inline { firewall, .. } = &svcs[0] else {
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
        "billableFirewalls": [],
        "connectorRuntimeTargets": []
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
        ("CronCreate\0CronDelete", "must not contain NUL bytes"),
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
        ("Bash\0Read", "must not contain NUL bytes"),
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
