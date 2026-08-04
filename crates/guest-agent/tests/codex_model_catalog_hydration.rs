//! Codex model-catalog hydration must happen before the configured CLI starts.

mod common;

use serde_json::{Value, json};
use shell_quote::quote_shell_arg;
use std::path::Path;
use std::process::{Command, Output};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn incomplete_catalog_inherits_bundled_defaults_before_cli_spawn() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    let discovery_codex = bin_dir.join("codex");
    let discovery_marker = tmp.path().join("discovery-args");
    let main_codex = tmp.path().join("main-codex");
    let main_marker = tmp.path().join("main-invoked");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&bin_dir)?;
    write_successful_discovery_codex(&discovery_codex, &discovery_marker)?;
    write_main_codex(&main_codex, &main_marker)?;

    let input_catalog = json!({
        "models": [{
            "slug": "deepseek-v3.2",
            "display_name": "DeepSeek V3.2",
            "context_window": 114_688,
            "unknown_model_field": { "preserve": true }
        }],
        "unknown_catalog_field": "preserve"
    });
    let run_payload_path = write_run_payload(&runtime_dir, input_catalog)?;

    let output = run_guest_agent(GuestAgentInvocation {
        discovery_bin_dir: &bin_dir,
        main_codex: &main_codex,
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "codex-model-catalog-hydration",
    })?;

    assert_eq!(
        std::fs::read_to_string(&discovery_marker)?,
        "debug\nmodels\n--bundled\n",
        "setup should invoke exactly `codex debug models --bundled`"
    );
    assert!(
        main_marker.exists(),
        "configured Codex CLI should start after successful hydration: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let written = read_written_catalog(tmp.path())?;
    assert_eq!(
        written["models"][0]["base_instructions"],
        "default instructions"
    );
    assert_eq!(
        written["models"][0]["model_messages"]["instructions_template"],
        "default template"
    );
    assert_eq!(written["models"][0]["context_window"], 114_688);
    assert_eq!(
        written["models"][0]["unknown_model_field"],
        json!({ "preserve": true })
    );
    assert_eq!(written["unknown_catalog_field"], "preserve");

    Ok(())
}

#[test]
fn complete_catalog_bypasses_bundled_discovery() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    let discovery_codex = bin_dir.join("codex");
    let discovery_marker = tmp.path().join("discovery-invoked");
    let main_codex = tmp.path().join("main-codex");
    let main_marker = tmp.path().join("main-invoked");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&bin_dir)?;
    write_failing_discovery_codex(&discovery_codex, &discovery_marker)?;
    write_main_codex(&main_codex, &main_marker)?;

    let input_catalog = json!({
        "models": [{
            "slug": "already-complete",
            "base_instructions": "",
            "unknown_model_field": true
        }],
        "unknown_catalog_field": "preserve"
    });
    let run_payload_path = write_run_payload(&runtime_dir, input_catalog.clone())?;

    let output = run_guest_agent(GuestAgentInvocation {
        discovery_bin_dir: &bin_dir,
        main_codex: &main_codex,
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "codex-complete-model-catalog",
    })?;

    assert!(
        !discovery_marker.exists(),
        "complete catalogs must not invoke bundled discovery"
    );
    assert!(
        main_marker.exists(),
        "configured Codex CLI should start for a complete catalog: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(read_written_catalog(tmp.path())?, input_catalog);

    Ok(())
}

#[test]
fn bundled_discovery_failure_preserves_existing_catalog_and_stops_cli_spawn() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    let discovery_codex = bin_dir.join("codex");
    let discovery_marker = tmp.path().join("discovery-invoked");
    let main_codex = tmp.path().join("main-codex");
    let main_marker = tmp.path().join("main-invoked");
    let runtime_dir = tmp.path().join("runtime");
    let codex_home = tmp.path().join(".codex");
    let catalog_path = codex_home.join("vm0-codex-model-catalog.json");
    std::fs::create_dir_all(&bin_dir)?;
    std::fs::create_dir_all(&codex_home)?;
    std::fs::write(&catalog_path, b"existing catalog")?;
    write_failing_discovery_codex(&discovery_codex, &discovery_marker)?;
    write_main_codex(&main_codex, &main_marker)?;
    let run_payload_path = write_run_payload(
        &runtime_dir,
        json!({ "models": [{ "slug": "incomplete" }] }),
    )?;

    let output = run_guest_agent(GuestAgentInvocation {
        discovery_bin_dir: &bin_dir,
        main_codex: &main_codex,
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "codex-model-catalog-discovery-failure",
    })?;

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(std::fs::read(&catalog_path)?, b"existing catalog");
    assert!(
        !main_marker.exists(),
        "configured Codex CLI must not start after discovery failure"
    );
    assert_eq!(
        std::fs::read_to_string(&discovery_marker)?,
        "debug\nmodels\n--bundled\n"
    );
    let error_path = guest_contracts::runtime_paths::checkpoint_error_file(&runtime_dir);
    let error = std::fs::read_to_string(error_path)?;
    assert!(error.contains("Codex setup failed"));
    assert!(error.contains("failed to read the bundled Codex model catalog"));

    Ok(())
}

