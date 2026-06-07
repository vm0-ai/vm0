use super::agent_run::*;
use super::diagnostics::*;
use super::env::*;
use super::guest_state::*;
use super::sandbox_run::*;
use super::session_restore::*;
use super::storage::*;
use super::telemetry::*;
use super::*;
use crate::host_env::{
    RUNNER_CONCURRENCY_FACTOR_ENV, RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV, RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV, RUNNER_NET_TX_MIB_PER_SEC_ENV,
};
use crate::http::HttpClientConfig;
use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::proxy;
use crate::types::{
    GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry, ResumeSession,
    SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG,
};
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImagePrepareRequest,
};
use agent_diagnostics::FAILURE_DIAGNOSTIC_SCHEMA_VERSION;
use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use api_contracts::generated::types::runners::storage::{
    ArtifactEntry, ArtifactEntryMissingRootPolicy, StorageEntry, StorageManifest,
};
use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ProcessControlMode, ProcessOutputMode,
    SandboxConfig, StartProcessRequest,
};
use sandbox_mock::MockSandboxFactory;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

const RUN_IN_SANDBOX_TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
struct CapturedEvent {
    level: Level,
    fields: BTreeMap<String, String>,
}

#[derive(Clone, Default)]
struct CapturedEvents {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

impl CapturedEvents {
    fn entries(&self) -> Vec<CapturedEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl<S> Layer<S> for CapturedEvents
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = CapturedFields::default();
        event.record(&mut visitor);
        self.events.lock().unwrap().push(CapturedEvent {
            level: *event.metadata().level(),
            fields: visitor.fields,
        });
    }
}

#[derive(Default)]
struct CapturedFields {
    fields: BTreeMap<String, String>,
}

impl Visit for CapturedFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.fields
            .insert(field.name().to_string(), format!("{value:?}"));
    }
}

fn api_storage(name: &str, mount_path: &str, version: &str, archive_url: &str) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        instructions_target_filename: None,
    }
}

fn api_artifact(
    name: &str,
    mount_path: &str,
    storage_id: &str,
    version: &str,
    archive_url: &str,
) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_storage_id: storage_id.into(),
        vas_version_id: version.into(),
        manifest_url: None,
        missing_root_policy: None,
    }
}

struct DestroyPanicFactory {
    inner: MockSandboxFactory,
}

#[async_trait]
impl SandboxFactory for DestroyPanicFactory {
    fn name(&self) -> &str {
        "destroy-panic"
    }

    fn config_hash(&self) -> String {
        "destroy-panic".into()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }

    #[allow(clippy::panic)]
    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
        panic!("simulated destroy panic");
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

fn build_env_for_test(ctx: &ExecutionContext, api_url: &str) -> HashMap<String, String> {
    build_env_for_test_result(ctx, api_url).expect("test env should build")
}

fn build_env_for_test_result(
    ctx: &ExecutionContext,
    api_url: &str,
) -> RunnerResult<HashMap<String, String>> {
    build_env_for_test_with_host_env_result(ctx, api_url, &HostEnv::default())
}

fn build_env_for_test_with_host_env(
    ctx: &ExecutionContext,
    api_url: &str,
    host_env: &HostEnv,
) -> HashMap<String, String> {
    build_env_for_test_with_host_env_result(ctx, api_url, host_env).expect("test env should build")
}

fn build_env_for_test_with_host_env_result(
    ctx: &ExecutionContext,
    api_url: &str,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    let sid = SandboxId::new_v4().to_string();
    build_env_json_with_host_env(ctx, api_url, &sid, SandboxReuseResult::Reused, host_env)
}

fn minimal_context() -> ExecutionContext {
    ExecutionContext {
        run_id: RunId::nil(),
        prompt: "test prompt".into(),
        append_system_prompt: None,
        _agent_compose_version_id: None,
        vars: None,
        checkpoint_id: None,
        sandbox_token: "tok".into(),
        storage_manifest: None,
        environment: None,
        resume_session: None,
        secret_values: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        cli_agent_type: String::new(),
        debug_no_mock_claude: None,
        debug_no_mock_codex: None,
        api_start_time: None,
        user_timezone: None,
        capture_network_bodies: None,
        firewalls: None,
        network_policies: None,
        disallowed_tools: None,
        tools: None,
        settings: None,
        experimental_profile: None,
        feature_flags: None,
        billable_firewalls: vec![],
        model_usage_provider: None,
    }
}

fn context_with_env(environment: HashMap<String, String>) -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.environment = Some(environment);
    ctx
}

fn set_session_workspace_image_cache_flag(ctx: &mut ExecutionContext, enabled: bool) {
    ctx.feature_flags
        .get_or_insert_with(HashMap::new)
        .insert(SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG.into(), enabled);
}

#[test]
fn agent_env_diagnostics_sort_bounds_and_never_include_values() {
    let mut bootstrap_env = HashMap::from([
        ("BASH_ENV".to_string(), "super-secret-bash-env".to_string()),
        ("NORMAL_KEY".to_string(), "normal-secret-value".to_string()),
        ("VM0_RUN_ID".to_string(), "runner-secret-value".to_string()),
        (
            "VM0_SECRET_VALUES".to_string(),
            "stored-secret-value".to_string(),
        ),
    ]);
    for index in 0..AGENT_ENV_KEY_DIAGNOSTIC_LIMIT {
        bootstrap_env.insert(format!("ZZZ_{index:03}"), format!("value-{index}"));
    }
    bootstrap_env.insert(
        format!("AAA_{}", "x".repeat(AGENT_ENV_KEY_MAX_CHARS * 4)),
        "long-secret-value".to_string(),
    );
    let user_env = HashMap::from([("BASH_ENV".to_string(), "user-secret-bash-env".to_string())]);

    let diagnostics = build_agent_env_diagnostics(&bootstrap_env, &user_env);

    assert_eq!(diagnostics.env_count, AGENT_ENV_KEY_DIAGNOSTIC_LIMIT + 5);
    assert_eq!(diagnostics.runner_owned_count, 2);
    assert_eq!(
        diagnostics.external_count,
        AGENT_ENV_KEY_DIAGNOSTIC_LIMIT + 3
    );
    assert_eq!(diagnostics.suspicious_keys, vec!["BASH_ENV".to_string()]);
    let env_pairs: Vec<(String, String)> = bootstrap_env.into_iter().collect();
    let key_diagnostics = build_agent_env_key_diagnostics(&env_pairs);
    assert_eq!(
        key_diagnostics.logged_keys.len(),
        AGENT_ENV_KEY_DIAGNOSTIC_LIMIT
    );
    assert_eq!(key_diagnostics.omitted_key_count, 5);
    let mut sorted_logged_keys = key_diagnostics.logged_keys.clone();
    sorted_logged_keys.sort();
    assert_eq!(key_diagnostics.logged_keys, sorted_logged_keys);
    let long_key = key_diagnostics
        .logged_keys
        .iter()
        .find(|key| key.starts_with("AAA_"))
        .expect("long key should be logged before the ZZZ keys");
    assert_eq!(long_key.chars().count(), AGENT_ENV_KEY_MAX_CHARS + 3);
    assert!(long_key.ends_with("..."));
    let rendered = format!(
        "{} {}",
        diagnostics.suspicious_keys_csv(),
        key_diagnostics.logged_keys_csv()
    );
    assert!(rendered.contains("BASH_ENV"));
    assert!(rendered.contains("VM0_RUN_ID"));
    assert!(!rendered.contains("super-secret-bash-env"));
    assert!(!rendered.contains("user-secret-bash-env"));
    assert!(!rendered.contains("normal-secret-value"));
    assert!(!rendered.contains("runner-secret-value"));
    assert!(!rendered.contains("stored-secret-value"));
    assert!(!rendered.contains("long-secret-value"));
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
fn elapsed_since_api_start_ms_returns_elapsed_duration() {
    let duration = elapsed_since_api_start_ms(1_700_000_000_000, 1_700_000_001_250);

    assert_eq!(duration, Some(Duration::from_millis(1_250)));
}

#[test]
fn elapsed_since_api_start_ms_clamps_future_start_to_zero() {
    let duration = elapsed_since_api_start_ms(1_700_000_001_250, 1_700_000_000_000);

    assert_eq!(duration, Some(Duration::ZERO));
}

#[test]
fn elapsed_since_api_start_ms_rejects_seconds_shaped_start() {
    let duration = elapsed_since_api_start_ms(1_700_000_000, 1_700_000_001_250);

    assert_eq!(duration, None);
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
fn dmesg_oom_positive() {
    assert!(dmesg_indicates_oom(
        "[  12.345] Out of memory: Killed process 1234 (claude)"
    ));
    assert!(dmesg_indicates_oom("oom-kill:constraint=CONSTRAINT_MEMCG"));
    assert!(dmesg_indicates_oom("oom_reaper: reaped process 42"));
}

#[test]
fn dmesg_oom_negative() {
    assert!(!dmesg_indicates_oom(""));
    // "Killed process" alone (without OOM context) should NOT match
    assert!(!dmesg_indicates_oom("Killed process 42 (node)"));
    assert!(!dmesg_indicates_oom("normal kernel log output"));
    assert!(!dmesg_indicates_oom("[  1.000] eth0: link up"));
    assert!(!dmesg_indicates_oom("task killed by signal 15"));
    // substring "oom" in unrelated words should not match
    assert!(!dmesg_indicates_oom("the room is full"));
}

#[test]
fn dmesg_oom_case_insensitive() {
    assert!(dmesg_indicates_oom("Out Of Memory: killed process 99"));
    assert!(!dmesg_indicates_oom("Killed process 99 (agent)"));
    assert!(dmesg_indicates_oom("OOM-kill: constraint=MEMCG"));
}

/// Real `sudo dmesg | grep 'oom-kill'` output captured from prod-3.
const PROD3_OOM_GREP: &str = "\
        [1718300.650867] fc_vcpu 0 invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0\n\
        [1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=vm0-runner-v0.45.6.service,mems_allowed=0,oom_memcg=/system.slice/vm0-runner-v0.45.6.service,task_memcg=/system.slice/vm0-runner-v0.45.6.service,task=firecracker,pid=586629,uid=1000";

#[test]
fn host_oom_matches_real_prod3_output() {
    assert!(host_dmesg_indicates_oom(PROD3_OOM_GREP, 586629));
}

#[test]
fn host_oom_no_match_different_pid() {
    assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 12345));
}

#[test]
fn host_oom_no_match_different_process() {
    // Same structure as prod-3 but task=node instead of task=firecracker
    let dmesg = "[1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,\
            task=node,pid=586629,uid=1000";
    assert!(!host_dmesg_indicates_oom(dmesg, 586629));
}

#[test]
fn host_oom_no_match_empty() {
    assert!(!host_dmesg_indicates_oom("", 12345));
}

