use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};

pub(super) const TEMPLATE_BUILD_SCRIPT: &str = include_str!("../../../scripts/build-template.sh");
const VERIFY_SCRIPT: &str = include_str!("../../../scripts/verify-rootfs.sh");
pub(super) const CUSTOMIZE_SCRIPT: &str = include_str!("../../../scripts/customize-rootfs.sh");

pub(super) struct RootfsScripts {
    temp_dir: Option<tempfile::TempDir>,
}

impl RootfsScripts {
    pub(super) fn new() -> Self {
        Self { temp_dir: None }
    }

    #[cfg(test)]
    pub(super) fn from_temp_dir(temp_dir: tempfile::TempDir) -> Self {
        Self {
            temp_dir: Some(temp_dir),
        }
    }

    pub(super) async fn path(&mut self) -> RunnerResult<PathBuf> {
        if self.temp_dir.is_none() {
            self.temp_dir = Some(create_rootfs_scripts_dir().await?);
        }
        match self.temp_dir.as_ref() {
            Some(dir) => Ok(dir.path().to_path_buf()),
            None => Err(RunnerError::Internal(
                "rootfs scripts dir was not initialized".into(),
            )),
        }
    }
}

async fn create_rootfs_scripts_dir() -> RunnerResult<tempfile::TempDir> {
    let dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    tokio::fs::write(dir.path().join("build-template.sh"), TEMPLATE_BUILD_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write template build script: {e}")))?;
    tokio::fs::write(dir.path().join("verify-rootfs.sh"), VERIFY_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write verify script: {e}")))?;
    tokio::fs::write(dir.path().join("customize-rootfs.sh"), CUSTOMIZE_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write customize script: {e}")))?;
    Ok(dir)
}

pub(super) fn rootfs_script_command(script: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg(script).stdin(std::process::Stdio::null());
    cmd.process_group(0);
    cmd.kill_on_drop(true);

    // SAFETY: `set_pdeathsig` calls `prctl(PR_SET_PDEATHSIG)`, which is
    // async-signal-safe. It narrows the window where a parent runner crash
    // releases flocks while a rootfs script keeps mutating staging files.
    unsafe {
        cmd.pre_exec(|| {
            nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGKILL)
                .map_err(std::io::Error::from)
        });
    }

    cmd
}

struct RootfsScriptProcess {
    child: tokio::process::Child,
    pgid: Option<nix::unistd::Pid>,
}

impl Drop for RootfsScriptProcess {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid {
            let _ = nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL);
        }
    }
}

