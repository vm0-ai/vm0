use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::process::{
    ProcessTreeKillTarget, kill_process_tree_target, process_tree_kill_target,
    refresh_process_tree_kill_target,
};

pub(crate) const EXEC_CGROUP_ROOT: &str = "/sys/fs/cgroup/vm0-exec";
pub(crate) const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const EVENTS_BUFFER_SIZE: usize = 4096;

#[derive(Clone)]
pub(crate) struct ContainmentManager {
    backend: Arc<ContainmentBackend>,
}

enum ContainmentBackend {
    Cgroup(CgroupManager),
    ProcessGroup,
}

struct CgroupManager {
    root: PathBuf,
    next_id: AtomicU64,
    fixture_files: bool,
}

pub(crate) enum PreparedContainment {
    Cgroup(CgroupLeaf),
    ProcessGroup,
}

pub(crate) enum ProcessContainment {
    Cgroup { leaf: CgroupLeaf, child_id: u32 },
    ProcessGroup(Option<ProcessTreeKillTarget>),
}

pub(crate) struct CgroupLeaf {
    path: PathBuf,
    procs: File,
    kill: File,
    events: File,
    fixture_files: bool,
}

impl Default for ContainmentManager {
    fn default() -> Self {
        if cfg!(debug_assertions) {
            Self {
                backend: Arc::new(ContainmentBackend::ProcessGroup),
            }
        } else {
            Self::cgroup(PathBuf::from(EXEC_CGROUP_ROOT), false)
        }
    }
}

impl ContainmentManager {
    fn cgroup(root: PathBuf, fixture_files: bool) -> Self {
        Self {
            backend: Arc::new(ContainmentBackend::Cgroup(CgroupManager {
                root,
                next_id: AtomicU64::new(1),
                fixture_files,
            })),
        }
    }

    #[cfg(any(debug_assertions, feature = "test-support"))]
    pub(crate) fn fixture(root: PathBuf) -> Self {
        Self::cgroup(root, true)
    }

    pub(crate) fn prepare(&self) -> io::Result<PreparedContainment> {
        match self.backend.as_ref() {
            ContainmentBackend::Cgroup(manager) => {
                manager.prepare().map(PreparedContainment::Cgroup)
            }
            ContainmentBackend::ProcessGroup => Ok(PreparedContainment::ProcessGroup),
        }
    }

    pub(crate) fn audit(&self) -> io::Result<()> {
        let ContainmentBackend::Cgroup(manager) = self.backend.as_ref() else {
            return Ok(());
        };
        manager.audit()
    }
}

impl CgroupManager {
    fn prepare(&self) -> io::Result<CgroupLeaf> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let path = self.root.join(format!("exec-{}-{id}", std::process::id()));
        fs::create_dir(&path)?;

        if self.fixture_files {
            fs::write(path.join("cgroup.procs"), [])?;
            fs::write(path.join("cgroup.kill"), [])?;
            fs::write(path.join("cgroup.events"), b"populated 0\nfrozen 0\n")?;
        }