fn write_run_payload(
    runtime_dir: &Path,
    model_catalog: Value,
) -> Result<std::path::PathBuf, String> {
    common::write_run_payload_file_for_test(
        runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "test model catalog setup".to_string(),
            codex_runtime_config: json!({
                "providerId": "deepseek-codex",
                "name": "DeepSeek Codex",
                "baseUrl": "https://example.test/v1",
                "envKey": "OPENAI_API_KEY",
                "wireApi": "responses",
                "supportsWebsockets": false,
                "modelCatalog": model_catalog
            })
            .to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )
}

fn read_written_catalog(home: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let path = home.join(".codex/vm0-codex-model-catalog.json");
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

struct GuestAgentInvocation<'a> {
    discovery_bin_dir: &'a Path,
    main_codex: &'a Path,
    runtime_dir: &'a Path,
    run_payload_path: &'a Path,
    home: &'a Path,
    run_id: &'a str,
}

fn run_guest_agent(args: GuestAgentInvocation<'_>) -> Result<Output, std::io::Error> {
    Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env_clear()
        .env("PATH", args.discovery_bin_dir)
        .env("CLI_AGENT_TYPE", "codex")
        .env("USE_MOCK_CODEX", "true")
        .env("VM0_MOCK_CODEX_PATH", args.main_codex)
        .env("VM0_RUN_ID", args.run_id)
        .env(
            guest_contracts::env::RUN_PAYLOAD_FILE_ENV,
            args.run_payload_path,
        )
        .env("VM0_API_BACKEND_URL", "http://127.0.0.1:1")
        .env("VM0_API_TOKEN", "")
        .env("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc")
        .env("VM0_SANDBOX_REUSE_RESULT", "reused")
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            args.runtime_dir,
        )
        .env("HOME", args.home)
        .output()
}

fn write_successful_discovery_codex(path: &Path, marker: &Path) -> TestResult {
    let marker = marker.to_string_lossy();
    let bundled = json!({
        "models": [
            {
                "priority": 0,
                "visibility": "hide",
                "supported_in_api": true,
                "base_instructions": "hidden instructions",
                "model_messages": null
            },
            {
                "priority": 2,
                "visibility": "list",
                "supported_in_api": true,
                "base_instructions": "lower priority instructions",
                "model_messages": null
            },
            {
                "priority": 1,
                "visibility": "list",
                "supported_in_api": true,
                "base_instructions": "default instructions",
                "model_messages": {
                    "instructions_template": "default template",
                    "instructions_variables": null,
                    "approvals": null,
                    "auto_review": null
                }
            }
        ]
    })
    .to_string();
    write_executable(
        path,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nprintf '%s' {}\n",
            quote_shell_arg(&marker),
            quote_shell_arg(&bundled)
        ),
    )
}

fn write_failing_discovery_codex(path: &Path, marker: &Path) -> TestResult {
    let marker = marker.to_string_lossy();
    write_executable(
        path,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nexit 42\n",
            quote_shell_arg(&marker)
        ),
    )
}

fn write_main_codex(path: &Path, marker: &Path) -> TestResult {
    let marker = marker.to_string_lossy();
    write_executable(
        path,
        &format!(
            "#!/bin/sh\nprintf invoked > {}\nexit 0\n",
            quote_shell_arg(&marker)
        ),
    )
}

fn write_executable(path: &Path, contents: &str) -> TestResult {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}
