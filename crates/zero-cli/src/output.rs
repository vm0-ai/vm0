//! Shared native command output, terminal, color, and EPIPE behavior.

use std::ffi::OsStr;
use std::io::{self, IsTerminal as _, Write};

use serde::Serialize;
use serde_json::json;
use thiserror::Error;

/// User-selected color policy for human-readable output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorChoice {
    /// Emit color only to terminal streams.
    Auto,
    /// Always emit color in human-readable mode.
    Always,
    /// Never emit color.
    Never,
}

impl ColorChoice {
    /// Resolve `NO_COLOR` and `FORCE_COLOR` for the current process.
    #[must_use]
    pub fn from_env() -> Self {
        if std::env::var_os("NO_COLOR").is_some() {
            return Self::Never;
        }
        match std::env::var_os("FORCE_COLOR") {
            Some(value) if value == OsStr::new("0") => Self::Never,
            Some(_) => Self::Always,
            None => Self::Auto,
        }
    }
}

/// Terminal capabilities captured before a native handler runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputCapabilities {
    /// Whether stdin is connected to a terminal and may be prompted.
    pub stdin_terminal: bool,
    /// Whether stdout is connected to a terminal.
    pub stdout_terminal: bool,
    /// Whether stderr is connected to a terminal.
    pub stderr_terminal: bool,
    /// Color selection policy.
    pub color: ColorChoice,
}

impl OutputCapabilities {
    /// Inspect the current process standard streams and color environment.
    #[must_use]
    pub fn detect() -> Self {
        Self {
            stdin_terminal: io::stdin().is_terminal(),
            stdout_terminal: io::stdout().is_terminal(),
            stderr_terminal: io::stderr().is_terminal(),
            color: ColorChoice::from_env(),
        }
    }
}

/// Output streams and rendering mode shared by native handlers.
pub struct Output {
    stdout: Box<dyn Write + Send>,
    stderr: Box<dyn Write + Send>,
    capabilities: OutputCapabilities,
    json: bool,
}

impl Output {
    /// Build an output boundary over the current process standard streams.
    #[must_use]
    pub fn stdio() -> Self {
        Self::new(io::stdout(), io::stderr(), OutputCapabilities::detect())
    }

    /// Build an output boundary over explicit streams and capabilities.
    #[must_use]
    pub fn new(
        stdout: impl Write + Send + 'static,
        stderr: impl Write + Send + 'static,
        capabilities: OutputCapabilities,
    ) -> Self {
        Self {
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
            capabilities,
            json: false,
        }
    }

    /// Select machine-readable output. JSON mode always disables ANSI color.
    pub const fn set_json(&mut self, json: bool) {
        self.json = json;
    }

    /// Whether machine-readable output is selected.
    #[must_use]
    pub const fn is_json(&self) -> bool {
        self.json
    }

    /// Whether stdout is a terminal and interactive prompts are permitted.
    ///
    /// This matches the npm CLI's shared prompt boundary. Commands that may
    /// consume piped input should check [`Self::stdin_is_terminal`] separately.
    #[must_use]
    pub const fn is_interactive(&self) -> bool {
        self.capabilities.stdout_terminal
    }

    /// Whether stdin is a terminal rather than a pipe or redirected file.
    #[must_use]
    pub const fn stdin_is_terminal(&self) -> bool {
        self.capabilities.stdin_terminal
    }

    /// Whether stdout is a terminal.
    #[must_use]
    pub const fn stdout_is_terminal(&self) -> bool {
        self.capabilities.stdout_terminal
    }

    /// Whether stderr is a terminal.
    #[must_use]
    pub const fn stderr_is_terminal(&self) -> bool {
        self.capabilities.stderr_terminal
    }

    /// Write one unstyled human-readable line to stdout.
    pub fn line(&mut self, message: &str) -> Result<(), OutputError> {
        writeln!(self.stdout, "{message}").map_err(OutputError::from)
    }

    /// Write unstyled text to stdout without adding a newline.
    pub fn write(&mut self, text: &str) -> Result<(), OutputError> {
        self.stdout
            .write_all(text.as_bytes())
            .map_err(OutputError::from)
    }

    /// Write one success line to stdout.
    pub fn success(&mut self, message: &str) -> Result<(), OutputError> {
        let rendered = render_style(
            message,
            "\u{1b}[32m",
            self.color_enabled(self.capabilities.stdout_terminal),
        );
        writeln!(self.stdout, "{rendered}").map_err(OutputError::from)
    }

    /// Write one subdued line to stderr.
    pub fn note(&mut self, message: &str) -> Result<(), OutputError> {
        let rendered = render_style(
            message,
            "\u{1b}[2m",
            self.color_enabled(self.capabilities.stderr_terminal),
        );
        writeln!(self.stderr, "{rendered}").map_err(OutputError::from)
    }

    /// Serialize one JSON value followed by a newline to stdout.
    pub fn json<T: Serialize>(&mut self, value: &T) -> Result<(), OutputError> {
        serde_json::to_writer(&mut self.stdout, value).map_err(OutputError::from_json)?;
        writeln!(self.stdout).map_err(OutputError::from)
    }

    /// Render a structured error to stderr in the selected output mode.
    pub fn error(&mut self, code: &str, message: &str) -> Result<(), OutputError> {
        if self.json {
            serde_json::to_writer(
                &mut self.stderr,
                &json!({ "error": { "code": code, "message": message } }),
            )
            .map_err(OutputError::from_json)?;
            return writeln!(self.stderr).map_err(OutputError::from);
        }

        let rendered = render_style(
            &format!("✗ {message}"),
            "\u{1b}[31m",
            self.color_enabled(self.capabilities.stderr_terminal),
        );
        writeln!(self.stderr, "{rendered}").map_err(OutputError::from)
    }

    fn color_enabled(&self, stream_terminal: bool) -> bool {
        if self.json {
            return false;
        }
        match self.capabilities.color {
            ColorChoice::Auto => stream_terminal,
            ColorChoice::Always => true,
            ColorChoice::Never => false,
        }
    }
}

fn render_style(message: &str, ansi_start: &str, enabled: bool) -> String {
    if enabled {
        format!("{ansi_start}{message}\u{1b}[0m")
    } else {
        message.to_string()
    }
}

/// Failure while rendering native command output.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum OutputError {
    /// A standard stream write failed.
    #[error("failed to write command output")]
    Write { kind: io::ErrorKind },
    /// A value could not be represented as JSON.
    #[error("failed to serialize command output")]
    Serialize,
}

impl OutputError {
    /// Whether a downstream reader closed its pipe early.
    #[must_use]
    pub const fn is_broken_pipe(self) -> bool {
        matches!(
            self,
            Self::Write {
                kind: io::ErrorKind::BrokenPipe
            }
        )
    }

    fn from_json(error: serde_json::Error) -> Self {
        match error.io_error_kind() {
            Some(kind) => Self::Write { kind },
            None => Self::Serialize,
        }
    }
}

impl From<io::Error> for OutputError {
    fn from(error: io::Error) -> Self {
        Self::Write { kind: error.kind() }
    }
}
