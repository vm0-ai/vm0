# Changelog

## [1.21.2](https://github.com/vm0-ai/vm0/compare/api-v1.21.1...api-v1.21.2) (2026-05-09)


### Bug Fixes

* **api:** add modelProviderType/modelProviderCredentialScope to chat-thread detail ([#12252](https://github.com/vm0-ai/vm0/issues/12252)) ([a15af0e](https://github.com/vm0-ai/vm0/commit/a15af0e569dc16751eb431b675e4153156c9a409))

## [1.21.1](https://github.com/vm0-ai/vm0/compare/api-v1.21.0...api-v1.21.1) (2026-05-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.3.1
    * @vm0/core bumped to 8.264.2
    * @vm0/db bumped to 1.2.2

## [1.21.0](https://github.com/vm0-ai/vm0/compare/api-v1.20.2...api-v1.21.0) (2026-05-08)


### Features

* **api:** add attachDatabasePool and env-configurable pool params ([#12239](https://github.com/vm0-ai/vm0/issues/12239)) ([b4f000d](https://github.com/vm0-ai/vm0/commit/b4f000d86f0792dcb09d50c4c2865b2afbb63993))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.3.0
    * @vm0/core bumped to 8.264.1
    * @vm0/db bumped to 1.2.1

## [1.20.2](https://github.com/vm0-ai/vm0/compare/api-v1.20.1...api-v1.20.2) (2026-05-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.264.0

## [1.20.1](https://github.com/vm0-ai/vm0/compare/api-v1.20.0...api-v1.20.1) (2026-05-08)


### Bug Fixes

* **api,web:** sort configuredTypes to eliminate connector shadow divergence ([#12217](https://github.com/vm0-ai/vm0/issues/12217)) ([74d7648](https://github.com/vm0-ai/vm0/commit/74d7648143c9e0e977b9b8abbe36edc0170cddbe))

## [1.20.0](https://github.com/vm0-ai/vm0/compare/api-v1.19.4...api-v1.20.0) (2026-05-08)


### Features

* **voice-chat:** backend transcript ingestion and talker tool dispatch from relay ([#12148](https://github.com/vm0-ai/vm0/issues/12148)) ([978db30](https://github.com/vm0-ai/vm0/commit/978db3048a0a7bc48b6de3785443d37399f17f83))
* **voice-chat:** implement vm0 realtime relay runtime and openai client ([#12150](https://github.com/vm0-ai/vm0/issues/12150)) ([4194a73](https://github.com/vm0-ai/vm0/commit/4194a73ba3175087676c380ee5e1908f3b2c9c1f))


### Bug Fixes

* **api:** strip Clerk user_ prefix from attachment file URLs ([#12163](https://github.com/vm0-ai/vm0/issues/12163)) ([ab23a04](https://github.com/vm0-ai/vm0/commit/ab23a041dd44395496603fcf5e74bf22857c6b51))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.2.0
    * @vm0/core bumped to 8.263.0
    * @vm0/db bumped to 1.2.0

## [1.19.4](https://github.com/vm0-ai/vm0/compare/api-v1.19.3...api-v1.19.4) (2026-05-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.1.0
    * @vm0/connectors bumped to 1.1.0
    * @vm0/core bumped to 8.262.0
    * @vm0/db bumped to 1.1.0

## [1.19.3](https://github.com/vm0-ai/vm0/compare/api-v1.19.2...api-v1.19.3) (2026-05-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.0.2
    * @vm0/core bumped to 8.261.2
    * @vm0/db bumped to 1.0.2

## [1.19.2](https://github.com/vm0-ai/vm0/compare/api-v1.19.1...api-v1.19.2) (2026-05-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.0.1
    * @vm0/core bumped to 8.261.1
    * @vm0/db bumped to 1.0.1

## [1.19.1](https://github.com/vm0-ai/vm0/compare/api-v1.19.0...api-v1.19.1) (2026-05-07)


### Bug Fixes

* **api:** track shared packages in release graph ([#12096](https://github.com/vm0-ai/vm0/issues/12096)) ([20c3751](https://github.com/vm0-ai/vm0/commit/20c375130a5368a95d270722e1d99d5ab1388893))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.0.0
    * @vm0/connectors bumped to 1.0.0
    * @vm0/core bumped to 8.261.0
    * @vm0/db bumped to 1.0.0

## [1.19.0](https://github.com/vm0-ai/vm0/compare/api-v1.18.0...api-v1.19.0) (2026-05-07)


### Features

* **chat:** render queued message as a user bubble with id-based dedup ([#12059](https://github.com/vm0-ai/vm0/issues/12059)) ([1e12849](https://github.com/vm0-ai/vm0/commit/1e12849625116a3bb0839a3a5788b4acac62b699))


### Bug Fixes

* fix two api shadow divergence sources — slack environment and connector timestamps ([#12055](https://github.com/vm0-ai/vm0/issues/12055)) ([17eaf0b](https://github.com/vm0-ai/vm0/commit/17eaf0bfcc4ace52a92034d17f3322cff554b360))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.260.0

## [1.18.0](https://github.com/vm0-ai/vm0/compare/api-v1.17.1...api-v1.18.0) (2026-05-06)


### Features

* add chat thread pending message api ([#11946](https://github.com/vm0-ai/vm0/issues/11946)) ([57717fe](https://github.com/vm0-ai/vm0/commit/57717feece2ba9dc3cf7b48862f56d03f06ced74))


### Bug Fixes

* order pinned threads first in chat thread list API ([#11989](https://github.com/vm0-ai/vm0/issues/11989)) ([14bed95](https://github.com/vm0-ai/vm0/commit/14bed954842a0ccf56b5633e4a6197909e3dfca3))
* use zero agent id for search filters ([#11995](https://github.com/vm0-ai/vm0/issues/11995)) ([3224bd0](https://github.com/vm0-ai/vm0/commit/3224bd05992be321f80f7c74febd5a393dbae6c4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.259.0

## [1.17.1](https://github.com/vm0-ai/vm0/compare/api-v1.17.0...api-v1.17.1) (2026-05-06)


### Bug Fixes

* align zero log agent filters with zero agent ids ([#11964](https://github.com/vm0-ai/vm0/issues/11964)) ([49c5d70](https://github.com/vm0-ai/vm0/commit/49c5d70063fea5ee6852ed3bed41d1bd9b5f0f7d))

## [1.17.0](https://github.com/vm0-ai/vm0/compare/api-v1.16.1...api-v1.17.0) (2026-05-06)


### Features

* **zero:** wire chatgpt-oauth metadata + stale-provider ux ([#11945](https://github.com/vm0-ai/vm0/issues/11945)) ([00da00d](https://github.com/vm0-ai/vm0/commit/00da00dee821515aaba65627f0b9128175797d13))

## [1.16.1](https://github.com/vm0-ai/vm0/compare/api-v1.16.0...api-v1.16.1) (2026-05-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.258.0

## [1.16.0](https://github.com/vm0-ai/vm0/compare/api-v1.15.1...api-v1.16.0) (2026-05-06)


### Features

* **zero:** plumb prefer_personal_provider through agent and schedule contracts ([#11903](https://github.com/vm0-ai/vm0/issues/11903)) ([5f7eff3](https://github.com/vm0-ai/vm0/commit/5f7eff3ec22c62087f57ffeb5d611a12afd5b2fa))


### Bug Fixes

* fill missing fields in API shadow responses ([#11900](https://github.com/vm0-ai/vm0/issues/11900)) ([5e9b034](https://github.com/vm0-ai/vm0/commit/5e9b03491c72363934179312f25b0e7583b48761))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.257.0

## [1.15.1](https://github.com/vm0-ai/vm0/compare/api-v1.15.0...api-v1.15.1) (2026-05-05)


### Bug Fixes

* use EVENT symbol to override top-level source field in Axiom logs ([#11853](https://github.com/vm0-ai/vm0/issues/11853)) ([4e199aa](https://github.com/vm0-ai/vm0/commit/4e199aa35911ae8950939ee44a72905b9acfcc64))

## [1.15.0](https://github.com/vm0-ai/vm0/compare/api-v1.14.8...api-v1.15.0) (2026-05-05)


### Features

* **api:** stream API logs to Axiom web-logs dataset ([#11807](https://github.com/vm0-ai/vm0/issues/11807)) ([5983cab](https://github.com/vm0-ai/vm0/commit/5983cab54210551cab9de486e257a65f529fc567))


### Bug Fixes

* **api:** raise shadow-compare default timeout to 5 minutes ([#11789](https://github.com/vm0-ai/vm0/issues/11789)) ([0811864](https://github.com/vm0-ai/vm0/commit/081186499462667739bd70643effe28b4fd658ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.256.0

## [1.14.8](https://github.com/vm0-ai/vm0/compare/api-v1.14.7...api-v1.14.8) (2026-05-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.255.0

## [1.14.7](https://github.com/vm0-ai/vm0/compare/api-v1.14.6...api-v1.14.7) (2026-05-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.254.0

## [1.14.6](https://github.com/vm0-ai/vm0/compare/api-v1.14.5...api-v1.14.6) (2026-05-03)


### Bug Fixes

* **api:** pass null body to fallthrough proxy for null-body upstream statuses ([#11690](https://github.com/vm0-ai/vm0/issues/11690)) ([7b7753f](https://github.com/vm0-ai/vm0/commit/7b7753f0e68138476aa79179b70699cdbd21d16f))

## [1.14.5](https://github.com/vm0-ai/vm0/compare/api-v1.14.4...api-v1.14.5) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.253.0

## [1.14.4](https://github.com/vm0-ai/vm0/compare/api-v1.14.3...api-v1.14.4) (2026-05-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.252.0

## [1.14.3](https://github.com/vm0-ai/vm0/compare/api-v1.14.2...api-v1.14.3) (2026-05-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.251.0

## [1.14.2](https://github.com/vm0-ai/vm0/compare/api-v1.14.1...api-v1.14.2) (2026-05-01)


### Bug Fixes

* remove permissive auth probe default to eliminate shadow mismatches ([#11646](https://github.com/vm0-ai/vm0/issues/11646)) ([3a49158](https://github.com/vm0-ai/vm0/commit/3a491586c1242f81590eadf5a46b2dc5a3d8cbe6))

## [1.14.1](https://github.com/vm0-ai/vm0/compare/api-v1.14.0...api-v1.14.1) (2026-04-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.250.0

## [1.14.0](https://github.com/vm0-ai/vm0/compare/api-v1.13.2...api-v1.14.0) (2026-04-30)


### Features

* **api:** add cors middleware for cross-origin browser access ([#11633](https://github.com/vm0-ai/vm0/issues/11633)) ([ca50728](https://github.com/vm0-ai/vm0/commit/ca50728186ca1d0619d41bf29f357bf62bde1ab3))

## [1.13.2](https://github.com/vm0-ai/vm0/compare/api-v1.13.1...api-v1.13.2) (2026-04-30)


### Refactoring

* **api:** tighten env schema and clean up dead code ([#11621](https://github.com/vm0-ai/vm0/issues/11621)) ([849fe02](https://github.com/vm0-ai/vm0/commit/849fe027474e831d4721c3f3758142f4677a60da))
* remove legacy credit ledger ([#11603](https://github.com/vm0-ai/vm0/issues/11603)) ([dad38a5](https://github.com/vm0-ai/vm0/commit/dad38a5ce28902731fdfe7379e55580a06a93ca3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.249.0

## [1.13.1](https://github.com/vm0-ai/vm0/compare/api-v1.13.0...api-v1.13.1) (2026-04-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.248.1

## [1.13.0](https://github.com/vm0-ai/vm0/compare/api-v1.12.2...api-v1.13.0) (2026-04-30)


### Features

* **api:** migrate remaining read routes, services, and mocks to apps/api ([#11565](https://github.com/vm0-ai/vm0/issues/11565)) ([a6a2013](https://github.com/vm0-ai/vm0/commit/a6a20136ed9395ac79c4868a8d64576ad772c1c1))

## [1.12.2](https://github.com/vm0-ai/vm0/compare/api-v1.12.1...api-v1.12.2) (2026-04-30)


### Bug Fixes

* **api:** buffer upstream body in proxyToWeb to prevent ReadableStream loss ([#11572](https://github.com/vm0-ai/vm0/issues/11572)) ([42ddc6a](https://github.com/vm0-ai/vm0/commit/42ddc6a8f12e307cec5ac0291d2180ee43cf81e9))

## [1.12.1](https://github.com/vm0-ai/vm0/compare/api-v1.12.0...api-v1.12.1) (2026-04-29)


### Bug Fixes

* strip forwarded headers from api fallback proxy ([#11557](https://github.com/vm0-ai/vm0/issues/11557)) ([8cbe7df](https://github.com/vm0-ai/vm0/commit/8cbe7dfdcf80fc069b1eb429d834b097b336ca10))


### Refactoring

* **api:** convert route test db helpers to commands ([#11553](https://github.com/vm0-ai/vm0/issues/11553)) ([451ce87](https://github.com/vm0-ai/vm0/commit/451ce87a5695a0c58920c239702da4111d9eba89))

## [1.12.0](https://github.com/vm0-ai/vm0/compare/api-v1.11.2...api-v1.12.0) (2026-04-29)


### Features

* **api:** migrate zero read routes to api ([#11540](https://github.com/vm0-ai/vm0/issues/11540)) ([3105ff0](https://github.com/vm0-ai/vm0/commit/3105ff071ad9110f705d30c2335185cb2877dd14))


### Refactoring

* **api:** convert body validation to computed and drop barrel reexports ([#11543](https://github.com/vm0-ai/vm0/issues/11543)) ([8bbea21](https://github.com/vm0-ai/vm0/commit/8bbea21ca61e43cb9eb6c6d7f8fba7d9eabbf164))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.248.0

## [1.11.2](https://github.com/vm0-ai/vm0/compare/api-v1.11.1...api-v1.11.2) (2026-04-29)


### Bug Fixes

* add min pool connection to api db to eliminate cold-start latency ([#11534](https://github.com/vm0-ai/vm0/issues/11534)) ([c3c6ddb](https://github.com/vm0-ai/vm0/commit/c3c6ddb8e630f6770b8e22ef818cba09d11fa6b7))

## [1.11.1](https://github.com/vm0-ai/vm0/compare/api-v1.11.0...api-v1.11.1) (2026-04-29)


### Bug Fixes

* aggregate model rankings by model name ([#11518](https://github.com/vm0-ai/vm0/issues/11518)) ([a61863a](https://github.com/vm0-ai/vm0/commit/a61863a45b373cc92d78e5281c038594f580a22d))

## [1.11.0](https://github.com/vm0-ai/vm0/compare/api-v1.10.2...api-v1.11.0) (2026-04-29)


### Features

* add api backend shadow migration and migrate read routes ([#11454](https://github.com/vm0-ai/vm0/issues/11454)) ([d45cbef](https://github.com/vm0-ai/vm0/commit/d45cbef58410bf5e7ea8f2c1debbce52ca3f4cb8))


### Bug Fixes

* harden model rankings cron aggregation ([#11485](https://github.com/vm0-ai/vm0/issues/11485)) ([39bc094](https://github.com/vm0-ai/vm0/commit/39bc0948c813a3250a8c3e8990c9ceb665a5f848))

## [1.10.2](https://github.com/vm0-ai/vm0/compare/api-v1.10.1...api-v1.10.2) (2026-04-29)


### Bug Fixes

* **api:** emit pg client spans by wrapping the pool instance ([#11499](https://github.com/vm0-ai/vm0/issues/11499)) ([2ebb619](https://github.com/vm0-ai/vm0/commit/2ebb61963a1c81050ad532629e224ffb8b23be42))
* **api:** include cron definitions in build output ([#11498](https://github.com/vm0-ai/vm0/issues/11498)) ([e5ed066](https://github.com/vm0-ai/vm0/commit/e5ed0669745fb3da9d83b6059afce58a2fcb89a1))

## [1.10.1](https://github.com/vm0-ai/vm0/compare/api-v1.10.0...api-v1.10.1) (2026-04-29)


### Bug Fixes

* **api:** stop @sentry/node from emitting duplicate spans ([#11462](https://github.com/vm0-ai/vm0/issues/11462)) ([5fe6c4f](https://github.com/vm0-ai/vm0/commit/5fe6c4f61686f826a654932614e6f5942cf4f280))

## [1.10.0](https://github.com/vm0-ai/vm0/compare/api-v1.9.0...api-v1.10.0) (2026-04-29)


### Features

* add model usage rankings ([#11464](https://github.com/vm0-ai/vm0/issues/11464)) ([e251a05](https://github.com/vm0-ai/vm0/commit/e251a05dcc738ea7b2ae0c798ef9a47e21978746))

## [1.9.0](https://github.com/vm0-ai/vm0/compare/api-v1.8.1...api-v1.9.0) (2026-04-28)


### Features

* add bb0 device flow ([#11383](https://github.com/vm0-ai/vm0/issues/11383)) ([00871f5](https://github.com/vm0-ai/vm0/commit/00871f521741d5769c0f20e7da9e93de9fbaf91b))

## [1.8.1](https://github.com/vm0-ai/vm0/compare/api-v1.8.0...api-v1.8.1) (2026-04-28)


### Bug Fixes

* thread auth options through shadow probe to eliminate false mismatch ([#11378](https://github.com/vm0-ai/vm0/issues/11378)) ([4c433f2](https://github.com/vm0-ai/vm0/commit/4c433f268530641f23e2b9d62d352bdfc8469519))

## [1.8.0](https://github.com/vm0-ai/vm0/compare/api-v1.7.0...api-v1.8.0) (2026-04-28)


### Features

* add voice transcription api ([#11365](https://github.com/vm0-ai/vm0/issues/11365)) ([4b15bf5](https://github.com/vm0-ai/vm0/commit/4b15bf5e4b75b97180a0c7e0044a7aa1b0f8975d))

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
