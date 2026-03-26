//! Filesystem initialization for VM boot.
//!
//! This module implements the filesystem initialization in Rust:
//! 1. Mount squashfs base filesystem
//! 2. Mount ext4 overlay filesystem
//! 3. Setup overlayfs
//! 4. Perform pivot_root
//! 5. Mount virtual filesystems (/proc, /sys)

use nix::mount::{MntFlags, MsFlags, mount, umount2};
use nix::unistd::{chdir, pivot_root};
use std::fs;
use std::io;
use std::path::Path;

const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Initialize filesystem and perform pivot_root.
///
/// This uses direct syscalls for filesystem initialization.
pub fn init_filesystem() -> Result<(), InitError> {
    eprintln!("[guest-init] Starting filesystem initialization");

    // 1. Mount squashfs (read-only base filesystem from /dev/vda)
    mount(
        Some("/dev/vda"),
        "/rom",
        Some("squashfs"),
        MsFlags::MS_RDONLY,
        None::<&str>,
    )
    .map_err(|e| InitError::Mount {
        target: "/rom".into(),
        source: e,
    })?;
    eprintln!("[guest-init] Mounted squashfs on /rom");

    // 2. Mount ext4 (read-write overlay from /dev/vdb)
    mount(
        Some("/dev/vdb"),
        "/rw",
        Some("ext4"),
        MsFlags::empty(),
        None::<&str>,
    )
    .map_err(|e| InitError::Mount {
        target: "/rw".into(),
        source: e,
    })?;
    eprintln!("[guest-init] Mounted ext4 on /rw");

    // 3. Create overlay directories
    fs::create_dir_all("/rw/upper").map_err(|e| InitError::Mkdir {
        path: "/rw/upper".into(),
        source: e,
    })?;
    fs::create_dir_all("/rw/work").map_err(|e| InitError::Mkdir {
        path: "/rw/work".into(),
        source: e,
    })?;

    // 4. Mount overlayfs
    mount(
        Some("overlay"),
        "/mnt/root",
        Some("overlay"),
        MsFlags::empty(),
        Some("lowerdir=/rom,upperdir=/rw/upper,workdir=/rw/work"),
    )
    .map_err(|e| InitError::Mount {
        target: "/mnt/root".into(),
        source: e,
    })?;
    eprintln!("[guest-init] Mounted overlayfs on /mnt/root");

    // 5. Prepare pivot_root
    fs::create_dir_all("/mnt/root/oldroot").map_err(|e| InitError::Mkdir {
        path: "/mnt/root/oldroot".into(),
        source: e,
    })?;

    // 6. Change directory and perform pivot_root
    chdir(Path::new("/mnt/root")).map_err(|e| InitError::Chdir {
        path: "/mnt/root".into(),
        source: e,
    })?;

    pivot_root(".", "oldroot").map_err(InitError::PivotRoot)?;
    eprintln!("[guest-init] pivot_root complete");

    // 7. Move mounts from old root
    // Create mount points if they don't exist
    fs::create_dir_all("/rom").ok();
    fs::create_dir_all("/rw").ok();

    mount(
        Some("/oldroot/rom"),
        "/rom",
        None::<&str>,
        MsFlags::MS_MOVE,
        None::<&str>,
    )
    .map_err(|e| InitError::MoveMount {
        from: "/oldroot/rom".into(),
        to: "/rom".into(),
        source: e,
    })?;

    mount(
        Some("/oldroot/rw"),
        "/rw",
        None::<&str>,
        MsFlags::MS_MOVE,
        None::<&str>,
    )
    .map_err(|e| InitError::MoveMount {
        from: "/oldroot/rw".into(),
        to: "/rw".into(),
        source: e,
    })?;

    mount(
        Some("/oldroot/dev"),
        "/dev",
        None::<&str>,
        MsFlags::MS_MOVE,
        None::<&str>,
    )
    .map_err(|e| InitError::MoveMount {
        from: "/oldroot/dev".into(),
        to: "/dev".into(),
        source: e,
    })?;

    // 8. Unmount old root (lazy unmount, ignore errors)
    let _ = umount2("/oldroot", MntFlags::MNT_DETACH);

    // 9. Mount virtual filesystems
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

    // 10. Set environment variables for the init process (root).
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

    // 11. Change to root home directory (init runs as root;
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
    Mkdir {
        path: String,
        source: io::Error,
    },
    Chdir {
        path: String,
        source: nix::Error,
    },
    PivotRoot(nix::Error),
    MoveMount {
        from: String,
        to: String,
        source: nix::Error,
    },
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::Mount { target, source } => {
                write!(f, "Failed to mount {}: {}", target, source)
            }
            InitError::Mkdir { path, source } => {
                write!(f, "Failed to create directory {}: {}", path, source)
            }
            InitError::Chdir { path, source } => {
                write!(f, "Failed to chdir to {}: {}", path, source)
            }
            InitError::PivotRoot(e) => write!(f, "Failed to pivot_root: {}", e),
            InitError::MoveMount { from, to, source } => {
                write!(f, "Failed to move mount {} to {}: {}", from, to, source)
            }
        }
    }
}

impl std::error::Error for InitError {}
