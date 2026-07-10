use std::fs;

pub(crate) use guest_contracts::storage_manifest::{ArtifactEntry, Manifest, StorageEntry};

pub(crate) fn load(manifest_path: &str) -> Result<Manifest, ManifestLoadError> {
    let manifest_json = fs::read_to_string(manifest_path).map_err(ManifestLoadError::Read)?;
    parse(manifest_json.as_bytes()).map_err(ManifestLoadError::Parse)
}

pub(crate) fn parse(manifest_json: &[u8]) -> Result<Manifest, serde_json::Error> {
    serde_json::from_slice(manifest_json)
}

pub(crate) enum ManifestLoadError {
    Read(std::io::Error),
    Parse(serde_json::Error),
}
