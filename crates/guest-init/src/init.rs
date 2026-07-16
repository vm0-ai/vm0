//! Filesystem initialization for VM boot.
//!
//! The kernel mounts the ext4 rootfs via `root=/dev/vda rw` boot arg and
//! auto-mounts devtmpfs on `/dev` (`CONFIG_DEVTMPFS_MOUNT=y`).
//!
//! This module handles the remaining setup:
//! 1. Mount virtual filesystems (/proc, /sys)
//! 2. Configure TCP keepalive and environment variables

use nix::mount::{MsFlags, mount};
use std::fs;
use std::io;
use std::path::Path;

use guest_contracts::process_containment::{CGROUP_V2_MOUNT_PATH, SUPERVISED_CGROUP_BASE_PATH};

const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const CGROUP_EVENTS_FILE: &str = "cgroup.events";
const CGROUP_KILL_FILE: &str = "cgroup.kill";
const CGROUP_SUBTREE_CONTROL_FILE: &str = "cgroup.subtree_control";

/// Initialize virtual filesystems and environment.
///
/// The kernel has already mounted `/dev/vda` as root (`root=/dev/vda rw`)
/// and devtmpfs on `/dev` (`CONFIG_DEVTMPFS_MOUNT=y`).
pub fn init_filesystem() -> Result<(), InitError> {
    eprintln!("[guest-init] Starting filesystem initialization");

    // 1. Mount virtual filesystems
    mount(
        Some("proc"),
        "/proc",
        Some("proc"),
        MsFlags::empty(),
        None::<&str>,
    )
    .map_err(|e| InitError::Mount {
        target: "/proc".into(),
        source: e,
    })?;

    // Configure aggressive TCP keepalive for faster dead connection detection.
    // Default values (7200s/75s/9 probes = ~2h11m) exceed JOB_TIMEOUT (2h),
    // so dead connections are never detected. These values reduce detection to ~2min.
    for (param, value) in [
        ("tcp_keepalive_time", "60"),
        ("tcp_keepalive_intvl", "10"),
        ("tcp_keepalive_probes", "6"),
    ] {
        let path = format!("/proc/sys/net/ipv4/{param}");
        if let Err(e) = fs::write(&path, value) {
            eprintln!("[guest-init] Warning: failed to set {param}: {e}");
        }
    }

    mount(
        Some("sys"),
        "/sys",
        Some("sysfs"),
        MsFlags::empty(),
        None::<&str>,
    )
    .map_err(|e| InitError::Mount {
        target: "/sys".into(),
        source: e,
    })?;

    initialize_process_containment()?;

    // Mount tmpfs on /dev/shm — required by Chromium for shared memory.
    // devtmpfs (CONFIG_DEVTMPFS_MOUNT=y) doesn't create /dev/shm.
    let _ = fs::create_dir_all("/dev/shm");
    mount(
        Some("tmpfs"),
        "/dev/shm",
        Some("tmpfs"),
        MsFlags::empty(),
        Some("mode=1777"),
    )
    .map_err(|e| InitError::Mount {
        target: "/dev/shm".into(),
        source: e,
    })?;

    eprintln!("[guest-init] Virtual filesystems mounted");

    // 2. Load environment variables.
    //
    // /etc/environment is baked into the rootfs by customize-rootfs.sh and
    // contains variables shared by ALL users (LANG, NODE_EXTRA_CA_CERTS, …).
    // PAM reads it for login shells (`su - user`), but the init process
    // (root) and its children (vsock-guest → `sh -c`) don't go through PAM,
    // so we load it explicitly here.
    //
    // SAFETY: We are the init process, no other threads are running yet
    unsafe {
        load_etc_environment();
        std::env::set_var("HOME", "/root");
        std::env::set_var("USER", "root");
        std::env::set_var("SHELL", "/bin/bash");
    }

    // 3. Change to root home directory (init runs as root;
    // `su - user` will cd to /home/user automatically)
    let _ = std::env::set_current_dir("/root");

    eprintln!("[guest-init] Filesystem initialization complete");
    Ok(())
}

/// Errors that can occur during filesystem initialization
#[derive(Debug)]
pub enum InitError {
    Mount {
        target: String,
        source: nix::Error,
    },
    Filesystem {
        operation: &'static str,
        path: String,
        source: io::Error,
    },
    InvalidProcessContainment(String),
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::Mount { target, source } => {
                write!(f, "Failed to mount {}: {}", target, source)
            }
            InitError::Filesystem {
                operation,
                path,
                source,
            } => write!(f, "Failed to {operation} {path}: {source}"),
            InitError::InvalidProcessContainment(message) => {
                write!(f, "Invalid process containment: {message}")
            }
        }
    }
}

impl std::error::Error for InitError {}

fn initialize_process_containment() -> Result<(), InitError> {
    create_dir_all(Path::new(CGROUP_V2_MOUNT_PATH))?;
    mount(
        Some("cgroup2"),
        CGROUP_V2_MOUNT_PATH,
        Some("cgroup2"),
        MsFlags::MS_NODEV | MsFlags::MS_NOEXEC | MsFlags::MS_NOSUID,
        None::<&str>,
    )
    .map_err(|source| InitError::Mount {
        target: CGROUP_V2_MOUNT_PATH.into(),
        source,
    })?;

    let base = Path::new(SUPERVISED_CGROUP_BASE_PATH);
    create_dir_all(base)?;
    verify_process_containment_base(base)?;
    eprintln!("[guest-init] Supervised process containment initialized");
    Ok(())
}

