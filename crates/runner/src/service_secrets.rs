use std::fmt;
use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

pub(crate) const SENTRY_DSN_ENV: &str = "SENTRY_DSN";
pub(crate) const AXIOM_TOKEN_ENV: &str = "AXIOM_TOKEN_TELEMETRY";
pub(crate) const AXIOM_SUFFIX_ENV: &str = "AXIOM_DATASET_SUFFIX";
pub(crate) const VERCEL_AUTOMATION_BYPASS_SECRET_ENV: &str = "VERCEL_AUTOMATION_BYPASS_SECRET";
pub(crate) const SERVICE_SECRETS_FILE_NAME: &str = "service-secrets.env";

const SERVICE_SECRETS_FILE_READ_MAX_BYTES: u64 = 64 * 1024;
const ALLOWED_SERVICE_SECRET_KEYS: [&str; 4] = [
    SENTRY_DSN_ENV,
    AXIOM_TOKEN_ENV,
    AXIOM_SUFFIX_ENV,
    VERCEL_AUTOMATION_BYPASS_SECRET_ENV,
];

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct ServiceSecrets {
    sentry_dsn: Option<String>,
    axiom_token_telemetry: Option<String>,
    axiom_dataset_suffix: Option<String>,
    vercel_automation_bypass_secret: Option<String>,
}

impl fmt::Debug for ServiceSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServiceSecrets")
            .field(
                "sentry_dsn",
                &self.sentry_dsn.as_ref().map(|_| "[redacted]"),
            )
            .field(
                "axiom_token_telemetry",
                &self.axiom_token_telemetry.as_ref().map(|_| "[redacted]"),
            )
            .field("axiom_dataset_suffix", &self.axiom_dataset_suffix)
            .field(
                "vercel_automation_bypass_secret",
                &self
                    .vercel_automation_bypass_secret
                    .as_ref()
                    .map(|_| "[redacted]"),
            )
            .finish()
    }
}

impl ServiceSecrets {
    pub(crate) fn from_env() -> Self {
        Self {
            sentry_dsn: non_empty_env(SENTRY_DSN_ENV),
            axiom_token_telemetry: non_empty_env(AXIOM_TOKEN_ENV),
            axiom_dataset_suffix: non_empty_env(AXIOM_SUFFIX_ENV),
            vercel_automation_bypass_secret: non_empty_env(VERCEL_AUTOMATION_BYPASS_SECRET_ENV),
        }
    }

    pub(crate) fn with_env_fallback(mut self) -> Self {
        let env = Self::from_env();
        if self.sentry_dsn.is_none() {
            self.sentry_dsn = env.sentry_dsn;
        }
        if self.axiom_token_telemetry.is_none() {
            self.axiom_token_telemetry = env.axiom_token_telemetry;
        }
        if self.axiom_dataset_suffix.is_none() {
            self.axiom_dataset_suffix = env.axiom_dataset_suffix;
        }
        if self.vercel_automation_bypass_secret.is_none() {
            self.vercel_automation_bypass_secret = env.vercel_automation_bypass_secret;
        }
        self
    }

    pub(crate) fn sentry_dsn(&self) -> Option<&str> {
        self.sentry_dsn.as_deref()
    }

    pub(crate) fn axiom_token_telemetry(&self) -> Option<&str> {
        self.axiom_token_telemetry.as_deref()
    }

    pub(crate) fn axiom_dataset_suffix(&self) -> Option<&str> {
        self.axiom_dataset_suffix.as_deref()
    }

    pub(crate) fn vercel_automation_bypass_secret(&self) -> Option<&str> {
        self.vercel_automation_bypass_secret.as_deref()
    }