#[test]
fn host_oom_no_match_without_oom_kill() {
    // Has the PID pattern but no oom-kill keyword
    let dmesg = "[1718300.651117] task=firecracker,pid=12345,uid=1000 started";
    assert!(!host_dmesg_indicates_oom(dmesg, 12345));
}

#[test]
fn host_oom_no_prefix_match() {
    // pid=58662 must NOT match pid=586629
    assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 58662));
}

#[test]
fn host_oom_pid_at_end_of_line() {
    // PID at end of string (no trailing comma) — edge case
    let dmesg = "[0.0] oom-kill:constraint=CONSTRAINT_MEMCG,task=firecracker,pid=42";
    assert!(host_dmesg_indicates_oom(dmesg, 42));
    assert!(!host_dmesg_indicates_oom(dmesg, 4));
}

#[test]
fn session_id_validation_rejects_path_traversal() {
    let invalid_ids = [
        "../../etc/passwd",
        "foo/bar",
        "a b",
        "id;rm -rf /",
        "a\nb",
        "",
    ];
    for id in invalid_ids {
        assert!(!is_valid_session_id(id), "expected rejection for: {id:?}");
    }
}

#[test]
fn session_id_validation_accepts_valid_ids() {
    let valid_ids = [
        "abc-123",
        "sess_456",
        "a1b2c3",
        "01961d3a-c0ab-7891-a6d3-9b52cd28716c",
    ];
    for id in valid_ids {
        assert!(is_valid_session_id(id), "expected acceptance for: {id:?}");
    }
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

// -----------------------------------------------------------------------
// Sandbox-interacting function tests (using sandbox-mock)
// -----------------------------------------------------------------------

use sandbox::{
    ExecResult, ProcessExit, ProcessOutputChunk, SandboxError, SandboxInitializationPhase,
    SandboxOperation, SandboxOperationReason,
};
use sandbox_mock::MockSandbox;

fn sandbox_exec_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn sandbox_write_file_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn sandbox_create_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: message.into(),
    }
}

#[tokio::test]
async fn fix_guest_clock_calls_date_command() {
    let sandbox = MockSandbox::new("test");
    // Default mock returns exit 0 — clock fix should succeed.
    fix_guest_clock(&sandbox).await.unwrap();
}

#[tokio::test]
async fn fix_guest_clock_propagates_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("timeout")));
    let result = fix_guest_clock(&sandbox).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn fix_guest_clock_fails_on_nonzero_exit() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        b"date stdout".to_vec(),
        b"date stderr".to_vec(),
    )));

    let result = fix_guest_clock(&sandbox).await;

    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("guest clock sync failed (exit code 2)"),
        "got: {message}"
    );
    assert!(
        message.contains("stderr (captured): date stderr"),
        "got: {message}"
    );
    assert!(
        message.contains("stdout (captured): date stdout"),
        "got: {message}"
    );
}

#[tokio::test]
async fn reseed_guest_entropy_succeeds() {
    let sandbox = MockSandbox::new("test");
    reseed_guest_entropy(&sandbox).await.unwrap();

    let calls = sandbox.exec_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].cmd, "guest-reseed");
    assert!(calls[0].sudo);
    let stdin_bytes = calls[0].stdin_bytes.as_ref().unwrap();
    assert_eq!(stdin_bytes.len(), 256);
}

#[tokio::test]
async fn reseed_guest_entropy_propagates_exec_error() {
    let sandbox = MockSandbox::new("test");
    // Sandbox-level failure (vsock connection issue).
    sandbox.push_exec_result(Err(sandbox_exec_error("reseed failed")));
    let result = reseed_guest_entropy(&sandbox).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn reseed_guest_entropy_fails_on_nonzero_exit() {
    let sandbox = MockSandbox::new("test");
    // guest-reseed exits with code 1 (e.g., ioctl failed).
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"RNDRESEEDCRNG failed: Operation not permitted".to_vec(),
    )));
    let result = reseed_guest_entropy(&sandbox).await;
    assert!(result.is_err());
    let msg = result.unwrap_err().to_string();
    assert!(msg.contains("guest-reseed failed"), "got: {msg}");
}

#[tokio::test]
async fn sync_guest_timezone_accepts_common_timezone_name_shapes() {
    for tz in [
        "UTC",
        "Etc/GMT+1",
        "Etc/GMT-14",
        "America/Argentina/Buenos_Aires",
    ] {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(tz.into());

        sync_guest_timezone(&sandbox, &ctx).await;

        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 1, "timezone {tz:?} should call guest exec");
        assert!(
            calls[0]
                .cmd
                .starts_with(&format!("if test -f /usr/share/zoneinfo/{tz}; then ")),
            "unexpected timezone command: {}",
            calls[0].cmd
        );
        assert!(
            calls[0]
                .cmd
                .contains(&format!("echo '{tz}' > /etc/timezone")),
            "unexpected timezone command: {}",
            calls[0].cmd
        );
        assert!(
            calls[0]
                .cmd
                .contains(&format!("echo 'TZ={tz}' >> /etc/environment")),
            "unexpected timezone command: {}",
            calls[0].cmd
        );
        assert!(calls[0].cmd.ends_with(" fi"));
    }
}

#[tokio::test]
async fn sync_guest_timezone_skips_when_none() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    sync_guest_timezone(&sandbox, &ctx).await;

    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn sync_guest_timezone_rejects_invalid_timezone_names() {
    for invalid_tz in [
        "$(rm -rf /)",
        "../UTC",
        "Etc/../UTC",
        "America/New York",
        "UTC;id",
        "UTC'",
    ] {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(invalid_tz.into());

        sync_guest_timezone(&sandbox, &ctx).await;

        assert!(
            sandbox.exec_calls().is_empty(),
            "timezone {invalid_tz:?} should be rejected before guest exec"
        );
    }
}

#[tokio::test]
async fn sync_guest_timezone_empty_string_skips() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.user_timezone = Some(String::new());
    sync_guest_timezone(&sandbox, &ctx).await;

    assert!(sandbox.exec_calls().is_empty());
}

async fn capture_sync_guest_timezone_events(
    sandbox: &dyn Sandbox,
    ctx: &ExecutionContext,
) -> Vec<CapturedEvent> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    sync_guest_timezone(sandbox, ctx).await;

    captured.entries()
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_nonzero_exit() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        2,
        b"timezone stdout".to_vec(),
        b"timezone stderr".to_vec(),
    )));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::nil().to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("America/New_York")
    );
    assert_eq!(event.fields.get("exit_code").map(String::as_str), Some("2"));
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains("timezone stderr")),
        "event={event:#?}"
    );
    assert!(
        event
            .fields
            .get("stdout_excerpt")
            .is_some_and(|value| value.contains("timezone stdout")),
        "event={event:#?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_guest_timezone_logs_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock disconnected")));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("America/New_York".into());

    let events = capture_sync_guest_timezone_events(&sandbox, &ctx).await;

    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    let run_id = RunId::nil().to_string();
    assert_eq!(
        event.fields.get("run_id").map(String::as_str),
        Some(run_id.as_str())
    );
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("America/New_York")
    );
    assert!(
        event
            .fields
            .get("error")
            .is_some_and(|value| value.contains("vsock disconnected")),
        "event={event:#?}"
    );
}

#[tokio::test]
async fn read_guest_error_file_returns_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"checkpoint error: disk full".to_vec())));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert_eq!(msg.as_deref(), Some("checkpoint error: disk full"));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(RunId::nil(), guest_runtime_paths::checkpoint_error_file).unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_missing_file() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(None));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_empty_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"   \n  ".to_vec())));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_exec_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Err(sandbox_exec_error("vsock timeout")));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_session_id_returns_trimmed_content_from_runtime_path() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b" session-abc \n".to_vec())));

    let session_id = read_guest_session_id(&sandbox, RunId::nil()).await;

    assert_eq!(session_id.as_deref(), Some("session-abc"));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(RunId::nil(), guest_runtime_paths::session_id_file).unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_session_id_returns_none_on_missing_or_empty_file() {
    let missing = MockSandbox::new("test");
    missing.push_read_file_result(Ok(None));
    assert!(
        read_guest_session_id(&missing, RunId::nil())
            .await
            .is_none()
    );

    let empty = MockSandbox::new("test");
    empty.push_read_file_result(Ok(Some(b" \n ".to_vec())));
    assert!(read_guest_session_id(&empty, RunId::nil()).await.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_valid_diagnostic() {
    let sandbox = MockSandbox::new("test");
    let diagnostic = FailureDiagnostic::new(
        agent_diagnostics::FailureClass::CliNonzero,
        agent_diagnostics::AgentFramework::ClaudeCode,
        agent_diagnostics::PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(agent_diagnostics::FailureDetailSource::ClaudeResult)
    .with_session_history_status(agent_diagnostics::SessionHistoryStatus::Present);
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));

    let read = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert_eq!(read, Some(diagnostic));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(RunId::nil(), guest_runtime_paths::failure_diagnostic_file).unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_missing_file() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(None));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_empty_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b" \n\t".to_vec())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_malformed_json() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"{not-json".to_vec())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_unsupported_schema() {
    let sandbox = MockSandbox::new("test");
    let mut diagnostic = FailureDiagnostic::new(
        agent_diagnostics::FailureClass::CliNonzero,
        agent_diagnostics::AgentFramework::ClaudeCode,
        agent_diagnostics::PromptMetadata::from_prompt("/help"),
    );
    diagnostic.schema_version = FAILURE_DIAGNOSTIC_SCHEMA_VERSION + 1;
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_read_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Err(sandbox_exec_error("vsock timeout")));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_oversized_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(vec![
        b' ';
        SMALL_GUEST_FILE_MAX_BYTES as usize + 1
    ])));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn download_storages_success() {
    let sandbox = MockSandbox::new("test");
    // write_file succeeds by default, exec returns exit 0 by default.
    let ctx = minimal_context();
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "data",
            "v1",
            Some("https://s3/archive.tar.gz"),
        )],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    download_storages(&sandbox, &ctx, &manifest).await.unwrap();
}

#[test]
fn guest_download_command_uses_guest_common_system_log_without_shell_redirect() {
    let cmd = guest_download_command();

    assert_eq!(
        cmd,
        "/usr/local/bin/guest-download /tmp/storage-manifest.json"
    );
    assert!(!cmd.contains(">>"));
    assert!(!cmd.contains("2>&1"));
    assert!(!cmd.contains("--system-log"));
}

#[test]
fn guest_download_env_includes_run_id_for_guest_common_logs() {
    let ctx = minimal_context();
    let run_id = ctx.run_id.to_string();
    let runtime_dir = guest_runtime_dir(ctx.run_id).unwrap();
    let env = guest_download_env(&run_id, &runtime_dir);

    assert_eq!(env[0].0, "VM0_RUN_ID");
    assert_eq!(env[0].1, run_id);
    assert_eq!(env[1].0, guest_runtime_paths::GUEST_RUNTIME_DIR_ENV);
    assert_eq!(env[1].1, runtime_dir);
}

