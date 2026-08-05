//! Constructs the shared mount-namespace command for snapshot creation and restore.
//!
//! Callers retain ownership of process lifecycle, stdio, readiness, diagnostics,
//! and cleanup after receiving the unspawned command.

use std::path::Path;

use tokio::process::Command;

// The counted sections keep paths in argv while allowing restore to run all
// stale unmount attempts before either mode starts its ordered bind sequence.
const INNER_COMMAND: &str = r#"stale_count=$1
shift
while [ "$stale_count" -gt 0 ]; do
    umount -- "$1" 2>/dev/null
    shift
    stale_count=$((stale_count - 1))
done
bind_count=$1
shift
while [ "$bind_count" -gt 0 ]; do
    mount --bind -- "$1" "$2" || exit
    shift 2
    bind_count=$((bind_count - 1))
done
exec ip netns exec "$@""#;

pub(crate) struct BindMount<'a> {
    source: &'a Path,
    target: &'a Path,
}

impl<'a> BindMount<'a> {
    pub(crate) fn new(source: &'a Path, target: &'a Path) -> Self {
        Self { source, target }
    }
}

pub(crate) enum SnapshotMountMode<'a> {
    Creation {
        rootfs: BindMount<'a>,
        workspace: BindMount<'a>,
    },
    Restore {
        vsock: BindMount<'a>,
        rootfs: BindMount<'a>,
        workspace: BindMount<'a>,
    },
}

pub(crate) fn build_command(
    mounts: SnapshotMountMode<'_>,
    network_name: &str,
    binary_path: &Path,
    api_sock: &Path,
) -> Command {
    let mut command = Command::new("unshare");
    command.args([
        "--mount",
        "--propagation",
        "private",
        "bash",
        "-c",
        INNER_COMMAND,
        "_",
    ]);

    match mounts {
        SnapshotMountMode::Creation { rootfs, workspace } => {
            command.args(["0", "2"]);
            append_bind(&mut command, rootfs);
            append_bind(&mut command, workspace);
        }
        SnapshotMountMode::Restore {
            vsock,
            rootfs,
            workspace,
        } => {
            command.arg("2").arg(rootfs.target).arg(workspace.target);
            command.arg("3");
            append_bind(&mut command, vsock);
            append_bind(&mut command, rootfs);
            append_bind(&mut command, workspace);
        }
    }

    command
        .arg(network_name)
        .arg(binary_path)
        .arg("--api-sock")
        .arg(api_sock);
    command
}

fn append_bind(command: &mut Command, bind: BindMount<'_>) {
    command.arg(bind.source).arg(bind.target);
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};

    use super::*;

    #[test]
    fn creation_command_owns_private_namespace_bind_order_and_tail() {
        let command = build_command(
            SnapshotMountMode::Creation {
                rootfs: BindMount::new(
                    Path::new("/dev/root device"),
                    Path::new("/snapshot/root bind"),
                ),
                workspace: BindMount::new(
                    Path::new("/images/workspace image"),
                    Path::new("/snapshot/workspace bind"),
                ),
            },
            "snapshot-network",
            Path::new("/opt/firecracker binary"),
            Path::new("/run/firecracker api.sock"),
        );

        assert_eq!(command.as_std().get_program(), OsStr::new("unshare"));
        assert_eq!(
            command_args(&command),
            vec![
                OsString::from("--mount"),
                OsString::from("--propagation"),
                OsString::from("private"),
                OsString::from("bash"),
                OsString::from("-c"),
                OsString::from(INNER_COMMAND),
                OsString::from("_"),
                OsString::from("0"),
                OsString::from("2"),
                OsString::from("/dev/root device"),
                OsString::from("/snapshot/root bind"),
                OsString::from("/images/workspace image"),
                OsString::from("/snapshot/workspace bind"),
                OsString::from("snapshot-network"),
                OsString::from("/opt/firecracker binary"),
                OsString::from("--api-sock"),
                OsString::from("/run/firecracker api.sock"),
            ]
        );
    }

    #[test]
    fn restore_command_cleans_drives_before_ordered_binds_and_tail() {
        let command = build_command(
            SnapshotMountMode::Restore {
                vsock: BindMount::new(
                    Path::new("/run/sandbox vsock"),
                    Path::new("/snapshot/vsock bind"),
                ),
                rootfs: BindMount::new(
                    Path::new("/dev/root device"),
                    Path::new("/snapshot/root bind"),
                ),
                workspace: BindMount::new(
                    Path::new("/images/workspace image"),
                    Path::new("/snapshot/workspace bind"),
                ),
            },
            "restore-network",
            Path::new("/opt/firecracker binary"),
            Path::new("/run/firecracker api.sock"),
        );

        assert_eq!(command.as_std().get_program(), OsStr::new("unshare"));
        assert_eq!(
            command_args(&command),
            vec![
                OsString::from("--mount"),
                OsString::from("--propagation"),
                OsString::from("private"),
                OsString::from("bash"),
                OsString::from("-c"),
                OsString::from(INNER_COMMAND),
                OsString::from("_"),
                OsString::from("2"),
                OsString::from("/snapshot/root bind"),
                OsString::from("/snapshot/workspace bind"),
                OsString::from("3"),
                OsString::from("/run/sandbox vsock"),
                OsString::from("/snapshot/vsock bind"),
                OsString::from("/dev/root device"),
                OsString::from("/snapshot/root bind"),
                OsString::from("/images/workspace image"),
                OsString::from("/snapshot/workspace bind"),
                OsString::from("restore-network"),
                OsString::from("/opt/firecracker binary"),
                OsString::from("--api-sock"),
                OsString::from("/run/firecracker api.sock"),
            ]
        );
    }

    #[test]
    fn inner_command_ignores_stale_unmounts_and_stops_on_bind_failure() {
        let stale_loop = r#"while [ "$stale_count" -gt 0 ]; do
    umount -- "$1" 2>/dev/null
    shift
    stale_count=$((stale_count - 1))
done"#;
        let bind_loop = r#"while [ "$bind_count" -gt 0 ]; do
    mount --bind -- "$1" "$2" || exit
    shift 2
    bind_count=$((bind_count - 1))
done"#;

        let stale_position = INNER_COMMAND.find(stale_loop).unwrap();
        let bind_position = INNER_COMMAND.find(bind_loop).unwrap();
        let exec_position = INNER_COMMAND.find("exec ip netns exec \"$@\"").unwrap();

        assert!(stale_position < bind_position);
        assert!(bind_position < exec_position);
        assert!(INNER_COMMAND.ends_with("exec ip netns exec \"$@\""));
        assert!(!INNER_COMMAND.contains("/dev/root device"));
        assert!(!INNER_COMMAND.contains("/snapshot/root bind"));
    }

    fn command_args(command: &Command) -> Vec<OsString> {
        command
            .as_std()
            .get_args()
            .map(OsStr::to_os_string)
            .collect()
    }
}