pub(super) async fn run_rootfs_script(
    mut cmd: tokio::process::Command,
    label: &str,
) -> RunnerResult<std::process::ExitStatus> {
    let child = cmd
        .spawn()
        .map_err(|e| RunnerError::Internal(format!("spawn {label}: {e}")))?;
    let pgid = child.id().map(|pid| nix::unistd::Pid::from_raw(pid as i32));
    let mut process = RootfsScriptProcess { child, pgid };

    let status = process
        .child
        .wait()
        .await
        .map_err(|e| RunnerError::Internal(format!("wait for {label}: {e}")))?;
    if status.success() {
        process.pgid = None;
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_quoted_var<'a>(script: &'a str, name: &str) -> Option<&'a str> {
        let prefix = format!("{name}=\"");
        script.lines().find_map(|line| {
            let value = line.strip_prefix(&prefix)?;
            value.strip_suffix('"')
        })
    }

    fn is_numeric_semver(version: &str) -> bool {
        let mut parts = version.split('.');
        let Some(major) = parts.next() else {
            return false;
        };
        let Some(minor) = parts.next() else {
            return false;
        };
        let Some(patch) = parts.next() else {
            return false;
        };

        parts.next().is_none()
            && [major, minor, patch]
                .iter()
                .all(|part| matches!(part.parse::<u32>(), Ok(value) if *part == value.to_string()))
    }

    struct ProcessGroupCleanup {
        pgid_file: PathBuf,
    }

    impl Drop for ProcessGroupCleanup {
        fn drop(&mut self) {
            if let Ok(raw_pgid) = std::fs::read_to_string(&self.pgid_file)
                && let Ok(pgid) = raw_pgid.parse::<i32>()
            {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pgid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
    }

    async fn write_process_group_leak_script(dir: &Path) -> PathBuf {
        let script = dir.join("leak-process-group.sh");
        tokio::fs::write(
            &script,
            r#"#!/usr/bin/env bash
set -euo pipefail

pgid_file="$1"
started_file="$2"
survived_file="$3"
mode="${4:-fail}"

printf '%s' "$$" > "$pgid_file"
(
  trap '' HUP TERM INT
  printf started > "$started_file"
  sleep 0.1
  printf survived > "$survived_file"
) &

while [[ ! -f "$started_file" ]]; do
  sleep 0.01
done

if [[ "$mode" == "wait" ]]; then
  sleep 30
fi

exit 1
"#,
        )
        .await
        .unwrap();
        script
    }

    async fn wait_for_file(path: &Path) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if tokio::fs::try_exists(path).await.unwrap_or(false) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {}", path.display()));
    }

    #[cfg(target_os = "linux")]
    fn process_group_has_live_members(pgid_file: &Path) -> bool {
        let raw_pgid = std::fs::read_to_string(pgid_file).expect("read test pgid");
        let pgid: i32 = raw_pgid.parse().expect("parse test pgid");
        let entries = std::fs::read_dir("/proc").expect("read /proc");
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                continue;
            };
            let Some((_, fields)) = stat.rsplit_once(") ") else {
                continue;
            };
            let mut fields = fields.split_whitespace();
            let state = fields.next().and_then(|value| value.chars().next());
            let _ppid = fields.next();
            let pgrp = fields.next().and_then(|value| value.parse::<i32>().ok());
            if pgrp == Some(pgid) && state != Some('Z') {
                return true;
            }
        }
        false
    }

    #[cfg(not(target_os = "linux"))]
    fn process_group_has_live_members(pgid_file: &Path) -> bool {
        let raw_pgid = std::fs::read_to_string(pgid_file).expect("read test pgid");
        let pgid = nix::unistd::Pid::from_raw(raw_pgid.parse().expect("parse test pgid"));
        match nix::sys::signal::killpg(pgid, None) {
            Ok(()) => true,
            Err(nix::errno::Errno::ESRCH) => false,
            Err(_) => true,
        }
    }

    async fn assert_process_group_stopped_without_survival_marker(
        pgid_file: &Path,
        survived_file: &Path,
    ) {
        wait_for_file(pgid_file).await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !process_group_has_live_members(pgid_file) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for process group in {pgid_file:?} to exit"));
        assert!(
            !tokio::fs::try_exists(survived_file).await.unwrap_or(false),
            "rootfs script process group was not killed; child wrote {}",
            survived_file.display()
        );
    }

    #[tokio::test]
    async fn run_rootfs_script_kills_process_group_after_script_failure() {
        let dir = tempfile::tempdir().unwrap();
        let pgid = dir.path().join("pgid");
        let started = dir.path().join("started");
        let survived = dir.path().join("survived");
        let script = write_process_group_leak_script(dir.path()).await;
        let _cleanup = ProcessGroupCleanup {
            pgid_file: pgid.clone(),
        };

        let mut cmd = rootfs_script_command(&script);
        cmd.arg(&pgid).arg(&started).arg(&survived).arg("fail");

        let status = run_rootfs_script(cmd, "leak-process-group.sh")
            .await
            .unwrap();

        assert!(!status.success());
        assert!(started.exists(), "test child should have started");
        assert_process_group_stopped_without_survival_marker(&pgid, &survived).await;
    }

    #[tokio::test]
    async fn run_rootfs_script_kills_process_group_when_future_is_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let pgid = dir.path().join("pgid");
        let started = dir.path().join("started");
        let survived = dir.path().join("survived");
        let script = write_process_group_leak_script(dir.path()).await;
        let _cleanup = ProcessGroupCleanup {
            pgid_file: pgid.clone(),
        };

        let mut cmd = rootfs_script_command(&script);
        cmd.arg(&pgid).arg(&started).arg(&survived).arg("wait");

        let handle =
            tokio::spawn(async move { run_rootfs_script(cmd, "leak-process-group.sh").await });
        wait_for_file(&started).await;
        handle.abort();
        let _ = handle.await;

        assert_process_group_stopped_without_survival_marker(&pgid, &survived).await;
    }

    #[tokio::test]
    async fn rootfs_scripts_writes_embedded_scripts_once() {
        let mut scripts = RootfsScripts::new();

        let first = scripts.path().await.unwrap();
        let second = scripts.path().await.unwrap();

        assert_eq!(first, second);
        assert!(first.join("build-template.sh").exists());
        assert!(first.join("verify-rootfs.sh").exists());
        assert!(first.join("customize-rootfs.sh").exists());
    }

    /// Guard the `[sync:ca-constants]` contract between customize-rootfs.sh
    /// and verify-rootfs.sh. Drift would cause silent CA
    /// customization/verification failures on rootfs images.
    #[test]
    fn ca_constants_in_sync_across_scripts() {
        let ca_cert_line = r#"CA_CERT_FILE="mitmproxy-ca-cert.pem""#;
        let ca_dest_line = r#"CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt""#;

        assert!(
            CUSTOMIZE_SCRIPT.contains(ca_cert_line),
            "customize-rootfs.sh missing CA_CERT_FILE constant — sync with other scripts"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains(ca_dest_line),
            "customize-rootfs.sh missing CA_ROOTFS_DEST constant — sync with other scripts"
        );

        // verify-rootfs.sh only uses CA_ROOTFS_DEST (it reads the cert from
        // inside the rootfs, not from the host CA_DIR).
        assert!(
            VERIFY_SCRIPT.contains(ca_dest_line),
            "verify-rootfs.sh missing CA_ROOTFS_DEST constant — sync with other scripts"
        );
    }

    /// Guard: customize-rootfs.sh must verify the CA actually made it into the
    /// system bundle after `update-ca-certificates`. `update-ca-certificates`
    /// can exit 0 while silently omitting our cert (e.g. malformed PEM),
    /// which would later surface as an opaque snapshot/VM-boot TLS error.
    /// See #9482.
    #[test]
    fn customize_rootfs_verifies_bundle_after_update() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("update-ca-certificates"),
            "customize-rootfs.sh must call update-ca-certificates"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("proxy CA not found in system bundle"),
            "customize-rootfs.sh must verify proxy CA landed in system bundle after \
             update-ca-certificates (silent failure guard; see #9482)"
        );
        assert!(
            !CUSTOMIZE_SCRIPT.contains("keytool -delete"),
            "customize-rootfs.sh starts from a CA-free template; duplicate Java aliases \
             should fail instead of being silently replaced"
        );
    }

    #[test]
    fn template_build_script_excludes_rootfs_only_inputs() {
        for forbidden in [
            "--guest-agent",
            "--guest-download",
            "--guest-init",
            "--guest-mock-claude",
            "--guest-mock-codex",
            "--guest-reseed",
            "--guest-write-file",
            "--ca-dir",
            "--dns-nameserver",
            "CA_ROOTFS_DEST",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(
                !TEMPLATE_BUILD_SCRIPT.contains(forbidden),
                "template build script must not embed rootfs-only input: {forbidden}"
            );
        }
    }

    #[test]
    fn customize_script_uses_chroot_install_for_destinations() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo chroot \"$MOUNT_DIR\" install -D"),
            "customize-rootfs.sh should install inside the chroot so /sbin -> /usr/sbin \
             resolves like it does at boot"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("realpath -m -- \"$parent\""),
            "customize-rootfs.sh should resolve destination parents inside the chroot"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("runtime mount"),
            "customize-rootfs.sh should reject writes that resolve under /proc, /sys, or /dev"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo chroot \"$MOUNT_DIR\" rm -f -- \"$safe_dest\""),
            "customize-rootfs.sh should replace existing target symlinks instead of \
             overwriting through them"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("mktemp -d -p \"$MOUNT_DIR\""),
            "customize-rootfs.sh should create temp files directly under the mounted root, \
             not below an untrusted in-rootfs parent like /tmp"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("/proc, /sys, and /dev are not mounted yet"),
            "customize-rootfs.sh should document why file writes happen before runtime bind mounts"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("unsafe rootfs destination component"),
            "customize-rootfs.sh should reject lexical path escapes before chroot install"
        );
    }

    #[test]
    fn customize_script_fails_when_cleanup_fails() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("local status=$?"),
            "customize-rootfs.sh cleanup should preserve the original command status"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("cleanup_failed=1"),
            "customize-rootfs.sh should track cleanup failures"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("if ! rmdir \"$MOUNT_DIR\""),
            "customize-rootfs.sh should treat mount temp dir cleanup failure as a cleanup failure"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("error: rootfs cleanup failed"),
            "customize-rootfs.sh should fail a successful customization if cleanup fails"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("exit \"$status\""),
            "customize-rootfs.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn build_script_fails_when_successful_cleanup_fails() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("local status=$?"),
            "build-template.sh cleanup should preserve the original command status"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("error: template build cleanup failed"),
            "build-template.sh should fail a successful build if temp rootfs cleanup fails"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("exit \"$status\""),
            "build-template.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn build_script_outputs_template_file() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"TEMPLATE_FILE="template.ext4""#),
            "build-template.sh should produce a template image, not the rootfs image filename"
        );
    }

    #[test]
    fn template_installs_and_verifies_pnpm() {
        let pnpm_version = shell_quoted_var(TEMPLATE_BUILD_SCRIPT, "PNPM_VERSION")
            .expect("build-template.sh should declare PNPM_VERSION");
        assert!(
            is_numeric_semver(pnpm_version),
            "build-template.sh should pin PNPM_VERSION to an exact numeric semver so template \
             cache inputs are deterministic"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("pnpm@${PNPM_VERSION}"),
            "build-template.sh should install pnpm into sandbox templates"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#""${MOUNT_DIR}/usr/bin/pnpm""#),
            "verify-rootfs.sh should verify pnpm is present in sandbox images"
        );
    }

    #[test]
    fn build_script_publishes_debootstrap_cache_atomically() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"CACHE_TMP_TAR="${cache_tar}.tmp.$$""#),
            "build-template.sh should stage debootstrap cache writes in a process-scoped temp file"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"--make-tarball="$CACHE_TMP_TAR""#),
            "build-template.sh must not write debootstrap output directly to the stable cache path"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"--unpack-tarball="$(realpath "$CACHE_TMP_TAR")""#),
            "build-template.sh should validate the temp tarball before publishing it"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"mv -f "$CACHE_TMP_TAR" "$cache_tar""#),
            "build-template.sh should atomically publish the verified debootstrap cache tarball"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT
                .contains(r#"[[ -n "$CACHE_TMP_TAR" ]] && ! rm -f "$CACHE_TMP_TAR""#),
            "build-template.sh should remove unpublished debootstrap cache temp files on cleanup"
        );
        assert!(
            !TEMPLATE_BUILD_SCRIPT.contains(r#"--make-tarball="$cache_tar""#),
            "build-template.sh must not publish partial debootstrap cache tarballs on cancellation"
        );
    }

    #[test]
    fn build_script_locks_only_debootstrap_cache_access() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("--debootstrap-lock"),
            "build-template.sh should receive the same debootstrap cache lock path used by GC"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("flock \"$lock_fd\""),
            "build-template.sh should lock shared debootstrap cache access"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("exec {lock_fd}>>\"$DEBOOTSTRAP_LOCK\""),
            "build-template.sh should open the pre-created lock file without truncating it"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("flock -u \"$lock_fd\""),
            "build-template.sh should release the debootstrap cache lock after unpack"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("debootstrap_cache_locked\n  flock -u"),
            "build-template.sh should release the cache lock before chroot package install and mkfs"
        );
    }

    #[test]
    fn rootfs_scripts_enter_private_mount_namespace() {
        for (name, script) in [
            ("build-template.sh", TEMPLATE_BUILD_SCRIPT),
            ("customize-rootfs.sh", CUSTOMIZE_SCRIPT),
            ("verify-rootfs.sh", VERIFY_SCRIPT),
        ] {
            assert!(
                script.contains(r#"UNSHARE_SENTINEL="--__vm0_unshared__""#),
                "{name} should use a sentinel so sudo does not need to preserve env vars"
            );
            assert!(
                script.contains("unshare --mount --propagation private"),
                "{name} should isolate mounts so SIGKILL cannot leak host-visible rootfs mounts"
            );
        }
    }

    #[test]
    fn customize_script_uses_autoclear_loop_mount() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo mount -o loop \"$ROOTFS\" \"$MOUNT_DIR\""),
            "customize-rootfs.sh should let mount create an autoclear loop device"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo mount --bind /proc")
                && CUSTOMIZE_SCRIPT.contains("sudo mount --bind /sys")
                && CUSTOMIZE_SCRIPT.contains("sudo mount --bind /dev"),
            "customize-rootfs.sh should run keytool in the same proc/sys/dev chroot environment \
             as the old rootfs build path"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo umount -R \"$target\""),
            "customize-rootfs.sh should recursively unmount runtime bind mounts"
        );
        assert!(
            !CUSTOMIZE_SCRIPT.contains("losetup --find --show"),
            "customize-rootfs.sh should not keep an explicit loop device that can leak on SIGKILL"
        );
    }

    #[test]
    fn verify_script_retries_and_surfaces_cleanup_failures() {
        assert!(
            VERIFY_SCRIPT.contains("unmount_with_retries()"),
            "verify-rootfs.sh should retry unmount to avoid transient loop mount leaks"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"error: ${MODE} verification cleanup failed"#),
            "verify-rootfs.sh should fail successful verification if cleanup fails"
        );
        assert!(
            VERIFY_SCRIPT.contains("if ! rmdir \"$MOUNT_DIR\""),
            "verify-rootfs.sh should treat mount temp dir cleanup failure as a cleanup failure"
        );
        assert!(
            VERIFY_SCRIPT.contains("exit \"$status\""),
            "verify-rootfs.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn verify_script_has_template_and_rootfs_modes() {
        assert!(
            VERIFY_SCRIPT.contains("--mode)"),
            "verify-rootfs.sh should accept --mode"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"$MODE" != "template""#)
                || VERIFY_SCRIPT.contains(r#"$MODE" == "template""#),
            "verify-rootfs.sh should have a template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"$MODE" == "rootfs""#),
            "verify-rootfs.sh should gate guest/CA checks to rootfs mode"
        );
    }

    #[test]
    fn verify_script_rejects_rootfs_only_content_in_template_mode() {
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only guest binary"),
            "verify-rootfs.sh should reject guest binaries in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only proxy CA certificate"),
            "verify-rootfs.sh should reject injected proxy CA files in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only environment CA settings"),
            "verify-rootfs.sh should reject injected CA environment settings in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only resolv.conf content"),
            "verify-rootfs.sh should reject customized resolver state in template mode"
        );
    }
}
