//! Pi CLI children receive only the canonical Runner-owned run identity.

mod common;

use guest_agent::masker::SecretMasker;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn guest_exposes_only_canonical_run_id_to_pi_cli() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let capture_path = tmp.path().join("canonical-run-id.txt");
    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
test -n "${OKOU_RUN_ID:-}"
test "${VM0_RUN_ID+x}" != x
printf '%s' "$OKOU_RUN_ID" > "$RUN_ID_CAPTURE_PATH"
IFS= read -r _
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"11111111-1111-4111-8111-111111111111","duration_ms":1}'
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let run_id = "00000000-0000-4000-8000-000000000123";
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, run_id);
        std::env::set_var(guest_contracts::env::API_URL_ENV, "http://127.0.0.1:1");
        std::env::set_var(guest_contracts::env::API_TOKEN_ENV, "");
        std::env::set_var(
            guest_contracts::env::SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV, "reused");
        std::env::set_var("HOME", tmp.path());
        let mut paths = vec![bin_dir.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "verify canonical Pi run identity".to_string(),
                pi_system_prompt: "system prompt".to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111111".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                (
                    "CLI_PKG_URL".to_string(),
                    "https://example.invalid/current-okou-cli.tgz".to_string(),
                ),
                (
                    "RUN_ID_CAPTURE_PATH".to_string(),
                    capture_path.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let runtime = common::guest_runtime_from_process_env()?;
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .expect("canonical Pi CLI process should finish")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(std::fs::read_to_string(capture_path)?, run_id);
    Ok(())
}
