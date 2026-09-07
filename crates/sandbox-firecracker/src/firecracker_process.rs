//! Applies the shared process contract for Firecracker children.

use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::Stdio;

use tokio::process::{Child, Command};

/// Firecracker's jailer defaults both open-file limits to this value.
const FIRECRACKER_NOFILE_LIMIT: libc::rlim_t = 2048;

pub(crate) fn spawn_firecracker(
    mut command: Command,
    current_dir: &Path,
    placement_file: Option<std::fs::File>,
) -> io::Result<Child> {
    command
        .current_dir(current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);

    // SAFETY: `write` and `setrlimit` are async-signal-safe. The placement file
    // remains owned by the closure until exec and is opened close-on-exec.
    unsafe {
        command.pre_exec(move || {
            if let Some(file) = placement_file.as_ref() {
                write_self_to_cgroup(file.as_raw_fd())?;
            }
            let limit = libc::rlimit {
                rlim_cur: FIRECRACKER_NOFILE_LIMIT,
                rlim_max: FIRECRACKER_NOFILE_LIMIT,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }

    command.spawn()
}

fn write_self_to_cgroup(fd: std::os::fd::RawFd) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is open for writing and the one-byte buffer remains valid.
        let written = unsafe { libc::write(fd, b"0".as_ptr().cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawned_child_inherits_jailer_nofile_limit() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "ulimit -Sn; ulimit -Hn"]);

        let output = spawn_firecracker(command, Path::new("/"), None)
            .unwrap()
            .wait_with_output()
            .await
            .unwrap();

        assert!(
            output.status.success(),
            "child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "2048\n2048\n");
    }

    #[tokio::test]
    async fn spawned_child_is_placed_before_exec() {
        use std::os::unix::fs::OpenOptionsExt;

        let temp = tempfile::tempdir().unwrap();
        let placement_path = temp.path().join("cgroup.procs");
        let placement_file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(libc::O_CLOEXEC)
            .open(&placement_path)
            .unwrap();
        let placement_fd = placement_file.as_raw_fd().to_string();
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "test ! -e /proc/self/fd/\"$1\"",
            "host-cpu-placement",
            &placement_fd,
        ]);

        let status = spawn_firecracker(command, Path::new("/"), Some(placement_file))
            .unwrap()
            .wait()
            .await
            .unwrap();

        assert!(status.success());
        assert_eq!(std::fs::read_to_string(placement_path).unwrap(), "0");
    }
}
