//! Raw-argument dispatch and the stable native handler registry.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;

use async_trait::async_trait;
use clap::error::ErrorKind;
use clap::{ArgMatches, Command};
use thiserror::Error;

use crate::build::BuildInfo;
use crate::error::CliError;
use crate::runtime::CommandContext;

/// Original operating-system arguments following the `zero-cli` executable.
pub struct Invocation {
    args: Vec<OsString>,
}

impl Invocation {
    /// Capture the original process arguments without Unicode conversion.
    #[must_use]
    pub fn from_env() -> Self {
        Self::from_args(std::env::args_os().skip(1))
    }

    /// Build an invocation from explicit raw arguments.
    #[must_use]
    pub fn from_args(args: impl IntoIterator<Item = OsString>) -> Self {
        Self {
            args: args.into_iter().collect(),
        }
    }

    /// Original arguments, unchanged and in original order.
    #[must_use]
    pub fn args(&self) -> &[OsString] {
        &self.args
    }

    fn first_command_name(&self) -> Option<&str> {
        self.args.first()?.to_str()
    }

    fn clap_args(&self) -> impl Iterator<Item = OsString> + '_ {
        std::iter::once(OsString::from("zero")).chain(self.args.iter().cloned())
    }
}

impl fmt::Debug for Invocation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Invocation")
            .field("argument_count", &self.args.len())
            .finish_non_exhaustive()
    }
}

/// One natively implemented top-level command.
#[async_trait]
pub trait NativeHandler: Send + Sync {
    /// Clap command definition owned by this handler.
    fn command(&self) -> Command;

    /// Execute the parsed command through shared runtime boundaries.
    async fn run(&self, context: &mut CommandContext, matches: ArgMatches) -> Result<(), CliError>;
}

struct HandlerEntry {
    command: Command,
    handler: Box<dyn NativeHandler>,
}

/// Deterministically ordered native top-level command registry.
///
/// Selection checks only the exact raw first argument. Root flags, unknown
/// commands, non-Unicode arguments, and unregistered commands are therefore
/// routed to npm without first passing through Clap.
#[derive(Default)]
pub struct HandlerRegistry {
    handlers: BTreeMap<String, HandlerEntry>,
}

impl HandlerRegistry {
    /// Validate and build a registry from native handlers.
    pub fn try_new(
        handlers: impl IntoIterator<Item = Box<dyn NativeHandler>>,
    ) -> Result<Self, RegistryError> {
        let mut registry = Self::default();
        for handler in handlers {
            let command = handler.command();
            let name = command.get_name().to_string();
            if registry.handlers.contains_key(&name) {
                return Err(RegistryError::DuplicateCommand { name });
            }
            registry
                .handlers
                .insert(name, HandlerEntry { command, handler });
        }
        Ok(registry)
    }

    /// Return the selected native handler without parsing or changing arguments.
    #[must_use]
    pub fn handler_for(&self, invocation: &Invocation) -> Option<&dyn NativeHandler> {
        let name = invocation.first_command_name()?;
        self.handlers.get(name).map(|entry| entry.handler.as_ref())
    }

    /// Build the structured native command root from registered handlers.
    #[must_use]
    pub fn command_root(&self) -> Command {
        let build = BuildInfo::current();
        self.handlers.values().fold(
            Command::new("zero")
                .about("Zero CLI — native runner-bundled runtime")
                .version(build.version)
                .long_version(build.build_id)
                .propagate_version(true)
                .disable_help_subcommand(true)
                .subcommand_required(true),
            |root, entry| root.subcommand(entry.command.clone()),
        )
    }

    pub(crate) fn parse(&self, invocation: &Invocation) -> Result<NativeParse<'_>, CliError> {
        let mut matches = match self
            .command_root()
            .try_get_matches_from(invocation.clap_args())
        {
            Ok(matches) => matches,
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
                ) =>
            {
                return Ok(NativeParse::Display(error.to_string()));
            }
            Err(_) => return Err(CliError::Usage),
        };
        let (name, matches) = matches
            .remove_subcommand()
            .ok_or(RegistryError::MissingSelectedCommand)?;
        let entry = self
            .handlers
            .get(&name)
            .ok_or(RegistryError::MissingSelectedCommand)?;
        Ok(NativeParse::Command(ParsedNativeCommand {
            handler: entry.handler.as_ref(),
            matches,
        }))
    }
}

pub(crate) enum NativeParse<'a> {
    Command(ParsedNativeCommand<'a>),
    Display(String),
}

pub(crate) struct ParsedNativeCommand<'a> {
    pub handler: &'a dyn NativeHandler,
    pub matches: ArgMatches,
}

/// Invalid native registry construction or dispatch state.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RegistryError {
    /// Two handlers claimed the same exact top-level command.
    #[error("duplicate native handler registration for {name}")]
    DuplicateCommand { name: String },
    /// A previously selected handler was absent from the parsed registry.
    #[error("native handler registry lost the selected command")]
    MissingSelectedCommand,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct HelpHandler;

    #[async_trait]
    impl NativeHandler for HelpHandler {
        fn command(&self) -> Command {
            Command::new("native-help").about("Native help boundary")
        }

        async fn run(
            &self,
            _context: &mut CommandContext,
            _matches: ArgMatches,
        ) -> Result<(), CliError> {
            Ok(())
        }
    }

    #[test]
    fn native_help_is_a_successful_display_decision() {
        let registry =
            HandlerRegistry::try_new([Box::new(HelpHandler) as Box<dyn NativeHandler>]).unwrap();
        let invocation = Invocation::from_args(["native-help".into(), "--help".into()]);
        let decision = registry.parse(&invocation).unwrap();
        let NativeParse::Display(help) = decision else {
            panic!("expected native help display");
        };

        assert!(help.contains("Native help boundary"));
        assert!(help.contains("Usage: zero native-help"));
    }
}
