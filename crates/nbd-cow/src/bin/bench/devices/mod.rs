use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

mod dm;
mod loop_device;
mod nbd;

pub(crate) use dm::{DmMappingGuard, cleanup_stale_dm_mappings};
pub(crate) use loop_device::LoopDeviceGuard;
pub(crate) use nbd::{cleanup_stale_nbd_devices, nbd_module_loaded};

pub(crate) struct TempFileCleanup {
    path: PathBuf,
}

impl TempFileCleanup {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempFileCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) fn create_sparse_file(path: &Path, size: u64) -> Result<(), String> {
    let f = std::fs::File::create(path)
        .map_err(|e| format!("failed to create {}: {e}", path.display()))?;
    f.set_len(size)
        .map_err(|e| format!("failed to set {} size: {e}", path.display()))?;
    Ok(())
}

fn run_cmd(cmd: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("{cmd} failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{cmd} failed: {stderr}"));
    }
    Ok(())
}

pub(crate) fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

pub(crate) fn tool_exists(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let Ok(cwd) = std::env::current_dir() else {
        return false;
    };
    tool_exists_in(name, &paths, &cwd)
}

fn tool_exists_in(name: &str, paths: &OsStr, cwd: &Path) -> bool {
    which::which_in(name, Some(paths), cwd).is_ok()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn tool_exists_in_finds_only_executable_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let executable = temp_dir.path().join("available-tool");
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let non_executable = temp_dir.path().join("non-executable-tool");
        std::fs::write(&non_executable, "not executable\n").unwrap();
        let mut permissions = std::fs::metadata(&non_executable).unwrap().permissions();
        permissions.set_mode(0o644);
        std::fs::set_permissions(&non_executable, permissions).unwrap();

        let paths = std::env::join_paths([temp_dir.path()]).unwrap();
        assert!(tool_exists_in("available-tool", &paths, temp_dir.path()));
        assert!(!tool_exists_in("missing-tool", &paths, temp_dir.path()));
        assert!(!tool_exists_in(
            "non-executable-tool",
            &paths,
            temp_dir.path()
        ));
    }
}
