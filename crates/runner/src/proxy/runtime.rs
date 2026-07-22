//! Private filesystem ownership for PyInstaller one-file extraction.

use std::collections::HashSet;
use std::fs::File;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nix::fcntl::Flock;
use nix::sys::signal::Signal;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::process::{ProcessStat, ProcessStatRead, process_stat_is_live};

pub(super) const RUNTIME_MARKER_ENV: &str = "VM0_MITMDUMP_RUNTIME_DIR";
const RUNTIME_MARKER_PREFIX: &[u8] = b"VM0_MITMDUMP_RUNTIME_DIR=";
const LAUNCH_PREFIX: &str = "launch-";
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_SCAN_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy)]
struct ProcessIdentity {
    pid: u32,
    starttime: u64,
}

/// Serializes owners of the runner-local proxy resources and scopes every
/// PyInstaller extraction to one private launch directory.
pub(super) struct MitmdumpRuntime {
    root: PathBuf,
    _lock: Flock<File>,
}

impl MitmdumpRuntime {
    pub(super) async fn acquire(root: PathBuf, lock_path: PathBuf) -> RunnerResult<Arc<Self>> {
        crate::private_fs::ensure_private_dir(&root).await?;
        let root = tokio::fs::canonicalize(&root).await.map_err(|error| {
            RunnerError::Config(format!(
                "canonicalize mitmdump runtime directory {}: {error}",
                root.display()
            ))
        })?;
        let runtime_lock = crate::lock::try_acquire(lock_path.clone())
            .await
            .map_err(|error| {
                RunnerError::Config(format!(
                    "acquire mitmdump runtime lock {}: {error}",
                    lock_path.display()
                ))
            })?;
        let runtime = Arc::new(Self {
            root,
            _lock: runtime_lock,
        });
        runtime.reconcile().await?;
        Ok(runtime)
    }

    pub(super) async fn create_launch_dir(&self) -> RunnerResult<tempfile::TempDir> {
        self.reconcile().await?;
        tempfile::Builder::new()
            .prefix(LAUNCH_PREFIX)
            .tempdir_in(&self.root)
            .map_err(|error| {
                RunnerError::Internal(format!(
                    "create mitmdump launch directory in {}: {error}",
                    self.root.display()
                ))
            })
    }

    pub(super) async fn close_launch(&self, launch: tempfile::TempDir) -> RunnerResult<()> {
        // Persist before the first await so task cancellation cannot let
        // TempDir remove a directory that a marked descendant still uses.
        let path = launch.keep();
        self.close_launch_path(path).await
    }

    pub(super) async fn close_launch_path(&self, path: PathBuf) -> RunnerResult<()> {
        if !self.is_launch_path(&path) {
            return Err(RunnerError::Internal(format!(
                "refusing to close unowned mitmdump launch path {}",
                path.display()
            )));
        }
        if let Err(error) = self.terminate_marked_processes(Some(&path)).await {
            warn!(path = %path.display(), error = %error, "preserving mitmdump launch directory for later reconciliation");
            return Err(error);
        }
        match tokio::fs::remove_dir_all(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(RunnerError::Internal(format!(
                "remove mitmdump launch directory {}: {error}",
                path.display()
            ))),
        }
    }

