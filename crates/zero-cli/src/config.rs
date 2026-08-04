//! Runtime configuration captured for native command handlers.

use std::ffi::OsString;
use std::fmt;

use thiserror::Error;
use url::Url;

use crate::secret::SecretString;
use crate::token::ZeroTokenPayload;

/// Production API used when `VM0_API_BACKEND_URL` is absent.
pub const DEFAULT_API_URL: &str = "https://api.vm0.ai";

/// Environment values consumed by the native runtime.
///
/// Keeping this as an explicit input lets tests exercise the production parser
/// without mutating process-global environment state.
#[derive(Default)]
pub struct RuntimeEnvironment {
    /// `ZERO_TOKEN` value.
    pub zero_token: Option<OsString>,
    /// `VM0_API_BACKEND_URL` value.
    pub api_backend_url: Option<OsString>,
    /// `VERCEL_AUTOMATION_BYPASS_SECRET` value.
    pub vercel_automation_bypass_secret: Option<OsString>,
    /// Resolved `http_proxy` / `HTTP_PROXY` value, with lowercase precedence.
    pub http_proxy: Option<OsString>,
    /// Resolved `https_proxy` / `HTTPS_PROXY` value, with lowercase precedence.
    pub https_proxy: Option<OsString>,
    /// Resolved `no_proxy` / `NO_PROXY` value, with lowercase precedence.
    pub no_proxy: Option<OsString>,
}

impl RuntimeEnvironment {
    /// Capture supported values from the current process environment.
    #[must_use]
    pub fn capture() -> Self {
        Self {
            zero_token: std::env::var_os("ZERO_TOKEN"),
            api_backend_url: std::env::var_os("VM0_API_BACKEND_URL"),
            vercel_automation_bypass_secret: std::env::var_os("VERCEL_AUTOMATION_BYPASS_SECRET"),
            http_proxy: proxy_environment_value("http_proxy", "HTTP_PROXY"),
            https_proxy: proxy_environment_value("https_proxy", "HTTPS_PROXY"),
            no_proxy: proxy_environment_value("no_proxy", "NO_PROXY"),
        }
    }
}

/// Proxy values applied only to the native CLI HTTP client.
pub struct ProxyConfig {
    http: Option<SecretString>,
    https: Option<SecretString>,
    no_proxy: Option<SecretString>,
}

impl ProxyConfig {
    /// Whether an HTTP proxy is configured.
    #[must_use]
    pub const fn has_http_proxy(&self) -> bool {
        self.http.is_some()
    }

    /// Whether an HTTPS proxy is configured.
    #[must_use]
    pub const fn has_https_proxy(&self) -> bool {
        self.https.is_some()
    }

    pub(crate) const fn http(&self) -> Option<&SecretString> {
        self.http.as_ref()
    }

    pub(crate) const fn https(&self) -> Option<&SecretString> {
        self.https.as_ref()
    }

    pub(crate) const fn no_proxy(&self) -> Option<&SecretString> {
        self.no_proxy.as_ref()
    }
}

impl fmt::Debug for ProxyConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProxyConfig")
            .field("has_http_proxy", &self.http.is_some())
            .field("has_https_proxy", &self.https.is_some())
            .field("has_no_proxy", &self.no_proxy.is_some())
            .finish()
    }
}

/// Validated configuration shared by native command modules.
pub struct RuntimeConfig {
    api_url: String,
    token: Option<SecretString>,
    vercel_bypass: Option<SecretString>,
    proxy: ProxyConfig,
    sandbox_context: Option<ZeroTokenPayload>,
}

