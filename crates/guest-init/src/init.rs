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

/// Parse `/etc/environment` and set each `KEY=VALUE` pair via `set_var`.
///
/// Skips blank lines, comments, and lines without `=`.
/// SAFETY: caller must ensure no other threads are running.
unsafe fn load_etc_environment() {
    let content = match fs::read_to_string("/etc/environment") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[guest-init] Warning: failed to read /etc/environment: {e}");
            return;
        }
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim().trim_matches('"');
            if !key.is_empty() {
                unsafe { std::env::set_var(key, value) };
            }
        }
    }
}