    async fn reconcile(&self) -> RunnerResult<()> {
        let launch_dirs = self.discover_launch_dirs().await?;
        if launch_dirs.is_empty() {
            return Ok(());
        }
        self.terminate_marked_processes(None).await?;

        let mut removed = 0usize;
        for launch_dir in launch_dirs {
            match tokio::fs::remove_dir_all(&launch_dir).await {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(RunnerError::Internal(format!(
                        "remove stale mitmdump launch directory {}: {error}",
                        launch_dir.display()
                    )));
                }
            }
        }
        if removed > 0 {
            info!(removed, root = %self.root.display(), "reconciled stale mitmdump launch directories");
        }
        Ok(())
    }

    async fn discover_launch_dirs(&self) -> RunnerResult<Vec<PathBuf>> {
        let expected_uid = nix::unistd::geteuid().as_raw();
        let mut entries = tokio::fs::read_dir(&self.root).await.map_err(|error| {
            RunnerError::Internal(format!(
                "read mitmdump runtime directory {}: {error}",
                self.root.display()
            ))
        })?;
        let mut launch_dirs = Vec::new();
        loop {
            let entry = entries.next_entry().await.map_err(|error| {
                RunnerError::Internal(format!(
                    "read entry in mitmdump runtime directory {}: {error}",
                    self.root.display()
                ))
            })?;
            let Some(entry) = entry else {
                break;
            };
            let name = entry.file_name();
            if !name.as_bytes().starts_with(LAUNCH_PREFIX.as_bytes()) {
                continue;
            }
            let path = entry.path();
            let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|error| {
                RunnerError::Internal(format!(
                    "inspect mitmdump launch path {}: {error}",
                    path.display()
                ))
            })?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(RunnerError::Config(format!(
                    "mitmdump launch path {} is not an owned directory",
                    path.display()
                )));
            }
            if metadata.uid() != expected_uid {
                return Err(RunnerError::Config(format!(
                    "mitmdump launch directory {} is owned by uid {}, expected {}",
                    path.display(),
                    metadata.uid(),
                    expected_uid
                )));
            }
            launch_dirs.push(path);
        }
        launch_dirs.sort();
        Ok(launch_dirs)
    }

    async fn terminate_marked_processes(&self, exact_path: Option<&Path>) -> RunnerResult<()> {
        let deadline = tokio::time::Instant::now() + PROCESS_EXIT_TIMEOUT;
        let mut consecutive_empty_scans = 0u8;
        loop {
            let processes = self.scan_marked_processes(exact_path).await?;
            if processes.is_empty() {
                consecutive_empty_scans += 1;
                if consecutive_empty_scans == 2 {
                    return Ok(());
                }
            } else {
                consecutive_empty_scans = 0;
                for process in processes {
                    signal_stable_process(process).await?;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                let target = exact_path.unwrap_or(&self.root);
                return Err(RunnerError::Internal(format!(
                    "timed out terminating mitmdump processes using {}",
                    target.display()
                )));
            }
            tokio::time::sleep(PROCESS_SCAN_INTERVAL).await;
        }
    }

    async fn scan_marked_processes(
        &self,
        exact_path: Option<&Path>,
    ) -> RunnerResult<Vec<ProcessIdentity>> {
        let expected_uid = nix::unistd::geteuid().as_raw();
        let mut entries = tokio::fs::read_dir("/proc").await.map_err(|error| {
            RunnerError::Internal(format!("scan /proc for mitmdump runtime owners: {error}"))
        })?;
        let mut processes = Vec::new();
        let mut seen = HashSet::new();
        loop {
            let entry = entries.next_entry().await.map_err(|error| {
                RunnerError::Internal(format!(
                    "read /proc entry for mitmdump runtime owners: {error}"
                ))
            })?;
            let Some(entry) = entry else {
                break;
            };
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            let metadata = match entry.metadata().await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(RunnerError::Internal(format!(
                        "inspect /proc/{pid} for mitmdump runtime owner: {error}"
                    )));
                }
            };
            if metadata.uid() != expected_uid {
                continue;
            }
            let Some(environ) = read_process_environ(pid).await? else {
                continue;
            };
            let Some(marker) = runtime_marker(&environ) else {
                continue;
            };
            let marker_path = Path::new(std::ffi::OsStr::from_bytes(marker));
            if !self.is_launch_path(marker_path)
                || exact_path.is_some_and(|expected| marker_path != expected)
            {
                continue;
            }
            let before = match crate::process::read_process_stat_checked(pid).await {
                ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
                ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
                ProcessStatRead::Unreadable(error) => {
                    return Err(RunnerError::Internal(format!(
                        "read /proc/{pid}/stat for mitmdump runtime owner: {error}"
                    )));
                }
                ProcessStatRead::Invalid => {
                    return Err(RunnerError::Internal(format!(
                        "parse /proc/{pid}/stat for mitmdump runtime owner"
                    )));
                }
            };
            let Some(rechecked_environ) = read_process_environ(pid).await? else {
                continue;
            };
            if runtime_marker(&rechecked_environ) != Some(marker) {
                continue;
            }
            let after = match crate::process::read_process_stat_checked(pid).await {
                ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
                ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
                ProcessStatRead::Unreadable(error) => {
                    return Err(RunnerError::Internal(format!(
                        "recheck /proc/{pid}/stat for mitmdump runtime owner: {error}"
                    )));
                }
                ProcessStatRead::Invalid => {
                    return Err(RunnerError::Internal(format!(
                        "reparse /proc/{pid}/stat for mitmdump runtime owner"
                    )));
                }
            };
            if !same_process(&before, &after) || !seen.insert((pid, after.starttime)) {
                continue;
            }
            processes.push(ProcessIdentity {
                pid,
                starttime: after.starttime,
            });
        }
        Ok(processes)
    }

    fn is_launch_path(&self, path: &Path) -> bool {
        path.parent() == Some(self.root.as_path())
            && path
                .file_name()
                .is_some_and(|name| name.as_bytes().starts_with(LAUNCH_PREFIX.as_bytes()))
    }
}