    fn to_file_contents(&self) -> String {
        let mut content = String::new();
        if let Some(value) = &self.sentry_dsn {
            content.push_str(SENTRY_DSN_ENV);
            content.push('=');
            content.push_str(value);
            content.push('\n');
        }
        if let Some(value) = &self.axiom_token_telemetry {
            content.push_str(AXIOM_TOKEN_ENV);
            content.push('=');
            content.push_str(value);
            content.push('\n');
        }
        if let Some(value) = &self.axiom_dataset_suffix {
            content.push_str(AXIOM_SUFFIX_ENV);
            content.push('=');
            content.push_str(value);
            content.push('\n');
        }
        if let Some(value) = &self.vercel_automation_bypass_secret {
            content.push_str(VERCEL_AUTOMATION_BYPASS_SECRET_ENV);
            content.push('=');
            content.push_str(value);
            content.push('\n');
        }
        content
    }
}

pub(crate) fn is_service_secret_key(key: &str) -> bool {
    ALLOWED_SERVICE_SECRET_KEYS.contains(&key)
}

pub(crate) fn canonical_service_secrets_path(home: &HomePaths, name: &str) -> PathBuf {
    home.runners_dir()
        .join(name)
        .join(SERVICE_SECRETS_FILE_NAME)
}

pub(crate) async fn load_start_service_secrets(
    service_secrets_file: Option<&Path>,
) -> RunnerResult<ServiceSecrets> {
    match service_secrets_file {
        Some(path) => read_private_service_secrets(path).await,
        None => Ok(ServiceSecrets::default()),
    }
}

pub(crate) async fn stage_service_secrets_file(
    source: &Path,
    destination: &Path,
) -> RunnerResult<()> {
    let content = read_source_file_to_string(source).await?;
    let secrets = parse_service_secrets_file(&content, &source.display().to_string())?;
    let parent = destination.parent().ok_or_else(|| {
        RunnerError::Config(format!(
            "{} does not have a parent directory; refusing to write service secrets",
            destination.display()
        ))
    })?;
    crate::private_fs::ensure_private_dir(parent).await?;
    crate::private_fs::write_private_file(destination, secrets.to_file_contents().as_bytes()).await
}

pub(crate) async fn remove_service_secrets_file(path: &Path) -> RunnerResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Config(format!(
            "remove service secrets file {}: {e}",
            path.display()
        ))),
    }
}

async fn read_private_service_secrets(path: &Path) -> RunnerResult<ServiceSecrets> {
    let content = crate::private_fs::read_private_file_to_string_with_max(
        path,
        SERVICE_SECRETS_FILE_READ_MAX_BYTES,
    )
    .await?
    .ok_or_else(|| {
        RunnerError::Config(format!("service secrets file {} not found", path.display()))
    })?;
    parse_service_secrets_file(&content, &path.display().to_string())
}

async fn read_source_file_to_string(path: &Path) -> RunnerResult<String> {
    let file = open_source_file(path).await?;
    read_limited_utf8(file, path).await
}

async fn open_source_file(path: &Path) -> RunnerResult<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        options.custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK);
    }
    let file = options.open(path).await.map_err(|e| {
        RunnerError::Config(format!("open service secrets file {}: {e}", path.display()))
    })?;
    let metadata = file.metadata().await.map_err(|e| {
        RunnerError::Config(format!("stat service secrets file {}: {e}", path.display()))
    })?;
    if !metadata.is_file() {
        return Err(RunnerError::Config(format!(
            "service secrets file {} is not a regular file",
            path.display()
        )));
    }
    Ok(file)
}

async fn read_limited_utf8(file: tokio::fs::File, path: &Path) -> RunnerResult<String> {
    let read_limit = SERVICE_SECRETS_FILE_READ_MAX_BYTES
        .checked_add(1)
        .ok_or_else(|| {
            RunnerError::Config(format!(
                "service secrets file {} read limit is too large",
                path.display()
            ))
        })?;
    let mut limited = file.take(read_limit);
    let mut contents = Vec::new();
    limited.read_to_end(&mut contents).await.map_err(|e| {
        RunnerError::Config(format!("read service secrets file {}: {e}", path.display()))
    })?;
    if contents.len() as u64 > SERVICE_SECRETS_FILE_READ_MAX_BYTES {
        return Err(RunnerError::Config(format!(
            "service secrets file {} exceeds {} bytes",
            path.display(),
            SERVICE_SECRETS_FILE_READ_MAX_BYTES
        )));
    }
    String::from_utf8(contents).map_err(|e| {
        RunnerError::Config(format!(
            "read service secrets file {} as UTF-8: {e}",
            path.display()
        ))
    })
}