#[tokio::test]
async fn download_storages_nonzero_exit_code() {
    let sandbox = MockSandbox::new("test");
    // write_file succeeds, but exec returns non-zero.
    sandbox.push_exec_result(Ok(ExecResult::new(
            1,
            b"stdout clue".to_vec(),
            b"[2026-05-20T18:03:00Z] [ERROR] [sandbox:guest-download] storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false download failed: Failed to read archive entries: invalid gzip header".to_vec(),
        )));
    let ctx = minimal_context();
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let err = download_storages(&sandbox, &ctx, &manifest)
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("storage download failed (exit code 1)"));
    assert!(msg.contains("stderr (captured)"));
    assert!(msg.contains("mountPath=/workspace"));
    assert!(msg.contains("vasStorageName=repo"));
    assert!(msg.contains("Failed to read archive entries"));
    assert!(msg.contains("stdout (captured): stdout clue"));
}

#[test]
fn guest_download_failure_output_redacts_url_queries() {
    let result = ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"HTTP transport error for archiveUrl=https://storage.example/archive.tar.gz?X-Amz-Signature=secret"
                .to_vec(),
            stdout_truncated: false,
            stderr_truncated: true,
        };

    let msg = format_guest_download_failure(&result);

    assert!(msg.contains("stderr (captured, sandbox-truncated)"));
    assert!(msg.contains("archiveUrl=https://storage.example/archive.tar.gz?<redacted>"));
    assert!(!msg.contains("secret"));
}

#[tokio::test]
async fn restore_session_writes_history() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    let session = ResumeSession {
        session_id: "sess-abc-123".into(),
        session_history: r#"{"type":"init"}"#.into(),
    };
    restore_session(&sandbox, &ctx, &session).await.unwrap();
}

#[tokio::test]
async fn restore_session_rejects_invalid_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let session = ResumeSession {
        session_id: "../../etc/passwd".into(),
        session_history: "data".into(),
    };
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
}

#[tokio::test]
async fn restore_session_skips_unknown_framework() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    let session = ResumeSession {
        session_id: "sess-1".into(),
        session_history: "data".into(),
    };
    // Unknown frameworks must no-op silently (warn-and-skip) so a typo in
    // CLI_AGENT_TYPE does not block the run. Pushing an exec error detects
    // any accidental fallthrough into either framework's restore path.
    sandbox.push_exec_result(Err(sandbox_exec_error("should not be called")));
    restore_session(&sandbox, &ctx, &session).await.unwrap();
}

#[tokio::test]
async fn restore_session_allows_empty_agent_type() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = String::new(); // empty defaults to claude-code
    let session = ResumeSession {
        session_id: "sess-1".into(),
        session_history: "{}".into(),
    };
    // Should proceed (empty agent type treated as claude-code).
    restore_session(&sandbox, &ctx, &session).await.unwrap();
}

#[tokio::test]
async fn restore_session_writes_codex_session() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let session = ResumeSession {
        session_id: session_id.into(),
        session_history: format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-06-04T07:18:08.001Z",
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "timestamp": "2026-06-04T07:18:08.000Z",
                    "cwd": "/workspace",
                    "originator": "test",
                    "cli_version": "0.137.0",
                    "source": "cli",
                    "model_provider": "test-provider",
                    "base_instructions": null,
                },
            }),
        ),
    };
    restore_session(&sandbox, &ctx, &session).await.unwrap();
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.ends_with(
            "/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
        ),
        "codex resume history must be restored as a canonical rollout jsonl, got {}",
        writes[0].path
    );
    assert_eq!(writes[0].content, session.session_history.as_bytes());
}

#[tokio::test]
async fn restore_session_writes_codex_session_with_canonical_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = ResumeSession {
        session_id: "019e9154-c304-70f0-adde-36efb1be1701".into(),
        session_history: "{\"type\":\"thread.started\"}\n{not-json}\n".into(),
    };

    restore_session(&sandbox, &ctx, &session).await.unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.starts_with("/home/user/.codex/sessions/"),
        "codex resume history must be restored under codex sessions, got {}",
        writes[0].path
    );
    let filename = writes[0]
        .path
        .rsplit('/')
        .next()
        .expect("restored codex path should have a filename");
    assert!(
        filename.starts_with("rollout-"),
        "codex resume history filename must use rollout prefix, got {filename}"
    );
    assert!(
        filename.ends_with("-019e9154-c304-70f0-adde-36efb1be1701.jsonl"),
        "codex resume history filename must include the thread id, got {filename}"
    );
    assert_eq!(writes[0].content, session.session_history.as_bytes());
}

#[tokio::test]
async fn restore_session_rejects_invalid_codex_session_id() {
    // Path-traversal validation runs before framework dispatch, so codex
    // shares the same allow-list as claude-code.
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    let session = ResumeSession {
        session_id: "../../etc/passwd".into(),
        session_history: "{}".into(),
    };
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
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

// -----------------------------------------------------------------------
// copy_guest_logs tests
// -----------------------------------------------------------------------

#[test]
fn guest_log_copy_failure_kind_tracks_cancellation() {
    assert_eq!(
        guest_log_copy_failure_kind(false),
        GuestLogCopyFailureKind::Failed
    );
    assert_eq!(
        guest_log_copy_failure_kind(true),
        GuestLogCopyFailureKind::SkippedAfterCancellation
    );
}

#[tokio::test]
async fn copy_guest_logs_writes_files_to_host() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    let system_stream_log_path = log_paths.system_stream_log(ctx.run_id);
    tokio::fs::write(&system_stream_log_path, b"transient host-streamed stdout\n")
        .await
        .unwrap();

    // Queue guest-copy results: system log + metrics log + sandbox ops log.
    sandbox.push_copy_file_result(Ok(b"system log line 1\nsystem log line 2\n".to_vec()));
    sandbox.push_copy_file_result(Ok(b"{\"cpu\":0.5}\n".to_vec()));
    sandbox.push_copy_file_result(Ok(
        b"{\"action_type\":\"final_telemetry_upload\",\"duration_ms\":10,\"success\":true}\n"
            .to_vec(),
    ));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    let system_log = tokio::fs::read_to_string(log_paths.system_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(system_log, "system log line 1\nsystem log line 2\n");
    let system_stream_log = tokio::fs::read_to_string(system_stream_log_path)
        .await
        .unwrap();
    assert_eq!(system_stream_log, "transient host-streamed stdout\n");

    let metrics_log = tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(metrics_log, "{\"cpu\":0.5}\n");

    let sandbox_ops_log = tokio::fs::read_to_string(log_paths.sandbox_ops_log(ctx.run_id))
        .await
        .unwrap();
    assert!(sandbox_ops_log.contains("final_telemetry_upload"));

    let calls = sandbox.copy_file_calls();
    assert_eq!(calls.len(), 3);
    assert_eq!(
        calls[2].path,
        guest_runtime_path(ctx.run_id, guest_runtime_paths::sandbox_ops_log_file).unwrap()
    );
    assert_eq!(calls[2].host_path, log_paths.sandbox_ops_log(ctx.run_id));
    assert_eq!(calls[0].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
    assert_eq!(calls[1].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
    assert_eq!(calls[2].max_bytes, GUEST_LOG_COPY_MAX_BYTES);
}

#[tokio::test]
async fn copy_guest_logs_keeps_existing_logs_when_sandbox_ops_missing() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    sandbox.push_copy_file_result(Ok(b"system log\n".to_vec()));
    sandbox.push_copy_file_result(Ok(b"{\"cpu\":0.5}\n".to_vec()));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    let system_log = tokio::fs::read_to_string(log_paths.system_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(system_log, "system log\n");

    let metrics_log = tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
        .await
        .unwrap();
    assert_eq!(metrics_log, "{\"cpu\":0.5}\n");
    assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());

    let calls = sandbox.copy_file_calls();
    assert_eq!(calls.len(), 3);
    assert!(
        calls[2].missing_ok,
        "missing sandbox ops log should be a best-effort no-op"
    );
}

#[tokio::test]
async fn copy_guest_logs_skips_on_nonzero_exit() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    // Copy fails (file doesn't exist in guest).
    sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("No such file")));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    // Host files should not be created
    assert!(!log_paths.system_log(ctx.run_id).exists());
    assert!(!log_paths.metrics_log(ctx.run_id).exists());
    assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());
}

#[tokio::test]
async fn copy_guest_logs_skips_on_exec_error() {
    let dir = tempfile::tempdir().unwrap();
    let log_paths = LogPaths::new(dir.path().to_path_buf());
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();

    sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));
    sandbox.push_copy_file_result(Err(sandbox_exec_error("vsock down")));

    copy_guest_logs(&sandbox, &ctx, &log_paths, false).await;

    assert!(!log_paths.system_log(ctx.run_id).exists());
    assert!(!log_paths.metrics_log(ctx.run_id).exists());
    assert!(!log_paths.sandbox_ops_log(ctx.run_id).exists());
}

#[tokio::test]
async fn post_job_cleanup_appends_stream_markers_after_guest_log_copy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let system_log_path = config.log_paths.system_log(ctx.run_id);
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    tokio::fs::write(&system_stream_log_path, b"transient host-streamed stdout\n")
        .await
        .unwrap();
    sandbox.push_copy_file_result(Ok(b"guest system log".to_vec()));

    post_job_cleanup(
        &sandbox,
        &config,
        &ctx,
        "10.0.0.1",
        false,
        AgentStdoutStreamDiagnostics {
            chunk_truncated: true,
            stream_overflowed: true,
        },
    )
    .await
    .unwrap();

    let system_log = tokio::fs::read(&system_log_path).await.unwrap();
    assert_eq!(system_log, b"guest system log");
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected_stream_log = b"transient host-streamed stdout\n".to_vec();
    expected_stream_log.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    expected_stream_log.extend_from_slice(STDOUT_STREAM_OVERFLOW_MARKER);
    assert_eq!(system_stream_log, expected_stream_log);
}

// -----------------------------------------------------------------------
// drain_stdout_to_file tests
// -----------------------------------------------------------------------

#[tokio::test]
async fn drain_stdout_writes_chunks_to_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    let (tx, rx) = tokio::sync::mpsc::channel(2);
    tx.send(ProcessOutputChunk {
        bytes: b"chunk 1\n".to_vec(),
        truncated: false,
    })
    .await
    .unwrap();
    tx.send(ProcessOutputChunk {
        bytes: b"chunk 2\n".to_vec(),
        truncated: false,
    })
    .await
    .unwrap();
    drop(tx); // close channel

    let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert_eq!(content, "chunk 1\nchunk 2\n");
    assert!(!report.chunk_truncated);
}

#[tokio::test]
async fn drain_stdout_reports_truncated_chunk_without_changing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tx.send(ProcessOutputChunk {
        bytes: b"partial chunk".to_vec(),
        truncated: true,
    })
    .await
    .unwrap();
    drop(tx);

    let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

    let content = tokio::fs::read(&path).await.unwrap();
    assert_eq!(content, b"partial chunk");
    assert!(report.chunk_truncated);
}