fn create_dir_all(path: &Path) -> Result<(), InitError> {
    fs::create_dir_all(path).map_err(|source| InitError::Filesystem {
        operation: "create directory",
        path: path.display().to_string(),
        source,
    })
}

fn verify_process_containment_base(base: &Path) -> Result<(), InitError> {
    for filename in [
        CGROUP_PROCS_FILE,
        CGROUP_EVENTS_FILE,
        CGROUP_KILL_FILE,
        CGROUP_SUBTREE_CONTROL_FILE,
    ] {
        let path = base.join(filename);
        let metadata = fs::metadata(&path).map_err(|source| InitError::Filesystem {
            operation: "inspect",
            path: path.display().to_string(),
            source,
        })?;
        if !metadata.is_file() {
            return Err(InitError::InvalidProcessContainment(format!(
                "{} is not a file",
                path.display()
            )));
        }
    }

    let subtree_control_path = base.join(CGROUP_SUBTREE_CONTROL_FILE);
    let subtree_control =
        fs::read_to_string(&subtree_control_path).map_err(|source| InitError::Filesystem {
            operation: "read",
            path: subtree_control_path.display().to_string(),
            source,
        })?;
    if !subtree_control.trim().is_empty() {
        return Err(InitError::InvalidProcessContainment(
            "resource controllers are enabled for the supervised subtree".into(),
        ));
    }
    Ok(())
}

/// Parse environment file content into key-value pairs.
///
/// Skips blank lines, comments, and lines without `=`.
/// Values may be optionally wrapped in double quotes which are stripped.
fn parse_env_content(content: &str) -> Vec<(&str, &str)> {
    let mut pairs = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim().trim_matches('"');
            if !key.is_empty() {
                pairs.push((key, value));
            }
        }
    }
    pairs
}

/// Parse `/etc/environment` and set each `KEY=VALUE` pair via `set_var`.
///
/// SAFETY: caller must ensure no other threads are running.
unsafe fn load_etc_environment() {
    let content = match fs::read_to_string("/etc/environment") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[guest-init] Warning: failed to read /etc/environment: {e}");
            return;
        }
    };
    for (key, value) in parse_env_content(&content) {
        unsafe { std::env::set_var(key, value) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_cgroup_core_files(base: &Path, subtree_control: &str) {
        fs::create_dir_all(base).unwrap();
        for (filename, content) in [
            (CGROUP_PROCS_FILE, ""),
            (CGROUP_EVENTS_FILE, "populated 0\nfrozen 0\n"),
            (CGROUP_KILL_FILE, ""),
            (CGROUP_SUBTREE_CONTROL_FILE, subtree_control),
        ] {
            fs::write(base.join(filename), content).unwrap();
        }
    }

    #[test]
    fn parse_env_basic() {
        let content = "LANG=en_US.UTF-8\nPATH=/usr/bin:/bin";
        let pairs = parse_env_content(content);
        assert_eq!(
            pairs,
            vec![("LANG", "en_US.UTF-8"), ("PATH", "/usr/bin:/bin")]
        );
    }

    #[test]
    fn parse_env_quoted_values() {
        let content = r#"FOO="bar baz""#;
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("FOO", "bar baz")]);
    }

    #[test]
    fn parse_env_skips_comments_and_blanks() {
        let content = "# comment\n\nKEY=value\n  \n# another comment\n";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("KEY", "value")]);
    }

    #[test]
    fn parse_env_skips_lines_without_equals() {
        let content = "no_equals_sign\nGOOD=yes";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("GOOD", "yes")]);
    }

    #[test]
    fn parse_env_trims_whitespace() {
        let content = "  KEY  =  value  ";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("KEY", "value")]);
    }

    #[test]
    fn parse_env_empty_value() {
        let content = "EMPTY=";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("EMPTY", "")]);
    }

    #[test]
    fn parse_env_value_with_equals() {
        // Values may legitimately contain `=`; only the first one separates key/value.
        let content = "TOKEN=abc=def==";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("TOKEN", "abc=def==")]);
    }

    #[test]
    fn parse_env_empty_key_skipped() {
        let content = "=value";
        let pairs = parse_env_content(content);
        assert!(pairs.is_empty());
    }

    #[test]
    fn init_error_display() {
        let err = InitError::Mount {
            target: "/proc".into(),
            source: nix::Error::EACCES,
        };
        let msg = err.to_string();
        assert!(msg.contains("/proc"));
        assert!(msg.contains("EACCES"));
    }

    #[test]
    fn process_containment_base_requires_core_files() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "");
        fs::remove_file(dir.path().join(CGROUP_KILL_FILE)).unwrap();

        let error = verify_process_containment_base(dir.path()).unwrap_err();

        assert!(error.to_string().contains(CGROUP_KILL_FILE));
    }

    #[test]
    fn process_containment_base_rejects_enabled_controllers() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "+memory\n");

        let error = verify_process_containment_base(dir.path()).unwrap_err();

        assert!(error.to_string().contains("resource controllers"));
    }

    #[test]
    fn process_containment_base_accepts_controller_free_core_files() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "\n");

        verify_process_containment_base(dir.path()).unwrap();
    }
}