fn parse_service_secrets_file(content: &str, label: &str) -> RunnerResult<ServiceSecrets> {
    if content.contains('\0') {
        return Err(RunnerError::Config(format!(
            "{label}: NUL characters are not allowed"
        )));
    }

    let mut secrets = ServiceSecrets::default();
    for (line_number, raw_line) in content.lines().enumerate() {
        let line_number = line_number + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.contains('\r') {
            return Err(RunnerError::Config(format!(
                "{label}:{line_number}: carriage returns are not allowed"
            )));
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            return Err(RunnerError::Config(format!(
                "{label}:{line_number}: expected KEY=VALUE"
            )));
        };
        let key = key.trim();
        let value = raw_value.trim();
        if !is_service_secret_key(key) {
            return Err(RunnerError::Config(format!(
                "{label}:{line_number}: unsupported service secret key {key:?}; allowed keys: {}",
                ALLOWED_SERVICE_SECRET_KEYS.join(", ")
            )));
        }
        if value.contains('\0') || value.contains('\r') || value.contains('\n') {
            return Err(RunnerError::Config(format!(
                "{label}:{line_number}: control characters are not allowed in service secret values"
            )));
        }

        set_secret_value(&mut secrets, key, value.to_string(), label, line_number)?;
    }
    Ok(secrets)
}