#[tokio::test]
async fn drain_stdout_empty_channel() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.log");

    let (_tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
    drop(_tx);

    let report = drain_stdout_to_file(rx, path.clone()).await.unwrap();

    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert!(content.is_empty());
    assert!(!report.chunk_truncated);
}

#[tokio::test]
async fn drain_stdout_invalid_path_returns_error() {
    let (_tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
    drop(_tx);
    let error = drain_stdout_to_file(rx, PathBuf::from("/dev/null/impossible/file"))
        .await
        .unwrap_err();
    assert!(matches!(error, StdoutDrainError::Open { .. }));
}

#[tokio::test]
async fn append_stdout_stream_diagnostics_noops_when_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    append_stdout_stream_diagnostics(&path, AgentStdoutStreamDiagnostics::default())
        .await
        .unwrap();

    assert!(!path.exists());
}

#[tokio::test]
async fn append_stdout_stream_diagnostics_writes_markers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");
    tokio::fs::write(&path, b"guest system log without newline")
        .await
        .unwrap();

    append_stdout_stream_diagnostics(
        &path,
        AgentStdoutStreamDiagnostics {
            chunk_truncated: true,
            stream_overflowed: true,
        },
    )
    .await
    .unwrap();

    let content = tokio::fs::read(&path).await.unwrap();
    let mut expected = b"guest system log without newline\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    expected.extend_from_slice(STDOUT_STREAM_OVERFLOW_MARKER);
    assert_eq!(content, expected);
}

// -----------------------------------------------------------------------
// write_file failure tests (using push_write_file_result)
// -----------------------------------------------------------------------

#[tokio::test]
async fn download_storages_fails_on_write_file_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
    let ctx = minimal_context();
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let err = download_storages(&sandbox, &ctx, &manifest)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("vsock write failed"), "got: {err}");
}

#[tokio::test]
async fn restore_session_fails_on_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let session = ResumeSession {
        session_id: "sess-abc".into(),
        session_history: r#"{"type":"init"}"#.into(),
    };
    sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("disk full"), "got: {err}");
}

// -----------------------------------------------------------------------
// execute_new_sandbox integration tests (MockSandboxFactory + real filesystem)
// -----------------------------------------------------------------------

/// Build a real `ExecutorConfig` backed by tempdir files.
async fn test_executor_config(dir: &std::path::Path) -> ExecutorConfig {
    let registry_path = dir.join("proxy-registry.json");
    let lock_path = dir.join("proxy-registry.json.lock");
    tokio::fs::write(&registry_path, r#"{"vms":{},"updatedAt":0}"#)
        .await
        .unwrap();
    let log_dir = dir.join("logs");
    tokio::fs::create_dir_all(&log_dir).await.unwrap();

    ExecutorConfig {
        api_url: "http://localhost:9999".into(),
        registry: proxy::ProxyRegistryHandle::new(registry_path, lock_path),
        http: crate::http::HttpClient::new(HttpClientConfig {
            api_url: "http://localhost:9999".into(),
            vercel_bypass: None,
        })
        .unwrap(),
        log_paths: LogPaths::new(log_dir),
        network_log_manager: NetworkLogManager::new(),
        network_log_drain: NetworkLogDrainCoordinator::noop(),
        home: HomePaths::with_root(dir.to_path_buf()),
        workspace_cache: None,
    }
}

fn default_params() -> JobParams {
    JobParams {
        profile_name: "vm0/default".into(),
        vcpu: 2,
        memory_mb: 2048,
        workspace_disk_mb: 16_384,
        restore_guest_state: false,
        device_rate_limits: None,
    }
}

fn test_device_rate_limits() -> sandbox::DeviceRateLimits {
    sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 25 * 1024 * 1024,
        },
    }
}

fn test_budget_lease() -> crate::resource_budget::BudgetLease {
    let budget = Arc::new(crate::resource_budget::ResourceBudget::new(1, 1, 1.0, 0));
    crate::resource_budget::ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap()
}

async fn make_reusable_idle_sandbox(
    sandbox: Box<dyn Sandbox>,
    source_ip: String,
    session_id: &str,
) -> (ReusableIdleSandbox, crate::resource_budget::BudgetLease) {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult, ParkedIdleCandidate,
        SyntheticParkedIdleCandidateParts,
    };

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });
    let candidate = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
        sandbox,
        factory: std::sync::Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
        session_id: session_id.into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(session_id).expect("idle entry should exist");
    match entry.try_unpark().await {
        IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => (*sandbox, budget_lease),
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    }
}

fn test_telemetry(config: &ExecutorConfig, ctx: &ExecutionContext) -> JobTelemetry {
    crate::telemetry::JobTelemetry::new(config.http.clone(), ctx.run_id, ctx.sandbox_token.clone())
}

async fn assert_proxy_registry_empty(dir: &std::path::Path) {
    let raw = tokio::fs::read_to_string(dir.join("proxy-registry.json"))
        .await
        .unwrap();
    let registry: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        registry["vms"].as_object().map(|vms| vms.len()),
        Some(0),
        "proxy registry should not retain a VM after executor cleanup: {registry}",
    );
    assert!(
        registry["updatedAt"]
            .as_i64()
            .is_some_and(|updated_at| updated_at > 0),
        "proxy registry should record a cleanup mutation: {registry}",
    );
}

struct CancelAfterWaitSandbox {
    inner: Box<dyn Sandbox>,
    cancel: tokio_util::sync::CancellationToken,
}

#[async_trait]
impl Sandbox for CancelAfterWaitSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn process_pid(&self) -> Option<u32> {
        self.inner.process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<()> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        self.inner.copy_file(path, host_path, options).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        let result = self.inner.wait_process(handle, timeout).await;
        self.cancel.cancel();
        result
    }
}

struct QueuedCopyFileSandbox {
    inner: Box<dyn Sandbox>,
    copy_file_results: Mutex<VecDeque<Vec<u8>>>,
    remove_path_before_copy: Option<std::path::PathBuf>,
}

impl QueuedCopyFileSandbox {
    fn new(inner: Box<dyn Sandbox>, copy_file_results: Vec<Vec<u8>>) -> Self {
        Self {
            inner,
            copy_file_results: Mutex::new(VecDeque::from(copy_file_results)),
            remove_path_before_copy: None,
        }
    }

    fn with_remove_path_before_copy(mut self, path: std::path::PathBuf) -> Self {
        self.remove_path_before_copy = Some(path);
        self
    }
}

#[async_trait]
impl Sandbox for QueuedCopyFileSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn process_pid(&self) -> Option<u32> {
        self.inner.process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<()> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        if let Some(path) = &self.remove_path_before_copy {
            let _ = std::fs::remove_file(path);
        }
        let bytes = self
            .copy_file_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front();
        let Some(bytes) = bytes else {
            return self.inner.copy_file(path, host_path, options).await;
        };

        if bytes.len() as u64 > options.max_bytes {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: format!("test copy_file exceeded {} bytes", options.max_bytes),
            });
        }
        if let Some(parent) = host_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(host_path, &bytes)?;
        Ok(sandbox::CopyFileResult {
            bytes_copied: bytes.len() as u64,
        })
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

async fn run_execute_inner(
    factory: &MockSandboxFactory,
    ctx: &ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
) -> RunnerResult<(i32, Option<String>)> {
    let mut telemetry = test_telemetry(config, ctx);
    let cancel = tokio_util::sync::CancellationToken::new();
    let outcome = execute_new_sandbox(
        factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        config,
        params,
        &mut telemetry,
        cancel,
    )
    .await?;
    Ok((outcome.exit_code(), outcome.error().map(ToOwned::to_owned)))
}

async fn create_overridden_sandbox(
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
) -> Box<dyn Sandbox> {
    sandbox_mock::MockSandboxFactory::with_overrides(overrides)
        .create(SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .unwrap()
}

async fn seed_workspace_image_cache(
    cache: &SessionWorkspaceCache,
    runner_paths: &RunnerPaths,
    session_id: &str,
    workspace_disk_mb: u32,
) -> PathBuf {
    let sandbox_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: "vm0/default",
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(u64::from(workspace_disk_mb) * 1024 * 1024)
        .await
        .unwrap();
    drop(file);

    assert!(
        lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                &crate::idle_pool::StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    drop(lease);

    let hit = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default",
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(hit.result(), WorkspaceCacheCheckoutResult::Hit);
    let seed = hit
        .workspace_drive_config()
        .and_then(|config| config.seed_image)
        .expect("seeded workspace cache should produce a seed image");
    drop(hit);
    seed
}

fn spawn_run_in_sandbox_test(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    spawn_run_in_sandbox_test_with_timeouts(sandbox, ctx, config, cancel, PROCESS_CANCEL_TIMEOUTS)
}

fn spawn_run_in_sandbox_test_with_timeouts(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: tokio_util::sync::CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        run_in_sandbox_with_process_cancel_timeouts(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            cancel,
            process_cancel_timeouts,
        )
        .await
    })
}

#[tokio::test]
async fn run_in_sandbox_preserves_wait_result_when_cancel_arrives_after_wait() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let cancel = tokio_util::sync::CancellationToken::new();
    let factory = MockSandboxFactory::with_overrides(overrides);
    let sandbox = CancelAfterWaitSandbox {
        inner: factory
            .create(SandboxConfig {
                id: SandboxId::new_v4(),
                resources: sandbox::ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 2048,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .unwrap(),
        cancel: cancel.clone(),
    };
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = run_in_sandbox(
        &sandbox,
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        cancel.clone(),
    )
    .await
    .unwrap();

    assert!(cancel.is_cancelled());
    assert!(result.failure.is_none());
    assert_eq!(
        result.stdout_stream_diagnostics,
        AgentStdoutStreamDiagnostics {
            chunk_truncated: true,
            stream_overflowed: false,
        }
    );
}

#[tokio::test]
async fn run_in_sandbox_cancels_guest_process_and_waits_for_terminal_status() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    assert!(
        overrides
            .wait_for_process_cancel_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
    assert_eq!(
        result.stdout_stream_diagnostics,
        AgentStdoutStreamDiagnostics {
            chunk_truncated: true,
            stream_overflowed: true,
        }
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_cancel_handle_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        wait_gate,
    ));
    overrides.set_process_cancel_supported(false);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert!(overrides.process_cancel_calls().is_empty());
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_process_cancel_send_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        wait_gate,
    ));
    overrides.push_process_cancel_error("cancel write failed");
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_wait_fails_after_process_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let mut overrides = sandbox_mock::MockSandboxOverrides::with_wait_process_gate(wait_gate);
    overrides.set_wait_process_error("wait failed after cancel");
    let overrides = Arc::new(overrides);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test(sandbox, ctx, config, cancel.clone());
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn run_in_sandbox_returns_cancelled_when_terminal_grace_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        wait_gate,
    ));
    overrides.set_process_cancel_releases_wait_gate(false);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_task = spawn_run_in_sandbox_test_with_timeouts(
        sandbox,
        ctx,
        config,
        cancel.clone(),
        ProcessCancelTimeouts {
            write: PROCESS_CANCEL_WRITE_TIMEOUT,
            terminal_grace: Duration::ZERO,
        },
    );
    cancel.cancel();

    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert_eq!(
        overrides.process_cancel_calls().as_slice(),
        [sandbox_mock::ProcessCancelCall {
            timeout: PROCESS_CANCEL_WRITE_TIMEOUT
        }]
    );
    assert_eq!(
        result.failure.as_ref().map(|failure| failure.exit_code),
        Some(EXIT_SIGKILL)
    );
}

