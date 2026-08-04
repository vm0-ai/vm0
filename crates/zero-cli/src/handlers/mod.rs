//! Production native command registrations.
//!
//! Phase 2 commands own one module and one registration slot each. A command
//! migration fills its existing slot without editing this shared registry, so
//! independent ports can proceed without repeatedly conflicting here.

mod banking;
mod finance;
mod intro;
mod model;
mod model_provider;
mod people_search;
mod scrape;
mod upgrade;
mod web_search;
mod whoami;

use crate::dispatch::{HandlerRegistry, NativeHandler, RegistryError};

type HandlerFactory = fn() -> Box<dyn NativeHandler>;

const PHASE_2_HANDLER_SLOTS: [Option<HandlerFactory>; 10] = [
    banking::HANDLER,
    finance::HANDLER,
    intro::HANDLER,
    model::HANDLER,
    model_provider::HANDLER,
    people_search::HANDLER,
    scrape::HANDLER,
    upgrade::HANDLER,
    web_search::HANDLER,
    whoami::HANDLER,
];

/// Build the production native handler registry.
///
/// Unfilled Phase 2 slots are omitted, preserving npm fallback for commands
/// that have not yet been migrated.
pub fn registry() -> Result<HandlerRegistry, RegistryError> {
    let handlers = PHASE_2_HANDLER_SLOTS
        .into_iter()
        .flatten()
        .map(|factory| factory());
    HandlerRegistry::try_new(handlers)
}
