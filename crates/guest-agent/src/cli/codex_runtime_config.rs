//! Codex runtime provider configuration owned by vm0.
//!
//! The API resolves provider capability metadata before dispatch. The guest
//! only translates that structured payload into Codex startup configuration.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::AgentError;

const MODEL_CATALOG_FILENAME: &str = "vm0-model-catalog.json";

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexRuntimeConfig {
    pub provider_id: String,
    pub name: String,
    pub base_url: String,
    pub env_key: String,
    pub wire_api: String,
    pub supports_websockets: bool,
    #[serde(default)]
    pub model_catalog: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct BundledModelCatalog {
    models: Vec<BundledModel>,
}

#[derive(serde::Deserialize)]
struct BundledModel {
    priority: i64,
    visibility: String,
    supported_in_api: bool,
    base_instructions: String,
    model_messages: serde_json::Value,
}

pub(super) fn parse_raw(raw: &str) -> Result<Option<CodexRuntimeConfig>, AgentError> {
    if raw.is_empty() {
        return Ok(None);
    }
    let config: CodexRuntimeConfig = serde_json::from_str(raw)?;
    validate_config(&config)?;
    Ok(Some(config))
}

fn validate_config(config: &CodexRuntimeConfig) -> Result<(), AgentError> {
    if !is_codex_config_key_segment(&config.provider_id) {
        return Err(AgentError::Execution(
            "invalid Codex runtime provider id".to_string(),
        ));
    }
    if !is_env_var_name(&config.env_key) {
        return Err(AgentError::Execution(
            "invalid Codex runtime auth env key".to_string(),
        ));
    }
    Ok(())
}

fn is_codex_config_key_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_env_var_name(value: &str) -> bool {
    let Some(first) = value.bytes().next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub(super) fn write_model_catalog_from_raw(home_dir: &str, raw: &str) -> Result<(), AgentError> {
    let Some(config) = parse_raw(raw)? else {
        return Ok(());
    };
    write_model_catalog(
        &crate::codex_auth::codex_home_path(Path::new(home_dir)),
        &config,
    )
}

pub(super) fn model_catalog_path(codex_home: &Path) -> PathBuf {
    codex_home.join(MODEL_CATALOG_FILENAME)
}

pub(super) fn write_model_catalog(
    codex_home: &Path,
    config: &CodexRuntimeConfig,
) -> Result<(), AgentError> {
    let Some(model_catalog) = &config.model_catalog else {
        return Ok(());
    };
    let model_catalog = if config.provider_id == "vm0-model" {
        inherit_default_model_instructions(model_catalog, load_bundled_model_catalog()?)?
    } else {
        model_catalog.clone()
    };
    std::fs::create_dir_all(codex_home)?;
    let path = model_catalog_path(codex_home);
    write_model_catalog_json_atomic(codex_home, &path, &serde_json::to_vec(&model_catalog)?)?;
    Ok(())
}

fn load_bundled_model_catalog() -> Result<BundledModelCatalog, AgentError> {
    let output = Command::new("codex")
        .args(["debug", "models", "--bundled"])
        .output()?;
    if !output.status.success() {
        return Err(AgentError::Execution(
            "failed to read the bundled Codex model catalog".to_string(),
        ));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn inherit_default_model_instructions(
    model_catalog: &serde_json::Value,
    bundled: BundledModelCatalog,
) -> Result<serde_json::Value, AgentError> {
    let source = bundled
        .models
        .into_iter()
        .filter(|model| model.visibility == "list" && model.supported_in_api)
        .min_by_key(|model| model.priority)
        .ok_or_else(|| {
            AgentError::Execution(
                "bundled Codex model catalog has no default model instructions".to_string(),
            )
        })?;
    let mut hydrated = model_catalog.clone();
    let models = hydrated
        .get_mut("models")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| AgentError::Execution("invalid Codex model catalog".to_string()))?;
    for model in models {
        let model = model
            .as_object_mut()
            .ok_or_else(|| AgentError::Execution("invalid Codex model entry".to_string()))?;
        model.insert(
            "base_instructions".to_string(),
            serde_json::Value::String(source.base_instructions.clone()),
        );
        model.insert("model_messages".to_string(), source.model_messages.clone());
    }
    Ok(hydrated)
}

fn write_model_catalog_json_atomic(
    codex_home: &Path,
    path: &Path,
    serialized: &[u8],
) -> Result<(), AgentError> {
    use std::io::Write as _;

    let mut temp = tempfile::NamedTempFile::new_in(codex_home)?;
    temp.as_file_mut().write_all(serialized)?;
    temp.as_file_mut().flush()?;
    temp.persist(path).map_err(|error| {
        AgentError::Io(std::io::Error::new(
            error.error.kind(),
            format!(
                "failed to replace {} atomically: {}",
                path.display(),
                error.error
            ),
        ))
    })?;
    Ok(())
}

pub(super) fn startup_config_overrides(
    config: Option<&CodexRuntimeConfig>,
    codex_home: &Path,
) -> Vec<String> {
    let Some(config) = config else {
        return Vec::new();
    };
    let provider_prefix = format!("model_providers.{}", config.provider_id);
    let mut overrides = vec![
        format!(
            "model_provider={}",
            quote_toml_basic_string(&config.provider_id)
        ),
        format!(
            "{provider_prefix}.name={}",
            quote_toml_basic_string(&config.name)
        ),
        format!(
            "{provider_prefix}.base_url={}",
            quote_toml_basic_string(&config.base_url)
        ),
        format!(
            "{provider_prefix}.env_key={}",
            quote_toml_basic_string(&config.env_key)
        ),
        format!(
            "{provider_prefix}.wire_api={}",
            quote_toml_basic_string(&config.wire_api)
        ),
        format!(
            "{provider_prefix}.supports_websockets={}",
            config.supports_websockets
        ),
    ];
    if config.model_catalog.is_some() {
        overrides.push(format!(
            "model_catalog_json={}",
            quote_toml_basic_string(&model_catalog_path(codex_home).to_string_lossy())
        ));
    }
    overrides
}

pub(super) fn quote_toml_basic_string(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\t' => quoted.push_str("\\t"),
            '\u{08}' => quoted.push_str("\\b"),
            '\u{0C}' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            ch if ch.is_control() => quoted.push_str(&format!("\\u{:04X}", u32::from(ch))),
            ch => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn startup_config_overrides_include_provider_and_catalog_path() {
        let codex_home = Path::new("/tmp/codex-home");
        let config = CodexRuntimeConfig {
            provider_id: "minimax".to_string(),
            name: "MiniMax".to_string(),
            base_url: "https://api.minimax.io/v1".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: Some(json!({ "models": [{ "slug": "MiniMax-M3" }] })),
        };

        let overrides = startup_config_overrides(Some(&config), codex_home);

        assert_eq!(overrides[0], r#"model_provider="minimax""#);
        assert!(overrides.contains(&r#"model_providers.minimax.name="MiniMax""#.to_string()));
        assert!(overrides.contains(
            &r#"model_providers.minimax.base_url="https://api.minimax.io/v1""#.to_string()
        ));
        assert!(
            overrides.contains(&r#"model_providers.minimax.env_key="OPENAI_API_KEY""#.to_string())
        );
        assert!(overrides.contains(&r#"model_providers.minimax.wire_api="responses""#.to_string()));
        assert!(
            overrides.contains(&r#"model_providers.minimax.supports_websockets=false"#.to_string())
        );
        assert!(overrides.contains(
            &r#"model_catalog_json="/tmp/codex-home/vm0-model-catalog.json""#.to_string()
        ));
    }

    #[test]
    fn parse_raw_rejects_unsafe_provider_key_segments() {
        let raw = r#"{
            "providerId": "provider.with.dot",
            "name": "Provider",
            "baseUrl": "https://example.test/v1",
            "envKey": "OPENAI_API_KEY",
            "wireApi": "responses",
            "supportsWebsockets": false
        }"#;

        let error = parse_raw(raw).unwrap_err().to_string();

        assert!(error.contains("invalid Codex runtime provider id"));
        assert!(!error.contains("provider.with.dot"));
    }

    #[test]
    fn parse_raw_rejects_invalid_auth_env_keys() {
        let raw = r#"{
            "providerId": "provider",
            "name": "Provider",
            "baseUrl": "https://example.test/v1",
            "envKey": "OPENAI-API-KEY",
            "wireApi": "responses",
            "supportsWebsockets": false
        }"#;

        let error = parse_raw(raw).unwrap_err().to_string();

        assert!(error.contains("invalid Codex runtime auth env key"));
        assert!(!error.contains("OPENAI-API-KEY"));
    }

    #[test]
    fn startup_config_overrides_use_codex_dotted_path_segments() {
        let config = CodexRuntimeConfig {
            provider_id: "provider-with-dash".to_string(),
            name: "Provider".to_string(),
            base_url: "https://example.test/v1".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: None,
        };

        let overrides = startup_config_overrides(Some(&config), Path::new("/tmp/codex-home"));

        assert!(overrides.contains(
            &r#"model_providers.provider-with-dash.base_url="https://example.test/v1""#.to_string()
        ));
        assert!(
            !overrides
                .iter()
                .any(|override_value| override_value.starts_with("model_catalog_json="))
        );
    }

    #[test]
    fn write_model_catalog_writes_json_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let config = CodexRuntimeConfig {
            provider_id: "minimax".to_string(),
            name: "MiniMax".to_string(),
            base_url: "https://api.minimax.io/v1".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: Some(json!({ "models": [{ "slug": "MiniMax-M3" }] })),
        };

        write_model_catalog(tmp.path(), &config).unwrap();

        let written = std::fs::read_to_string(model_catalog_path(tmp.path())).unwrap();
        assert_eq!(written, r#"{"models":[{"slug":"MiniMax-M3"}]}"#);
    }

    #[cfg(unix)]
    #[test]
    fn write_model_catalog_replaces_existing_symlink_without_touching_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let symlink_target = tmp.path().join("target-catalog.json");
        std::fs::write(&symlink_target, b"TARGET_CONTENT_MUST_SURVIVE").unwrap();
        symlink(&symlink_target, model_catalog_path(&codex_home)).unwrap();
        let config = CodexRuntimeConfig {
            provider_id: "minimax".to_string(),
            name: "MiniMax".to_string(),
            base_url: "https://api.minimax.io/v1".to_string(),
            env_key: "OPENAI_API_KEY".to_string(),
            wire_api: "responses".to_string(),
            supports_websockets: false,
            model_catalog: Some(json!({ "models": [{ "slug": "MiniMax-M3" }] })),
        };

        write_model_catalog(&codex_home, &config).unwrap();

        assert_eq!(
            std::fs::read_to_string(&symlink_target).unwrap(),
            "TARGET_CONTENT_MUST_SURVIVE",
            "model catalog replacement must not write through an existing symlink"
        );
        assert!(
            !std::fs::symlink_metadata(model_catalog_path(&codex_home))
                .unwrap()
                .file_type()
                .is_symlink(),
            "model catalog path should be a regular replacement file, not the old symlink"
        );
        let written = std::fs::read_to_string(model_catalog_path(&codex_home)).unwrap();
        assert_eq!(written, r#"{"models":[{"slug":"MiniMax-M3"}]}"#);
    }

    #[test]
    fn inherit_default_model_instructions_uses_highest_priority_visible_model() {
        let target = json!({
            "models": [{
                "slug": "vm0-model",
                "base_instructions": "",
                "model_messages": null,
                "context_window": 1_000_000
            }]
        });
        let bundled = BundledModelCatalog {
            models: vec![
                BundledModel {
                    priority: 0,
                    visibility: "hide".to_string(),
                    supported_in_api: true,
                    base_instructions: "hidden instructions".to_string(),
                    model_messages: serde_json::Value::Null,
                },
                BundledModel {
                    priority: 2,
                    visibility: "list".to_string(),
                    supported_in_api: true,
                    base_instructions: "lower priority instructions".to_string(),
                    model_messages: serde_json::Value::Null,
                },
                BundledModel {
                    priority: 1,
                    visibility: "list".to_string(),
                    supported_in_api: true,
                    base_instructions: "default instructions".to_string(),
                    model_messages: json!({
                        "instructions_template": "default template",
                        "instructions_variables": null,
                        "approvals": null,
                        "auto_review": null
                    }),
                },
            ],
        };

        let hydrated = inherit_default_model_instructions(&target, bundled).unwrap();

        assert_eq!(
            hydrated["models"][0]["base_instructions"],
            "default instructions"
        );
        assert_eq!(
            hydrated["models"][0]["model_messages"]["instructions_template"],
            "default template"
        );
        assert_eq!(hydrated["models"][0]["context_window"], 1_000_000);
    }
}
