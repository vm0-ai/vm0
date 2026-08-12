//! Process-boundary coverage for the Pi standby CLI bootstrap.
//!
//! A fake `npx` at the front of the child PATH captures the real argv emitted
//! by `execute_cli`. It then completes the Pi JSONL protocol so the assertion
//! covers process resolution, spawn, argv construction, and protocol startup.

mod common;

use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;

#[tokio::test]
async fn pi_standby_launches_canonical_okou_entrypoint() -> Result<(), Box<dyn std::error::Error>> {
    const PACKAGE_URL: &str = "https://static.vm0.io/okou-cli/okou-only-test/package.tgz";
    const SYSTEM_PROMPT: &str = "fixed Pi command-boundary prompt";
    const SKILL_DIGEST: &str = "sha256:pi-command-boundary-snapshot";

    let tmp = tempfile::tempdir()?;
    let fake_bin = tmp.path().join("bin");
    std::fs::create_dir_all(&fake_bin)?;
    let argv_path = tmp.path().join("npx-argv.txt");
    let fake_npx = fake_bin.join("npx");
    std::fs::write(
        &fake_npx,
        r#"#!/bin/sh
set -eu
printf '%s\n' "$@" > "$VM0_TEST_PI_ARGV_FILE"
printf '{"type":"pi-ready","runId":"%s","systemPromptDigest":"%s","skillSnapshotDigest":"%s"}\n' "$VM0_RUN_ID" "$VM0_TEST_PI_SYSTEM_PROMPT_DIGEST" "$VM0_TEST_PI_SKILL_SNAPSHOT_DIGEST"
printf '{"type":"pi-complete","exitCode":0,"error":null,"lastEventSequence":null,"systemPromptDigest":"%s","skillSnapshotDigest":"%s"}\n' "$VM0_TEST_PI_SYSTEM_PROMPT_DIGEST" "$VM0_TEST_PI_SKILL_SNAPSHOT_DIGEST"
"#,
    )?;
    let mut permissions = std::fs::metadata(&fake_npx)?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_npx, permissions)?;

    let run_id = "pi-standby-okou-command";
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)?;
    let system_prompt_digest = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(SYSTEM_PROMPT.as_bytes()))
    );
    let user_env = HashMap::from([
        ("CLI_PKG_URL".to_string(), PACKAGE_URL.to_string()),
        ("PATH".to_string(), fake_bin.to_string_lossy().into_owned()),
        (
            "VM0_TEST_PI_ARGV_FILE".to_string(),
            argv_path.to_string_lossy().into_owned(),
        ),
        (
            "VM0_TEST_PI_SYSTEM_PROMPT_DIGEST".to_string(),
            system_prompt_digest,
        ),
        (
            "VM0_TEST_PI_SKILL_SNAPSHOT_DIGEST".to_string(),
            SKILL_DIGEST.to_string(),
        ),
    ]);

    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "claude-code");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, run_id);
        std::env::set_var(guest_contracts::env::API_URL_ENV, "http://127.0.0.1:1");
        std::env::set_var(guest_contracts::env::API_TOKEN_ENV, "");
        std::env::set_var(
            guest_contracts::env::SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV, "reused");
        std::env::set_var("HOME", tmp.path());
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "run Pi standby".to_string(),
                pi_system_prompt: SYSTEM_PROMPT.to_string(),
                pi_model_config: r#"{"provider":"test"}"#.to_string(),
                run_skill_snapshot: format!(r#"{{"digest":"{SKILL_DIGEST}"}}"#),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(&runtime_dir, &user_env)?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let runtime = GuestRuntime::from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        false,
        &runtime.config.prompt,
    );
    let result = guest_agent::cli::execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        active_input.into_writer(),
        &runtime.config,
        &runtime.paths,
    )
    .await?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    let actual_argv = std::fs::read_to_string(argv_path)?
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(
        actual_argv,
        [
            "--yes".to_string(),
            format!("--package={PACKAGE_URL}"),
            "okou".to_string(),
            "__agent-loop".to_string(),
            "--standby".to_string(),
        ]
    );

    Ok(())
}
