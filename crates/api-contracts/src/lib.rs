//! Rust bindings for selected `@vm0/api-contracts` routes, DTOs, and shared
//! constants.
//!
//! Route constants under [`generated::routes`] are generated from the
//! TypeScript supported-route registry. Request/response DTOs under
//! [`generated::types`] are generated from the selected Rust DTO registry.
//! Narrow cross-language contract constants are generated under
//! [`generated::constants`]. Regenerate all bindings with:
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
//! `turbo/packages/api-contracts/src/rust-bindings/types.ts`. Add shared
//! constants only when they are part of an explicit Rust/TypeScript contract,
//! and register them under `turbo/packages/api-contracts/src/rust-bindings/`.

pub mod generated;

mod route;

pub use route::{Method, ResolvedRoute, Route, RouteTemplate};