fn set_secret_value(
    secrets: &mut ServiceSecrets,
    key: &str,
    value: String,
    label: &str,
    line_number: usize,
) -> RunnerResult<()> {
    let slot = match key {
        SENTRY_DSN_ENV => &mut secrets.sentry_dsn,
        AXIOM_TOKEN_ENV => &mut secrets.axiom_token_telemetry,
        AXIOM_SUFFIX_ENV => &mut secrets.axiom_dataset_suffix,
        VERCEL_AUTOMATION_BYPASS_SECRET_ENV => &mut secrets.vercel_automation_bypass_secret,
        _ => {
            return Err(RunnerError::Config(format!(
                "{label}:{line_number}: unsupported service secret key {key:?}"
            )));
        }
    };
    if slot.is_some() {
        return Err(RunnerError::Config(format!(
            "{label}:{line_number}: duplicate service secret key {key}"
        )));
    }
    if !value.is_empty() {
        *slot = Some(value);
    }
    Ok(())
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_service_secrets_accepts_allowed_keys() {
        let secrets = parse_service_secrets_file(
            "\n# telemetry\nSENTRY_DSN = sentry\nAXIOM_TOKEN_TELEMETRY=token\nAXIOM_DATASET_SUFFIX = prod\nVERCEL_AUTOMATION_BYPASS_SECRET=bypass=with=equals\n",
            "test.env",
        )
        .unwrap();

        assert_eq!(secrets.sentry_dsn(), Some("sentry"));
        assert_eq!(secrets.axiom_token_telemetry(), Some("token"));
        assert_eq!(secrets.axiom_dataset_suffix(), Some("prod"));
        assert_eq!(
            secrets.vercel_automation_bypass_secret(),
            Some("bypass=with=equals")
        );
    }

    #[test]
    fn parse_service_secrets_treats_empty_values_as_absent() {
        let secrets = parse_service_secrets_file("SENTRY_DSN=\n", "test.env").unwrap();

        assert_eq!(secrets.sentry_dsn(), None);
        assert_eq!(secrets.to_file_contents(), "");
    }

    #[test]
    fn parse_service_secrets_rejects_unknown_key_without_leaking_value() {
        let err = parse_service_secrets_file("UNKNOWN=super-secret-value\n", "test.env")
            .unwrap_err()
            .to_string();

        assert!(err.contains("unsupported service secret key"));
        assert!(err.contains("UNKNOWN"));
        assert!(!err.contains("super-secret-value"));
    }

    #[test]
    fn parse_service_secrets_rejects_duplicates_without_leaking_value() {
        let err = parse_service_secrets_file(
            "SENTRY_DSN=first-secret\nSENTRY_DSN=second-secret\n",
            "test.env",
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("duplicate service secret key SENTRY_DSN"));
        assert!(!err.contains("first-secret"));
        assert!(!err.contains("second-secret"));
    }

    #[test]
    fn parse_service_secrets_rejects_malformed_lines_without_leaking_value() {
        let err = parse_service_secrets_file("secret-without-equals\n", "test.env")
            .unwrap_err()
            .to_string();

        assert!(err.contains("expected KEY=VALUE"));
        assert!(!err.contains("secret-without-equals"));
    }

    #[test]
    fn parse_service_secrets_rejects_nul_without_leaking_value() {
        let err = parse_service_secrets_file("SENTRY_DSN=secret\0value\n", "test.env")
            .unwrap_err()
            .to_string();

        assert!(err.contains("NUL characters are not allowed"));
        assert!(!err.contains("secret"));
    }

    #[test]
    fn service_secrets_debug_redacts_sensitive_values() {
        let secrets = parse_service_secrets_file(
            "SENTRY_DSN=sentry-secret\nAXIOM_TOKEN_TELEMETRY=token-secret\nAXIOM_DATASET_SUFFIX=prod\nVERCEL_AUTOMATION_BYPASS_SECRET=bypass-secret\n",
            "test.env",
        )
        .unwrap();
        let debug = format!("{secrets:?}");

        assert!(debug.contains("[redacted]"));
        assert!(debug.contains("prod"));
        assert!(!debug.contains("sentry-secret"));
        assert!(!debug.contains("token-secret"));
        assert!(!debug.contains("bypass-secret"));
    }

    #[test]
    fn canonical_service_secrets_path_lives_under_runner_dir() {
        let home = HomePaths::with_root(PathBuf::from("/test"));

        assert_eq!(
            canonical_service_secrets_path(&home, "v0.1.0"),
            PathBuf::from("/test/runners/v0.1.0/service-secrets.env")
        );
    }

    #[tokio::test]
    async fn stage_service_secrets_file_writes_canonical_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.env");
        let destination = dir
            .path()
            .join("runners")
            .join("v0.1.0")
            .join(SERVICE_SECRETS_FILE_NAME);
        tokio::fs::write(
            &source,
            "# comment\nSENTRY_DSN = sentry\nAXIOM_DATASET_SUFFIX=prod\n",
        )
        .await
        .unwrap();

        stage_service_secrets_file(&source, &destination)
            .await
            .unwrap();

        let content = tokio::fs::read_to_string(&destination).await.unwrap();
        assert_eq!(content, "SENTRY_DSN=sentry\nAXIOM_DATASET_SUFFIX=prod\n");
        let loaded = read_private_service_secrets(&destination).await.unwrap();
        assert_eq!(loaded.sentry_dsn(), Some("sentry"));
        assert_eq!(loaded.axiom_dataset_suffix(), Some("prod"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stage_service_secrets_file_rejects_fifo_source_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.env");
        nix::unistd::mkfifo(&source, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
        let destination = dir
            .path()
            .join("runners")
            .join("v0.1.0")
            .join(SERVICE_SECRETS_FILE_NAME);

        let err = stage_service_secrets_file(&source, &destination)
            .await
            .unwrap_err()
            .to_string();

        assert!(err.contains("is not a regular file"));
    }
}
