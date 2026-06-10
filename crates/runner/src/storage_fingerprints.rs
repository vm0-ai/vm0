use std::collections::HashMap;

use api_contracts::generated::types::runners::storage::StorageManifest;
use serde::{Deserialize, Serialize};

/// Compact version fingerprints for storage manifest entries.
/// Used to skip re-downloading unchanged storages on VM reuse.
///
/// All comparisons use `(vas_storage_name, vas_version_id)` tuples.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StorageFingerprints {
    /// mount_path → (vas_storage_name, vas_version_id) for regular storages.
    pub(crate) storages: HashMap<String, (String, String)>,
    /// mount_path → (vas_storage_name, vas_version_id) for artifacts.
    pub(crate) artifacts: HashMap<String, (String, String)>,
}

const TAINTED_STORAGE_FINGERPRINT_NAME: &str = "\0vm0-tainted-storage\0";
const TAINTED_STORAGE_FINGERPRINT_VERSION: &str = "\0vm0-tainted-storage\0";

impl StorageFingerprints {
    pub(crate) fn from_manifest(manifest: &StorageManifest) -> Self {
        let mut storages = HashMap::new();
        for s in &manifest.storages {
            storages.insert(
                s.mount_path.clone(),
                (s.vas_storage_name.clone(), s.vas_version_id.clone()),
            );
        }
        let mut artifacts = HashMap::new();
        for a in &manifest.artifacts {
            artifacts.insert(
                a.mount_path.clone(),
                (a.vas_storage_name.clone(), a.vas_version_id.clone()),
            );
        }
        Self {
            storages,
            artifacts,
        }
    }

    pub(crate) fn tainted_paths(&self) -> Self {
        let tainted = || {
            (
                TAINTED_STORAGE_FINGERPRINT_NAME.to_owned(),
                TAINTED_STORAGE_FINGERPRINT_VERSION.to_owned(),
            )
        };
        Self {
            storages: self
                .storages
                .keys()
                .map(|path| (path.clone(), tainted()))
                .collect(),
            artifacts: self
                .artifacts
                .keys()
                .map(|path| (path.clone(), tainted()))
                .collect(),
        }
    }

    pub(crate) fn fingerprint_is_tainted(fingerprint: &(String, String)) -> bool {
        fingerprint.0 == TAINTED_STORAGE_FINGERPRINT_NAME
            && fingerprint.1 == TAINTED_STORAGE_FINGERPRINT_VERSION
    }
}
