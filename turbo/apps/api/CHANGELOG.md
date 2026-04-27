# Changelog

## [1.3.1](https://github.com/vm0-ai/vm0/compare/api-v1.3.0...api-v1.3.1) (2026-04-27)


### Refactoring

* **api:** consolidate auth tests into a single /health/auth probe ([#11233](https://github.com/vm0-ai/vm0/issues/11233)) ([809c5d6](https://github.com/vm0-ai/vm0/commit/809c5d6f2722c8517e5d59b6430367483c6e13fe))

## [1.3.0](https://github.com/vm0-ai/vm0/compare/api-v1.2.1...api-v1.3.0) (2026-04-27)


### Features

* **api:** add auth-route wrapper, lazy-singleton helpers, and lint rules ([#11228](https://github.com/vm0-ai/vm0/issues/11228)) ([d513a3a](https://github.com/vm0-ai/vm0/commit/d513a3a1c81d5c1582e2e40224d0172b6c9f1cda))

## [1.2.1](https://github.com/vm0-ai/vm0/compare/api-v1.2.0...api-v1.2.1) (2026-04-27)


### Refactoring

* **api:** replace routesExtend with keyed handlers in test helpers ([#11168](https://github.com/vm0-ai/vm0/issues/11168)) ([d2be45e](https://github.com/vm0-ai/vm0/commit/d2be45ef884a8df8214df0d10fe077cf9d928114))

## [1.2.0](https://github.com/vm0-ai/vm0/compare/api-v1.1.0...api-v1.2.0) (2026-04-26)


### Features

* **api:** add typed health routes ([#11165](https://github.com/vm0-ai/vm0/issues/11165)) ([4b03280](https://github.com/vm0-ai/vm0/commit/4b032809e451cbdcbc0e7e864ea0c1d152ba1cab))
* **api:** migrate infra auth to hono service ([#11146](https://github.com/vm0-ai/vm0/issues/11146)) ([3e6f32f](https://github.com/vm0-ai/vm0/commit/3e6f32f43c4eab95e51f292bddc99f3f8ccb13dc))


### Bug Fixes

* **api:** add health check endpoint ([#11154](https://github.com/vm0-ai/vm0/issues/11154)) ([c1b9d63](https://github.com/vm0-ai/vm0/commit/c1b9d63ad0ccbf51a885a01fa7a1c5c3909e9ab5))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/api-v1.0.1...api-v1.1.0) (2026-04-26)


### Features

* **api:** add hono tracing and built-in model listing ([#11133](https://github.com/vm0-ai/vm0/issues/11133)) ([0c954d5](https://github.com/vm0-ai/vm0/commit/0c954d5729d36959e7660874e61be80157e64290))

## [1.0.1](https://github.com/vm0-ai/vm0/compare/api-v1.0.0...api-v1.0.1) (2026-04-26)


### Bug Fixes

* **api:** Vercel picks wrong entrypoint, causing FUNCTION_INVOCATION_FAILED ([#11121](https://github.com/vm0-ai/vm0/issues/11121)) ([f340ff2](https://github.com/vm0-ai/vm0/commit/f340ff20ec3376eca0675b205015c313eb9a0bbd))

## 1.0.0 (2026-04-25)


### Features

* add hono api server ([#11095](https://github.com/vm0-ai/vm0/issues/11095)) ([fb18794](https://github.com/vm0-ai/vm0/commit/fb187940811d4e0c47f41964efbec499de3f8bac))


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))
