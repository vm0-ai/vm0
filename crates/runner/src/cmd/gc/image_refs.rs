use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use tracing::warn;

use crate::config;
use crate::image_hash;

type ProtectedImageRefMap = HashMap<String, HashSet<String>>;

pub(super) enum ProtectedImageRefs {
    Complete(ProtectedImageRefMap),
    Incomplete,
}

impl ProtectedImageRefs {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) const fn is_complete(&self) -> bool {
        matches!(self, Self::Complete(_))
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        match self {
            Self::Complete(refs) => refs.is_empty(),
            Self::Incomplete => false,
        }
    }

    #[cfg(test)]
    pub(super) const fn incomplete() -> Self {
        Self::Incomplete
    }
}

impl Default for ProtectedImageRefs {
    fn default() -> Self {
        Self::Complete(HashMap::new())
    }
}

#[derive(serde::Deserialize)]
struct ConfigImageRefs {
    profiles: BTreeMap<String, ConfigProfileImageRef>,
}

#[derive(serde::Deserialize)]
struct ConfigProfileImageRef {
    rootfs_hash: String,
    snapshot_hash: String,
}

fn insert_protected_image_ref(
    protected_image_refs: &mut ProtectedImageRefs,
    rootfs_hash: String,
    snapshot_hash: String,
) {
    if let ProtectedImageRefs::Complete(refs) = protected_image_refs {
        refs.entry(rootfs_hash).or_default().insert(snapshot_hash);
    }
}

pub(super) fn is_protected_image_ref(
    protected_image_refs: &ProtectedImageRefs,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> bool {
    match protected_image_refs {
        ProtectedImageRefs::Complete(refs) => refs
            .get(rootfs_hash)
            .is_some_and(|snapshot_hashes| snapshot_hashes.contains(snapshot_hash)),
        // Preserve fail-closed behavior if a future caller checks a pair
        // without first rejecting the incomplete inventory.
        ProtectedImageRefs::Incomplete => true,
    }
}

pub(super) async fn protected_image_refs_for_gc(
    retained_config_paths: &[PathBuf],
    resource_inventory_complete: bool,
) -> ProtectedImageRefs {
    if !resource_inventory_complete {
        warn!("runner image refs: managed resource inventory incomplete, skipping image GC");
        return ProtectedImageRefs::Incomplete;
    }

    let mut refs = ProtectedImageRefs::new();
    if !collect_retained_config_image_refs(retained_config_paths, &mut refs).await {
        return ProtectedImageRefs::Incomplete;
    }
    refs
}

async fn collect_retained_config_image_refs(
    retained_config_paths: &[PathBuf],
    refs: &mut ProtectedImageRefs,
) -> bool {
    let mut complete = true;
    for config_path in retained_config_paths {
        complete &= collect_config_image_refs(config_path, refs).await;
    }
    complete
}

async fn collect_config_image_refs(config_path: &Path, refs: &mut ProtectedImageRefs) -> bool {
    let Some(content) = (match config::read_diagnostic_config_to_string(config_path).await {
        Ok(content) => content,
        Err(e) => {
            warn!(
                "runner image refs: cannot read retained config {} ({e}), skipping image GC",
                config_path.display()
            );
            return false;
        }
    }) else {
        warn!(
            "runner image refs: retained config {} is missing, skipping path",
            config_path.display()
        );
        return true;
    };

    let config = match serde_yaml_ng::from_str::<ConfigImageRefs>(&content) {
        Ok(config) => config,
        Err(_) => {
            warn!(
                "runner image refs: cannot parse retained config {}, skipping image GC",
                config_path.display()
            );
            return false;
        }
    };
    for (_, profile_ref) in config.profiles {
        if image_hash::validate_or_err(&profile_ref.rootfs_hash).is_err() {
            warn!(
                "runner image refs: retained config {} has a profile with an invalid rootfs hash, skipping image GC",
                config_path.display()
            );
            return false;
        }
        if image_hash::validate_or_err(&profile_ref.snapshot_hash).is_err() {
            warn!(
                "runner image refs: retained config {} has a profile with an invalid snapshot hash, skipping image GC",
                config_path.display()
            );
            return false;
        }
        insert_protected_image_ref(refs, profile_ref.rootfs_hash, profile_ref.snapshot_hash);
    }
    true
}

#[cfg(test)]
mod tests;
