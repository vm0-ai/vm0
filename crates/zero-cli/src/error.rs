//! Structured errors shared by native command modules.

use std::io;

use thiserror::Error;

use crate::config::ConfigError;
use crate::dispatch::RegistryError;
use crate::output::OutputError;

/// Parsed non-success response from the vm0 API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    status: u16,
    code: String,
    message: String,
}

impl ApiError {
    /// Build a sanitized API response error.
    #[must_use]
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    /// HTTP status returned by the API.
    #[must_use]
    pub const fn status(&self) -> u16 {
        self.status
    }

    /// API error code, or `UNKNOWN` when the body omitted one.
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    /// API error message, or the request's default failure message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

/// Error crossing the native CLI process boundary.
#[derive(Debug, Error)]
pub enum CliError {
    /// Invalid environment configuration.
    #[error(transparent)]
    Config(#[from] ConfigError),
    /// Invalid native handler registration.
    #[error(transparent)]
    Registry(#[from] RegistryError),
    /// Native output failed.
    #[error(transparent)]
    Output(#[from] OutputError),
    /// No run-scoped authentication token is available.
    #[error("not authenticated; set ZERO_TOKEN to a valid run token")]
    NotAuthenticated,
    /// The shared HTTP client could not be initialized.
    #[error("failed to initialize the API HTTP client")]
    HttpClient,
    /// An API request failed before receiving a response.
    #[error("API request failed: {message}")]
    Transport { message: String },
    /// The API returned a non-success response.
    #[error("{status}: {message}", status = .0.status(), message = .0.message())]
    Api(ApiError),
    /// A registered native command received invalid arguments.
    #[error("invalid command arguments; run the command with --help")]
    Usage,
    /// A native command returned a domain error.
    #[error("{message}")]
    Command { code: &'static str, message: String },
    /// The npm fallback could not replace the current process.
    #[error("failed to execute the npm Zero CLI fallback")]
    FallbackExec { kind: io::ErrorKind },
    /// The single-thread native async runtime could not be initialized.
    #[error("failed to initialize the native command runtime")]
    Runtime,
}

impl CliError {
    /// Build an exec failure without retaining arguments, environment, or paths.
    #[must_use]
    pub const fn fallback_exec(kind: io::ErrorKind) -> Self {
        Self::FallbackExec { kind }
    }

    /// Build a transport error after its URL has been removed.
    #[must_use]
    pub fn transport(message: impl Into<String>) -> Self {
        Self::Transport {
            message: message.into(),
        }
    }

    /// Stable machine-readable code for the error boundary.
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::Config(_) => "CONFIG_ERROR",
            Self::Registry(_) | Self::Runtime => "RUNTIME_ERROR",
            Self::Output(_) => "OUTPUT_ERROR",
            Self::NotAuthenticated => "UNAUTHORIZED",
            Self::HttpClient | Self::Transport { .. } => "HTTP_ERROR",
            Self::Api(error) => error.code(),
            Self::Usage => "INVALID_ARGUMENTS",
            Self::Command { code, .. } => code,
            Self::FallbackExec { .. } => "NPM_FALLBACK_ERROR",
        }
    }

    /// Exit status used by the native error boundary.
    #[must_use]
    pub const fn exit_status(&self) -> u8 {
        match self {
            Self::Usage => 2,
            _ => 1,
        }
    }

    /// Whether writing failed because a downstream pipe closed.
    #[must_use]
    pub const fn is_broken_pipe(&self) -> bool {
        matches!(Self::output_error(self), Some(error) if error.is_broken_pipe())
    }

    const fn output_error(&self) -> Option<OutputError> {
        match self {
            Self::Output(error) => Some(*error),
            _ => None,
        }
    }
}
