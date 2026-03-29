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

const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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

    // 2. Set environment variables for the init process (root).
    // User commands run via `su - user` which resets env from /etc/passwd,
    // so these only affect root/sudo commands (e.g. clock fix).
    // SAFETY: We are the init process, no other threads are running yet
    unsafe {
        std::env::set_var("PATH", DEFAULT_PATH);
        std::env::set_var("HOME", "/root");
        std::env::set_var("USER", "root");
        std::env::set_var("SHELL", "/bin/bash");
        std::env::set_var("LANG", "C.UTF-8");
    }

    // Write environment for `su - user` (login shell). Docker ENV is lost
    // during `docker export`, and `std::env::set_var` only affects the
    // current process — `su -` resets the environment.
    //
    // LANG goes in /etc/environment (read by PAM, not overridden later).
    // PATH goes in /etc/profile.d/ because Debian's /etc/profile overrides
    // PATH from /etc/environment, omitting sbin dirs for non-root users.
    // Scripts in /etc/profile.d/ run after /etc/profile, so our PATH wins.
    if let Err(e) = fs::write(
        "/etc/environment",
        "LANG=C.UTF-8\nNPM_CONFIG_UPDATE_NOTIFIER=false\n",
    ) {
        eprintln!("[guest-init] Warning: failed to write /etc/environment: {e}");
    }
    if let Err(e) = fs::write(
        "/etc/profile.d/vm0-path.sh",
        format!("export PATH={DEFAULT_PATH}\n"),
    ) {
        eprintln!("[guest-init] Warning: failed to write /etc/profile.d/vm0-path.sh: {e}");
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