impl RuntimeConfig {
    /// Capture and validate configuration from the current process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_environment(RuntimeEnvironment::capture())
    }

    /// Validate explicitly supplied runtime environment values.
    pub fn from_environment(environment: RuntimeEnvironment) -> Result<Self, ConfigError> {
        let token = optional_secret(environment.zero_token, "ZERO_TOKEN")?;
        let vercel_bypass = optional_secret(
            environment.vercel_automation_bypass_secret,
            "VERCEL_AUTOMATION_BYPASS_SECRET",
        )?;
        let api_url = normalize_api_url(environment.api_backend_url)?;
        let proxy = ProxyConfig {
            http: optional_trimmed_secret(environment.http_proxy, "http_proxy/HTTP_PROXY")?,
            https: optional_trimmed_secret(environment.https_proxy, "https_proxy/HTTPS_PROXY")?,
            no_proxy: optional_trimmed_secret(environment.no_proxy, "no_proxy/NO_PROXY")?,
        };
        let sandbox_context = token.as_ref().and_then(ZeroTokenPayload::decode);

        Ok(Self {
            api_url,
            token,
            vercel_bypass,
            proxy,
            sandbox_context,
        })
    }

    /// Normalized API base URL.
    #[must_use]
    pub fn api_url(&self) -> &str {
        &self.api_url
    }

    /// Whether a non-empty `ZERO_TOKEN` was supplied.
    #[must_use]
    pub const fn has_token(&self) -> bool {
        self.token.is_some()
    }

    /// Decoded sandbox visibility context, when the token is well formed.
    #[must_use]
    pub const fn sandbox_context(&self) -> Option<&ZeroTokenPayload> {
        self.sandbox_context.as_ref()
    }

    /// Native HTTP proxy configuration captured from process environment.
    #[must_use]
    pub const fn proxy(&self) -> &ProxyConfig {
        &self.proxy
    }

    pub(crate) const fn token(&self) -> Option<&SecretString> {
        self.token.as_ref()
    }

    pub(crate) const fn vercel_bypass(&self) -> Option<&SecretString> {
        self.vercel_bypass.as_ref()
    }
}

impl fmt::Debug for RuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeConfig")
            .field("uses_default_api_url", &(self.api_url == DEFAULT_API_URL))
            .field("has_token", &self.token.is_some())
            .field("has_vercel_bypass", &self.vercel_bypass.is_some())
            .field("proxy", &self.proxy)
            .field("sandbox_context", &self.sandbox_context)
            .finish()
    }
}

/// Invalid native runtime configuration.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    /// An environment value could not be represented as Unicode.
    #[error("{name} must contain valid Unicode")]
    NonUnicode { name: &'static str },
    /// The API base URL is not a usable absolute HTTP(S) URL.
    #[error(
        "VM0_API_BACKEND_URL must be an absolute http(s) URL without credentials, query, or fragment"
    )]
    InvalidApiUrl,
}

fn optional_secret(
    value: Option<OsString>,
    name: &'static str,
) -> Result<Option<SecretString>, ConfigError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .into_string()
        .map_err(|_| ConfigError::NonUnicode { name })?;
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(SecretString::new(value)))
}

fn optional_trimmed_secret(
    value: Option<OsString>,
    name: &'static str,
) -> Result<Option<SecretString>, ConfigError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .into_string()
        .map_err(|_| ConfigError::NonUnicode { name })?;
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(SecretString::new(value)))
}

fn proxy_environment_value(lowercase: &str, uppercase: &str) -> Option<OsString> {
    let lowercase_value = std::env::var_os(lowercase);
    if lowercase_value.as_ref().is_some_and(nonempty_proxy_value) {
        return lowercase_value;
    }
    let uppercase_value = std::env::var_os(uppercase);
    uppercase_value.filter(nonempty_proxy_value)
}

fn nonempty_proxy_value(value: &OsString) -> bool {
    value.to_str().is_none_or(|value| !value.trim().is_empty())
}

fn normalize_api_url(value: Option<OsString>) -> Result<String, ConfigError> {
    let Some(value) = value else {
        return Ok(DEFAULT_API_URL.to_string());
    };
    let value = value.into_string().map_err(|_| ConfigError::NonUnicode {
        name: "VM0_API_BACKEND_URL",
    })?;
    if value.is_empty() {
        return Ok(DEFAULT_API_URL.to_string());
    }

    let value = if value.starts_with("http") {
        value
    } else if value.contains("://") {
        return Err(ConfigError::InvalidApiUrl);
    } else {
        format!("https://{value}")
    };
    let parsed = Url::parse(&value).map_err(|_| ConfigError::InvalidApiUrl)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ConfigError::InvalidApiUrl);
    }

    Ok(parsed.as_str().trim_end_matches('/').to_string())
}
