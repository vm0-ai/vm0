//! Production native command registrations.
//!
//! Business command ports add their modules and registrations here. The
//! process selection and npm fallback boundary remain unchanged.

use crate::dispatch::{HandlerRegistry, NativeHandler, RegistryError};

/// Build the production native handler registry.
///
/// Issue #24969 establishes the runtime only, so the initial registry is
/// intentionally empty and every user-facing command continues through npm.
pub fn registry() -> Result<HandlerRegistry, RegistryError> {
    HandlerRegistry::try_new(Vec::<Box<dyn NativeHandler>>::new())
}
