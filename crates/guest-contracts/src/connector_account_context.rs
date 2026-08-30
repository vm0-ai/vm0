//! Non-secret connector account selection exposed to managed CLI children.

/// Current connector account context schema version.
pub const SCHEMA_VERSION: u8 = 1;

/// One run's connector account selections.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConnectorAccountContext {
    /// Wire schema version.
    pub schema_version: u8,
    /// Logical connector targets admitted for the run.
    pub targets: Vec<RunConnectorAccountTarget>,
}

/// One logical connector target and its run-pinned account, when available.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RunConnectorAccountTarget {
    /// Built-in connector target.
    #[serde(rename_all = "camelCase")]
    Builtin {
        /// Public connector slug.
        connector_slug: String,
        /// Exact connector account selected at admission.
        connection_id: Option<String>,
    },
    /// User-managed custom connector target.
    #[serde(rename_all = "camelCase")]
    Custom {
        /// Custom connector definition id.
        custom_connector_id: String,
        /// Exact connector account selected at admission.
        connection_id: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_uses_versioned_camel_case_wire_shape() {
        let context = RunConnectorAccountContext {
            schema_version: SCHEMA_VERSION,
            targets: vec![
                RunConnectorAccountTarget::Builtin {
                    connector_slug: "github".to_string(),
                    connection_id: Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
                },
                RunConnectorAccountTarget::Custom {
                    custom_connector_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    connection_id: None,
                },
            ],
        };

        assert_eq!(
            serde_json::to_value(context).unwrap(),
            serde_json::json!({
                "schemaVersion": 1,
                "targets": [
                    {
                        "kind": "builtin",
                        "connectorSlug": "github",
                        "connectionId": "550e8400-e29b-41d4-a716-446655440000"
                    },
                    {
                        "kind": "custom",
                        "customConnectorId": "550e8400-e29b-41d4-a716-446655440001",
                        "connectionId": null
                    }
                ]
            })
        );
    }
}