#[tokio::test]
async fn execute_inner_happy_path() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let (exit_code, error_msg) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_proxy_register_failure_destroys_fresh_sandbox_before_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("register VM in proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_none());
    assert!(outcome.network_log_session.is_none());
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start when proxy registry registration fails"
    );
}

#[tokio::test]
async fn execute_reused_sandbox_proxy_register_failure_returns_sandbox_before_agent_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let prev_storage = crate::idle_pool::StorageFingerprints::default();

    let outcome = execute_reused_sandbox(
        sandbox,
        &source_ip,
        &ctx,
        &config,
        &prev_storage,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("register VM in proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_some());
    assert!(outcome.network_log_session.is_none());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start an agent when proxy registration fails"
    );
}

#[tokio::test]
async fn execute_job_workspace_mount_failure_destroys_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "mount -t ext4".to_string(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"mount denied".to_vec(),
    });
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("mount workspace drive failed"),
        "got: {error}"
    );
    assert!(error.contains("mount denied"), "got: {error}");
    assert!(
        outcome.sandbox.is_none(),
        "fresh mount failure should be destroyed inline"
    );
    assert!(
        outcome.network_log_session.is_none(),
        "network log session should be closed before returning"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start after workspace mount failure"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_appends_stream_overflow_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    assert_eq!(system_stream_log, STDOUT_STREAM_OVERFLOW_MARKER);
}

#[tokio::test]
async fn execute_inner_writes_user_env_file_and_starts_agent_with_bootstrap_env_only() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.user_timezone = Some("Asia/Shanghai".into());
    ctx.environment = Some(HashMap::from([
        ("CUSTOM_USER_ENV".into(), "visible-to-cli".into()),
        ("BASH_ENV".into(), "/tmp/user-bash-env".into()),
        ("NODE_OPTIONS".into(), "--require /tmp/user-node.js".into()),
        ("VM0_API_TOKEN".into(), "stolen-token".into()),
        (USER_ENV_FILE_ENV_KEY.into(), "/tmp/evil-env.json".into()),
        ("VM0_STUCK_TOOL_TIMEOUT_SECS".into(), "3".into()),
    ]));

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let start_calls = overrides.start_process_calls();
    assert_eq!(start_calls.len(), 1);
    let start_env: BTreeMap<String, String> = start_calls[0].env.iter().cloned().collect();
    let expected_user_env_dir = guest_user_env_dir_path(ctx.run_id).unwrap();
    let expected_user_env_file = guest_user_env_file_path(ctx.run_id).unwrap();
    assert_eq!(start_env.get("VM0_API_TOKEN").unwrap(), "tok");
    assert_eq!(start_env.get("VM0_STUCK_TOOL_TIMEOUT_SECS").unwrap(), "3");
    assert_eq!(
        start_env.get(USER_ENV_FILE_ENV_KEY).map(String::as_str),
        Some(expected_user_env_file.as_str())
    );
    for key in ["CUSTOM_USER_ENV", "BASH_ENV", "NODE_OPTIONS", "TZ"] {
        assert!(
            !start_env.contains_key(key),
            "{key} should not be passed to guest-agent bootstrap"
        );
    }

    let mkdir_call = overrides
        .exec_calls()
        .into_iter()
        .find(|call| call.cmd.contains(&expected_user_env_dir))
        .expect("user env directory should be created before agent start");
    assert!(mkdir_call.cmd.starts_with("mkdir -p -m 700 "));
    assert!(mkdir_call.cmd.contains(" && chmod 700 "));
    assert!(mkdir_call.env_keys.is_empty());
    assert!(!mkdir_call.sudo);
    let chmod_call = overrides
        .exec_calls()
        .into_iter()
        .find(|call| call.cmd == format!("chmod 600 {expected_user_env_file}"))
        .expect("user env file mode should be tightened after write");
    assert!(chmod_call.env_keys.is_empty());
    assert!(!chmod_call.sudo);

    let writes = overrides.write_file_calls();
    let user_env_write = writes
        .iter()
        .find(|call| call.path == expected_user_env_file)
        .expect("user env JSON should be written");
    let user_env: HashMap<String, String> =
        serde_json::from_slice(&user_env_write.content).unwrap();
    assert_eq!(user_env.get("CUSTOM_USER_ENV").unwrap(), "visible-to-cli");
    assert_eq!(user_env.get("BASH_ENV").unwrap(), "/tmp/user-bash-env");
    assert_eq!(
        user_env.get("NODE_OPTIONS").unwrap(),
        "--require /tmp/user-node.js"
    );
    assert_eq!(user_env.get("TZ").unwrap(), "Asia/Shanghai");
    assert!(!user_env.contains_key("VM0_API_TOKEN"));
    assert!(!user_env.contains_key(USER_ENV_FILE_ENV_KEY));
    assert!(!user_env.contains_key("VM0_STUCK_TOOL_TIMEOUT_SECS"));
}

#[tokio::test]
async fn execute_inner_appends_stream_limit_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_inner_appends_stream_limit_marker_after_oom_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial stdout".to_vec(),
        truncated: true,
    }]);
    overrides.push_wait_process_exit(ProcessExit::new(1, EXIT_SIGKILL, Vec::new(), Vec::new()));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "dmesg".to_string(),
        exit_code: 0,
        stdout: b"Out of memory: Killed process 1234".to_vec(),
        stderr: Vec::new(),
    });
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let (exit_code, error_msg) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();

    assert_eq!(exit_code, 1);
    assert_eq!(
        error_msg.as_deref(),
        Some("Agent process killed by OOM killer")
    );
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_inner_preserves_system_stream_log_after_nonzero_exit_guest_copy() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"bootstrap diagnostic\n".to_vec(),
        truncated: false,
    }]);
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let sandbox: Box<dyn Sandbox> = Box::new(QueuedCopyFileSandbox::new(
        sandbox,
        vec![b"guest system log\n".to_vec()],
    ));
    let system_log_path = config.log_paths.system_log(ctx.run_id);
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 126);
    assert_eq!(outcome.error(), Some("Agent exited with code 126"));
    assert!(outcome.sandbox.is_some());
    assert_proxy_registry_empty(dir.path()).await;
    let system_log = tokio::fs::read(&system_log_path).await.unwrap();
    assert_eq!(system_log, b"guest system log\n");
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    assert_eq!(system_stream_log, b"bootstrap diagnostic\n");
}

#[tokio::test]
async fn execute_inner_proxy_unregister_failure_marks_successful_run_failed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
    let sandbox: Box<dyn Sandbox> = Box::new(
        QueuedCopyFileSandbox::new(sandbox, vec![b"guest system log\n".to_vec()])
            .with_remove_path_before_copy(dir.path().join("proxy-registry.json")),
    );
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
        },
        &ctx,
        &config,
        RunStart {
            restore_guest_state: false,
            reuse_result: SandboxReuseResult::PoolMiss,
            prev_storage: None,
        },
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("post-job proxy cleanup failed"),
        "got: {error}"
    );
    assert!(
        error.contains("unregister VM from proxy registry"),
        "got: {error}"
    );
    assert!(outcome.sandbox.is_some());
    assert!(outcome.network_log_session.is_some());
    assert!(outcome.guest_session_id.is_none());
}

#[tokio::test]
async fn execute_inner_passes_device_rate_limits_to_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let limits = test_device_rate_limits();
    let params = JobParams {
        workspace_disk_mb: 512,
        device_rate_limits: Some(limits.clone()),
        ..default_params()
    };

    let (exit_code, error_msg) = run_execute_inner(&factory, &minimal_context(), &config, &params)
        .await
        .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].device_rate_limits, Some(limits));
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 512,
            seed_image: None,
        })
    );
}

#[tokio::test]
async fn execute_inner_launches_agent_stream_only_without_guest_log_tee() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides.clone());

    let (exit_code, error_msg) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();
    assert_eq!(exit_code, 0);
    assert!(error_msg.is_none());

    let calls = overrides.start_process_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].output, ProcessOutputMode::stream());
    assert_eq!(calls[0].control, ProcessControlMode::Enabled);
}

#[tokio::test]
async fn execute_inner_with_snapshot_runs_clock_fix_and_reseed() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let params = JobParams {
        restore_guest_state: true,
        ..default_params()
    };
    let (exit_code, _) = run_execute_inner(&factory, &minimal_context(), &config, &params)
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_with_storage_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let mut ctx = minimal_context();
    ctx.storage_manifest = Some(StorageManifest {
        storages: vec![api_storage(
            "data",
            "/data",
            "v1",
            "https://example.com/data.tar.gz",
        )],
        artifacts: vec![],
    });
    let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_with_resume_session() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-abc-123".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
        .await
        .unwrap();
    assert_eq!(exit_code, 0);
}

#[tokio::test]
async fn execute_inner_create_failure_returns_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    factory.push_create_result(Err(sandbox_create_error("no free devices")));

    let err = run_execute_inner(&factory, &minimal_context(), &config, &default_params())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no free devices"), "got: {err}");
}

#[tokio::test]
async fn execute_inner_retries_fresh_after_workspace_cache_hit_create_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_create_result(Err(sandbox_create_error("bad seed image")));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-cache-hit".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-hit", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    assert!(!outcome.workspace_promotable);
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: Some(expected_seed.clone()),
        })
    );
    assert_eq!(
        configs[1].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(
        !expected_seed.exists(),
        "failed cache hit should invalidate the unusable baseline"
    );
}

#[tokio::test]
async fn execute_inner_ignores_workspace_cache_when_feature_flag_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-cache-disabled".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, false);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let seeded_cache =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-disabled", 16).await;
    let other_size_seeded_cache =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-cache-disabled", 32).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.workspace_image.is_none());
    assert!(!outcome.workspace_promotable);
    let configs = overrides.create_configs();
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].workspace_drive,
        Some(sandbox::WorkspaceDriveConfig {
            size_mb: 16,
            seed_image: None,
        })
    );
    assert!(
        !seeded_cache.exists(),
        "disabled feature flag should invalidate stale workspace cache baseline"
    );
    assert!(
        !other_size_seeded_cache.exists(),
        "disabled feature flag should invalidate every stale baseline for the session"
    );
    assert!(
        cache.held_session_states().await.is_empty(),
        "disabled feature flag should stop advertising stale workspace cache affinity"
    );
}

