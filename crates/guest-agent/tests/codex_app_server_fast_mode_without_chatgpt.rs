//! Fast-tier rejection coverage for non-ChatGPT Codex app-server runs.

#[path = "common/codex_app_server_startup.rs"]
mod codex_app_server_startup;
mod common;

use std::collections::HashMap;

#[tokio::test]
async fn codex_app_server_omits_fast_mode_without_chatgpt_account()
-> Result<(), Box<dyn std::error::Error>> {
    codex_app_server_startup::assert_codex_app_server_startup_case(
        codex_app_server_startup::CodexAppServerStartupCase {
            run_id: "codex-app-server-fast-mode-without-chatgpt-test",
            user_env: HashMap::from([
                ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
                ("OPENAI_MODEL".to_string(), "gpt-5.5".to_string()),
                ("VM0_CODEX_SERVICE_TIER".to_string(), "fast".to_string()),
            ]),
            expect_fast_mode: false,
        },
    )
    .await
}
