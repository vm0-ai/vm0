use std::path::Path;

#[must_use]
pub struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    pub fn set(path: impl AsRef<Path>) -> Self {
        guest_common::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}