#[tokio::test]
async fn execute_inner_does_not_retry_workspace_cache_hit_after_proxy_register_failure() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    tokio::fs::remove_file(dir.path().join("proxy-registry.json"))
        .await
        .unwrap();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-register-fail".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let expected_seed =
        seed_workspace_image_cache(&cache, &runner_paths, "sess-register-fail", 16).await;
    let mut telemetry = test_telemetry(&config, &ctx);

    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &params,
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await;

    assert!(
        result.is_err(),
        "proxy registration failure must return an error"
    );
    let err = result.err().unwrap();
    assert!(
        err.to_string().contains("register VM in proxy registry"),
        "got: {err}"
    );
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "proxy registration failure must not retry with a fresh workspace image"
    );
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(
        overrides.start_process_calls().is_empty(),
        "agent must not start when proxy registry registration fails"
    );
    assert!(
        expected_seed.exists(),
        "proxy registration failure must not invalidate the unrelated workspace cache hit"
    );
}

#[tokio::test]
async fn execute_inner_aborts_drain_task_on_wait_process_error() {
    // Simulate wait_process timeout: stdout channel stays open (sender held
    // alive by MockSandbox), wait_process returns error.
    // Without the fix, task.await blocks forever → test times out.
    // With the fix, task is aborted immediately → test completes.
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_error(
        "wait timeout",
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("wait timeout"), "got: {error}");
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on post-start execution failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned on post-start execution failure"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_inner_nonzero_without_guest_error_returns_failure_message() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
        7,
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 7);
    assert_eq!(error.as_deref(), Some("Agent exited with code 7"));
}

#[tokio::test]
async fn execute_inner_abnormal_exit_collects_guest_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 126);
    assert_eq!(error.as_deref(), Some("Agent exited with code 126"));
    let calls = overrides.exec_calls();
    let diagnostic_calls: Vec<&sandbox_mock::ExecCall> = calls
        .iter()
        .filter(|call| call.cmd.contains("guest-agent-binary"))
        .collect();
    assert_eq!(diagnostic_calls.len(), 1);
    let call = diagnostic_calls[0];
    assert!(call.cmd.contains("guest-agent-binary"));
    let active_diagnostic_cmd = call
        .cmd
        .lines()
        .map(str::trim_start)
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["environ", "printenv", "ps aux", "ps -ef", "ps e"] {
        assert!(
            !active_diagnostic_cmd.contains(forbidden),
            "diagnostic command must not collect environment values via {forbidden}"
        );
    }
    assert!(
        !active_diagnostic_cmd
            .lines()
            .any(|line| line == "env" || line.starts_with("env ")),
        "diagnostic command must not collect raw environment output"
    );
    assert_eq!(call.timeout, AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT);
    assert!(call.env_keys.is_empty());
    assert!(call.sudo);
    assert!(call.stdin_bytes.is_none());
    assert_eq!(call.output_limits, EXEC_OUTPUT_LIMIT_64_KIB);
}

#[tokio::test]
async fn execute_inner_success_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 0);
    assert!(error.is_none());
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_stderr_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 7, Vec::new(), b"guest stderr".to_vec()));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 7);
    assert_eq!(error.as_deref(), Some("guest stderr"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_process_diagnostic_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let mut exit = ProcessExit::new(1, 126, Vec::new(), Vec::new());
    exit.diagnostic = "guest-agent bootstrap diagnostic".to_string();
    overrides.push_wait_process_exit(exit);
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 126);
    assert_eq!(error.as_deref(), Some("Agent exited with code 126"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_with_failure_diagnostic_skips_abnormal_exit_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    let diagnostic = FailureDiagnostic::new(
        agent_diagnostics::FailureClass::CliNonzero,
        agent_diagnostics::AgentFramework::ClaudeCode,
        agent_diagnostics::PromptMetadata::from_prompt("/help"),
    );
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    overrides.push_read_file_result(Ok(None));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let (exit_code, error) =
        run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap();

    assert_eq!(exit_code, 126);
    assert_eq!(error.as_deref(), Some("Agent exited with code 126"));
    assert!(
        overrides
            .exec_calls()
            .iter()
            .all(|call| !call.cmd.contains("guest-agent-binary"))
    );
}

#[tokio::test]
async fn execute_inner_nonzero_records_agent_execute_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_code(
        7,
    ));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let cancel = tokio_util::sync::CancellationToken::new();

    let outcome = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        cancel,
    )
    .await
    .unwrap();

    assert_eq!(outcome.exit_code(), 7);
    let ops = telemetry.pending_ops_snapshot();
    let agent_execute = ops
        .iter()
        .find(|op| op.0 == "agent_execute")
        .expect("agent_execute telemetry should be recorded");
    assert!(!agent_execute.1);
    assert_eq!(agent_execute.2.as_deref(), Some("Agent exited with code 7"));
}

#[tokio::test]
async fn execute_inner_start_failure_destroy_panic_returns_start_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_result(Err(SandboxError::Start {
        message: "boot failed".into(),
    }));
    let factory = DestroyPanicFactory {
        inner: MockSandboxFactory::with_overrides(overrides),
    };

    let ctx = minimal_context();
    let mut telemetry = test_telemetry(&config, &ctx);
    let cancel = tokio_util::sync::CancellationToken::new();
    let result = execute_new_sandbox(
        &factory,
        &ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        &mut telemetry,
        cancel,
    )
    .await;

    assert!(result.is_err(), "start failure must return an error");
    let err = result.err().unwrap();
    assert!(err.to_string().contains("boot failed"), "got: {err}");
    assert_proxy_registry_empty(dir.path()).await;
    assert!(
        !config
            .network_log_manager
            .append_for_ip(
                "10.0.0.1",
                serde_json::json!({"type":"dns","host":"after-start-failure.test"})
            )
            .await,
        "start failure should close inline network-log attribution",
    );
}

#[tokio::test]
async fn execute_job_wraps_execute_inner() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.error().is_none());
    assert!(outcome.sandbox.is_some());
}

#[tokio::test]
async fn execute_job_create_failure_returns_exit_1() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();
    factory.push_create_result(Err(sandbox_create_error("boom")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("boom"));
    assert!(outcome.sandbox.is_none());
}

#[tokio::test]
async fn execute_job_model_provider_env_validation_failure_returns_run_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let secret = "sk-proj-real-openai-secret";
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains(secret));
    assert!(outcome.sandbox.is_none());
    assert!(
        overrides.create_configs().is_empty(),
        "fresh sandbox must not be created after env validation failure"
    );
}

#[tokio::test]
async fn execute_job_claude_tool_validation_failure_skips_sandbox_create() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.tools = Some(vec!["Bash,Read".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(error.contains("VM0_TOOLS"));
    assert!(error.contains("must not contain commas"));
    assert!(outcome.sandbox.is_none());
    assert!(
        overrides.create_configs().is_empty(),
        "fresh sandbox must not be created after tool validation failure"
    );
}

#[tokio::test]
async fn execute_job_codex_ignores_claude_tool_validation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx.disallowed_tools = Some(vec!["".into()]);
    ctx.tools = Some(vec!["Bash,Read".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 0);
    assert!(outcome.error().is_none());
    assert!(outcome.sandbox.is_some());
    assert_eq!(overrides.create_configs().len(), 1);
}

// -----------------------------------------------------------------------
// Keep-alive VM reuse integration tests
// -----------------------------------------------------------------------

#[tokio::test]
async fn execute_job_reuse_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // First: create a sandbox via normal execute_job
    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    // Reuse the sandbox for a second turn
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.error().is_none());
    assert!(reuse_outcome.sandbox.is_some());
}

#[tokio::test]
async fn execute_job_reuse_without_workspace_cache_config_invalidates_held_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse";
    let (idle_sandbox, _current_image, _overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn execute_job_reuse_with_workspace_cache_flag_disabled_invalidates_held_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-disabled-reuse";
    let (idle_sandbox, _current_image, _overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;
    let other_size_seeded_cache =
        seed_workspace_image_cache(&cache, &runner_paths, session_id, 32).await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, false);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.workspace_image.is_none());
    assert!(!reuse_outcome.workspace_promotable);

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(
        !other_size_seeded_cache.exists(),
        "disabled reuse should invalidate every stale baseline for the session"
    );
    assert!(
        cache.held_session_states().await.is_empty(),
        "disabled reuse should stop advertising stale workspace cache affinity"
    );
}

#[tokio::test]
async fn unconfigured_cache_reuse_stops_when_cache_invalidation_fails() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse-invalidate-error";
    let (idle_sandbox, current_image, overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;
    tokio::fs::remove_file(&current_image).await.unwrap();
    tokio::fs::create_dir(&current_image).await.unwrap();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(
        reuse_outcome
            .error()
            .unwrap()
            .contains("failed to invalidate workspace image cache before unconfigured-cache reuse")
    );
    assert!(
        overrides.exec_calls().is_empty(),
        "reused sandbox must not run after stale cache invalidation fails"
    );
}

#[tokio::test]
async fn unconfigured_cache_reuse_stops_when_required_cache_invalidation_lock_is_busy() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let config = test_executor_config(dir.path()).await;
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-unconfigured-reuse-lock-busy";
    let current_image =
        seed_workspace_image_cache(&cache, &runner_paths, session_id, params.workspace_disk_mb)
            .await;
    let (idle_sandbox, overrides) = reusable_idle_sandbox_with_unlocked_workspace_promotion(
        &cache,
        &runner_paths,
        &params,
        session_id,
    )
    .await;
    let cache_key = crate::paths::scoped_session_workspace_cache_key(
        "",
        &params.profile_name,
        session_id,
        CANONICAL_WORKING_DIR,
        u64::from(params.workspace_disk_mb) * 1024 * 1024,
    );
    let _held_lock = crate::lock::acquire(crate::paths::workspace_image_cache_lock_path(
        &runner_paths.base_dir().join("locks"),
        &cache_key,
    ))
    .await
    .unwrap();

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    let error = reuse_outcome.error().unwrap();
    assert!(
        error
            .contains("failed to invalidate workspace image cache before unconfigured-cache reuse"),
        "got: {error}"
    );
    assert!(
        error.contains("lock unavailable"),
        "lock contention should be surfaced, got: {error}"
    );
    assert!(
        overrides.exec_calls().is_empty(),
        "reused sandbox must not run when required stale cache invalidation cannot get the entry lock"
    );
    assert!(
        current_image.exists(),
        "lock-busy invalidation must not remove a cache image it could not lock"
    );
}

