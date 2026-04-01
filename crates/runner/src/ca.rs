use std::path::Path;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

const CA_CERT: &str = "mitmproxy-ca-cert.pem";
const CA_KEY: &str = "mitmproxy-ca-key.pem";
const CA_COMBINED: &str = "mitmproxy-ca.pem";

/// Ensure CA certificates exist at `/var/lib/vm0-runner/ca/`.
///
/// Generates a self-signed RSA 4096 CA via openssl if the files don't
/// already exist. Idempotent — safe to call on every build.
pub async fn ensure(home: &HomePaths) -> RunnerResult<()> {
    let ca_dir = home.ca_dir();
    let cert = ca_dir.join(CA_CERT);
    let key = ca_dir.join(CA_KEY);
    let combined = ca_dir.join(CA_COMBINED);

    if exists(&cert).await? && exists(&key).await? && exists(&combined).await? {
        tracing::info!("CA certificates already exist, skipping generation");
        return Ok(());
    }

    tokio::fs::create_dir_all(&ca_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create ca dir: {e}")))?;

    tracing::info!("generating proxy CA certificate...");

    // Generate RSA 4096 private key
    run_openssl(&["genrsa", "-out", &key.to_string_lossy(), "4096"]).await?;

    // Generate self-signed certificate (10 years)
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

    // Create combined PEM (cert + key) for mitmproxy
    let cert_content = tokio::fs::read(&cert)
        .await
        .map_err(|e| RunnerError::Internal(format!("read CA cert: {e}")))?;
    let key_content = tokio::fs::read(&key)
        .await
        .map_err(|e| RunnerError::Internal(format!("read CA key: {e}")))?;
    let mut combined_content = cert_content;
    combined_content.extend_from_slice(&key_content);
    tokio::fs::write(&combined, &combined_content)
        .await
        .map_err(|e| RunnerError::Internal(format!("write CA combined: {e}")))?;

    // Set permissions: key and combined = 600, cert = 644
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA key: {e}")))?;
        tokio::fs::set_permissions(&combined, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA combined: {e}")))?;
        tokio::fs::set_permissions(&cert, std::fs::Permissions::from_mode(0o644))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod CA cert: {e}")))?;
    }

    tracing::info!("CA certificates generated at {}", ca_dir.display());
    Ok(())
}

async fn exists(path: &Path) -> RunnerResult<bool> {
    tokio::fs::try_exists(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", path.display())))
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