async fn read_process_environ(pid: u32) -> RunnerResult<Option<Vec<u8>>> {
    match tokio::fs::read(format!("/proc/{pid}/environ")).await {
        Ok(environ) => Ok(Some(environ)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) if process_comm_is_mitmdump(pid).await? => Err(RunnerError::Internal(format!(
            "read /proc/{pid}/environ for mitmdump runtime owner: {error}"
        ))),
        Err(_) => Ok(None),
    }
}

async fn process_comm_is_mitmdump(pid: u32) -> RunnerResult<bool> {
    let path = format!("/proc/{pid}/comm");
    match tokio::fs::read(&path).await {
        Ok(comm) => Ok(comm.strip_suffix(b"\n").unwrap_or(&comm) == b"mitmdump"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(RunnerError::Internal(format!(
            "read {path} after an unreadable process environment: {error}"
        ))),
    }
}

fn runtime_marker(environ: &[u8]) -> Option<&[u8]> {
    environ
        .split(|byte| *byte == 0)
        .find_map(|entry| entry.strip_prefix(RUNTIME_MARKER_PREFIX))
}

fn same_process(before: &ProcessStat, after: &ProcessStat) -> bool {
    before.pgid == after.pgid && before.starttime == after.starttime
}

async fn signal_stable_process(process: ProcessIdentity) -> RunnerResult<()> {
    let current = match crate::process::read_process_stat_checked(process.pid).await {
        ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
        ProcessStatRead::Found(_) | ProcessStatRead::Missing => return Ok(()),
        ProcessStatRead::Unreadable(error) => {
            return Err(RunnerError::Internal(format!(
                "recheck /proc/{}/stat before mitmdump cleanup signal: {error}",
                process.pid
            )));
        }
        ProcessStatRead::Invalid => {
            return Err(RunnerError::Internal(format!(
                "reparse /proc/{}/stat before mitmdump cleanup signal",
                process.pid
            )));
        }
    };
    if current.starttime != process.starttime {
        return Ok(());
    }
    let pid = i32::try_from(process.pid).map_err(|error| {
        RunnerError::Internal(format!(
            "convert mitmdump cleanup pid {}: {error}",
            process.pid
        ))
    })?;
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), Signal::SIGKILL) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        Err(error) => Err(RunnerError::Internal(format!(
            "kill mitmdump runtime owner pid {}: {error}",
            process.pid
        ))),
    }
}

pub(super) fn preserve_launch(launch: tempfile::TempDir, error: &impl std::fmt::Display) {
    let path = launch.path().to_path_buf();
    let _kept_path = launch.keep();
    warn!(path = %path.display(), error = %error, "preserving mitmdump launch directory for later reconciliation");
}
