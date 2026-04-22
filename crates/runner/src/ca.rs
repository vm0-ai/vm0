use std::path::Path;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

const CA_CERT: &str = "mitmproxy-ca-cert.pem";
const CA_KEY: &str = "mitmproxy-ca-key.pem";
const CA_COMBINED: &str = "mitmproxy-ca.pem";

/// Ensure CA certificates exist at `/var/lib/vm0-runner/ca/`.
///
/// Generates a self-signed RSA 4096 CA via openssl if the cert or key is
/// missing. If only the combined PEM is missing (e.g., manual cleanup or
/// partial disk corruption), rebuilds it from the existing cert + key rather
/// than rotating the CA — rotation would silently invalidate any running
/// guests that trust the current cert. Idempotent — safe to call on every
/// build.
///
/// Also locks down permissions unconditionally on every call (not just on
/// first-ever generation) so legacy runners that shipped with looser perms
/// get migrated automatically.
pub async fn ensure(home: &HomePaths) -> RunnerResult<()> {
    let ca_dir = home.ca_dir();
    let cert = ca_dir.join(CA_CERT);
    let key = ca_dir.join(CA_KEY);
    let combined = ca_dir.join(CA_COMBINED);

    // Create dir with 0o700 on first run. `recursive(true)` is a no-op on an
    // already-existing dir; we chmod explicitly below to migrate legacy perms.
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder
        .create(&ca_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create ca dir: {e}")))?;

    // Symlink guard + unconditional chmod to migrate legacy `0o755` dirs.
    // The symlink check prevents an attacker-placed symlink from redirecting
    // our chmod at an arbitrary path.
    //
    // TOCTOU note: there's a tiny window between `symlink_metadata` and
    // `set_permissions` where `ca_dir` could in principle be swapped for a
    // symlink. We accept this because the parent dir (`/var/lib/vm0-runner/`)
    // is runner-owned in deployed configurations — a local attacker who can
    // write to the parent has already escalated past the trust boundary this
    // check is defending.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = tokio::fs::symlink_metadata(&ca_dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("stat ca dir: {e}")))?;
        if !meta.file_type().is_dir() {
            return Err(RunnerError::Internal(format!(
                "{} is not a directory (refusing to chmod through symlink)",
                ca_dir.display()
            )));
        }
        tokio::fs::set_permissions(&ca_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod ca dir: {e}")))?;
    }

    // Fast path: all three files already exist. Still migrate their perms so
    // runners upgraded from versions that wrote `0o644` key/combined get fixed.
    if exists(&cert).await? && exists(&key).await? && exists(&combined).await? {
        tracing::info!("CA certificates already exist, skipping generation");
        apply_perms(&cert, &key, &combined).await?;
        return Ok(());
    }

    // Recovery path: cert + key exist but combined is missing. Rebuild
    // combined from them instead of falling through to full generation —
    // `openssl genrsa` below would otherwise overwrite the existing key,
    // silently rotating the CA identity and breaking guests that already
    // trust the current cert.
    if exists(&cert).await? && exists(&key).await? {
        tracing::info!("combined CA missing; rebuilding from existing cert + key");
        build_combined(&cert, &key, &combined).await?;
        apply_perms(&cert, &key, &combined).await?;
        return Ok(());
    }

    tracing::info!("generating proxy CA certificate...");

    // Generate RSA 4096 private key. Immediately chmod 0o600 — older openssl
    // releases don't default to 0600.
    run_openssl(&["genrsa", "-out", &key.to_string_lossy(), "4096"]).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA key: {e}")))?;
    }

    // Generate self-signed certificate (10 years). Cert is non-sensitive.
    run_openssl(&[
        "req",
        "-new",
        "-x509",
        "-days",
        "3650",
        "-key",
        &key.to_string_lossy(),
        "-out",
        &cert.to_string_lossy(),
        "-subj",
        "/CN=mitmproxy/O=mitmproxy",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
    ])
    .await?;

    // Create combined PEM (cert + key) for mitmproxy, then apply perms to
    // all three files.  The explicit chmod covers the truncation case where
    // a stale `combined` kept its old (possibly loose) perms.
    build_combined(&cert, &key, &combined).await?;
    apply_perms(&cert, &key, &combined).await?;

    tracing::info!("CA certificates generated at {}", ca_dir.display());
    Ok(())
}

