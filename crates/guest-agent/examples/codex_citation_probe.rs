//! Explicit installed-runtime acceptance driver; uses the production Guest entry point.
//! Run with an isolated fixture home, a Codex binary, and a local synthetic provider.

use std::path::PathBuf;

use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::cli::execute_cli_with_active_input_for_config;
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_contracts::env::{RUN_PAYLOAD_FILENAME, RUN_PAYLOAD_PRIVATE_DIR_NAME, RunPayload};
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let home = PathBuf::from(args.next().ok_or("missing isolated home")?);
    let binary = args.next().ok_or("missing Codex binary")?;
    let provider_url = args.next().ok_or("missing fixture provider URL")?;
    if !provider_url.starts_with("http://127.0.0.1:") {
        return Err("this acceptance driver requires a local synthetic provider".into());
    }
    let resume = args.next().unwrap_or_default();
    let runtime_dir = home.join(format!("probe-run-{}", uuid::Uuid::new_v4()));
    let payload_dir = runtime_dir.join(RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&payload_dir)?;
    let payload_path = payload_dir.join(RUN_PAYLOAD_FILENAME);
    let payload = RunPayload {
        prompt: "Explain the synthetic delimiter example without using tools.".to_string(),
        codex_runtime_config: json!({
            "providerId": "fixture", "name": "Synthetic fixture", "baseUrl": provider_url,
            "envKey": "OPENAI_API_KEY", "wireApi": "responses", "supportsWebsockets": false
        })
        .to_string(),
        ..RunPayload::default()
    };
    std::fs::write(&payload_path, serde_json::to_vec(&payload)?)?;
    let mut config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: "citation-native-probe".to_string(),
        cli_agent_type: "codex".to_string(),
        use_mock_codex: "true".to_string(),
        mock_codex_path: Some(binary),
        run_payload_file: payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir.clone()),
        home: Some(home.to_string_lossy().into_owned()),
        resume_session_id: resume,
        ..GuestConfigRaw::default()
    })?;
    config.codex_home_dir = home.join("codex").to_string_lossy().into_owned();
    config.user_env.insert(
        "OPENAI_API_KEY".to_string(),
        "synthetic-no-provider-secret".to_string(),
    );
    config
        .user_env
        .insert("OPENAI_MODEL".to_string(), "gpt-5.4".to_string());
    let paths = GuestPaths::from_runtime_dir(runtime_dir);
    let http = HttpClient::for_config(&config)?;
    let active = ActiveInputRuntime::new_disabled(&config.run_id, &config.prompt);
    let result = execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        None,
        http,
        active.into_writer(),
        &config,
        &paths,
    )
    .await?;
    let events: Vec<Value> = std::fs::read_to_string(paths.agent_log_file())?
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    let visible: Vec<&str> = events
        .iter()
        .filter(|event| {
            event.pointer("/item/type").and_then(Value::as_str) == Some("agent_message")
        })
        .filter_map(|event| event.pointer("/item/text").and_then(Value::as_str))
        .collect();
    println!(
        "{}",
        json!({"exitCode": result.exit_code, "threadId": std::fs::read_to_string(paths.session_id_file())?, "visible": visible})
    );
    Ok(())
}