#[tokio::test]
async fn cached_reuse_validation_failure_keeps_workspace_cache_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let runner_paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(runner_paths.clone());
    let mut config = test_executor_config(dir.path()).await;
    config.workspace_cache = Some(cache.clone());
    let params = JobParams {
        workspace_disk_mb: 16,
        ..default_params()
    };
    let session_id = "sess-cache-reuse-validation-failure";
    let (idle_sandbox, _current_image, overrides) =
        reusable_idle_sandbox_with_workspace_promotion(&cache, &runner_paths, &params, session_id)
            .await;

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: session_id.into(),
        session_history: r#"{"type":"init"}"#.into(),
    });
    set_session_workspace_image_cache_flag(&mut ctx, true);
    ctx.environment = Some(HashMap::from([(
        "OPENAI_API_KEY".into(),
        "sk-proj-real-openai-secret".into(),
    )]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &params, cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.workspace_promotable);
    assert!(reuse_outcome.workspace_image.is_some());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );

    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        WorkspaceCacheCheckoutResult::LockBusy,
        "pre-run validation failure must not release the hidden cache baseline before finalization can promote or invalidate the live workspace"
    );
}

async fn reusable_idle_sandbox_with_workspace_promotion(
    cache: &SessionWorkspaceCache,
    runner_paths: &RunnerPaths,
    params: &JobParams,
    session_id: &str,
) -> (
    crate::idle_pool::ReusableIdleSandbox,
    PathBuf,
    Arc<sandbox_mock::MockSandboxOverrides>,
) {
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, IdleUnparkResult,
        ParkResult, StorageFingerprints,
    };

    let current_image =
        seed_workspace_image_cache(cache, runner_paths, session_id, params.workspace_disk_mb).await;

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: &params.profile_name,
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert!(lease.is_cache_hit());
    let promotion = lease
        .into_promotion_context(
            crate::workspace_image_cache::WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let candidate = IdleParkRequest::new(IdleParkRequestParts {
        sandbox,
        factory,
        session_id: session_id.to_owned(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        workspace_promotion: Some(promotion),
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_active_parts().error;
        panic!("test sandbox should park: {error}");
    })
    .with_last_completed_at("2026-06-01T00:00:01.000Z".into());

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(session_id).expect("idle entry should exist");
    let idle_sandbox = match entry.try_unpark().await {
        IdleUnparkResult::Reused { sandbox, .. } => *sandbox,
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };

    (idle_sandbox, current_image, overrides)
}

async fn reusable_idle_sandbox_with_unlocked_workspace_promotion(
    cache: &SessionWorkspaceCache,
    runner_paths: &RunnerPaths,
    params: &JobParams,
    session_id: &str,
) -> (
    crate::idle_pool::ReusableIdleSandbox,
    Arc<sandbox_mock::MockSandboxOverrides>,
) {
    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, IdleUnparkResult,
        ParkResult, StorageFingerprints,
    };

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: &params.profile_name,
            session_id: None,
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"active image")
        .await
        .unwrap();
    let promotion = lease
        .into_promotion_context(
            crate::workspace_image_cache::WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            },
        )
        .unwrap();

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: params.vcpu,
                memory_mb: params.memory_mb,
            },
            device_rate_limits: params.device_rate_limits.clone(),
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let source_ip = sandbox.source_ip().to_owned();
    let candidate = IdleParkRequest::new(IdleParkRequestParts {
        sandbox,
        factory,
        session_id: session_id.to_owned(),
        sandbox_id,
        profile_name: params.profile_name.clone(),
        device_rate_limits: params.device_rate_limits.clone(),
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: StorageFingerprints::default(),
        workspace_promotion: Some(promotion),
    })
    .park_for_idle()
    .await
    .unwrap_or_else(|failure| {
        let error = failure.into_active_parts().error;
        panic!("test sandbox should park: {error}");
    })
    .with_last_completed_at("2026-06-01T00:00:01.000Z".into());

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(session_id).expect("idle entry should exist");
    let idle_sandbox = match entry.try_unpark().await {
        IdleUnparkResult::Reused { sandbox, .. } => *sandbox,
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };

    (idle_sandbox, overrides)
}

#[tokio::test]
async fn execute_job_reuse_model_provider_env_validation_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let secret = "sk-proj-real-openai-secret";
    let mut ctx = minimal_context();
    ctx.environment = Some(HashMap::from([("OPENAI_API_KEY".into(), secret.into())]));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("OPENAI_API_KEY"));
    assert!(!error.contains(secret));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after env validation failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_claude_tool_validation_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let mut ctx = minimal_context();
    ctx.disallowed_tools = Some(vec!["   ".into()]);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 1);
    let error = reuse_outcome.error().unwrap();
    assert!(error.contains("VM0_DISALLOWED_TOOLS"));
    assert!(error.contains("must not be empty"));
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_none());
    assert!(
        overrides.start_process_calls().is_empty(),
        "reused sandbox must not start a process after tool validation failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_appends_stream_limit_marker() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"reuse partial stdout".to_vec(),
        truncated: true,
    }]);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let ctx = minimal_context();
    let system_stream_log_path = config.log_paths.system_stream_log(ctx.run_id);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.error().is_none());
    assert!(reuse_outcome.sandbox.is_some());
    assert!(reuse_outcome.network_log_session.is_some());
    assert_proxy_registry_empty(dir.path()).await;
    let system_stream_log = tokio::fs::read(&system_stream_log_path).await.unwrap();
    let mut expected = b"reuse partial stdout\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    assert_eq!(system_stream_log, expected);
}

#[tokio::test]
async fn execute_job_reuse_with_session_context() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // First turn: execute with resume_session
    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "test-session-abc".into(),
        session_history: r#"{"type":"human","text":"hello"}"#.into(),
    });
    assert_eq!(ctx.session_id(), Some("test-session-abc"));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    // Second turn: reuse with new session history
    let mut ctx2 = minimal_context();
    ctx2.resume_session = Some(ResumeSession {
        session_id: "test-session-abc".into(),
        session_history: r#"{"type":"human","text":"hello"}
{"type":"assistant","text":"hi"}
{"type":"human","text":"do something"}"#
            .into(),
    });

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let (reuse_outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx2, &config, &default_params(), cancel).await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.sandbox.is_some());
}

#[tokio::test]
async fn idle_pool_park_and_reuse_cycle() {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, ParkedIdleCandidate,
        SyntheticParkedIdleCandidateParts,
    };

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    // Execute first job
    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(outcome.exit_code(), 0);
    let sandbox = outcome.sandbox.expect("sandbox alive");

    // Park in idle pool
    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });

    let entry = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
        sandbox,
        factory: std::sync::Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
        session_id: "test-session".into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease: test_budget_lease(),
        source_ip: outcome.source_ip,
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    });

    let result = pool.park(entry);
    assert!(matches!(result, ParkResult::Parked));
    assert_eq!(pool.len(), 1);

    // Take from pool for reuse
    let reuse_entry = pool.take("test-session").expect("should find session");
    assert_eq!(pool.len(), 0);
    assert_eq!(reuse_entry.profile_name(), "vm0/default");

    // Execute reuse
    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) = match reuse_entry.try_unpark().await {
        crate::idle_pool::IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => (*sandbox, budget_lease),
        crate::idle_pool::IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    };
    let (reuse_outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;
    assert_eq!(reuse_outcome.exit_code(), 0);
    assert!(reuse_outcome.sandbox.is_some());
}

#[tokio::test]
async fn idle_pool_profile_mismatch_returns_none() {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkedIdleCandidate, SyntheticParkedIdleCandidateParts,
    };

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });

    // Park with profile "vm0/default"
    let entry = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
        sandbox: Box::new(sandbox_mock::MockSandbox::new("test")),
        factory: std::sync::Arc::new(
            Box::new(sandbox_mock::MockSandboxFactory::new()) as Box<dyn SandboxFactory>
        ),
        session_id: "test-session".into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease: test_budget_lease(),
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    });
    let _ = pool.park(entry);

    // Take and verify profile
    let taken = pool.take("test-session").expect("should find");
    assert_eq!(taken.profile_name(), "vm0/default");

    // Simulate caller checking profile mismatch
    let matches_browser = taken.profile_name() == "vm0/browser";
    assert!(!matches_browser, "should not match different profile");
}

#[tokio::test]
async fn execute_job_reuse_clock_fix_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    // First exec mounts the workspace drive, second exec fixes the clock.
    let sandbox = MockSandbox::new("reuse-clock-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Err(sandbox_exec_error("vsock broken")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("vsock broken"));
    // Critical: sandbox must be returned so caller can stop + destroy it
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on clock fix failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned so finalization can close it"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

#[tokio::test]
async fn execute_job_reuse_reseed_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    // Workspace mount and clock fix succeed, then reseed_guest_entropy fails.
    let sandbox = MockSandbox::new("reuse-reseed-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Ok(ExecResult::new(0, Vec::new(), Vec::new())));
    sandbox.push_exec_result(Err(sandbox_exec_error("reseed timeout")));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("reseed timeout"));
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on reseed failure"
    );
}

#[tokio::test]
async fn execute_job_reuse_workspace_mount_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    let sandbox = MockSandbox::new("reuse-mount-fail");
    sandbox.push_exec_result(Ok(ExecResult::new(
        64,
        Vec::new(),
        b"mount denied".to_vec(),
    )));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-1").await;
    let (outcome, _telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_eq!(outcome.exit_code(), 1);
    let error = outcome.error().unwrap();
    assert!(
        error.contains("mount workspace drive failed"),
        "got: {error}"
    );
    assert!(error.contains("mount denied"), "got: {error}");
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on workspace mount failure"
    );
    assert!(
        outcome.network_log_session.is_some(),
        "network log session must be returned so finalization can close it"
    );
    assert_proxy_registry_empty(dir.path()).await;
}

/// Verify that session restore failure during reuse still returns the sandbox.
#[tokio::test]
async fn execute_job_reuse_session_restore_failure_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;

    let sandbox = MockSandbox::new("reuse-session-fail");
    // clock fix and reseed succeed (default), but write_file for session
    // history fails.
    sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));

    let mut ctx = minimal_context();
    ctx.resume_session = Some(ResumeSession {
        session_id: "sess-abc".into(),
        session_history: r#"{"type":"init"}"#.into(),
    });

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(Box::new(sandbox), "10.0.0.1".into(), "sess-abc").await;
    let (outcome, _telemetry) =
        execute_job_reuse(idle_sandbox, ctx, &config, &default_params(), cancel).await;

    assert_eq!(outcome.exit_code(), 1);
    assert!(outcome.error().unwrap().contains("disk full"));
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned on session restore failure"
    );
}

#[tokio::test]
async fn execute_job_nonzero_exit_still_returns_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    // Sandbox should be alive regardless of exit code (caller decides fate)
    assert!(
        outcome.sandbox.is_some(),
        "sandbox must be returned for caller to stop+destroy or park"
    );
}

// -----------------------------------------------------------------------
// filter_unchanged_storages tests
// -----------------------------------------------------------------------

fn guest_art(name: &str, ver: &str, url: Option<&str>) -> GuestDownloadArtifactEntry {
    guest_art_with_policy(name, ver, url, None)
}

