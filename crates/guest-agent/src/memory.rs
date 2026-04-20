//! Auto-memory symlink setup for Claude Code.
//!
//! Creates a symlink from Claude Code's expected auto-memory directory to the
//! vm0 memory volume mount path, enabling native auto-memory read/write.

use guest_common::{log_info, log_warn};
use std::path::Path;

use crate::artifact;
use crate::env;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Snapshot of the memory mount's content at boot, used by the checkpoint
/// step to detect whether the CLI modified memory during the run. `None`
/// means memory is not configured or the mount doesn't exist — in both cases
/// the checkpoint step falls through to the normal path. Propagated
/// explicitly from `main::execute` into `checkpoint::create_checkpoint` to
/// avoid process-wide mutable state.
pub type MemoryBootFingerprint = Option<[u8; 32]>;

/// Capture the memory mount's fingerprint right now. Must be called during
/// init, before the CLI can modify the mount. Returns `None` when memory
/// isn't configured or the mount doesn't exist — in either case the
/// checkpoint step's `has_memory` / `mount exists` early-returns fire, so
/// the captured value would go unused.
///
/// The walk + per-file SHA-256 is offloaded to `spawn_blocking` because it
/// can take tens to hundreds of ms for large memory directories and would
/// otherwise block a runtime worker thread.
pub async fn capture_boot_fingerprint() -> MemoryBootFingerprint {
    if env::memory_driver().is_empty() || env::memory_name().is_empty() {
        return None;
    }
    let mount = env::memory_mount_path();
    if mount.is_empty() || !Path::new(mount).exists() {
        return None;
    }
    let mount = mount.to_string();
    match tokio::task::spawn_blocking(move || artifact::compute_directory_fingerprint(&mount)).await
    {
        Ok(fp) => Some(fp),
        Err(e) => {
            // spawn_blocking only returns Err on panic. Log so a silent
            // loss of the skip optimization is observable in production.
            log_warn!(LOG_TAG, "memory boot fingerprint capture failed: {e}");
            None
        }
    }
}

/// Compute Claude Code's project directory name from a working directory path.
///
/// Encoding: strip leading "/", replace remaining "/" with "-", prepend "-".
/// Example: "/home/user/workspace" → "-home-user-workspace"
fn encode_project_name(working_dir: &str) -> String {
    let stripped = working_dir.strip_prefix('/').unwrap_or(working_dir);
    format!("-{}", stripped.replace('/', "-"))
}

/// Set up a symlink from Claude Code's auto-memory directory to the vm0
/// memory mount path.
///
/// Returns `true` if the symlink was created, `false` if skipped.
///
/// No-op when:
/// - No memory volume configured (mount path empty)
/// - Memory mount path doesn't exist on disk
/// - Symlink target already exists
pub fn setup_auto_memory_symlink() -> bool {
    let memory_mount = env::memory_mount_path();
    if memory_mount.is_empty() {
        return false;
    }

    let mount_path = Path::new(memory_mount);
    if !mount_path.exists() {
        return false;
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let project_name = encode_project_name(env::working_dir());
    let auto_memory_dir = Path::new(&home)
        .join(".claude")
        .join("projects")
        .join(&project_name)
        .join("memory");

    if auto_memory_dir.exists() {
        return false;
    }

    // Create parent directories
    if let Some(parent) = auto_memory_dir.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        log_info!(LOG_TAG, "Failed to create auto-memory parent dir: {e}");
        return false;
    }

    // Create symlink
    if let Err(e) = std::os::unix::fs::symlink(mount_path, &auto_memory_dir) {
        log_info!(LOG_TAG, "Failed to create auto-memory symlink: {e}");
        return false;
    }

    log_info!(
        LOG_TAG,
        "Auto-memory symlink: {} → {}",
        auto_memory_dir.display(),
        mount_path.display()
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_project_name_standard_path() {
        assert_eq!(
            encode_project_name("/home/user/workspace"),
            "-home-user-workspace"
        );
    }

    #[test]
    fn encode_project_name_root() {
        assert_eq!(encode_project_name("/"), "-");
    }

    #[test]
    fn encode_project_name_deeply_nested() {
        assert_eq!(encode_project_name("/a/b/c/d/e/f"), "-a-b-c-d-e-f");
    }

    #[test]
    fn encode_project_name_no_leading_slash() {
        assert_eq!(encode_project_name("relative/path"), "-relative-path");
    }

    #[test]
    fn encode_project_name_single_component() {
        assert_eq!(encode_project_name("/workspace"), "-workspace");
    }

    #[test]
    fn encode_project_name_empty() {
        assert_eq!(encode_project_name(""), "-");
    }

    #[test]
    fn encode_project_name_workspaces_vm0() {
        assert_eq!(encode_project_name("/workspaces/vm0"), "-workspaces-vm0");
    }
}
