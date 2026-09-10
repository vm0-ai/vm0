//! Real-cgroup launch coverage selected by the native host CPU CI job.

use std::fs::{self, File};
use std::future::{Future, poll_fn};
use std::io;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::task::Poll;
use std::time::Duration;

use process_launch::{Command, SpawnOptions, Stdio, asynchronous};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::TestResult;

pub(super) async fn verify(root: &Path) -> TestResult<()> {
    let leaf = root.join("guests/launch-contract");
    fs::create_dir(&leaf)?;
    let directory = File::from(process_launch::private_descriptor(
        File::open(&leaf)?.into(),
    )?);
    let workspace = tempfile::tempdir()?;
    let mut command = Command::new("sh");
    command
        .args([
            "-c",
            "test ! -e /proc/self/fd/\"$PRIVATE_FD\" || exit 1; \
             cat /proc/self/cgroup; pwd; printf '%s\\n' \"$VALUE\"; \
             ulimit -Sn; ulimit -Hn; exit 23",
        ])
        .env_clear()
        .env("PATH", "/bin:/usr/bin")
        .env("PRIVATE_FD", directory.as_raw_fd().to_string())
        .env("VALUE", "launch-value")
        .current_dir(workspace.path())
        .nofile_limit(2048)
        .stdin(Stdio::Null)
        .stdout(Stdio::Piped)
        .stderr(Stdio::Null);
    let mut child =
        asynchronous::spawn(command, directory.as_fd(), SpawnOptions::default()).await?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("missing child PID"))?;
    // The owned, unreaped child must lead its own group before any group signal.
    assert_eq!(
        unsafe { libc::getpgid(pid as libc::pid_t) },
        pid as libc::pid_t
    );
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing stdout pipe"))?
        .read_to_string(&mut stdout)
        .await?;
    let status = child.wait().await?;
    assert_eq!(status.code(), Some(23));
    assert_eq!(child.wait().await?, status);
    assert_eq!(child.try_wait()?, Some(status));
    assert_eq!(child.id(), None);
    let membership = leaf.strip_prefix("/sys/fs/cgroup")?.display();
    assert_eq!(
        stdout,
        format!(
            "0::/{membership}\n{}\nlaunch-value\n2048\n2048\n",
            workspace.path().display()
        )
    );

    verify_pipes(&directory).await?;
    verify_cancel_and_drop(&directory).await?;
    verify_failed_exec(&directory, workspace.path()).await?;
    verify_pending_exec_cleanup(&directory, &leaf).await?;
    wait_for_empty(&leaf).await?;
    drop(directory);
    fs::remove_dir(leaf)?;
    Ok(())
}

struct FrozenCgroup<'a>(&'a Path);

impl Drop for FrozenCgroup<'_> {
    fn drop(&mut self) {
        // This guard only owns the isolated test leaf. Restore it even if an
        // assertion fails while checking cancellation of the frozen child.
        let _ = fs::write(self.0.join("cgroup.freeze"), "0");
    }
}

