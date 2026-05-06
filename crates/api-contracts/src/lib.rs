//! Rust bindings for selected `@vm0/api-contracts` routes and DTOs.
//!
//! Route constants under [`generated::routes`] are generated from the
//! TypeScript supported-route registry. Request/response DTOs under
//! [`generated::types`] are generated from the selected Rust DTO registry.
//! Regenerate them with:
//!
//! ```bash
//! cd turbo && pnpm -F @vm0/api-contracts generate:rust
//! ```
//!
//! Static routes are generated as [`Route`] constants. Routes with path
//! parameters are generated as [`RouteTemplate`] constants plus typed `Params`
//! and `route(...)` helpers that return [`ResolvedRoute`]. Use [`Route::url`]
//! for static routes and [`ResolvedRoute::url`] after applying path params.
//!
//! Add new Rust-supported routes to
//! `turbo/packages/api-contracts/src/rust-bindings/routes.ts`, and add new
//! Rust-supported DTOs to
//! `turbo/packages/api-contracts/src/rust-bindings/types.ts`.

pub mod generated;

mod route;

pub use route::{Method, ResolvedRoute, Route, RouteTemplate};
