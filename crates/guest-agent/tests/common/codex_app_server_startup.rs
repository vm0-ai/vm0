use guest_agent::masker::SecretMasker;
use shell_quote::quote_shell_arg;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::common;

const CODEX_FIXED_STARTUP_CONFIGS: [&str; 3] = [
    "analytics.enabled=false",
    "features.plugins=false",
    "features.apps=false",
];
const CODEX_FAST_MODE_STARTUP_CONFIGS: [&str; 2] =
    ["features.fast_mode=true", r#"service_tier="fast""#];

pub struct CodexAppServerStartupCase {
    pub run_id: &'static str,
    pub user_env: HashMap<String, String>,
    pub expect_fast_mode: bool,
}

pub async fn assert_codex_app_server_startup_case(
    case: CodexAppServerStartupCase,
) -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let argv_path = tmp.path().join("codex-argv");
    let recording_mock = recording_codex(tmp.path(), &mock, &argv_path)?;

    unsafe {
        common::setup_codex_app_server_env(
            &recording_mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: case.run_id,
                prompt: "verify Codex app-server startup configuration",
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), case.run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        common::set_user_env_file_env_for_test(&runtime_dir, &case.user_env)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .map_err(|_| std::io::Error::other("Codex app-server execution timed out"))??;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.failure_diagnostic.is_none());
    assert_startup_policy(&argv_path, case.expect_fast_mode)?;
    Ok(())
}

fn recording_codex(root: &Path, mock: &Path, argv_path: &Path) -> Result<PathBuf, std::io::Error> {
    use std::os::unix::fs::PermissionsExt as _;

    let path = root.join("recording-codex");
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nexec {} \"$@\"\n",
            quote_shell_arg(&argv_path.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        ),
    )?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}

fn assert_startup_policy(argv_path: &Path, expect_fast_mode: bool) -> Result<(), std::io::Error> {
    let args = std::fs::read_to_string(argv_path)?
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let app_server_index = args
        .iter()
        .position(|arg| arg == "app-server")
        .ok_or_else(|| std::io::Error::other("Codex argv omitted app-server subcommand"))?;

    for config in CODEX_FIXED_STARTUP_CONFIGS {
        assert_config_count_and_order(&args, app_server_index, config, 1);
    }
    for config in CODEX_FAST_MODE_STARTUP_CONFIGS {
        let expected_count = usize::from(expect_fast_mode);
        assert_config_count_and_order(&args, app_server_index, config, expected_count);
    }
    Ok(())
}

fn assert_config_count_and_order(
    args: &[String],
    app_server_index: usize,
    config: &str,
    expected_count: usize,
) {
    let indexes = args
        .windows(2)
        .enumerate()
        .filter_map(|(index, window)| {
            matches!(window, [flag, value] if flag == "-c" && value == config).then_some(index)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        indexes.len(),
        expected_count,
        "unexpected count for Codex app-server config {config:?}: {args:?}"
    );
    assert!(
        indexes.iter().all(|index| *index < app_server_index),
        "Codex app-server config {config:?} must precede the subcommand: {args:?}"
    );
}
