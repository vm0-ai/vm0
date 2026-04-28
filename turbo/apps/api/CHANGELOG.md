# Changelog

## [1.7.0](https://github.com/vm0-ai/vm0/compare/api-v1.6.0...api-v1.7.0) (2026-04-28)


### Features

* add bb0 device onboarding api ([#11340](https://github.com/vm0-ai/vm0/issues/11340)) ([0fc8ebe](https://github.com/vm0-ai/vm0/commit/0fc8ebedfa81ec7cb5b64707635654231604845d))


### Bug Fixes

* evaluate zero token before sandbox capability guard in API auth ([#11349](https://github.com/vm0-ai/vm0/issues/11349)) ([f9c24fd](https://github.com/vm0-ai/vm0/commit/f9c24fdbf50fc0ffae59ee99c48120203384b39d))

## [1.6.0](https://github.com/vm0-ai/vm0/compare/api-v1.5.0...api-v1.6.0) (2026-04-28)


### Features

* **api:** per-route opentelemetry traces routed to axiom ([#11339](https://github.com/vm0-ai/vm0/issues/11339)) ([c4d83ad](https://github.com/vm0-ai/vm0/commit/c4d83adcf10248b765a1fdcb1711877c1b65f391))

## [1.5.0](https://github.com/vm0-ai/vm0/compare/api-v1.4.1...api-v1.5.0) (2026-04-28)


### Features

* **api:** proxy unmatched requests to the web app ([#11308](https://github.com/vm0-ai/vm0/issues/11308)) ([5edb547](https://github.com/vm0-ai/vm0/commit/5edb547217e654556839e1b57fdf6de9c9d03d70))

## [1.4.1](https://github.com/vm0-ai/vm0/compare/api-v1.4.0...api-v1.4.1) (2026-04-28)


### Bug Fixes

* **api:** tighten bearer auth fallthrough and adopt platform's lint rules ([#11294](https://github.com/vm0-ai/vm0/issues/11294)) ([b458bef](https://github.com/vm0-ai/vm0/commit/b458beffb74d9577d686fb9f035ab46b320f22c1))

## [1.4.0](https://github.com/vm0-ai/vm0/compare/api-v1.3.1...api-v1.4.0) (2026-04-28)


### Features

* shadow web /api/v1/chat-threads read routes against new api handlers ([#11278](https://github.com/vm0-ai/vm0/issues/11278)) ([df01cb6](https://github.com/vm0-ai/vm0/commit/df01cb601d221a19a26b44e19d20b337a6e83758))


### Bug Fixes

* **api:** align auth resolution with web app for shadow comparison ([#11271](https://github.com/vm0-ai/vm0/issues/11271)) ([2df9c36](https://github.com/vm0-ai/vm0/commit/2df9c36c126c25da1898e727eb64f6ef5b06169f))

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