async fn verify_pending_exec_cleanup(directory: &File, leaf: &Path) -> TestResult<()> {
    for abort in [true, false] {
        fs::write(leaf.join("cgroup.freeze"), "1")?;
        let frozen = FrozenCgroup(leaf);
        let task_directory = directory.try_clone()?;
        let task_leaf = leaf.to_owned();
        let (started, observed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut launch = Box::pin(sleeper(&task_directory));
            poll_fn(|cx| {
                assert!(launch.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            // clone3 puts the child in the frozen leaf before executing any
            // child code. Its live PID proves this is post-clone acknowledgement,
            // not merely an admission wait or a delayed test task.
            let membership = fs::read_to_string(task_leaf.join("cgroup.procs"))?;
            let pids = membership.split_whitespace().collect::<Vec<_>>();
            assert_eq!(pids.len(), 1);
            let pid = pids
                .first()
                .ok_or_else(|| io::Error::other("frozen child PID missing"))?
                .parse::<u32>()
                .map_err(io::Error::other)?;
            started
                .send(pid)
                .map_err(|_| io::Error::other("cancel observer dropped"))?;
            launch.await
        });
        let pid = tokio::time::timeout(Duration::from_secs(5), observed).await??;
        if abort {
            task.abort();
            let result = tokio::time::timeout(Duration::from_secs(5), task).await?;
            assert!(matches!(result, Err(error) if error.is_cancelled()));
        } else {
            let result = tokio::time::timeout(Duration::from_secs(6), task).await??;
            assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::TimedOut));
        }
        // Cleanup must finish before returning to the cgroup owner, without
        // thawing the child or relying on an asynchronous reap retry.
        assert!(!Path::new(&format!("/proc/{pid}")).exists());
        assert!(
            fs::read_to_string(leaf.join("cgroup.procs"))?
                .trim()
                .is_empty()
        );
        drop(frozen);
        let mut child = asynchronous::spawn(
            Command::new("/bin/true"),
            directory.as_fd(),
            SpawnOptions::default(),
        )
        .await?;
        assert!(child.wait().await?.success());
    }
    Ok(())
}

async fn verify_pipes(directory: &File) -> TestResult<()> {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "cat; head -c 131072 /dev/zero >&2; exit 17"])
        .stdin(Stdio::Piped)
        .stdout(Stdio::Piped)
        .stderr(Stdio::Piped);
    let mut child =
        asynchronous::spawn(command, directory.as_fd(), SpawnOptions::default()).await?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("missing stdin pipe"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing stdout pipe"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("missing stderr pipe"))?;
    let input = vec![b'x'; 131072];
    let mut out = Vec::new();
    let mut err = Vec::new();
    let write = async {
        stdin.write_all(&input).await?;
        drop(stdin);
        std::io::Result::Ok(())
    };
    let (_, _, _, status) = tokio::try_join!(
        write,
        stdout.read_to_end(&mut out),
        stderr.read_to_end(&mut err),
        child.wait()
    )?;
    assert_eq!(status.code(), Some(17));
    assert_eq!(out, input);
    assert_eq!(err, vec![0; 131072]);
    Ok(())
}

async fn sleeper(directory: &File) -> std::io::Result<asynchronous::Child> {
    let mut command = Command::new("/bin/sleep");
    command
        .arg("60")
        .stdin(Stdio::Null)
        .stdout(Stdio::Null)
        .stderr(Stdio::Null);
    asynchronous::spawn(command, directory.as_fd(), SpawnOptions::default()).await
}

async fn verify_cancel_and_drop(directory: &File) -> TestResult<()> {
    let mut child = sleeper(directory).await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(1), child.wait())
            .await
            .is_err()
    );
    child.kill().await?;
    assert_eq!(child.wait().await?.signal(), Some(libc::SIGKILL));

    let child = sleeper(directory).await?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("missing child PID"))?;
    drop(child);
    tokio::time::timeout(Duration::from_secs(5), async {
        while Path::new(&format!("/proc/{pid}")).exists() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await?;
    Ok(())
}

async fn verify_failed_exec(directory: &File, workspace: &Path) -> TestResult<()> {
    let missing = workspace.join("missing");
    let missing_executable = Command::new(&missing);
    let mut missing_directory = Command::new("/bin/true");
    missing_directory.current_dir(&missing);
    for command in [missing_executable, missing_directory] {
        let result = asynchronous::spawn(command, directory.as_fd(), SpawnOptions::default()).await;
        assert!(matches!(result, Err(error) if error.raw_os_error() == Some(libc::ENOENT)));
    }
    Ok(())
}

async fn wait_for_empty(leaf: &Path) -> TestResult<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fs::read_to_string(leaf.join("cgroup.procs"))?
            .trim()
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        std::io::Result::Ok(())
    })
    .await??;
    Ok(())
}
