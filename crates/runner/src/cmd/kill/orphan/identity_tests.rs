use std::process::{ExitStatus, Stdio};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;

use super::*;

struct OrphanProcess {
    child: Child,
    target: KillTarget,
    _base: tempfile::TempDir,
}

impl OrphanProcess {
    async fn spawn(group: Option<u32>) -> Self {
        let base = tempfile::tempdir().unwrap();
        let sandbox_id = uuid::Uuid::new_v4().to_string();
        let workspace = base.path().join("workspaces").join(&sandbox_id);
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let firecracker = base.path().join("firecracker");
        std::os::unix::fs::symlink("/bin/sh", &firecracker).unwrap();
        let mut child = tokio::process::Command::new(&firecracker)
            .args(["-c", "printf 'ready\\n'; IFS= read -r _; exit 0"])
            .current_dir(&workspace)
            .process_group(i32::try_from(group.unwrap_or(0)).unwrap())
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), output.next_line())
                .await
                .unwrap()
                .unwrap()
                .as_deref(),
            Some("ready")
        );
        let pid = child.id().unwrap();
        let ProcessStatRead::Found(stat) = process::read_process_stat_checked(pid).await else {
            panic!("ready process must have a readable stat");
        };
        Self {
            child,
            target: KillTarget {
                pid,
                ppid: Some(stat.ppid),
                run_id: None,
                sandbox_id,
                base_dir: Some(base.path().to_path_buf()),
                generation: Some(stat.procfs_generation()),
            },
            _base: base,
        }
    }

    async fn exit(mut self) -> ExitStatus {
        // EOF releases the shell's read barrier without sending a signal.
        drop(self.child.stdin.take());
        tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .unwrap()
            .unwrap()
    }
}

#[tokio::test]
async fn original_identity_loss_does_not_signal_replacement_group() {
    let original = OrphanProcess::spawn(None).await;
    let OrphanTargetValidation::Valid(mut validated) =
        validate_orphan_target(&original.target).await
    else {
        panic!("original process must validate before exit");
    };
    assert!(original.exit().await.success());

    let replacement = OrphanProcess::spawn(None).await;
    let member = OrphanProcess::spawn(Some(replacement.target.pid)).await;
    // Model numeric routing now naming a replacement group, without churning
    // shared host PIDs or requiring privileged PID-namespace manipulation. The
    // actual delivery still exercises the original, exited kernel identity.
    validated.generation = replacement.target.generation.unwrap();
    let result = signal_process_group(replacement.target.pid, &validated);
    let retained_stat = validated.process.read_stat().await;
    let retained_cmdline = validated.process.read_cmdline().await;
    let retained_cwd = validated.process.read_cwd();
    let (replacement_status, member_status) = tokio::join!(replacement.exit(), member.exit());

    assert_eq!(result, ProcessGroupSignalResult::AlreadyGone);
    assert!(matches!(retained_stat, ProcessStatRead::Missing));
    assert!(retained_cmdline.is_none());
    assert!(retained_cwd.is_none());
    assert!(
        replacement_status.success(),
        "replacement leader received a signal"
    );
    assert!(
        member_status.success(),
        "replacement member received a signal"
    );
}

#[tokio::test]
async fn retained_group_identity_terminates_members_after_leader_is_reaped() {
    let leader = OrphanProcess::spawn(None).await;
    let member = OrphanProcess::spawn(Some(leader.target.pid)).await;
    let OrphanTargetValidation::Valid(validated) = validate_orphan_target(&leader.target).await
    else {
        panic!("group leader must validate");
    };
    let leader_pid = leader.target.pid;
    assert!(leader.exit().await.success());

    let result = signal_process_group(leader_pid, &validated);
    let member_exit =
        wait_for_orphan_exit(member.target.pid, &member.target.generation.unwrap()).await;
    let member_status = member.exit().await;

    assert_eq!(result, ProcessGroupSignalResult::Signaled);
    assert_eq!(member_exit, Ok(()));
    assert!(
        !member_status.success(),
        "original group member survived SIGKILL"
    );
}

#[tokio::test]
async fn orphan_termination_refuses_non_leader_without_signaling_group() {
    let leader = OrphanProcess::spawn(None).await;
    let member = OrphanProcess::spawn(Some(leader.target.pid)).await;
    let outcome = terminate(&member.target).await;
    let (leader_status, member_status) = tokio::join!(leader.exit(), member.exit());

    assert!(matches!(outcome, Outcome::AlreadyExitedOrChanged(_)));
    assert!(leader_status.success());
    assert!(member_status.success());
}

#[tokio::test]
async fn orphan_termination_refuses_changed_generation_without_signaling() {
    let original = OrphanProcess::spawn(None).await;
    let mut changed = original.target.clone();
    changed.generation.as_mut().unwrap().starttime += 1;
    let outcome = terminate(&changed).await;
    let status = original.exit().await;

    assert!(matches!(outcome, Outcome::AlreadyExitedOrChanged(_)));
    assert!(status.success());
}

#[tokio::test]
async fn rejected_kernel_signal_does_not_fall_back_to_numeric_signaling() {
    for error in [
        nix::errno::Errno::ENOSYS,
        nix::errno::Errno::EINVAL,
        nix::errno::Errno::EPERM,
    ] {
        let original = OrphanProcess::spawn(None).await;
        let OrphanTargetValidation::Valid(validated) =
            validate_orphan_target(&original.target).await
        else {
            panic!("original process must validate");
        };
        // Only the external kernel signal operation is injected. Validation,
        // refusal handling and the process whose survival matters are real.
        let result = signal_process_group_with(original.target.pid, &validated, |_| Err(error));
        let status = original.exit().await;

        assert_eq!(result, ProcessGroupSignalResult::Failed, "{error}");
        assert!(
            status.success(),
            "numeric fallback signaled the process after {error}"
        );
    }
}
