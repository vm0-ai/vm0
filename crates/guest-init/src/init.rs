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
    // /etc/environment is baked into the rootfs by build-rootfs.sh and
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
    Mount { target: String, source: nix::Error },
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::Mount { target, source } => {
                write!(f, "Failed to mount {}: {}", target, source)
            }
        }
    }
}

impl std::error::Error for InitError {}

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
        let content = "NODE_EXTRA_CA_CERTS=/etc/ssl/ca.pem";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("NODE_EXTRA_CA_CERTS", "/etc/ssl/ca.pem")]);
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
}