fn guest_art_with_policy(
    name: &str,
    ver: &str,
    url: Option<&str>,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
) -> GuestDownloadArtifactEntry {
    GuestDownloadArtifactEntry {
        mount_path: "/workspace".into(),
        archive_url: url.map(str::to_string),
        cached: false,
        vas_storage_name: name.into(),
        vas_storage_id: String::new(),
        vas_version_id: ver.into(),
        missing_root_policy,
    }
}

fn guest_storage(
    mount_path: &str,
    name: &str,
    ver: &str,
    url: Option<&str>,
) -> GuestDownloadStorageEntry {
    GuestDownloadStorageEntry {
        mount_path: mount_path.into(),
        archive_url: url.map(str::to_string),
        instructions_target_filename: None,
        cached: false,
        vas_storage_name: name.into(),
        vas_version_id: ver.into(),
    }
}

fn art_fp(mount: &str, name: &str, ver: &str) -> HashMap<String, (String, String)> {
    let mut m = HashMap::new();
    m.insert(mount.into(), (name.into(), ver.into()));
    m
}

#[test]
fn filter_same_artifact_version_keeps_url_for_mount_repair() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/v1")
    );
    assert!(result.artifacts[0].cached);
    assert!(!result.cleanup_paths.contains(&"/workspace".to_string()));
}

#[test]
fn filter_different_artifact_version_keeps_url() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v2", Some("https://s3/v2"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/v2"),
    );
}

#[test]
fn filter_different_artifact_name_keeps_url() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("other-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.artifacts[0].archive_url.is_some());
}

#[test]
fn filter_new_artifact_not_in_prev_keeps_url() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints::default();
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.artifacts[0].archive_url.is_some());
}

#[test]
fn filter_empty_prev_downloads_everything() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "vol-1",
            "v1",
            Some("https://s3/data"),
        )],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints::default();
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.storages[0].archive_url.is_some());
    assert!(result.artifacts[0].archive_url.is_some());
}

#[test]
fn filter_all_unchanged_nulls_storage_urls_and_keeps_artifact_urls() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "vol-1",
            "v1",
            Some("https://s3/same-url"),
        )],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.storages[0].archive_url.is_none());
    assert!(result.storages[0].cached);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/v1")
    );
    assert!(result.artifacts[0].cached);
}

#[test]
fn filter_two_artifacts_at_different_mount_paths() {
    let art_a = GuestDownloadArtifactEntry {
        mount_path: "/workspace".into(),
        archive_url: Some("https://s3/a-v2".into()),
        cached: false,
        vas_storage_name: "art-a".into(),
        vas_storage_id: String::new(),
        vas_version_id: "v2".into(),
        missing_root_policy: None,
    };
    let art_b = GuestDownloadArtifactEntry {
        mount_path: "/data".into(),
        archive_url: Some("https://s3/b-v1".into()),
        cached: false,
        vas_storage_name: "art-b".into(),
        vas_storage_id: String::new(),
        vas_version_id: "v1".into(),
        missing_root_policy: None,
    };
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![art_a, art_b],
        cleanup_paths: vec![],
    };
    // Previous fingerprints: art-a was v1 (changed), art-b was v1 (unchanged).
    let mut artifacts = HashMap::new();
    artifacts.insert("/workspace".into(), ("art-a".into(), "v1".into()));
    artifacts.insert("/data".into(), ("art-b".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts,
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert_eq!(result.artifacts.len(), 2);
    // art-a changed → keeps URL, not cached, cleanup path added
    assert!(result.artifacts[0].archive_url.is_some());
    assert!(!result.artifacts[0].cached);
    assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
    // art-b unchanged -> URL retained for missing-root repair, still cached.
    assert_eq!(
        result.artifacts[1].archive_url.as_deref(),
        Some("https://s3/b-v1")
    );
    assert!(result.artifacts[1].cached);
}

#[test]
fn filter_detects_removed_artifacts() {
    // Current manifest has only one artifact; previous had two.
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("kept", "v1", Some("https://s3/kept"))],
        cleanup_paths: vec![],
    };
    let mut artifacts = HashMap::new();
    artifacts.insert("/workspace".into(), ("kept".into(), "v1".into()));
    artifacts.insert("/old".into(), ("removed".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts,
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    // Removed artifact path must appear in cleanup_paths.
    assert!(result.cleanup_paths.contains(&"/old".to_string()));
}

#[test]
fn filter_computes_cleanup_for_changed_storages() {
    let manifest = GuestDownloadManifest {
        storages: vec![
            guest_storage(
                "/home/user/.claude",
                "instructions",
                "v2",
                Some("https://s3/instructions"),
            ),
            guest_storage(
                "/home/user/.claude/skills/foo",
                "skill-foo",
                "v1",
                Some("https://s3/foo"),
            ),
        ],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert(
        "/home/user/.claude".into(),
        ("instructions".into(), "v1".into()),
    );
    storages.insert(
        "/home/user/.claude/skills/foo".into(),
        ("skill-foo".into(), "v1".into()),
    );
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    // Instructions changed (v1→v2), skill-foo unchanged
    assert!(result.storages[0].archive_url.is_some());
    assert!(!result.storages[0].cached);
    assert!(result.storages[1].archive_url.is_none());
    assert!(result.storages[1].cached);
    // Only changed storage in cleanup_paths
    assert_eq!(result.cleanup_paths, vec!["/home/user/.claude"]);
}

#[test]
fn filter_detects_removed_storages() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/home/user/.claude",
            "instructions",
            "v1",
            Some("https://s3/instructions"),
        )],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert(
        "/home/user/.claude".into(),
        ("instructions".into(), "v1".into()),
    );
    storages.insert(
        "/home/user/.claude/skills/old-skill".into(),
        ("old-skill".into(), "v1".into()),
    );
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    // instructions unchanged, old-skill removed
    assert!(result.storages[0].archive_url.is_none());
    assert!(
        result
            .cleanup_paths
            .contains(&"/home/user/.claude/skills/old-skill".to_string())
    );
}

#[test]
fn filter_changed_artifact_adds_cleanup_path() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v2", Some("https://s3/v2"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.artifacts[0].archive_url.is_some());
    assert!(
        result
            .cleanup_paths
            .contains(&result.artifacts[0].mount_path)
    );
}

#[test]
fn filter_changed_artifact_with_null_url_adds_cleanup_path() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v2", None)],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    // Version changed → must be in cleanup_paths even though URL is absent.
    assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
    assert!(!result.artifacts[0].cached);
}

#[test]
fn filter_unchanged_artifact_policy_does_not_force_redownload() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art_with_policy(
            "memory",
            "v1",
            Some("https://s3/memory"),
            Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        )],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "memory", "v1"),
    };

    let result = filter_unchanged_storages(&manifest, &prev);

    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/memory")
    );
    assert!(result.artifacts[0].cached);
    assert!(!result.cleanup_paths.contains(&"/workspace".to_string()));
}

#[test]
fn filter_changed_storage_with_null_url_adds_cleanup_path() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage("/data", "vol-1", "v2", None)],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    // Version changed → must be in cleanup_paths even though URL is absent.
    assert!(result.cleanup_paths.contains(&"/data".to_string()));
    assert!(!result.storages[0].cached);
}

#[test]
fn filter_unchanged_storage_sets_cached_true() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "vol-1",
            "v1",
            Some("https://s3/data"),
        )],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.storages[0].cached);
    assert!(result.storages[0].archive_url.is_none());
}

#[test]
fn filter_tainted_paths_force_download_even_when_versions_match() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/workspace/repo",
            "repo",
            "v1",
            Some("https://s3/repo"),
        )],
        artifacts: vec![GuestDownloadArtifactEntry {
            mount_path: "/workspace/artifact".into(),
            archive_url: Some("https://s3/artifact".into()),
            cached: false,
            vas_storage_name: "artifact".into(),
            vas_storage_id: String::new(),
            vas_version_id: "v1".into(),
            missing_root_policy: None,
        }],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::from([("/workspace/repo".into(), ("repo".into(), "v1".into()))]),
        artifacts: HashMap::from([(
            "/workspace/artifact".into(),
            ("artifact".into(), "v1".into()),
        )]),
    }
    .tainted_paths();

    let result = filter_unchanged_storages(&manifest, &prev);

    assert_eq!(
        result.storages[0].archive_url.as_deref(),
        Some("https://s3/repo")
    );
    assert!(!result.storages[0].cached);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/artifact")
    );
    assert!(!result.artifacts[0].cached);
    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/repo".to_string())
    );
    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/artifact".to_string())
    );
}

#[test]
fn filter_tainted_removed_paths_are_cleaned() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::from([(
            "/workspace/removed-storage".into(),
            ("repo".into(), "v1".into()),
        )]),
        artifacts: HashMap::from([(
            "/workspace/removed-artifact".into(),
            ("artifact".into(), "v1".into()),
        )]),
    }
    .tainted_paths();

    let result = filter_unchanged_storages(&manifest, &prev);

    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/removed-storage".to_string())
    );
    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/removed-artifact".to_string())
    );
}

// -----------------------------------------------------------------------
// Reuse-outcome telemetry (issue #10360: sandbox reuse success rate)
// -----------------------------------------------------------------------

fn new_telemetry() -> JobTelemetry {
    let http = HttpClient::new(HttpClientConfig {
        api_url: "http://localhost".to_string(),
        vercel_bypass: None,
    })
    .unwrap();
    JobTelemetry::new(http, RunId::nil(), "tok".to_string())
}

#[test]
fn record_reuse_result_emits_hit_for_reuse() {
    let mut telemetry = new_telemetry();
    record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].0, "sandbox_reuse_hit");
}

#[test]
fn record_reuse_result_emits_miss_for_every_miss_variant() {
    let variants = [
        SandboxReuseResult::NoSessionId,
        SandboxReuseResult::PoolMiss,
        SandboxReuseResult::ProfileMismatch,
        SandboxReuseResult::DeviceLimitMismatch,
        SandboxReuseResult::UnparkFailed,
    ];
    for variant in variants {
        let mut telemetry = new_telemetry();
        record_reuse_result(&mut telemetry, variant);
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(ops.len(), 1, "{variant:?}");
        assert_eq!(ops[0].0, "sandbox_reuse_miss", "{variant:?}");
    }
}

#[tokio::test]
async fn execute_job_records_sandbox_reuse_miss_in_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    let ops = telemetry.pending_ops_snapshot();
    let reuse_events: Vec<_> = ops
        .iter()
        .filter(|op| op.0.starts_with("sandbox_reuse_"))
        .collect();
    assert_eq!(reuse_events.len(), 1);
    assert_eq!(reuse_events[0].0, "sandbox_reuse_miss");
}

#[tokio::test]
async fn execute_job_reuse_records_sandbox_reuse_hit_in_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let (_outcome, telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    let ops = telemetry.pending_ops_snapshot();
    let reuse_events: Vec<_> = ops
        .iter()
        .filter(|op| op.0.starts_with("sandbox_reuse_"))
        .collect();
    assert_eq!(reuse_events.len(), 1);
    assert_eq!(reuse_events[0].0, "sandbox_reuse_hit");
}
