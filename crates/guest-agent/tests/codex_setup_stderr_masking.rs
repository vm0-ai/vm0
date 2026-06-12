//! Codex setup login failures must not leak secret-bearing diagnostics.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

use api_contracts::generated::constants::model_provider_env::placeholders::OPENAI_API_KEY as OPENAI_API_KEY_PLACEHOLDER;
use base64::Engine as _;
use guest_agent::masker::SecretMasker;
use std::path::Path;
use std::time::Duration;

const OTHER_SECRET: &str = "codex-setup-env-secret";
const STDERR_OMITTED_LONG_LINE: &str = "[stderr line omitted: exceeded diagnostic size limit]";

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &Path) -> Self {
        guest_common::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

#[tokio::test]
async fn codex_setup_stderr_masking_masks_failure() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    let fake_codex = bin_dir.join("codex");
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join("user-env");
    let user_env_path = user_env_dir.join("env.json");
    let system_log_path = tmp.path().join("system.log");

    std::fs::create_dir_all(&bin_dir)?;
    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "OPENAI_API_KEY": OPENAI_API_KEY_PLACEHOLDER,
            "SETUP_OTHER_SECRET": OTHER_SECRET,
        }))?,
    )?;
    write_fake_codex(&fake_codex)?;

    let original_path = std::env::var("PATH").unwrap_or_default();
    let path = format!("{}:{original_path}", bin_dir.display());
    let encoded_other_secret = base64::engine::general_purpose::STANDARD.encode(OTHER_SECRET);

    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_RUN_ID", format!("codex-setup-{}", std::process::id()));
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("VM0_PROMPT", "test prompt");
        std::env::set_var("VM0_SECRET_VALUES", encoded_other_secret);
        std::env::set_var("VM0_USER_ENV_FILE", &user_env_path);
        std::env::set_var(guest_runtime_paths::GUEST_RUNTIME_DIR_ENV, &runtime_dir);
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("PATH", path);
    }

    let _system_log = SystemLogOverrideGuard::set(&system_log_path);
    let masker = SecretMasker::from_env();
    tokio::time::timeout(
        Duration::from_secs(2),
        guest_agent::cli::setup_codex(&masker),
    )
    .await
    .expect("codex setup should not hang on descendant-held stderr")?;

    let system_log = std::fs::read_to_string(&system_log_path)?;
    assert!(
        system_log.contains("codex login failed (non-fatal):"),
        "system log should include non-fatal setup failure context: {system_log}"
    );
    assert!(
        system_log.contains("***"),
        "system log should include redacted diagnostics: {system_log}"
    );
    assert!(
        system_log.contains(STDERR_OMITTED_LONG_LINE),
        "system log should include bounded stderr omission marker: {system_log}"
    );
    assert!(
        !system_log.contains(OTHER_SECRET),
        "system log leaked raw env secret: {system_log}"
    );
    assert!(
        !system_log.contains("overlong-start"),
        "system log leaked overlong stderr content: {system_log}"
    );

    Ok(())
}

fn write_fake_codex(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::write(
        path,
        r#"#!/bin/sh
cat >/dev/null
printf 'env secret: %s\n' "$SETUP_OTHER_SECRET" >&2
sh -c 'while :; do sleep 60; done' >&2 &
printf 'overlong-start-' >&2
i=0
while [ "$i" -lt 20000 ]; do
  printf x >&2
  i=$((i + 1))
done
printf '\n' >&2
exit 7
"#,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}
