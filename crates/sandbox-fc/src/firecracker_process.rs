//! Applies the shared process contract for Firecracker children.

use std::io;
use std::path::Path;
use std::process::Stdio;

use tokio::process::{Child, Command};

/// Firecracker's jailer defaults both open-file limits to this value.
const FIRECRACKER_NOFILE_LIMIT: libc::rlim_t = 2048;

pub(crate) fn spawn_firecracker(mut command: Command, current_dir: &Path) -> io::Result<Child> {
    command
        .current_dir(current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);

    // SAFETY: `setrlimit` is async-signal-safe and receives a valid pointer to
    // child-local stack storage. The hook does not access shared process state.
    unsafe {
        command.pre_exec(|| {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawned_child_inherits_jailer_nofile_limit() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "ulimit -Sn; ulimit -Hn"]);

        let output = spawn_firecracker(command, Path::new("/"))
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
}
