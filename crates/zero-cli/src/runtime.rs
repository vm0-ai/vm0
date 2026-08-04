//! Native-only initialization and the shared process error boundary.

use std::process::ExitCode;

use crate::config::RuntimeConfig;
use crate::dispatch::{HandlerRegistry, Invocation, NativeParse};
use crate::error::CliError;
use crate::output::Output;

/// Shared state supplied to one native command handler.
pub struct CommandContext {
    config: Option<RuntimeConfig>,
    output: Output,
}

impl CommandContext {
    /// Build a command context without reading process configuration.
    ///
    /// Local-only handlers can use the output boundary without being affected
    /// by unrelated API or authentication environment variables.
    #[must_use]
    pub const fn new(output: Output) -> Self {
        Self {
            config: None,
            output,
        }
    }

    /// Lazily load and return the captured runtime configuration.
    pub fn config(&mut self) -> Result<&RuntimeConfig, CliError> {
        if self.config.is_none() {
            self.config = Some(RuntimeConfig::from_env()?);
        }

        self.config.as_ref().ok_or(CliError::Runtime)
    }

    /// Shared output renderer.
    #[must_use]
    pub const fn output(&self) -> &Output {
        &self.output
    }

    /// Mutable shared output renderer.
    #[must_use]
    pub const fn output_mut(&mut self) -> &mut Output {
        &mut self.output
    }

    fn into_output(self) -> Output {
        self.output
    }
}

/// Parse and run a selected native handler.
///
/// This function is called only after raw dispatch has proven that a native
/// handler exists, so unsupported commands never initialize config, Clap, or
/// an async runtime before npm process replacement.
pub fn run_native(registry: HandlerRegistry, invocation: Invocation) -> ExitCode {
    let mut output = Output::stdio();
    let parsed = match registry.parse(&invocation) {
        Ok(NativeParse::Command(parsed)) => parsed,
        Ok(NativeParse::Display(text)) => {
            return match output.write(&text) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) if error.is_broken_pipe() => ExitCode::SUCCESS,
                Err(_) => ExitCode::FAILURE,
            };
        }
        Err(error) => return render_error(error, output),
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return render_error(CliError::Runtime, output),
    };

    let mut context = CommandContext::new(output);
    let result = runtime.block_on(parsed.handler.run(&mut context, parsed.matches));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => render_error(error, context.into_output()),
    }
}

/// Render one process-boundary error and return its exit status.
#[must_use]
pub fn render_error(error: CliError, mut output: Output) -> ExitCode {
    if error.is_broken_pipe() {
        return ExitCode::SUCCESS;
    }

    let exit_status = error.exit_status();
    let code = error.code().to_string();
    let message = error.to_string();
    match output.error(&code, &message) {
        Ok(()) => ExitCode::from(exit_status),
        Err(output_error) if output_error.is_broken_pipe() => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_context_does_not_load_config_during_construction() {
        let context = CommandContext::new(Output::stdio());

        assert!(context.config.is_none());
    }
}