async fn exists(path: &Path) -> RunnerResult<bool> {
    tokio::fs::try_exists(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", path.display())))
}

/// Read `cert` + `key` and write their concatenation to `combined` with mode
/// `0o600` on Unix. `create(true).truncate(true)` (not `create_new`) preserves
/// idempotence if a stale `combined` file is left from a prior run.
async fn build_combined(cert: &Path, key: &Path, combined: &Path) -> RunnerResult<()> {
    let cert_content = tokio::fs::read(cert)
        .await
        .map_err(|e| RunnerError::Internal(format!("read CA cert: {e}")))?;
    let key_content = tokio::fs::read(key)
        .await
        .map_err(|e| RunnerError::Internal(format!("read CA key: {e}")))?;
    let mut combined_content = cert_content;
    combined_content.extend_from_slice(&key_content);

    use tokio::io::AsyncWriteExt;
    let mut opts = tokio::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut f = opts
        .open(combined)
        .await
        .map_err(|e| RunnerError::Internal(format!("open CA combined: {e}")))?;
    f.write_all(&combined_content)
        .await
        .map_err(|e| RunnerError::Internal(format!("write CA combined: {e}")))?;
    f.flush()
        .await
        .map_err(|e| RunnerError::Internal(format!("flush CA combined: {e}")))?;
    Ok(())
}

/// Chmod the three CA files: cert 0o644, key 0o600, combined 0o600.
/// Migrates legacy runners that shipped with looser perms. No-op on non-Unix.
#[cfg_attr(not(unix), allow(unused_variables))]
async fn apply_perms(cert: &Path, key: &Path, combined: &Path) -> RunnerResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(cert, std::fs::Permissions::from_mode(0o644))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA cert: {e}")))?;
        tokio::fs::set_permissions(key, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA key: {e}")))?;
        tokio::fs::set_permissions(combined, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA combined: {e}")))?;
    }
    Ok(())
}

async fn run_openssl(args: &[&str]) -> RunnerResult<()> {
    let output = tokio::process::Command::new("openssl")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn openssl: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RunnerError::Internal(format!(
            "openssl {} failed with {}: {stderr}",
            args.first().unwrap_or(&""),
            output.status
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::HomePaths;

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn ensure_generates_ca_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());

        ensure(&home).await.unwrap();

        let ca_dir = home.ca_dir();
        assert!(ca_dir.join(CA_CERT).exists(), "cert should exist");
        assert!(ca_dir.join(CA_KEY).exists(), "key should exist");
        assert!(ca_dir.join(CA_COMBINED).exists(), "combined should exist");

        let combined = std::fs::read_to_string(ca_dir.join(CA_COMBINED)).unwrap();
        assert!(combined.contains("BEGIN CERTIFICATE"));
        assert!(
            combined.contains("BEGIN PRIVATE KEY") || combined.contains("BEGIN RSA PRIVATE KEY")
        );
    }

    #[tokio::test]
    async fn ensure_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());

        ensure(&home).await.unwrap();
        let cert1 = std::fs::read(home.ca_dir().join(CA_CERT)).unwrap();

        ensure(&home).await.unwrap();
        let cert2 = std::fs::read(home.ca_dir().join(CA_CERT)).unwrap();
        assert_eq!(cert1, cert2, "cert should not change on second call");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_sets_restrictive_permissions_on_fresh_generation() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());

        ensure(&home).await.unwrap();

        let ca_dir = home.ca_dir();
        assert_eq!(mode_of(&ca_dir), 0o700, "ca_dir should be 0700");
        assert_eq!(mode_of(&ca_dir.join(CA_KEY)), 0o600, "key should be 0600");
        assert_eq!(
            mode_of(&ca_dir.join(CA_COMBINED)),
            0o600,
            "combined should be 0600"
        );
        assert_eq!(mode_of(&ca_dir.join(CA_CERT)), 0o644, "cert should be 0644");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_migrates_legacy_loose_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let ca_dir = home.ca_dir();

        // Simulate legacy runner: 0755 dir, 0644 key + combined.
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::set_permissions(&ca_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(ca_dir.join(CA_CERT), b"fake cert").unwrap();
        std::fs::write(ca_dir.join(CA_KEY), b"fake key").unwrap();
        std::fs::write(ca_dir.join(CA_COMBINED), b"fake combined").unwrap();
        for name in [CA_CERT, CA_KEY, CA_COMBINED] {
            std::fs::set_permissions(ca_dir.join(name), std::fs::Permissions::from_mode(0o644))
                .unwrap();
        }

        ensure(&home).await.unwrap();

        assert_eq!(mode_of(&ca_dir), 0o700, "ca_dir should be migrated to 0700");
        assert_eq!(
            mode_of(&ca_dir.join(CA_KEY)),
            0o600,
            "key should be migrated to 0600"
        );
        assert_eq!(
            mode_of(&ca_dir.join(CA_COMBINED)),
            0o600,
            "combined should be migrated to 0600"
        );
        assert_eq!(
            mode_of(&ca_dir.join(CA_CERT)),
            0o644,
            "cert should remain 0644"
        );

        // Contents untouched (no regeneration).
        assert_eq!(
            std::fs::read(ca_dir.join(CA_KEY)).unwrap(),
            b"fake key",
            "key contents preserved"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_rebuilds_combined_without_rotating_ca() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let ca_dir = home.ca_dir();

        // Generate a real CA, then snapshot cert + key bytes.
        ensure(&home).await.unwrap();
        let original_key = std::fs::read(ca_dir.join(CA_KEY)).unwrap();
        let original_cert = std::fs::read(ca_dir.join(CA_CERT)).unwrap();

        // Lose only the combined PEM — mirrors a manual cleanup or partial
        // disk corruption scenario.
        std::fs::remove_file(ca_dir.join(CA_COMBINED)).unwrap();

        // Second call must rebuild combined from existing cert + key, not
        // rotate the CA.
        ensure(&home).await.unwrap();

        assert_eq!(
            std::fs::read(ca_dir.join(CA_KEY)).unwrap(),
            original_key,
            "key must not be rotated when only combined is missing"
        );
        assert_eq!(
            std::fs::read(ca_dir.join(CA_CERT)).unwrap(),
            original_cert,
            "cert must not be reissued when only combined is missing"
        );

        let mut expected_combined = original_cert.clone();
        expected_combined.extend_from_slice(&original_key);
        assert_eq!(
            std::fs::read(ca_dir.join(CA_COMBINED)).unwrap(),
            expected_combined,
            "combined should be cert + key concatenation"
        );
        assert_eq!(
            mode_of(&ca_dir.join(CA_COMBINED)),
            0o600,
            "rebuilt combined should be 0600"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_regenerates_combined_when_partial_state() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());

        // Leave a stale combined file with wrong perms behind from a prior run.
        let ca_dir = home.ca_dir();
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::write(ca_dir.join(CA_COMBINED), b"stale").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            ca_dir.join(CA_COMBINED),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        // Partial state (cert+key missing) → regenerate. Must not panic with EEXIST.
        ensure(&home).await.unwrap();

        assert_eq!(
            mode_of(&ca_dir.join(CA_COMBINED)),
            0o600,
            "regenerated combined should be 0600"
        );
        let combined = std::fs::read_to_string(ca_dir.join(CA_COMBINED)).unwrap();
        assert!(
            combined.contains("BEGIN CERTIFICATE"),
            "combined should contain real cert, not stale placeholder"
        );
    }
}