        let opened = CgroupLeaf::open(path.clone(), self.fixture_files);
        if opened.is_err() {
            remove_leaf_path(&path, self.fixture_files);
        }
        opened
    }

    fn audit(&self) -> io::Result<()> {
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let path = entry.path();
            let events = match open_control(&path.join("cgroup.events"), false) {
                Ok(events) => events,
                Err(error) if error.kind() == io::ErrorKind::NotFound && !path.exists() => {
                    continue;
                }
                Err(error) => return Err(error),
            };
            if read_populated(&events)? {
                return Err(io::Error::other(format!(
                    "exec containment remains populated: {}",
                    path.display()
                )));
            }
            drop(events);
            match remove_leaf(&path, self.fixture_files) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound && !path.exists() => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

impl PreparedContainment {
    pub(crate) fn register_pre_exec(&self, command: &mut Command) {
        let Self::Cgroup(leaf) = self else {
            return;
        };
        let procs_fd = leaf.procs.as_raw_fd();
        // SAFETY: the closure only invokes async-signal-safe write(2) on an
        // already-open close-on-exec cgroup.procs descriptor.
        unsafe {
            command.pre_exec(move || write_current_process(procs_fd));
        }
    }

    pub(crate) fn finish(self, child_id: u32) -> ProcessContainment {
        match self {
            Self::Cgroup(leaf) => ProcessContainment::Cgroup { leaf, child_id },
            Self::ProcessGroup => {
                ProcessContainment::ProcessGroup(Some(process_tree_kill_target(child_id)))
            }
        }
    }

    pub(crate) fn discard(self) {
        if let Self::Cgroup(leaf) = self {
            let path = leaf.path.clone();
            let fixture_files = leaf.fixture_files;
            drop(leaf);
            remove_leaf_path(&path, fixture_files);
        }
    }
}

impl ProcessContainment {
    pub(crate) fn kill(&mut self) -> io::Result<bool> {
        match self {
            Self::Cgroup { leaf, child_id } => {
                write_control(leaf.kill.as_raw_fd(), b"1")?;
                if leaf.fixture_files {
                    let mut target = process_tree_kill_target(*child_id);
                    refresh_process_tree_kill_target(&mut target);
                    // SAFETY: fixture containment is used only while the
                    // direct child remains owned and unreaped by the caller.
                    let _ = unsafe { kill_process_tree_target(target) };
                }
                Ok(true)
            }
            Self::ProcessGroup(target) => {
                let Some(mut target) = target.take() else {
                    return Ok(false);
                };
                refresh_process_tree_kill_target(&mut target);
                // SAFETY: the wait owner retains the unreaped direct child.
                Ok(unsafe { kill_process_tree_target(target) })
            }
        }
    }

    pub(crate) fn populated(&self) -> io::Result<bool> {
        match self {
            Self::Cgroup { leaf, .. } => read_populated(&leaf.events),
            Self::ProcessGroup(_) => Ok(false),
        }
    }

    pub(crate) fn wait_empty_until(&self, deadline: Instant) -> io::Result<bool> {
        loop {
            if !self.populated()? {
                return Ok(true);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            std::thread::sleep(remaining.min(Duration::from_millis(10)));
        }
    }

    pub(crate) fn remove(self) -> io::Result<()> {
        let Self::Cgroup { leaf, .. } = self else {
            return Ok(());
        };
        let path = leaf.path.clone();
        let fixture_files = leaf.fixture_files;
        drop(leaf);
        remove_leaf(&path, fixture_files)
    }

    pub(crate) fn is_cgroup(&self) -> bool {
        matches!(self, Self::Cgroup { .. })
    }
}

impl CgroupLeaf {
    fn open(path: PathBuf, fixture_files: bool) -> io::Result<Self> {
        Ok(Self {
            procs: open_control(&path.join("cgroup.procs"), true)?,
            kill: open_control(&path.join("cgroup.kill"), true)?,
            events: open_control(&path.join("cgroup.events"), false)?,
            path,
            fixture_files,
        })
    }
}

fn open_control(path: &Path, write: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(!write)
        .write(write)
        .custom_flags(libc::O_CLOEXEC);
    options.open(path)
}

fn write_current_process(fd: RawFd) -> io::Result<()> {
    let bytes = b"0";
    // SAFETY: fd is the inherited cgroup.procs descriptor and bytes remains
    // valid for the duration of this syscall.
    let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
    if written == bytes.len() as isize {
        Ok(())
    } else if written < 0 {
        Err(io::Error::last_os_error())
    } else {
        Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "short write while attaching exec cgroup",
        ))
    }
}

fn write_control(fd: RawFd, bytes: &[u8]) -> io::Result<()> {
    // SAFETY: fd is a newly opened cgroup control descriptor and bytes is
    // valid for the duration of write(2). Each control is written once.
    let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
    if written == bytes.len() as isize {
        Ok(())
    } else if written < 0 {
        Err(io::Error::last_os_error())
    } else {
        Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "short write to exec cgroup control",
        ))
    }
}

fn read_populated(events: &File) -> io::Result<bool> {
    let mut bytes = [0_u8; EVENTS_BUFFER_SIZE];
    // SAFETY: bytes is a valid writable buffer and events is an open
    // cgroup.events descriptor.
    let read = unsafe {
        libc::pread(
            events.as_raw_fd(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            0,
        )
    };
    if read < 0 {
        return Err(io::Error::last_os_error());
    }
    if read as usize == bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cgroup.events exceeds supported size",
        ));
    }
    let content = bytes
        .get(..read as usize)
        .ok_or_else(|| io::Error::other("cgroup.events read exceeded buffer"))?;
    let content = std::str::from_utf8(content).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("cgroup.events is not UTF-8: {error}"),
        )
    })?;
    parse_populated(content)
}

fn parse_populated(content: &str) -> io::Result<bool> {
    let mut populated = None;
    for line in content.lines() {
        let mut fields = line.split_whitespace();
        let key = fields.next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "empty cgroup.events line")
        })?;
        let value = fields.next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "missing cgroup.events value")
        })?;
        if fields.next().is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected cgroup.events fields",
            ));
        }
        if key == "populated" {
            if populated.is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "duplicate populated entry in cgroup.events",
                ));
            }
            populated = match value {
                "0" => Some(false),
                "1" => Some(true),
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid populated value in cgroup.events",
                    ));
                }
            };
        }
    }
    populated.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "missing populated entry in cgroup.events",
        )
    })
}

fn remove_leaf(path: &Path, fixture_files: bool) -> io::Result<()> {
    if fixture_files {
        for name in ["cgroup.procs", "cgroup.kill", "cgroup.events"] {
            fs::remove_file(path.join(name))?;
        }
    }
    fs::remove_dir(path)
}

fn remove_leaf_path(path: &Path, fixture_files: bool) {
    if fixture_files {
        for name in ["cgroup.procs", "cgroup.kill", "cgroup.events"] {
            let _ = fs::remove_file(path.join(name));
        }
    }
    let _ = fs::remove_dir(path);
}
