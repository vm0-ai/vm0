//! Rust bindings for selected `@vm0/api-contracts` routes.
//!
//! Route constants under [`generated::routes`] are generated from the
//! TypeScript supported-route registry. Regenerate them with:
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
//! `turbo/packages/api-contracts/src/rust-bindings/routes.ts`.

pub mod generated;

mod route;

pub use route::{Method, ResolvedRoute, Route, RouteTemplate};
