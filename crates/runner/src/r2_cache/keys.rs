pub(super) const LEGACY_ROOTFS_KEY_PREFIX: &str = "runner-images/";
pub(super) const TEMPLATE_KEY_PREFIX: &str = "runner-templates/";

#[cfg(test)]
pub(super) fn key_for_hash(hash: &str) -> String {
    format!("{LEGACY_ROOTFS_KEY_PREFIX}{hash}.tar.zst")
}

pub(super) fn key_for_template_hash(hash: &str) -> String {
    format!("{TEMPLATE_KEY_PREFIX}{hash}.tar.zst")
}
