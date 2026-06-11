use std::collections::HashMap;

use api_contracts::generated::types::runners::storage::StorageManifest;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Compact version fingerprints for storage manifest entries.
/// Used to skip re-downloading unchanged storages on VM reuse.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StorageFingerprints {
    /// mount_path to version fingerprint for regular storages.
    pub(crate) storages: HashMap<String, StorageFingerprint>,
    /// mount_path to version fingerprint for artifacts.
    pub(crate) artifacts: HashMap<String, StorageFingerprint>,
}

const TAINTED_STORAGE_FINGERPRINT_NAME: &str = "\0vm0-tainted-storage\0";
const TAINTED_STORAGE_FINGERPRINT_VERSION: &str = "\0vm0-tainted-storage\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StorageFingerprint {
    kind: StorageFingerprintKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum StorageFingerprintKind {
    Known {
        vas_storage_name: String,
        vas_version_id: String,
    },
    Tainted,
}

impl StorageFingerprint {
    pub(crate) fn new(
        vas_storage_name: impl Into<String>,
        vas_version_id: impl Into<String>,
    ) -> Self {
        let vas_storage_name = vas_storage_name.into();
        let vas_version_id = vas_version_id.into();
        if vas_storage_name == TAINTED_STORAGE_FINGERPRINT_NAME
            && vas_version_id == TAINTED_STORAGE_FINGERPRINT_VERSION
        {
            return Self::tainted();
        }
        Self {
            kind: StorageFingerprintKind::Known {
                vas_storage_name,
                vas_version_id,
            },
        }
    }

    pub(crate) fn tainted() -> Self {
        Self {
            kind: StorageFingerprintKind::Tainted,
        }
    }

    pub(crate) fn is_tainted(&self) -> bool {
        matches!(self.kind, StorageFingerprintKind::Tainted)
    }

    pub(crate) fn matches(&self, vas_storage_name: &str, vas_version_id: &str) -> bool {
        if self.is_tainted() {
            return false;
        }
        match &self.kind {
            StorageFingerprintKind::Known {
                vas_storage_name: known_name,
                vas_version_id: known_version,
            } => known_name == vas_storage_name && known_version == vas_version_id,
            StorageFingerprintKind::Tainted => false,
        }
    }
}

impl Serialize for StorageFingerprint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match &self.kind {
            StorageFingerprintKind::Known {
                vas_storage_name,
                vas_version_id,
            } => (vas_storage_name, vas_version_id).serialize(serializer),
            StorageFingerprintKind::Tainted => (
                TAINTED_STORAGE_FINGERPRINT_NAME,
                TAINTED_STORAGE_FINGERPRINT_VERSION,
            )
                .serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for StorageFingerprint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let (vas_storage_name, vas_version_id) = <(String, String)>::deserialize(deserializer)?;
        Ok(Self::new(vas_storage_name, vas_version_id))
    }
}

impl StorageFingerprints {
    pub(crate) fn from_manifest(manifest: &StorageManifest) -> Self {
        let mut storages = HashMap::new();
        for s in &manifest.storages {
            storages.insert(
                s.mount_path.clone(),
                StorageFingerprint::new(s.vas_storage_name.clone(), s.vas_version_id.clone()),
            );
        }
        let mut artifacts = HashMap::new();
        for a in &manifest.artifacts {
            artifacts.insert(
                a.mount_path.clone(),
                StorageFingerprint::new(a.vas_storage_name.clone(), a.vas_version_id.clone()),
            );
        }
        Self {
            storages,
            artifacts,
        }
    }

    pub(crate) fn tainted_paths(&self) -> Self {
        Self {
            storages: self
                .storages
                .keys()
                .map(|path| (path.clone(), StorageFingerprint::tainted()))
                .collect(),
            artifacts: self
                .artifacts
                .keys()
                .map(|path| (path.clone(), StorageFingerprint::tainted()))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn known_fingerprint_deserializes_from_legacy_tuple() {
        let fingerprint: StorageFingerprint = serde_json::from_value(json!(["repo", "v1"]))
            .expect("legacy tuple fingerprint should deserialize");

        assert!(!fingerprint.is_tainted());
        assert!(fingerprint.matches("repo", "v1"));
        assert!(!fingerprint.matches("repo", "v2"));
        assert!(!fingerprint.matches("other", "v1"));
    }

    #[test]
    fn known_fingerprint_serializes_to_legacy_tuple() {
        let value = serde_json::to_value(StorageFingerprint::new("repo", "v1"))
            .expect("known fingerprint should serialize");

        assert_eq!(value, json!(["repo", "v1"]));
    }

    #[test]
    fn tainted_fingerprint_deserializes_from_legacy_sentinel_tuple() {
        let fingerprint: StorageFingerprint = serde_json::from_value(json!([
            TAINTED_STORAGE_FINGERPRINT_NAME,
            TAINTED_STORAGE_FINGERPRINT_VERSION
        ]))
        .expect("legacy tainted tuple should deserialize");

        assert!(fingerprint.is_tainted());
        assert!(!fingerprint.matches(
            TAINTED_STORAGE_FINGERPRINT_NAME,
            TAINTED_STORAGE_FINGERPRINT_VERSION
        ));
        assert!(!fingerprint.matches("repo", "v1"));
    }

    #[test]
    fn tainted_fingerprint_serializes_to_legacy_sentinel_tuple() {
        let value = serde_json::to_value(StorageFingerprint::tainted())
            .expect("tainted fingerprint should serialize");

        assert_eq!(
            value,
            json!([
                TAINTED_STORAGE_FINGERPRINT_NAME,
                TAINTED_STORAGE_FINGERPRINT_VERSION
            ])
        );
    }

    #[test]
    fn storage_fingerprints_preserve_legacy_map_value_shape() {
        let fingerprints = StorageFingerprints {
            storages: HashMap::from([(
                "/workspace/repo".to_owned(),
                StorageFingerprint::new("repo", "v1"),
            )]),
            artifacts: HashMap::from([(
                "/workspace/artifact".to_owned(),
                StorageFingerprint::tainted(),
            )]),
        };

        let value =
            serde_json::to_value(&fingerprints).expect("storage fingerprints should serialize");

        assert_eq!(value["storages"]["/workspace/repo"], json!(["repo", "v1"]));
        assert_eq!(
            value["artifacts"]["/workspace/artifact"],
            json!([
                TAINTED_STORAGE_FINGERPRINT_NAME,
                TAINTED_STORAGE_FINGERPRINT_VERSION
            ])
        );

        let parsed: StorageFingerprints =
            serde_json::from_value(value).expect("legacy map value shape should deserialize");
        assert!(
            parsed
                .storages
                .get("/workspace/repo")
                .expect("storage fingerprint should exist")
                .matches("repo", "v1")
        );
        assert!(
            parsed
                .artifacts
                .get("/workspace/artifact")
                .expect("artifact fingerprint should exist")
                .is_tainted()
        );
    }
}
