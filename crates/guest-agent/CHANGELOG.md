# Changelog

## [0.61.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.3...guest-agent-v0.61.4) (2026-07-31)

## [0.61.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.2...guest-agent-v0.61.3) (2026-07-31)


### Documentation

* **rust:** document session-history sidecar export contract ([#24224](https://github.com/vm0-ai/vm0/issues/24224)) ([05ab252](https://github.com/vm0-ai/vm0/commit/05ab252160536271300f46221a2f42211675d08b))

## [0.61.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.1...guest-agent-v0.61.2) (2026-07-31)

## [0.61.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.61.0...guest-agent-v0.61.1) (2026-07-30)

## [0.61.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.60.2...guest-agent-v0.61.0) (2026-07-30)


### Features

* add admin-defined model gateway connections ([#23807](https://github.com/vm0-ai/vm0/issues/23807)) ([0632cb4](https://github.com/vm0-ai/vm0/commit/0632cb4e4dfda2c844a2531d6c13a3dd74b86e29))

## [0.60.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.60.1...guest-agent-v0.60.2) (2026-07-30)

## [0.60.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.60.0...guest-agent-v0.60.1) (2026-07-30)

## [0.60.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.59.0...guest-agent-v0.60.0) (2026-07-30)


### Features

* **events:** report structured guest event delivery failures ([#23974](https://github.com/vm0-ai/vm0/issues/23974)) ([ebdf828](https://github.com/vm0-ai/vm0/commit/ebdf8280b7b961ebf8404790a15696a7338ecd6e))

## [0.59.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.11...guest-agent-v0.59.0) (2026-07-30)


### Features

* enable codex session pruning globally ([#23937](https://github.com/vm0-ai/vm0/issues/23937)) ([e186ffe](https://github.com/vm0-ai/vm0/commit/e186ffe85a92fe9a5b960e5e3174893d54526557))

## [0.58.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.10...guest-agent-v0.58.11) (2026-07-30)


### Bug Fixes

* **guest-agent:** checkpoint user cancellations before completion ([#23899](https://github.com/vm0-ai/vm0/issues/23899)) ([ba905f6](https://github.com/vm0-ai/vm0/commit/ba905f65bb5f99fac077c236b4ca57175708ead5))

## [0.58.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.9...guest-agent-v0.58.10) (2026-07-29)

## [0.58.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.8...guest-agent-v0.58.9) (2026-07-29)


### Bug Fixes

* **runner:** checkpoint sessions before job timeout ([#23734](https://github.com/vm0-ai/vm0/issues/23734)) ([15f44cc](https://github.com/vm0-ai/vm0/commit/15f44cc68e1387d5b18f604fea9c964a1557561d))

## [0.58.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.7...guest-agent-v0.58.8) (2026-07-29)


### Documentation

* **guest-agent:** document claude result status ([#23687](https://github.com/vm0-ai/vm0/issues/23687)) ([915e342](https://github.com/vm0-ai/vm0/commit/915e3422dc04d9729e5691c76147fa0dbdecf2fc))

## [0.58.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.6...guest-agent-v0.58.7) (2026-07-29)

## [0.58.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.5...guest-agent-v0.58.6) (2026-07-29)


### Refactoring

* **guest-agent:** split checkpoint pipelines ([#23600](https://github.com/vm0-ai/vm0/issues/23600)) ([859fb3b](https://github.com/vm0-ai/vm0/commit/859fb3b537a842d78b7bebb7dc483b3c1eaea160))

## [0.58.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.4...guest-agent-v0.58.5) (2026-07-28)

## [0.58.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.3...guest-agent-v0.58.4) (2026-07-28)

## [0.58.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.2...guest-agent-v0.58.3) (2026-07-28)


### Bug Fixes

* **runner:** classify codex safety policy refusals ([#23391](https://github.com/vm0-ai/vm0/issues/23391)) ([a1d9986](https://github.com/vm0-ai/vm0/commit/a1d9986f1183067249dc168ba3643acdf05f79ca))

## [0.58.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.1...guest-agent-v0.58.2) (2026-07-27)


### Refactoring

* **guest-agent:** retire checkpoint gzip downgrade ([#23314](https://github.com/vm0-ai/vm0/issues/23314)) ([7fe12c2](https://github.com/vm0-ai/vm0/commit/7fe12c206e8e0504da52a646527221359e7b94b7))

## [0.58.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.58.0...guest-agent-v0.58.1) (2026-07-27)


### Bug Fixes

* **guest-agent:** preserve codex fast mode in app server ([#23240](https://github.com/vm0-ai/vm0/issues/23240)) ([f108f48](https://github.com/vm0-ai/vm0/commit/f108f48e832d3d4d61de338bb698b6d782f1121e))


### Documentation

* **guest-agent:** document reuse preparation safety contract ([#23243](https://github.com/vm0-ai/vm0/issues/23243)) ([9437606](https://github.com/vm0-ai/vm0/commit/9437606dabaa1ae4f51bd4be04f388b66d9c0ab4))


### Refactoring

* **guest-agent:** narrow session metadata visibility ([#23244](https://github.com/vm0-ai/vm0/issues/23244)) ([fba8fff](https://github.com/vm0-ai/vm0/commit/fba8fff884be8030a1af16f5c1c108a3b28d5d22))


### Performance Improvements

* **guest-agent:** offload checkpoint history work ([#23260](https://github.com/vm0-ai/vm0/issues/23260)) ([41379e3](https://github.com/vm0-ai/vm0/commit/41379e381da2c29323f5e1e3f6a11031b81cea5e))

## [0.58.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.57.1...guest-agent-v0.58.0) (2026-07-26)


### Features

* prune oversized codex session history ([#23136](https://github.com/vm0-ai/vm0/issues/23136)) ([010d286](https://github.com/vm0-ai/vm0/commit/010d286e46b4b7035ef41e6417bdfca707688aa0))


### Refactoring

* **storage:** detach runtime from legacy storage type ([#23143](https://github.com/vm0-ai/vm0/issues/23143)) ([cc415c5](https://github.com/vm0-ai/vm0/commit/cc415c5c844343ab573c0d9de5a31d1fd378ad69))

## [0.57.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.57.0...guest-agent-v0.57.1) (2026-07-26)


### Performance Improvements

* disable unused codex plugin and apps startup work ([#23132](https://github.com/vm0-ai/vm0/issues/23132)) ([038cabe](https://github.com/vm0-ai/vm0/commit/038cabedd7e5b8adbe4926f94102affe8455ad14))

## [0.57.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.6...guest-agent-v0.57.0) (2026-07-26)


### Features

* prune compacted claude session history ([#23081](https://github.com/vm0-ai/vm0/issues/23081)) ([671dc1c](https://github.com/vm0-ai/vm0/commit/671dc1c3a1ffe14b3be6d7079afd6f2cc24f14b0))

## [0.56.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.5...guest-agent-v0.56.6) (2026-07-26)


### Refactoring

* **storage:** authorize writeback by storage id ([#23112](https://github.com/vm0-ai/vm0/issues/23112)) ([321117e](https://github.com/vm0-ai/vm0/commit/321117edaf5f2304b87a435748557ad47cf73ea3))

## [0.56.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.4...guest-agent-v0.56.5) (2026-07-26)


### Performance Improvements

* **guest-agent:** disable upstream codex analytics ([#23099](https://github.com/vm0-ai/vm0/issues/23099)) ([88ecf52](https://github.com/vm0-ai/vm0/commit/88ecf529e28c1a18f2ecd421d51f5d8023b25d8b))

## [0.56.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.3...guest-agent-v0.56.4) (2026-07-25)


### Bug Fixes

* **guest-agent:** classify no-chunks stream timeouts ([#23041](https://github.com/vm0-ai/vm0/issues/23041)) ([f3a9714](https://github.com/vm0-ai/vm0/commit/f3a97146f04c2b883c00f174f05a2ead14ec5342))

## [0.56.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.2...guest-agent-v0.56.3) (2026-07-25)


### Bug Fixes

* **guest-agent:** classify oversized session history failures ([#23020](https://github.com/vm0-ai/vm0/issues/23020)) ([13b74f3](https://github.com/vm0-ai/vm0/commit/13b74f3d501b1e2f3be539969d3a9eb3479c7d3e))

## [0.56.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.1...guest-agent-v0.56.2) (2026-07-25)


### Performance Improvements

* **guest-agent:** reuse verified mock builds across tests ([#22984](https://github.com/vm0-ai/vm0/issues/22984)) ([cfe1d4b](https://github.com/vm0-ai/vm0/commit/cfe1d4bd614b83a1191b635f1cd80ef23d6b97c2))

## [0.56.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.56.0...guest-agent-v0.56.1) (2026-07-25)


### Performance Improvements

* add first-output coverage and codex lifecycle timings ([#22946](https://github.com/vm0-ai/vm0/issues/22946)) ([12e1316](https://github.com/vm0-ai/vm0/commit/12e13160392117b0fbe950b51fb0edc986059b90))
* **guest-agent:** reuse serialized event bodies ([#22944](https://github.com/vm0-ai/vm0/issues/22944)) ([aade076](https://github.com/vm0-ai/vm0/commit/aade076d5570c98e5a575d6cb61734df4510c4cf))

## [0.56.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.55.0...guest-agent-v0.56.0) (2026-07-23)


### Features

* **zero:** enable managed web search for all users ([#22761](https://github.com/vm0-ai/vm0/issues/22761)) ([68f7cd0](https://github.com/vm0-ai/vm0/commit/68f7cd02c24a65ca7226541f83b21ca09c0923c6))

## [0.55.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.3...guest-agent-v0.55.0) (2026-07-23)


### Features

* make managed zero web search authoritative ([#22544](https://github.com/vm0-ai/vm0/issues/22544)) ([e8e66ce](https://github.com/vm0-ai/vm0/commit/e8e66ce625f8bde4673ed4846eecd8cda15c7fa9))


### Bug Fixes

* disable vm0 model reasoning summaries ([#22337](https://github.com/vm0-ai/vm0/issues/22337)) ([9d04a70](https://github.com/vm0-ai/vm0/commit/9d04a70c81bfb3e30ed8214b767a2eb9bbb64587))
* **guest-agent:** batch queued event delivery ([#22320](https://github.com/vm0-ai/vm0/issues/22320)) ([39dd251](https://github.com/vm0-ai/vm0/commit/39dd251f3b4c688a4550cc3ec15373672d3120d5))
* **guest-agent:** bound ordinary cli stdout ingestion ([#22095](https://github.com/vm0-ai/vm0/issues/22095)) ([4641dd5](https://github.com/vm0-ai/vm0/commit/4641dd5e1340bb204866e0433eb4adbe5eb955f2))
* **guest-agent:** bound stalled codex resume startup ([#22557](https://github.com/vm0-ai/vm0/issues/22557)) ([1bf198e](https://github.com/vm0-ai/vm0/commit/1bf198e0791884e807f70a2d08fff0b93b050698))
* **guest-agent:** raise cli event delivery queue to 512 ([#22265](https://github.com/vm0-ai/vm0/issues/22265)) ([30b0657](https://github.com/vm0-ai/vm0/commit/30b06579b766b6f1966c94688c9b84cc3e7066a5))
* **guest-agent:** set Luna reasoning effort to max ([#22394](https://github.com/vm0-ai/vm0/issues/22394)) ([badea1e](https://github.com/vm0-ai/vm0/commit/badea1ee91f45ddcf83c1d51e18a0df3e1f20b33))
* **guest-agent:** set sol reasoning effort to max ([#22506](https://github.com/vm0-ai/vm0/issues/22506)) ([94040e6](https://github.com/vm0-ai/vm0/commit/94040e656e85766c5357432ab60d540679cd11a5))
* log codex quota exhaustion at info ([#22490](https://github.com/vm0-ai/vm0/issues/22490)) ([c858cd8](https://github.com/vm0-ai/vm0/commit/c858cd818f548d7423a2ba9513cef8fbe3329f9a))
* log fable usage limits at info ([#22494](https://github.com/vm0-ai/vm0/issues/22494)) ([057d0d0](https://github.com/vm0-ai/vm0/commit/057d0d00fa0fda104fecff47ef2142691b844a13))
* **vsock:** replace descendant process-group cleanup with exec cgroups ([#22013](https://github.com/vm0-ai/vm0/issues/22013)) ([302bf21](https://github.com/vm0-ai/vm0/commit/302bf216fac511a8fd6bf9c0c778cf8643f2374b))


### Documentation

* **guest-agent:** make mock scenario docs authoritative ([#22210](https://github.com/vm0-ai/vm0/issues/22210)) ([a584642](https://github.com/vm0-ai/vm0/commit/a58464252a205b643ae48a9a32eb7d3985e0877a))
* **rust:** expose private path guarantees in guest-agent ([#22710](https://github.com/vm0-ai/vm0/issues/22710)) ([ef12e55](https://github.com/vm0-ai/vm0/commit/ef12e55e627b4e627c8efbcf30867bc493222785))


### Refactoring

* **api-contracts:** type guest checkpoint requests ([#22219](https://github.com/vm0-ai/vm0/issues/22219)) ([23ebfc5](https://github.com/vm0-ai/vm0/commit/23ebfc5c758d6b986cb3bb824fb748c6a8b6ec07))
* **guest-agent:** drop masker build patterns ([#21936](https://github.com/vm0-ai/vm0/issues/21936)) ([97501a7](https://github.com/vm0-ai/vm0/commit/97501a75824a060fd3bc20b20b5f068746899b6f))
* **rust:** extract guest-agent failure diagnostics from main ([#22203](https://github.com/vm0-ai/vm0/issues/22203)) ([88fd828](https://github.com/vm0-ai/vm0/commit/88fd828d9480fc7564b7d40d1901f0a47bae7bea))


### Performance Improvements

* align session-history sidecar capacity with resume limit ([#22392](https://github.com/vm0-ai/vm0/issues/22392)) ([6eee854](https://github.com/vm0-ai/vm0/commit/6eee8548718c69c4d46afe9b1ddcd8c7babcca59))
* **guest-agent:** bound cli event delivery buffering ([#22015](https://github.com/vm0-ai/vm0/issues/22015)) ([0bde876](https://github.com/vm0-ai/vm0/commit/0bde876b83ef7781a24deb495f68ebec5e78e1cf))
* **guest-agent:** overlap artifact checkpoint pipelines ([#22709](https://github.com/vm0-ai/vm0/issues/22709)) ([ed29a8a](https://github.com/vm0-ai/vm0/commit/ed29a8aafe5c809154aa78e366e427e106522cad))

## [0.54.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.2...guest-agent-v0.54.3) (2026-07-23)


### Performance Improvements

* **guest-agent:** overlap artifact checkpoint pipelines ([#22709](https://github.com/vm0-ai/vm0/issues/22709)) ([ed29a8a](https://github.com/vm0-ai/vm0/commit/ed29a8aafe5c809154aa78e366e427e106522cad))

## [0.54.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.1...guest-agent-v0.54.2) (2026-07-23)


### Documentation

* **rust:** expose private path guarantees in guest-agent ([#22710](https://github.com/vm0-ai/vm0/issues/22710)) ([ef12e55](https://github.com/vm0-ai/vm0/commit/ef12e55e627b4e627c8efbcf30867bc493222785))

## [0.54.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.54.0...guest-agent-v0.54.1) (2026-07-23)

## [0.54.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.23...guest-agent-v0.54.0) (2026-07-22)


### Features

* make managed zero web search authoritative ([#22544](https://github.com/vm0-ai/vm0/issues/22544)) ([e8e66ce](https://github.com/vm0-ai/vm0/commit/e8e66ce625f8bde4673ed4846eecd8cda15c7fa9))

## [0.53.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.22...guest-agent-v0.53.23) (2026-07-22)


### Bug Fixes

* **guest-agent:** bound stalled codex resume startup ([#22557](https://github.com/vm0-ai/vm0/issues/22557)) ([1bf198e](https://github.com/vm0-ai/vm0/commit/1bf198e0791884e807f70a2d08fff0b93b050698))
* **guest-agent:** set sol reasoning effort to max ([#22506](https://github.com/vm0-ai/vm0/issues/22506)) ([94040e6](https://github.com/vm0-ai/vm0/commit/94040e656e85766c5357432ab60d540679cd11a5))

## [0.53.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.21...guest-agent-v0.53.22) (2026-07-22)


### Bug Fixes

* log codex quota exhaustion at info ([#22490](https://github.com/vm0-ai/vm0/issues/22490)) ([c858cd8](https://github.com/vm0-ai/vm0/commit/c858cd818f548d7423a2ba9513cef8fbe3329f9a))

## [0.53.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.20...guest-agent-v0.53.21) (2026-07-21)


### Bug Fixes

* **guest-agent:** set Luna reasoning effort to max ([#22394](https://github.com/vm0-ai/vm0/issues/22394)) ([badea1e](https://github.com/vm0-ai/vm0/commit/badea1ee91f45ddcf83c1d51e18a0df3e1f20b33))


### Performance Improvements

* align session-history sidecar capacity with resume limit ([#22392](https://github.com/vm0-ai/vm0/issues/22392)) ([6eee854](https://github.com/vm0-ai/vm0/commit/6eee8548718c69c4d46afe9b1ddcd8c7babcca59))

## [0.53.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.19...guest-agent-v0.53.20) (2026-07-21)


### Bug Fixes

* disable vm0 model reasoning summaries ([#22337](https://github.com/vm0-ai/vm0/issues/22337)) ([9d04a70](https://github.com/vm0-ai/vm0/commit/9d04a70c81bfb3e30ed8214b767a2eb9bbb64587))

## [0.53.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.18...guest-agent-v0.53.19) (2026-07-21)


### Bug Fixes

* **guest-agent:** batch queued event delivery ([#22320](https://github.com/vm0-ai/vm0/issues/22320)) ([39dd251](https://github.com/vm0-ai/vm0/commit/39dd251f3b4c688a4550cc3ec15373672d3120d5))

## [0.53.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.17...guest-agent-v0.53.18) (2026-07-21)


### Bug Fixes

* **guest-agent:** raise cli event delivery queue to 512 ([#22265](https://github.com/vm0-ai/vm0/issues/22265)) ([30b0657](https://github.com/vm0-ai/vm0/commit/30b06579b766b6f1966c94688c9b84cc3e7066a5))

## [0.53.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.16...guest-agent-v0.53.17) (2026-07-21)

## [0.53.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.15...guest-agent-v0.53.16) (2026-07-20)

## [0.53.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.14...guest-agent-v0.53.15) (2026-07-20)


### Refactoring

* **api-contracts:** type guest checkpoint requests ([#22219](https://github.com/vm0-ai/vm0/issues/22219)) ([23ebfc5](https://github.com/vm0-ai/vm0/commit/23ebfc5c758d6b986cb3bb824fb748c6a8b6ec07))

## [0.53.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.13...guest-agent-v0.53.14) (2026-07-20)


### Documentation

* **guest-agent:** make mock scenario docs authoritative ([#22210](https://github.com/vm0-ai/vm0/issues/22210)) ([a584642](https://github.com/vm0-ai/vm0/commit/a58464252a205b643ae48a9a32eb7d3985e0877a))


### Refactoring

* **rust:** extract guest-agent failure diagnostics from main ([#22203](https://github.com/vm0-ai/vm0/issues/22203)) ([88fd828](https://github.com/vm0-ai/vm0/commit/88fd828d9480fc7564b7d40d1901f0a47bae7bea))

## [0.53.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.12...guest-agent-v0.53.13) (2026-07-19)

## [0.53.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.11...guest-agent-v0.53.12) (2026-07-19)

## [0.53.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.10...guest-agent-v0.53.11) (2026-07-19)


### Bug Fixes

* **guest-agent:** bound ordinary cli stdout ingestion ([#22095](https://github.com/vm0-ai/vm0/issues/22095)) ([4641dd5](https://github.com/vm0-ai/vm0/commit/4641dd5e1340bb204866e0433eb4adbe5eb955f2))

## [0.53.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.9...guest-agent-v0.53.10) (2026-07-18)

## [0.53.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.8...guest-agent-v0.53.9) (2026-07-17)


### Bug Fixes

* **vsock:** replace descendant process-group cleanup with exec cgroups ([#22013](https://github.com/vm0-ai/vm0/issues/22013)) ([302bf21](https://github.com/vm0-ai/vm0/commit/302bf216fac511a8fd6bf9c0c778cf8643f2374b))


### Performance Improvements

* **guest-agent:** bound cli event delivery buffering ([#22015](https://github.com/vm0-ai/vm0/issues/22015)) ([0bde876](https://github.com/vm0-ai/vm0/commit/0bde876b83ef7781a24deb495f68ebec5e78e1cf))

## [0.53.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.7...guest-agent-v0.53.8) (2026-07-17)

## [0.53.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.6...guest-agent-v0.53.7) (2026-07-17)

## [0.53.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.5...guest-agent-v0.53.6) (2026-07-17)

## [0.53.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.4...guest-agent-v0.53.5) (2026-07-17)


### Refactoring

* **guest-agent:** drop masker build patterns ([#21936](https://github.com/vm0-ai/vm0/issues/21936)) ([97501a7](https://github.com/vm0-ai/vm0/commit/97501a75824a060fd3bc20b20b5f068746899b6f))

## [0.53.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.3...guest-agent-v0.53.4) (2026-07-16)


### Bug Fixes

* **runner:** classify oversized sidecars as unavailable ([#21877](https://github.com/vm0-ai/vm0/issues/21877)) ([d9fde61](https://github.com/vm0-ai/vm0/commit/d9fde61a0cce1579c4cf841e3e721aaf016eb537))

## [0.53.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.2...guest-agent-v0.53.3) (2026-07-16)


### Bug Fixes

* **runner:** contain supervised run descendants ([#21780](https://github.com/vm0-ai/vm0/issues/21780)) ([23e961c](https://github.com/vm0-ai/vm0/commit/23e961ce1b30f45ec9786e30289d870f5f436762))

## [0.53.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.1...guest-agent-v0.53.2) (2026-07-16)


### Documentation

* **guest-agent:** clarify backend exit code semantics ([#21799](https://github.com/vm0-ai/vm0/issues/21799)) ([2592598](https://github.com/vm0-ai/vm0/commit/25925984aa59135335a3e187c19e560fe8821ce7))

## [0.53.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.53.0...guest-agent-v0.53.1) (2026-07-16)


### Documentation

* **guest-agent:** correct heartbeat failure threshold wording ([#21718](https://github.com/vm0-ai/vm0/issues/21718)) ([e940472](https://github.com/vm0-ai/vm0/commit/e940472337856cd0b24f0e406750e466afa0acee))

## [0.53.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.52.0...guest-agent-v0.53.0) (2026-07-16)


### Features

* route vm0-auto through signed usage proxy ([#21437](https://github.com/vm0-ai/vm0/issues/21437)) ([cdb5bee](https://github.com/vm0-ai/vm0/commit/cdb5beeb3617f207570635e1497d57a4f796e329))


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.52.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.7...guest-agent-v0.52.0) (2026-07-15)


### Features

* default new organizations to luna with ultra reasoning ([#21323](https://github.com/vm0-ai/vm0/issues/21323)) ([d42f4c3](https://github.com/vm0-ai/vm0/commit/d42f4c30743bcb6aa087fd2c077b348b519175ca))
* run gpt-5.6 sol with ultra reasoning by default ([#20869](https://github.com/vm0-ai/vm0/issues/20869)) ([6f0a851](https://github.com/vm0-ai/vm0/commit/6f0a85112091fe2dc6c6ff24b252396f59b0af24))


### Bug Fixes

* **guest-agent:** pass codex prompts through stdin ([#21548](https://github.com/vm0-ai/vm0/issues/21548)) ([3c5e277](https://github.com/vm0-ai/vm0/commit/3c5e2779872cf7e93de88f6b10be646e2ad06ba6))
* **guest-agent:** prevent stale app-server group signaling ([#21233](https://github.com/vm0-ai/vm0/issues/21233)) ([b0f59a4](https://github.com/vm0-ai/vm0/commit/b0f59a4a2fd97493117f66f1c40e8fd29ab9ed16))
* **guest-agent:** redact secrets from event object keys ([#21626](https://github.com/vm0-ai/vm0/issues/21626)) ([e42aa15](https://github.com/vm0-ai/vm0/commit/e42aa15170c108c2abba983420326ec942dd9d19))
* **guest-agent:** reduce gpt-5.6 sol reasoning effort to xhigh ([#20887](https://github.com/vm0-ai/vm0/issues/20887)) ([005812d](https://github.com/vm0-ai/vm0/commit/005812dff55e96145cf46d43e46a2af572d832bd))
* **guest-agent:** set terra reasoning effort to low ([#21020](https://github.com/vm0-ai/vm0/issues/21020)) ([79283c9](https://github.com/vm0-ai/vm0/commit/79283c9c40735662efcd330c52d70dd16a5daa52))
* **runner:** qualify guest rootfs before idle reuse ([#21563](https://github.com/vm0-ai/vm0/issues/21563)) ([b9230c3](https://github.com/vm0-ai/vm0/commit/b9230c3bd213fb95777e0b5f84b17bbbbc3dd2e8))


### Documentation

* **guest-agent:** document active-input payload schema ([#21661](https://github.com/vm0-ai/vm0/issues/21661)) ([9154d84](https://github.com/vm0-ai/vm0/commit/9154d8490fd09856152df1ec0313d7b02885e145))
* **rust:** fix stale session metadata integration-test path ([#21118](https://github.com/vm0-ai/vm0/issues/21118)) ([02786e0](https://github.com/vm0-ai/vm0/commit/02786e039826beee978efe8ca3a7c4f885057568))


### Refactoring

* **guest-agent:** clarify runtime bootstrap contract ([#20927](https://github.com/vm0-ai/vm0/issues/20927)) ([e4121b6](https://github.com/vm0-ai/vm0/commit/e4121b6a5ea0b4002abb0f5fad0a48add7d646d9))
* **guest-agent:** name http retry budget as attempts ([#21543](https://github.com/vm0-ai/vm0/issues/21543)) ([3e114ba](https://github.com/vm0-ai/vm0/commit/3e114baaad5ed42cce2c4bfd91c4031763e4dd99))
* **guest-agent:** share event sender worker ([#21430](https://github.com/vm0-ai/vm0/issues/21430)) ([ba504b6](https://github.com/vm0-ai/vm0/commit/ba504b63ffcedefc3c89c8ab119c0e60b8b7f7d6))
* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))


### Performance Improvements

* **guest-agent:** avoid directory probes for artifact files ([#21275](https://github.com/vm0-ai/vm0/issues/21275)) ([85db30c](https://github.com/vm0-ai/vm0/commit/85db30ce599dd9f0e4ac391649e43db1b23c08ce))
* **guest-agent:** export sidecars from one history snapshot ([#21236](https://github.com/vm0-ai/vm0/issues/21236)) ([497d8c1](https://github.com/vm0-ai/vm0/commit/497d8c1c4363909f1982b3e98dd7172eb24a7b07))
* **guest-agent:** move parsed app-server payloads ([#21198](https://github.com/vm0-ai/vm0/issues/21198)) ([d89b5ec](https://github.com/vm0-ai/vm0/commit/d89b5ec872f58efd31c99ae6c9986b3b1662ee21))

## [0.51.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.6...guest-agent-v0.51.7) (2026-07-15)


### Bug Fixes

* **guest-agent:** redact secrets from event object keys ([#21626](https://github.com/vm0-ai/vm0/issues/21626)) ([e42aa15](https://github.com/vm0-ai/vm0/commit/e42aa15170c108c2abba983420326ec942dd9d19))

## [0.51.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.5...guest-agent-v0.51.6) (2026-07-15)


### Bug Fixes

* **runner:** qualify guest rootfs before idle reuse ([#21563](https://github.com/vm0-ai/vm0/issues/21563)) ([b9230c3](https://github.com/vm0-ai/vm0/commit/b9230c3bd213fb95777e0b5f84b17bbbbc3dd2e8))

## [0.51.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.4...guest-agent-v0.51.5) (2026-07-15)

## [0.51.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.3...guest-agent-v0.51.4) (2026-07-15)


### Refactoring

* **guest-agent:** name http retry budget as attempts ([#21543](https://github.com/vm0-ai/vm0/issues/21543)) ([3e114ba](https://github.com/vm0-ai/vm0/commit/3e114baaad5ed42cce2c4bfd91c4031763e4dd99))

## [0.51.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.2...guest-agent-v0.51.3) (2026-07-14)

## [0.51.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.1...guest-agent-v0.51.2) (2026-07-14)


### Refactoring

* **guest-agent:** share event sender worker ([#21430](https://github.com/vm0-ai/vm0/issues/21430)) ([ba504b6](https://github.com/vm0-ai/vm0/commit/ba504b63ffcedefc3c89c8ab119c0e60b8b7f7d6))

## [0.51.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.51.0...guest-agent-v0.51.1) (2026-07-14)

## [0.51.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.7...guest-agent-v0.51.0) (2026-07-14)


### Features

* default new organizations to luna with ultra reasoning ([#21323](https://github.com/vm0-ai/vm0/issues/21323)) ([d42f4c3](https://github.com/vm0-ai/vm0/commit/d42f4c30743bcb6aa087fd2c077b348b519175ca))

## [0.50.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.6...guest-agent-v0.50.7) (2026-07-13)


### Performance Improvements

* **guest-agent:** avoid directory probes for artifact files ([#21275](https://github.com/vm0-ai/vm0/issues/21275)) ([85db30c](https://github.com/vm0-ai/vm0/commit/85db30ce599dd9f0e4ac391649e43db1b23c08ce))

## [0.50.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.5...guest-agent-v0.50.6) (2026-07-13)


### Refactoring

* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))

## [0.50.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.4...guest-agent-v0.50.5) (2026-07-13)

## [0.50.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.3...guest-agent-v0.50.4) (2026-07-12)


### Documentation

* **rust:** fix stale session metadata integration-test path ([#21118](https://github.com/vm0-ai/vm0/issues/21118)) ([02786e0](https://github.com/vm0-ai/vm0/commit/02786e039826beee978efe8ca3a7c4f885057568))

## [0.50.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.2...guest-agent-v0.50.3) (2026-07-11)


### Bug Fixes

* **guest-agent:** set terra reasoning effort to low ([#21020](https://github.com/vm0-ai/vm0/issues/21020)) ([79283c9](https://github.com/vm0-ai/vm0/commit/79283c9c40735662efcd330c52d70dd16a5daa52))

## [0.50.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.1...guest-agent-v0.50.2) (2026-07-10)


### Refactoring

* **guest-agent:** clarify runtime bootstrap contract ([#20927](https://github.com/vm0-ai/vm0/issues/20927)) ([e4121b6](https://github.com/vm0-ai/vm0/commit/e4121b6a5ea0b4002abb0f5fad0a48add7d646d9))

## [0.50.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.50.0...guest-agent-v0.50.1) (2026-07-10)


### Bug Fixes

* **guest-agent:** reduce gpt-5.6 sol reasoning effort to xhigh ([#20887](https://github.com/vm0-ai/vm0/issues/20887)) ([005812d](https://github.com/vm0-ai/vm0/commit/005812dff55e96145cf46d43e46a2af572d832bd))

## [0.50.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.6...guest-agent-v0.50.0) (2026-07-10)


### Features

* run gpt-5.6 sol with ultra reasoning by default ([#20869](https://github.com/vm0-ai/vm0/issues/20869)) ([6f0a851](https://github.com/vm0-ai/vm0/commit/6f0a85112091fe2dc6c6ff24b252396f59b0af24))

## [0.49.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.5...guest-agent-v0.49.6) (2026-07-09)

## [0.49.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.4...guest-agent-v0.49.5) (2026-07-09)


### Documentation

* document guest-agent active input api ([#20779](https://github.com/vm0-ai/vm0/issues/20779)) ([f350e32](https://github.com/vm0-ai/vm0/commit/f350e321ef38cfc23359af477cbd2b133b4ea579))

## [0.49.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.3...guest-agent-v0.49.4) (2026-07-09)


### Performance Improvements

* cache session history with workspace images ([#20733](https://github.com/vm0-ai/vm0/issues/20733)) ([d588e5a](https://github.com/vm0-ai/vm0/commit/d588e5a9aa6e67ca18199cd74cadfa7dd4d66418))

## [0.49.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.2...guest-agent-v0.49.3) (2026-07-08)


### Bug Fixes

* add runner exit signal diagnostics ([#20674](https://github.com/vm0-ai/vm0/issues/20674)) ([bf46c07](https://github.com/vm0-ai/vm0/commit/bf46c07f8a9954576040760dfcfb3bb81ee2d1ea))
* remove minimax codex legacy base url ([#20707](https://github.com/vm0-ai/vm0/issues/20707)) ([a4a9e77](https://github.com/vm0-ai/vm0/commit/a4a9e77fe2d8e1065f1b57a9ead26565b054fa39))


### Refactoring

* centralize guest private runtime file handling ([#20671](https://github.com/vm0-ai/vm0/issues/20671)) ([24ca30c](https://github.com/vm0-ai/vm0/commit/24ca30c56b4c9b657a3aad8da2affac5a49e5b4b))

## [0.49.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.1...guest-agent-v0.49.2) (2026-07-08)

## [0.49.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.49.0...guest-agent-v0.49.1) (2026-07-08)


### Bug Fixes

* configure minimax codex runtime provider ([#20588](https://github.com/vm0-ai/vm0/issues/20588)) ([a5ae66b](https://github.com/vm0-ai/vm0/commit/a5ae66be4034b2b018175593b02b57d00a90615e))

## [0.49.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.48.0...guest-agent-v0.49.0) (2026-07-08)


### Features

* add desktop client request headers ([#20622](https://github.com/vm0-ai/vm0/issues/20622)) ([00a66b8](https://github.com/vm0-ai/vm0/commit/00a66b894644a59f4646c31799a918e6ceafa19a))

## [0.48.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.5...guest-agent-v0.48.0) (2026-07-08)


### Features

* add platform client headers to runner requests ([#20577](https://github.com/vm0-ai/vm0/issues/20577)) ([dee5306](https://github.com/vm0-ai/vm0/commit/dee53066bbc014e302a85aa085136b408e2df833))

## [0.47.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.4...guest-agent-v0.47.5) (2026-07-07)


### Documentation

* clarify codex app-server client contract ([#20541](https://github.com/vm0-ai/vm0/issues/20541)) ([4f1ff80](https://github.com/vm0-ai/vm0/commit/4f1ff80721e9effd8d8571b7ece4cb77a681c6de))

## [0.47.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.3...guest-agent-v0.47.4) (2026-07-07)

## [0.47.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.2...guest-agent-v0.47.3) (2026-07-07)

## [0.47.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.1...guest-agent-v0.47.2) (2026-07-07)


### Performance Improvements

* reuse codex zstd session history ([#20450](https://github.com/vm0-ai/vm0/issues/20450)) ([e9b1a48](https://github.com/vm0-ai/vm0/commit/e9b1a48e0e36b8ae75bceab667fd8d6f70fd2ede))

## [0.47.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.47.0...guest-agent-v0.47.1) (2026-07-07)


### Bug Fixes

* prevent compressed session history identity fallback ([#20434](https://github.com/vm0-ai/vm0/issues/20434)) ([8eba6a0](https://github.com/vm0-ai/vm0/commit/8eba6a07a04b47653e89d6a12c307cd16521ca69))

## [0.47.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.8...guest-agent-v0.47.0) (2026-07-06)


### Features

* write zstd session history blobs ([#20392](https://github.com/vm0-ai/vm0/issues/20392)) ([3e5215d](https://github.com/vm0-ai/vm0/commit/3e5215d916ca250c866480be2cb5e60382867ac6))


### Performance Improvements

* **guest-agent:** avoid buffering reasoning text twice ([#20373](https://github.com/vm0-ai/vm0/issues/20373)) ([a234c82](https://github.com/vm0-ai/vm0/commit/a234c829366b4c5ba2eeb1229b5a98498bada848))

## [0.46.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.7...guest-agent-v0.46.8) (2026-07-06)

## [0.46.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.6...guest-agent-v0.46.7) (2026-07-06)

## [0.46.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.5...guest-agent-v0.46.6) (2026-07-06)


### Refactoring

* unify session history source resolution ([#20320](https://github.com/vm0-ai/vm0/issues/20320)) ([c680f9e](https://github.com/vm0-ai/vm0/commit/c680f9ef8ccad70de72869ee56b519ebd9af6688))

## [0.46.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.4...guest-agent-v0.46.5) (2026-07-05)


### Refactoring

* centralize run payload field validation ([#20225](https://github.com/vm0-ai/vm0/issues/20225)) ([8a293a7](https://github.com/vm0-ai/vm0/commit/8a293a762a48b4828780e8e99ca59e48ca915415))

## [0.46.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.3...guest-agent-v0.46.4) (2026-07-05)

## [0.46.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.2...guest-agent-v0.46.3) (2026-07-04)

## [0.46.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.1...guest-agent-v0.46.2) (2026-07-03)


### Bug Fixes

* move runner bootstrap payloads out of env ([#19989](https://github.com/vm0-ai/vm0/issues/19989)) ([847d8d2](https://github.com/vm0-ai/vm0/commit/847d8d24372d84568133007db87c44a0ebd72b95))

## [0.46.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.46.0...guest-agent-v0.46.1) (2026-07-03)

## [0.46.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.3...guest-agent-v0.46.0) (2026-07-02)


### Features

* add Codex fast mode for ChatGPT subscription runs ([#19811](https://github.com/vm0-ai/vm0/issues/19811)) ([42e8e48](https://github.com/vm0-ai/vm0/commit/42e8e4883e548d497eb0b86a936b6be308ad1bed))


### Bug Fixes

* enforce session history read size cap ([#19878](https://github.com/vm0-ai/vm0/issues/19878)) ([efa2680](https://github.com/vm0-ai/vm0/commit/efa26801d6bdd96aa6e8522b4bfdb6c5e9944990))

## [0.45.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.2...guest-agent-v0.45.3) (2026-07-02)


### Bug Fixes

* **guest-agent:** compress non-utf8 session history uploads ([#19826](https://github.com/vm0-ai/vm0/issues/19826)) ([7b0d449](https://github.com/vm0-ai/vm0/commit/7b0d44977de5ba2b435ebbd3c9b4b557f0ca9ae3))

## [0.45.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.1...guest-agent-v0.45.2) (2026-07-02)


### Bug Fixes

* **guest-agent:** classify claude stalled streams ([#19865](https://github.com/vm0-ai/vm0/issues/19865)) ([6799682](https://github.com/vm0-ai/vm0/commit/679968254cadde4774a1082b533ccec1ca26ac74))

## [0.45.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.45.0...guest-agent-v0.45.1) (2026-07-02)


### Bug Fixes

* expose runner session ids in diagnostics ([#19755](https://github.com/vm0-ai/vm0/issues/19755)) ([e4c62e1](https://github.com/vm0-ai/vm0/commit/e4c62e17ed7de8743f89dacf9edc62f7042307d6))


### Performance Improvements

* add compressed resume session history transport ([#19667](https://github.com/vm0-ai/vm0/issues/19667)) ([ee23c32](https://github.com/vm0-ai/vm0/commit/ee23c326ccf794228d2c4f9dd6d8844cd032fc49))

## [0.45.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.44.2...guest-agent-v0.45.0) (2026-07-02)


### Features

* restore Claude Fable 5 support ([#19721](https://github.com/vm0-ai/vm0/issues/19721)) ([97a7753](https://github.com/vm0-ai/vm0/commit/97a775354429e1f3de625627e3fbeeaf01c2552d))


### Refactoring

* remove guest-common runtime path fallbacks ([#19717](https://github.com/vm0-ai/vm0/issues/19717)) ([2ce4fd7](https://github.com/vm0-ai/vm0/commit/2ce4fd76711d400408d340d4126b5224c716616b))

## [0.44.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.44.1...guest-agent-v0.44.2) (2026-07-01)


### Refactoring

* retire guest-agent env facade readers ([#19712](https://github.com/vm0-ai/vm0/issues/19712)) ([13cf0a8](https://github.com/vm0-ai/vm0/commit/13cf0a857fc2738671a0ec629e97ddc53ccc21ec))

## [0.44.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.44.0...guest-agent-v0.44.1) (2026-07-01)


### Refactoring

* remove guest-agent path facades ([#19687](https://github.com/vm0-ai/vm0/issues/19687)) ([e054c10](https://github.com/vm0-ai/vm0/commit/e054c10f91e6b91838770c1de324782a75182d9d))

## [0.44.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.6...guest-agent-v0.44.0) (2026-07-01)


### Features

* gate MiniMax Codex framework routing ([#19616](https://github.com/vm0-ai/vm0/issues/19616)) ([ed9b1de](https://github.com/vm0-ai/vm0/commit/ed9b1dea4c8b95ed78074f6fa2f9197dded9cdbc))

## [0.43.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.5...guest-agent-v0.43.6) (2026-07-01)


### Bug Fixes

* classify codex context window failures ([#19607](https://github.com/vm0-ai/vm0/issues/19607)) ([34ed0ac](https://github.com/vm0-ai/vm0/commit/34ed0ac9d29d81ffda52c5ccd6bf69915d5cc80c))


### Refactoring

* pass guest diagnostics paths explicitly ([#19574](https://github.com/vm0-ai/vm0/issues/19574)) ([5913576](https://github.com/vm0-ai/vm0/commit/5913576079f9acde38845e9b8174ad76f4b82f10))

## [0.43.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.4...guest-agent-v0.43.5) (2026-07-01)


### Bug Fixes

* align session history verification cap ([#19561](https://github.com/vm0-ai/vm0/issues/19561)) ([657cc42](https://github.com/vm0-ai/vm0/commit/657cc422cfe1e929e921a82e7bbd7ceec0d7861d))


### Refactoring

* reuse codex test setup helpers ([#19556](https://github.com/vm0-ai/vm0/issues/19556)) ([f7cd596](https://github.com/vm0-ai/vm0/commit/f7cd596258dadd281c035314fbddf4d3844ada93))
* use guest runtime for checkpoint metadata ([#19550](https://github.com/vm0-ai/vm0/issues/19550)) ([18128ab](https://github.com/vm0-ai/vm0/commit/18128ab52ff14fd9b5545304b4d142b2eb2206f8))

## [0.43.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.3...guest-agent-v0.43.4) (2026-07-01)


### Refactoring

* migrate guest-agent CLI runtime inputs ([#19514](https://github.com/vm0-ai/vm0/issues/19514)) ([bee67d0](https://github.com/vm0-ai/vm0/commit/bee67d0bc1b5d2d90b7fe0e664dc0a6579c7e16f))

## [0.43.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.2...guest-agent-v0.43.3) (2026-06-30)

## [0.43.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.1...guest-agent-v0.43.2) (2026-06-30)

## [0.43.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.43.0...guest-agent-v0.43.1) (2026-06-30)


### Bug Fixes

* **guest-agent:** reconcile codex auth state locally ([#19487](https://github.com/vm0-ai/vm0/issues/19487)) ([30d3b65](https://github.com/vm0-ai/vm0/commit/30d3b65e43d77b6cebf47181363480d2b9c0d6db))

## [0.43.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.42.2...guest-agent-v0.43.0) (2026-06-30)


### Features

* enable codex local active input ([#19463](https://github.com/vm0-ai/vm0/issues/19463)) ([5a34420](https://github.com/vm0-ai/vm0/commit/5a34420314311d9a290c195f33539d8359303660))

## [0.42.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.42.1...guest-agent-v0.42.2) (2026-06-30)


### Refactoring

* **guest-agent:** add explicit run config and paths ([#19437](https://github.com/vm0-ai/vm0/issues/19437)) ([685db73](https://github.com/vm0-ai/vm0/commit/685db7388d2c935a518b5ca25b1e37bece8834c8))

## [0.42.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.42.0...guest-agent-v0.42.1) (2026-06-30)


### Performance Improvements

* verify large session histories in guest ([#19386](https://github.com/vm0-ai/vm0/issues/19386)) ([a3f62a1](https://github.com/vm0-ai/vm0/commit/a3f62a1bd2b649e6d5dfe0a694894d020d196925))

## [0.42.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.18...guest-agent-v0.42.0) (2026-06-30)


### Features

* add Codex app-server active input steering ([#19361](https://github.com/vm0-ai/vm0/issues/19361)) ([7a231a7](https://github.com/vm0-ai/vm0/commit/7a231a7e9069c817b314aeea7408859b496c60d2))

## [0.41.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.17...guest-agent-v0.41.18) (2026-06-29)


### Refactoring

* centralize guest-agent cli termination runtime ([#19342](https://github.com/vm0-ai/vm0/issues/19342)) ([fe032a9](https://github.com/vm0-ai/vm0/commit/fe032a9714a6d577bdba1c31c0001f5cac128954))

## [0.41.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.16...guest-agent-v0.41.17) (2026-06-29)


### Refactoring

* merge agent diagnostics into guest contracts ([#19317](https://github.com/vm0-ai/vm0/issues/19317)) ([e36a711](https://github.com/vm0-ai/vm0/commit/e36a71168939a1b692a1ab80005d984697a77fe4))

## [0.41.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.15...guest-agent-v0.41.16) (2026-06-29)

## [0.41.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.14...guest-agent-v0.41.15) (2026-06-29)


### Performance Improvements

* park checkpointed session history identity ([#19270](https://github.com/vm0-ai/vm0/issues/19270)) ([e21745b](https://github.com/vm0-ai/vm0/commit/e21745be11c34b09052a27182971d4c48ab881c1))

## [0.41.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.13...guest-agent-v0.41.14) (2026-06-29)

## [0.41.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.12...guest-agent-v0.41.13) (2026-06-27)


### Bug Fixes

* guard post-result cleanup deadlines ([#19179](https://github.com/vm0-ai/vm0/issues/19179)) ([e1d2779](https://github.com/vm0-ai/vm0/commit/e1d2779ab9b32e0d195e1d5bf4d3ae7745022b5d))

## [0.41.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.11...guest-agent-v0.41.12) (2026-06-26)

## [0.41.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.10...guest-agent-v0.41.11) (2026-06-26)

## [0.41.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.9...guest-agent-v0.41.10) (2026-06-26)

## [0.41.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.8...guest-agent-v0.41.9) (2026-06-26)

## [0.41.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.7...guest-agent-v0.41.8) (2026-06-26)


### Bug Fixes

* **guest-agent:** preserve non-UTF-8 success checkpoints ([#19009](https://github.com/vm0-ai/vm0/issues/19009)) ([46271a7](https://github.com/vm0-ai/vm0/commit/46271a7264be80e4d277e0687063787951a5f518))


### Refactoring

* centralize codex session history traversal ([#19022](https://github.com/vm0-ai/vm0/issues/19022)) ([02c3a2b](https://github.com/vm0-ai/vm0/commit/02c3a2bb16a233a4f6b4af9804ba368bb46464f3))

## [0.41.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.6...guest-agent-v0.41.7) (2026-06-25)


### Bug Fixes

* classify claude stream idle timeout failures ([#18941](https://github.com/vm0-ai/vm0/issues/18941)) ([2f30e00](https://github.com/vm0-ai/vm0/commit/2f30e005ce1d4d85d55674c7f384d51c701fb0bf))

## [0.41.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.5...guest-agent-v0.41.6) (2026-06-25)


### Bug Fixes

* **runner:** downgrade claude overload result logs ([#18890](https://github.com/vm0-ai/vm0/issues/18890)) ([2751ac3](https://github.com/vm0-ai/vm0/commit/2751ac3631d328965a032a20e6b51dd0a8e358cb))

## [0.41.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.4...guest-agent-v0.41.5) (2026-06-25)


### Documentation

* document guest-agent process control handle ([#18853](https://github.com/vm0-ai/vm0/issues/18853)) ([548841b](https://github.com/vm0-ai/vm0/commit/548841be1c92ddba8dc6ad107e3e86b50f72338f))

## [0.41.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.3...guest-agent-v0.41.4) (2026-06-25)


### Refactoring

* centralize rust shell quoting ([#18833](https://github.com/vm0-ai/vm0/issues/18833)) ([d4f8878](https://github.com/vm0-ai/vm0/commit/d4f88785000474267e3462a44afea99759768e77))

## [0.41.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.2...guest-agent-v0.41.3) (2026-06-25)


### Performance Improvements

* cache guest artifact content hash sort keys ([#18834](https://github.com/vm0-ai/vm0/issues/18834)) ([cef34c2](https://github.com/vm0-ai/vm0/commit/cef34c287824c193afcdf1457ecf05e7c68de5ed))

## [0.41.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.1...guest-agent-v0.41.2) (2026-06-24)

## [0.41.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.41.0...guest-agent-v0.41.1) (2026-06-24)


### Bug Fixes

* align storage hash sort with javascript ([#18783](https://github.com/vm0-ai/vm0/issues/18783)) ([1864d86](https://github.com/vm0-ai/vm0/commit/1864d86dd39340fab24b85855ea659fe61597b59))
* **guest-agent:** bound codex session lookup ([#18780](https://github.com/vm0-ai/vm0/issues/18780)) ([96c2142](https://github.com/vm0-ai/vm0/commit/96c214200019bcc99ace849def5af2d3fea036b2))
* **runner:** classify Claude provider server errors ([#18781](https://github.com/vm0-ai/vm0/issues/18781)) ([c150950](https://github.com/vm0-ai/vm0/commit/c150950445346a61c63cb696adfa71b184c1e297))


### Documentation

* document guest-agent active input contract ([#18779](https://github.com/vm0-ai/vm0/issues/18779)) ([9c2d65b](https://github.com/vm0-ai/vm0/commit/9c2d65bce9df85faee0e2fe50c8f82df8c5f2b0d))


### Refactoring

* **guest-agent:** centralize forced cli termination ([#18782](https://github.com/vm0-ai/vm0/issues/18782)) ([93bdd96](https://github.com/vm0-ai/vm0/commit/93bdd9675b598e02ca043f780d2172ddc9b0398b))

## [0.41.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.6...guest-agent-v0.41.0) (2026-06-24)


### Features

* add codex app-server event adapter ([#18716](https://github.com/vm0-ai/vm0/issues/18716)) ([c419e1f](https://github.com/vm0-ai/vm0/commit/c419e1f84cee76d2a374a038b0efa6b29fb5e4bf))

## [0.40.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.5...guest-agent-v0.40.6) (2026-06-23)


### Bug Fixes

* preserve codex app-server failure diagnostics ([#18682](https://github.com/vm0-ai/vm0/issues/18682)) ([b84ddfa](https://github.com/vm0-ai/vm0/commit/b84ddfa3eccf095c11e0ebd75a8e55ee743ead11))

## [0.40.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.4...guest-agent-v0.40.5) (2026-06-23)

## [0.40.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.3...guest-agent-v0.40.4) (2026-06-23)


### Bug Fixes

* reject non-utf8 artifact paths ([#18625](https://github.com/vm0-ai/vm0/issues/18625)) ([27173de](https://github.com/vm0-ai/vm0/commit/27173dee401a35e30edc2c99092f1fd96b969c51))

## [0.40.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.2...guest-agent-v0.40.3) (2026-06-23)


### Refactoring

* extract active input replay test harness ([#18605](https://github.com/vm0-ai/vm0/issues/18605)) ([be58da1](https://github.com/vm0-ai/vm0/commit/be58da14b91e4498a24fb96ee0397050f1d71227))

## [0.40.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.1...guest-agent-v0.40.2) (2026-06-23)


### Bug Fixes

* classify claude output token limits ([#18579](https://github.com/vm0-ai/vm0/issues/18579)) ([2b43740](https://github.com/vm0-ai/vm0/commit/2b437408b03be9c6413705dd1b633cbc33a2a62a))


### Refactoring

* centralize guest-agent process group signaling ([#18567](https://github.com/vm0-ai/vm0/issues/18567)) ([ba20395](https://github.com/vm0-ai/vm0/commit/ba20395de33b867bdcd2799254a5d1b31ef58573))

## [0.40.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.40.0...guest-agent-v0.40.1) (2026-06-22)


### Bug Fixes

* separate Claude post-result cleanup lifecycle ([#18524](https://github.com/vm0-ai/vm0/issues/18524)) ([6dcad82](https://github.com/vm0-ai/vm0/commit/6dcad82ea6241cc2197e577867ba8bee00e13525))


### Refactoring

* centralize codex thread id contract ([#18499](https://github.com/vm0-ai/vm0/issues/18499)) ([9cecc84](https://github.com/vm0-ai/vm0/commit/9cecc8421f4073ce32b6529fff89049779a7c13e))

## [0.40.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.3...guest-agent-v0.40.0) (2026-06-22)


### Features

* add Codex app-server JSON-RPC client ([#18428](https://github.com/vm0-ai/vm0/issues/18428)) ([8c49a61](https://github.com/vm0-ai/vm0/commit/8c49a6119ad8a6fe483d518ea7f4436114b18082))

## [0.39.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.2...guest-agent-v0.39.3) (2026-06-22)


### Bug Fixes

* **guest-agent:** classify repeated claude 529 overloads ([#18465](https://github.com/vm0-ai/vm0/issues/18465)) ([c30ecd1](https://github.com/vm0-ai/vm0/commit/c30ecd12ce74aa9c817653cdbab86cf190cdaa3d))

## [0.39.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.1...guest-agent-v0.39.2) (2026-06-22)

## [0.39.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.39.0...guest-agent-v0.39.1) (2026-06-20)

## [0.39.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.3...guest-agent-v0.39.0) (2026-06-19)


### Features

* add runner local active input forwarding ([#18286](https://github.com/vm0-ai/vm0/issues/18286)) ([a798b1a](https://github.com/vm0-ai/vm0/commit/a798b1abc04cfaa960d63bee7ce8d52b8300737a))

## [0.38.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.2...guest-agent-v0.38.3) (2026-06-19)

## [0.38.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.1...guest-agent-v0.38.2) (2026-06-19)


### Performance Improvements

* **guest-agent:** resolve session markers at checkpoint time ([#18295](https://github.com/vm0-ai/vm0/issues/18295)) ([6ed71a3](https://github.com/vm0-ai/vm0/commit/6ed71a319d804f5fc58c90fc250dab81875dc5b6))

## [0.38.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.38.0...guest-agent-v0.38.1) (2026-06-18)

## [0.38.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.5...guest-agent-v0.38.0) (2026-06-18)


### Features

* **guest-agent:** add claude active input support ([#18124](https://github.com/vm0-ai/vm0/issues/18124)) ([a62e604](https://github.com/vm0-ai/vm0/commit/a62e60404961eea9a1034c0abf6f82b25364cea0))


### Refactoring

* clarify agent and cli session ids ([#18232](https://github.com/vm0-ai/vm0/issues/18232)) ([18fa8d6](https://github.com/vm0-ai/vm0/commit/18fa8d6e5740b7121b3985a19b5082a637f9d39b))

## [0.37.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.4...guest-agent-v0.37.5) (2026-06-18)

## [0.37.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.3...guest-agent-v0.37.4) (2026-06-18)

## [0.37.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.2...guest-agent-v0.37.3) (2026-06-18)

## [0.37.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.1...guest-agent-v0.37.2) (2026-06-17)


### Refactoring

* remove stale feature switches and dead code ([#18090](https://github.com/vm0-ai/vm0/issues/18090)) ([9406838](https://github.com/vm0-ai/vm0/commit/940683865a2256f83b2d92d36cf102e0fb06e131))

## [0.37.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.37.0...guest-agent-v0.37.1) (2026-06-17)


### Bug Fixes

* **guest-agent:** classify codex model capacity failures ([#18086](https://github.com/vm0-ai/vm0/issues/18086)) ([3a91436](https://github.com/vm0-ai/vm0/commit/3a91436b86726dffb016ef246d7e8e423be1afb1))

## [0.37.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.7...guest-agent-v0.37.0) (2026-06-17)


### Features

* **runner:** add local submit env overrides ([#17930](https://github.com/vm0-ai/vm0/issues/17930)) ([5c2c63c](https://github.com/vm0-ai/vm0/commit/5c2c63cdde42a7951e3af80dad7c892cdeca4de9))


### Refactoring

* **guest-agent:** split session history reader tests ([#18041](https://github.com/vm0-ai/vm0/issues/18041)) ([d698fed](https://github.com/vm0-ai/vm0/commit/d698fed994d96d838eb7aa501bfb067c57cc9732))

## [0.36.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.6...guest-agent-v0.36.7) (2026-06-17)

## [0.36.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.5...guest-agent-v0.36.6) (2026-06-16)


### Bug Fixes

* guard guest metrics arithmetic overflow ([#17889](https://github.com/vm0-ai/vm0/issues/17889)) ([04d9256](https://github.com/vm0-ai/vm0/commit/04d9256f38804eb71f8f6d09c0b54a686d98acc3))

## [0.36.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.4...guest-agent-v0.36.5) (2026-06-16)

## [0.36.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.3...guest-agent-v0.36.4) (2026-06-16)


### Bug Fixes

* log claude provider overloads as info ([#17813](https://github.com/vm0-ai/vm0/issues/17813)) ([b13b8a6](https://github.com/vm0-ai/vm0/commit/b13b8a69fea42d20ea45b1ab87e5048fda3661de))


### Refactoring

* simplify telemetry delta test fixtures ([#17847](https://github.com/vm0-ai/vm0/issues/17847)) ([c21d04b](https://github.com/vm0-ai/vm0/commit/c21d04b7673c9659af13aedae96681dfa2c275b5))

## [0.36.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.2...guest-agent-v0.36.3) (2026-06-16)

## [0.36.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.1...guest-agent-v0.36.2) (2026-06-15)

## [0.36.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.36.0...guest-agent-v0.36.1) (2026-06-15)


### Bug Fixes

* increase stuck tool watchdog timeout ([#17734](https://github.com/vm0-ai/vm0/issues/17734)) ([5b4a76e](https://github.com/vm0-ai/vm0/commit/5b4a76e0ec1b81fb9a9f4817092b058e5d01d4a6))

## [0.36.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.6...guest-agent-v0.36.0) (2026-06-15)


### Features

* send Claude prompt over stream-json stdin ([#17710](https://github.com/vm0-ai/vm0/issues/17710)) ([857762b](https://github.com/vm0-ai/vm0/commit/857762b76ed511314e37b145fa879309fe955fee))

## [0.35.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.5...guest-agent-v0.35.6) (2026-06-15)


### Bug Fixes

* classify provider credit limit failures ([#17688](https://github.com/vm0-ai/vm0/issues/17688)) ([b967f1b](https://github.com/vm0-ai/vm0/commit/b967f1b2d3cf17ba15501022f2249423feaeb9ed))


### Refactoring

* centralize guest env key names ([#17626](https://github.com/vm0-ai/vm0/issues/17626)) ([476546d](https://github.com/vm0-ai/vm0/commit/476546de9d385733c481558b422511b30b1cc45a))
* share archive manifest verification ([#17705](https://github.com/vm0-ai/vm0/issues/17705)) ([a4e5ea1](https://github.com/vm0-ai/vm0/commit/a4e5ea1c2cfbaef7ff48b8ef59278cb5150d1ab2))

## [0.35.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.4...guest-agent-v0.35.5) (2026-06-14)


### Bug Fixes

* classify claude monthly spend limits ([#17627](https://github.com/vm0-ai/vm0/issues/17627)) ([1d33872](https://github.com/vm0-ai/vm0/commit/1d338727d1886ff129603bc3c808e83ed97c1bc5))

## [0.35.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.3...guest-agent-v0.35.4) (2026-06-14)


### Refactoring

* **guest-agent:** share system log test guard ([#17582](https://github.com/vm0-ai/vm0/issues/17582)) ([edcd791](https://github.com/vm0-ai/vm0/commit/edcd79197e44c4f16a4f8ab06f01d3523b181f77))

## [0.35.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.2...guest-agent-v0.35.3) (2026-06-13)

## [0.35.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.1...guest-agent-v0.35.2) (2026-06-13)


### Bug Fixes

* remove claude fable 5 model support ([#17567](https://github.com/vm0-ai/vm0/issues/17567)) ([63733bf](https://github.com/vm0-ai/vm0/commit/63733bf637ce02afe00d0f97a2439f988c59078d))


### Documentation

* document cli failure diagnostic fields ([#17571](https://github.com/vm0-ai/vm0/issues/17571)) ([d5f6bd8](https://github.com/vm0-ai/vm0/commit/d5f6bd8fac011d570520b50dac839cf9f453a2af))

## [0.35.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.35.0...guest-agent-v0.35.1) (2026-06-12)


### Bug Fixes

* mask runtime guest-agent session ids ([#17491](https://github.com/vm0-ai/vm0/issues/17491)) ([4f6308d](https://github.com/vm0-ai/vm0/commit/4f6308dc3fb70f5115cdfb0dd1318447250dc121))

## [0.35.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.34...guest-agent-v0.35.0) (2026-06-12)


### Features

* stream assistant text deltas to web chat ([#17370](https://github.com/vm0-ai/vm0/issues/17370)) ([cbfdf74](https://github.com/vm0-ai/vm0/commit/cbfdf74761771d0142603030ca764d1f33d61479))

## [0.34.34](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.33...guest-agent-v0.34.34) (2026-06-12)


### Bug Fixes

* set fable effort to low ([#17486](https://github.com/vm0-ai/vm0/issues/17486)) ([5a190d6](https://github.com/vm0-ai/vm0/commit/5a190d6b1c9c06f11f00437ef5110f51741b0f9a))

## [0.34.33](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.32...guest-agent-v0.34.33) (2026-06-12)

## [0.34.32](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.31...guest-agent-v0.34.32) (2026-06-12)


### Bug Fixes

* mask codex setup login diagnostics ([#17458](https://github.com/vm0-ai/vm0/issues/17458)) ([ed43b5a](https://github.com/vm0-ai/vm0/commit/ed43b5ab028c02472083c544495d563918352ca1))

## [0.34.31](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.30...guest-agent-v0.34.31) (2026-06-12)


### Bug Fixes

* classify non-code runner job failures ([#17438](https://github.com/vm0-ai/vm0/issues/17438)) ([dcae0a6](https://github.com/vm0-ai/vm0/commit/dcae0a69924bbf34c4a31cea9fee74cbca9aa16d))

## [0.34.30](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.29...guest-agent-v0.34.30) (2026-06-11)

## [0.34.29](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.28...guest-agent-v0.34.29) (2026-06-11)

## [0.34.28](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.27...guest-agent-v0.34.28) (2026-06-11)

## [0.34.27](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.26...guest-agent-v0.34.27) (2026-06-11)

## [0.34.26](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.25...guest-agent-v0.34.26) (2026-06-10)

## [0.34.25](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.24...guest-agent-v0.34.25) (2026-06-10)


### Bug Fixes

* harden mock codex session persistence ([#16940](https://github.com/vm0-ai/vm0/issues/16940)) ([39374df](https://github.com/vm0-ai/vm0/commit/39374df46e1f7e42e51cc00cab388c10d39107c4))

## [0.34.24](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.23...guest-agent-v0.34.24) (2026-06-09)


### Bug Fixes

* expose api url to sandbox cli child ([#16846](https://github.com/vm0-ai/vm0/issues/16846)) ([5906d51](https://github.com/vm0-ai/vm0/commit/5906d5101232bbebf8e2ae486a28fa9bd43f06e2))

## [0.34.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.22...guest-agent-v0.34.23) (2026-06-09)


### Bug Fixes

* mask lowercase percent-encoded secrets ([#16769](https://github.com/vm0-ai/vm0/issues/16769)) ([6e3a625](https://github.com/vm0-ai/vm0/commit/6e3a6253fcd1556225dc4f2f8f3ba8caddf677e9))

## [0.34.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.21...guest-agent-v0.34.22) (2026-06-09)


### Refactoring

* split telemetry delta reader ([#16765](https://github.com/vm0-ai/vm0/issues/16765)) ([7951c52](https://github.com/vm0-ai/vm0/commit/7951c525d2b7c8dccb8647d194ad2a91aeb72d79))

## [0.34.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.20...guest-agent-v0.34.21) (2026-06-08)

## [0.34.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.19...guest-agent-v0.34.20) (2026-06-08)


### Bug Fixes

* mask multiline cli stderr secrets ([#16669](https://github.com/vm0-ai/vm0/issues/16669)) ([7712ba4](https://github.com/vm0-ai/vm0/commit/7712ba4ae44820960f55e12103791db677b353d0))

## [0.34.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.18...guest-agent-v0.34.19) (2026-06-07)


### Bug Fixes

* bound guest telemetry delta reads ([#16455](https://github.com/vm0-ai/vm0/issues/16455)) ([122b447](https://github.com/vm0-ai/vm0/commit/122b447bcfc0d0c907596da44631549cbb3eec0e))

## [0.34.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.17...guest-agent-v0.34.18) (2026-06-05)


### Bug Fixes

* **runner:** split guest-agent bootstrap env ([#16295](https://github.com/vm0-ai/vm0/issues/16295)) ([b77e7c7](https://github.com/vm0-ai/vm0/commit/b77e7c7c2dfd54e7c97596fee8ca371654e7c7b7))

## [0.34.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.16...guest-agent-v0.34.17) (2026-06-05)


### Bug Fixes

* strip guest-agent reqwest urls from logs ([#16314](https://github.com/vm0-ai/vm0/issues/16314)) ([9f063de](https://github.com/vm0-ai/vm0/commit/9f063dec7ab44c8fb9584b6122ee6797ece645bf))

## [0.34.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.15...guest-agent-v0.34.16) (2026-06-05)


### Bug Fixes

* move guest runtime files out of tmp ([#16263](https://github.com/vm0-ai/vm0/issues/16263)) ([dc87ac5](https://github.com/vm0-ai/vm0/commit/dc87ac5f4f11ada3306d4061a845de5f592d09b2))

## [0.34.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.14...guest-agent-v0.34.15) (2026-06-05)


### Bug Fixes

* preserve missing auto-memory artifact roots ([#16245](https://github.com/vm0-ai/vm0/issues/16245)) ([44cd72a](https://github.com/vm0-ai/vm0/commit/44cd72a947c260572181cf6735e2ecbfe85624d8))

## [0.34.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.13...guest-agent-v0.34.14) (2026-06-04)

## [0.34.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.12...guest-agent-v0.34.13) (2026-06-04)


### Performance Improvements

* stream artifact manifest uploads ([#16178](https://github.com/vm0-ai/vm0/issues/16178)) ([68ffd1f](https://github.com/vm0-ai/vm0/commit/68ffd1fd8f4ee6e22e22145328a1beca8bd545ad))

## [0.34.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.11...guest-agent-v0.34.12) (2026-06-04)


### Bug Fixes

* log session metadata write results ([#16118](https://github.com/vm0-ai/vm0/issues/16118)) ([30587a4](https://github.com/vm0-ai/vm0/commit/30587a4f0d248920f3e0a7db60c3460e9e1017e4))


### Documentation

* document artifact archive validation invariants ([#16132](https://github.com/vm0-ai/vm0/issues/16132)) ([6ad9dbe](https://github.com/vm0-ai/vm0/commit/6ad9dbe0b5f103c99eb00693928701a3ed0a0fcb))

## [0.34.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.10...guest-agent-v0.34.11) (2026-06-04)

## [0.34.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.9...guest-agent-v0.34.10) (2026-06-04)


### Bug Fixes

* materialize cached artifact mount roots ([#16083](https://github.com/vm0-ai/vm0/issues/16083)) ([d6a4ed3](https://github.com/vm0-ai/vm0/commit/d6a4ed307b5c4aeac8edb400aec1f65369d5f781))

## [0.34.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.8...guest-agent-v0.34.9) (2026-06-04)


### Bug Fixes

* preserve canonical auto memory missing roots ([#16053](https://github.com/vm0-ai/vm0/issues/16053)) ([a3ea955](https://github.com/vm0-ai/vm0/commit/a3ea955d7e4d968d155cd70beed1a95a1a7d1109))

## [0.34.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.7...guest-agent-v0.34.8) (2026-06-03)

## [0.34.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.6...guest-agent-v0.34.7) (2026-06-03)


### Bug Fixes

* preserve missing auto memory artifact checkpoints ([#15964](https://github.com/vm0-ai/vm0/issues/15964)) ([020dc4a](https://github.com/vm0-ai/vm0/commit/020dc4a62cd90237639396419ccee1ba85d7d4d0))

## [0.34.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.5...guest-agent-v0.34.6) (2026-06-03)

## [0.34.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.4...guest-agent-v0.34.5) (2026-06-03)

## [0.34.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.3...guest-agent-v0.34.4) (2026-06-02)

## [0.34.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.2...guest-agent-v0.34.3) (2026-06-02)


### Bug Fixes

* **guest-agent:** fail checkpoint on unreadable artifact root ([#15886](https://github.com/vm0-ai/vm0/issues/15886)) ([8812f88](https://github.com/vm0-ai/vm0/commit/8812f887b4559f8b68f36a7f1824780eacb14bfa))

## [0.34.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.1...guest-agent-v0.34.2) (2026-06-02)


### Refactoring

* split guest-agent integration tests ([#15871](https://github.com/vm0-ai/vm0/issues/15871)) ([5c14f9e](https://github.com/vm0-ai/vm0/commit/5c14f9e68f60d9daab881d15568e0891893e44b5))

## [0.34.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.34.0...guest-agent-v0.34.1) (2026-06-02)


### Bug Fixes

* classify Claude Code session/weekly limits as usage limits ([#15854](https://github.com/vm0-ai/vm0/issues/15854)) ([140fcaa](https://github.com/vm0-ai/vm0/commit/140fcaae9e2d190c91746ee556174418acdcad04)), closes [#15852](https://github.com/vm0-ai/vm0/issues/15852)

## [0.34.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.5...guest-agent-v0.34.0) (2026-06-01)


### Features

* add canonical workspace drive foundation ([#15688](https://github.com/vm0-ai/vm0/issues/15688)) ([593460a](https://github.com/vm0-ai/vm0/commit/593460ab818768ae75d1fd658a7211a2120a956b))

## [0.33.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.4...guest-agent-v0.33.5) (2026-06-01)

## [0.33.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.3...guest-agent-v0.33.4) (2026-06-01)


### Refactoring

* hardcode runner working directory ([#15606](https://github.com/vm0-ai/vm0/issues/15606)) ([132296d](https://github.com/vm0-ai/vm0/commit/132296da082953e4cdeb796c8a4432e07cd38c20))

## [0.33.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.2...guest-agent-v0.33.3) (2026-05-31)

## [0.33.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.1...guest-agent-v0.33.2) (2026-05-31)


### Performance Improvements

* **guest-agent:** move event payloads without cloning ([#15558](https://github.com/vm0-ai/vm0/issues/15558)) ([9ebd3fa](https://github.com/vm0-ai/vm0/commit/9ebd3fa72143c81e2a8e5233227f96f51c26fb02))

## [0.33.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.33.0...guest-agent-v0.33.1) (2026-05-29)


### Bug Fixes

* classify codex session limits as usage limits ([#15371](https://github.com/vm0-ai/vm0/issues/15371)) ([f37823f](https://github.com/vm0-ai/vm0/commit/f37823f8e5d8bbb2f2a278bf3e85365b0a91ed52))

## [0.33.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.26...guest-agent-v0.33.0) (2026-05-28)


### Features

* **guest-agent:** default codex reasoning_effort to xhigh for gpt-5.5 ([#15310](https://github.com/vm0-ai/vm0/issues/15310)) ([0c895c7](https://github.com/vm0-ai/vm0/commit/0c895c794a70c389fe4f03e2142512bd23474a85))

## [0.32.26](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.25...guest-agent-v0.32.26) (2026-05-28)

## [0.32.25](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.24...guest-agent-v0.32.25) (2026-05-27)


### Refactoring

* split artifact snapshot phases ([#15146](https://github.com/vm0-ai/vm0/issues/15146)) ([5fa4ef4](https://github.com/vm0-ai/vm0/commit/5fa4ef48de916bb45e392be79e8fae25ee112325))

## [0.32.24](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.23...guest-agent-v0.32.24) (2026-05-27)


### Bug Fixes

* make guest-agent api http config explicit ([#15095](https://github.com/vm0-ai/vm0/issues/15095)) ([ec72581](https://github.com/vm0-ai/vm0/commit/ec725819f03cef9d5f713050307b0e92b36aba4c))
* validate claude tool list entries ([#15092](https://github.com/vm0-ai/vm0/issues/15092)) ([7f48d58](https://github.com/vm0-ai/vm0/commit/7f48d5836cd891200f3b0a4159aad9d0ad59726f))

## [0.32.23](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.22...guest-agent-v0.32.23) (2026-05-27)

## [0.32.22](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.21...guest-agent-v0.32.22) (2026-05-26)

## [0.32.21](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.20...guest-agent-v0.32.21) (2026-05-26)

## [0.32.20](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.19...guest-agent-v0.32.20) (2026-05-25)

## [0.32.19](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.18...guest-agent-v0.32.19) (2026-05-25)

## [0.32.18](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.17...guest-agent-v0.32.18) (2026-05-25)


### Bug Fixes

* downgrade expected runner job failures ([#14845](https://github.com/vm0-ai/vm0/issues/14845)) ([01e7044](https://github.com/vm0-ai/vm0/commit/01e7044031f4d998bce986e724b3329aba72ecf2))

## [0.32.17](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.16...guest-agent-v0.32.17) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.32.16](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.15...guest-agent-v0.32.16) (2026-05-25)


### Refactoring

* share storage request file dto ([#14739](https://github.com/vm0-ai/vm0/issues/14739)) ([55dcc8d](https://github.com/vm0-ai/vm0/commit/55dcc8d2190ff326f5d0bcba3c18c36b2846e3ce))

## [0.32.15](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.14...guest-agent-v0.32.15) (2026-05-24)

## [0.32.14](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.13...guest-agent-v0.32.14) (2026-05-24)

## [0.32.13](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.12...guest-agent-v0.32.13) (2026-05-23)

## [0.32.12](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.11...guest-agent-v0.32.12) (2026-05-22)

## [0.32.11](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.10...guest-agent-v0.32.11) (2026-05-22)

## [0.32.10](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.9...guest-agent-v0.32.10) (2026-05-21)

## [0.32.9](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.8...guest-agent-v0.32.9) (2026-05-21)

## [0.32.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.7...guest-agent-v0.32.8) (2026-05-21)


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))

## [0.32.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.6...guest-agent-v0.32.7) (2026-05-20)

## [0.32.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.5...guest-agent-v0.32.6) (2026-05-20)


### Bug Fixes

* parse guest cpu stat fields strictly ([#14157](https://github.com/vm0-ai/vm0/issues/14157)) ([78f614a](https://github.com/vm0-ai/vm0/commit/78f614a3a059682798babd983b6ae9cbdd6bf7f2))
* preserve Claude failure diagnostics ([#14174](https://github.com/vm0-ai/vm0/issues/14174)) ([7cd9971](https://github.com/vm0-ai/vm0/commit/7cd99711b6ded65520acbfbe74f12d90a0f391c6))

## [0.32.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.4...guest-agent-v0.32.5) (2026-05-19)

## [0.32.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.3...guest-agent-v0.32.4) (2026-05-19)


### Bug Fixes

* enforce api start time milliseconds ([#13963](https://github.com/vm0-ai/vm0/issues/13963)) ([847d7a2](https://github.com/vm0-ai/vm0/commit/847d7a2054778457d0c65da5e75439b71b78d965))

## [0.32.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.2...guest-agent-v0.32.3) (2026-05-19)


### Bug Fixes

* disable imagegen skill for codex runner ([#13902](https://github.com/vm0-ai/vm0/issues/13902)) ([0d1d61d](https://github.com/vm0-ai/vm0/commit/0d1d61d7a323442dcd2d4d1d98404b6aaceabc0f))

## [0.32.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.1...guest-agent-v0.32.2) (2026-05-19)


### Bug Fixes

* add runner failure diagnostics ([#13880](https://github.com/vm0-ai/vm0/issues/13880)) ([3fc6515](https://github.com/vm0-ai/vm0/commit/3fc6515e53564de4668ae551ce4caaebcb943d74))

## [0.32.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.32.0...guest-agent-v0.32.1) (2026-05-18)


### Bug Fixes

* preserve codex jsonl failure diagnostics ([#13713](https://github.com/vm0-ai/vm0/issues/13713)) ([7fe2ece](https://github.com/vm0-ai/vm0/commit/7fe2ece7cb75ee6606e4cfb522cc28a19117acf3))
* preserve stderr for generic codex failures ([#13717](https://github.com/vm0-ai/vm0/issues/13717)) ([326145b](https://github.com/vm0-ai/vm0/commit/326145b4d1643757ff9a815d15ff71d3e4ec0729))


### Documentation

* document guest-agent http client constructors ([#13674](https://github.com/vm0-ai/vm0/issues/13674)) ([4ede9cc](https://github.com/vm0-ai/vm0/commit/4ede9cc0dffe19e7c6dc463dec870a03af0de0a3))

## [0.32.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.8...guest-agent-v0.32.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))


### Refactoring

* separate guest-agent session metadata capture ([#13550](https://github.com/vm0-ai/vm0/issues/13550)) ([8600e84](https://github.com/vm0-ai/vm0/commit/8600e844cdf87e0c72a717960538c6b704d65b97))

## [0.31.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.7...guest-agent-v0.31.8) (2026-05-16)


### Documentation

* **guest-agent:** document cli module boundaries ([#13531](https://github.com/vm0-ai/vm0/issues/13531)) ([5fdedd4](https://github.com/vm0-ai/vm0/commit/5fdedd493b951ddb83a2ccd18b26897e85e473e4))

## [0.31.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.6...guest-agent-v0.31.7) (2026-05-16)


### Refactoring

* **guest-agent:** extract cli termination fsm ([#13493](https://github.com/vm0-ai/vm0/issues/13493)) ([f35b86f](https://github.com/vm0-ai/vm0/commit/f35b86f3b070e089d6ede4ebe5f54328934538dc))

## [0.31.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.5...guest-agent-v0.31.6) (2026-05-15)


### Refactoring

* **guest-agent:** extract cli framework behavior ([#13481](https://github.com/vm0-ai/vm0/issues/13481)) ([0550ed2](https://github.com/vm0-ai/vm0/commit/0550ed2f6c27cc7799bdd7f8e9df32cc03796568))

## [0.31.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.4...guest-agent-v0.31.5) (2026-05-15)


### Refactoring

* **guest-agent:** extract cli event delivery state ([#13477](https://github.com/vm0-ai/vm0/issues/13477)) ([c17e528](https://github.com/vm0-ai/vm0/commit/c17e528867b79ca8cb5acb36d01aecca26f725fe))

## [0.31.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.3...guest-agent-v0.31.4) (2026-05-15)


### Refactoring

* **guest-agent:** extract cli command building ([#13460](https://github.com/vm0-ai/vm0/issues/13460)) ([fc3de78](https://github.com/vm0-ai/vm0/commit/fc3de78e4e9977623e03fb2b8aad39e24c77a943))
* **guest-agent:** extract cli stderr diagnostics ([#13467](https://github.com/vm0-ai/vm0/issues/13467)) ([4412206](https://github.com/vm0-ai/vm0/commit/4412206ad10e5bebcd77aead7e709a02f83e7ee7))

## [0.31.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.2...guest-agent-v0.31.3) (2026-05-14)


### Bug Fixes

* avoid symlink traversal in codex session lookup ([#13321](https://github.com/vm0-ai/vm0/issues/13321)) ([72f85e9](https://github.com/vm0-ai/vm0/commit/72f85e9d27b2e45d5a6981de4320096a220a039b))


### Refactoring

* share guest-agent no-follow fs helpers ([#13341](https://github.com/vm0-ai/vm0/issues/13341)) ([fc259af](https://github.com/vm0-ai/vm0/commit/fc259af7bc81253453decb672bf4583fdb0d5a14))

## [0.31.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.1...guest-agent-v0.31.2) (2026-05-14)


### Bug Fixes

* write codex auth atomically ([#13296](https://github.com/vm0-ai/vm0/issues/13296)) ([9ccf7dc](https://github.com/vm0-ai/vm0/commit/9ccf7dc7409339cf06c7aca8219915c8cf19f979))


### Refactoring

* **api-contracts:** generate codex oauth placeholders ([#13315](https://github.com/vm0-ai/vm0/issues/13315)) ([b9cd208](https://github.com/vm0-ai/vm0/commit/b9cd208dd81a1798b5e946b12581c3648bee0ddd))

## [0.31.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.31.0...guest-agent-v0.31.1) (2026-05-14)


### Bug Fixes

* handle claude zero-turn no-history runs ([#13246](https://github.com/vm0-ai/vm0/issues/13246)) ([41db91a](https://github.com/vm0-ai/vm0/commit/41db91ac41352fd0e7c2f8c5a77563d4dffd35d7))

## [0.31.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.4...guest-agent-v0.31.0) (2026-05-13)


### Features

* enable Codex memory mounting ([#12651](https://github.com/vm0-ai/vm0/issues/12651)) ([3646b72](https://github.com/vm0-ai/vm0/commit/3646b72ccafa675ff53895f797a99a1e754fd82e))
* **guest-agent:** record last event to cli exit metric ([#12272](https://github.com/vm0-ai/vm0/issues/12272)) ([dce7e82](https://github.com/vm0-ai/vm0/commit/dce7e82908b8bf8f5aff511a7995c0f8e20e66a5))


### Bug Fixes

* **guest-agent:** bound cli stderr diagnostics ([#12937](https://github.com/vm0-ai/vm0/issues/12937)) ([f640407](https://github.com/vm0-ai/vm0/commit/f64040738b75cc29b141bfa18960200fb30727f3))
* **guest-agent:** gate claude code event handling ([#12327](https://github.com/vm0-ai/vm0/issues/12327)) ([94a7634](https://github.com/vm0-ai/vm0/commit/94a7634254d9445f04bb3456d5c28e67bd15e189))
* log Codex JSONL failure diagnostics ([#13118](https://github.com/vm0-ai/vm0/issues/13118)) ([94686f0](https://github.com/vm0-ai/vm0/commit/94686f000b644c7c178dc1eb62976318cdfe006d))
* log masked cli stderr on failure ([#12786](https://github.com/vm0-ai/vm0/issues/12786)) ([0b7c456](https://github.com/vm0-ai/vm0/commit/0b7c456c731f194e7cb9165db91d4afcf7a7249a))


### Refactoring

* split guest artifact snapshot modules ([#13014](https://github.com/vm0-ai/vm0/issues/13014)) ([69d4ebc](https://github.com/vm0-ai/vm0/commit/69d4ebc10f4d72f485401640a66063e2243c115d))

## [0.30.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.3...guest-agent-v0.30.4) (2026-05-13)


### Bug Fixes

* log Codex JSONL failure diagnostics ([#13118](https://github.com/vm0-ai/vm0/issues/13118)) ([94686f0](https://github.com/vm0-ai/vm0/commit/94686f000b644c7c178dc1eb62976318cdfe006d))

## [0.30.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.2...guest-agent-v0.30.3) (2026-05-12)


### Refactoring

* split guest artifact snapshot modules ([#13014](https://github.com/vm0-ai/vm0/issues/13014)) ([69d4ebc](https://github.com/vm0-ai/vm0/commit/69d4ebc10f4d72f485401640a66063e2243c115d))

## [0.30.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.1...guest-agent-v0.30.2) (2026-05-12)


### Bug Fixes

* **guest-agent:** bound cli stderr diagnostics ([#12937](https://github.com/vm0-ai/vm0/issues/12937)) ([f640407](https://github.com/vm0-ai/vm0/commit/f64040738b75cc29b141bfa18960200fb30727f3))

## [0.30.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.30.0...guest-agent-v0.30.1) (2026-05-12)


### Bug Fixes

* log masked cli stderr on failure ([#12786](https://github.com/vm0-ai/vm0/issues/12786)) ([0b7c456](https://github.com/vm0-ai/vm0/commit/0b7c456c731f194e7cb9165db91d4afcf7a7249a))

## [0.30.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.29.1...guest-agent-v0.30.0) (2026-05-11)


### Features

* enable Codex memory mounting ([#12651](https://github.com/vm0-ai/vm0/issues/12651)) ([3646b72](https://github.com/vm0-ai/vm0/commit/3646b72ccafa675ff53895f797a99a1e754fd82e))

## [0.29.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.29.0...guest-agent-v0.29.1) (2026-05-09)


### Bug Fixes

* **guest-agent:** gate claude code event handling ([#12327](https://github.com/vm0-ai/vm0/issues/12327)) ([94a7634](https://github.com/vm0-ai/vm0/commit/94a7634254d9445f04bb3456d5c28e67bd15e189))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.4...guest-agent-v0.29.0) (2026-05-09)


### Features

* **guest-agent:** record last event to cli exit metric ([#12272](https://github.com/vm0-ai/vm0/issues/12272)) ([dce7e82](https://github.com/vm0-ai/vm0/commit/dce7e82908b8bf8f5aff511a7995c0f8e20e66a5))

## [0.28.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.3...guest-agent-v0.28.4) (2026-05-09)

## [0.28.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.2...guest-agent-v0.28.3) (2026-05-08)


### Bug Fixes

* **cli:** drain terminal run events ([#12154](https://github.com/vm0-ai/vm0/issues/12154)) ([1795a3c](https://github.com/vm0-ai/vm0/commit/1795a3c1a08f1337aa47ce95495bcac472a11d83))

## [0.28.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.1...guest-agent-v0.28.2) (2026-05-08)


### Bug Fixes

* restore codex sessions as jsonl ([#12137](https://github.com/vm0-ai/vm0/issues/12137)) ([ab3dc5b](https://github.com/vm0-ai/vm0/commit/ab3dc5b5f35105709cc22d7caf9e571c59ec5a39))

## [0.28.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.0...guest-agent-v0.28.1) (2026-05-07)


### Bug Fixes

* preserve real codex stderr through complete + telemetry pipelines ([#12082](https://github.com/vm0-ai/vm0/issues/12082)) ([748c737](https://github.com/vm0-ai/vm0/commit/748c737a1622716107888dcd228c4eccb29bc6c1))

## [0.28.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.27.1...guest-agent-v0.28.0) (2026-05-07)


### Features

* pass codex append prompt as developer instructions ([#12063](https://github.com/vm0-ai/vm0/issues/12063)) ([8fb02a3](https://github.com/vm0-ai/vm0/commit/8fb02a3feab159db1fe5dfd35a50c481d267193b))


### Bug Fixes

* use lowercase codex auth mode ([#12075](https://github.com/vm0-ai/vm0/issues/12075)) ([0a1770e](https://github.com/vm0-ai/vm0/commit/0a1770e7b9cd27c298351c611b274c054dad8cd4))

## [0.27.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.27.0...guest-agent-v0.27.1) (2026-05-06)


### Bug Fixes

* **guest-agent:** checkpoint recoverable abnormal exits ([#11984](https://github.com/vm0-ai/vm0/issues/11984)) ([f4621f4](https://github.com/vm0-ai/vm0/commit/f4621f40f47229f364e0f82a2ca3b4a49b15b15c))


### Refactoring

* **guest-agent:** initialize http client explicitly ([#11966](https://github.com/vm0-ai/vm0/issues/11966)) ([d0984f2](https://github.com/vm0-ai/vm0/commit/d0984f2d66307cfd54320e117723e7a3cfdd77ab))
* rename chatgpt-oauth-token to codex-oauth-token ([#11990](https://github.com/vm0-ai/vm0/issues/11990)) ([0659786](https://github.com/vm0-ai/vm0/commit/06597865f129656105438bc99d4d308b6c9942b7))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.5...guest-agent-v0.27.0) (2026-05-06)


### Features

* **guest-agent:** bootstrap codex chatgpt-oauth mode via fabricated auth.json ([#11881](https://github.com/vm0-ai/vm0/issues/11881)) ([d7f8127](https://github.com/vm0-ai/vm0/commit/d7f81275af55020f7de7d54a432e2d80b6a62902))

## [0.26.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.4...guest-agent-v0.26.5) (2026-05-05)

## [0.26.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.3...guest-agent-v0.26.4) (2026-05-03)


### Documentation

* document guest agent error variants ([#11735](https://github.com/vm0-ai/vm0/issues/11735)) ([5582bd2](https://github.com/vm0-ai/vm0/commit/5582bd29e15032f24f1f755a407c7824a276356d))

## [0.26.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.2...guest-agent-v0.26.3) (2026-05-03)


### Bug Fixes

* **guest-agent:** escalate forced CLI termination ([#11698](https://github.com/vm0-ai/vm0/issues/11698)) ([ad07a39](https://github.com/vm0-ai/vm0/commit/ad07a39afca3122eb73bd9092a48cbdd07d33766))


### Documentation

* **guest-agent:** document artifact env fields ([#11700](https://github.com/vm0-ai/vm0/issues/11700)) ([4fa1127](https://github.com/vm0-ai/vm0/commit/4fa1127ab2e5c189609a05e49abfd9130c6b2df8))
* **guest-agent:** document env accessors ([#11713](https://github.com/vm0-ai/vm0/issues/11713)) ([cd72661](https://github.com/vm0-ai/vm0/commit/cd726614df33729c72f601e73357ee31b3fa948e))

## [0.26.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.1...guest-agent-v0.26.2) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.26.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.0...guest-agent-v0.26.1) (2026-04-29)


### Bug Fixes

* **guest-agent:** disable claude background tasks ([#11533](https://github.com/vm0-ai/vm0/issues/11533)) ([1d85fa1](https://github.com/vm0-ai/vm0/commit/1d85fa121e26773eb1cf44b8d3f57cbf7e62c687))

## [0.26.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.25.0...guest-agent-v0.26.0) (2026-04-29)


### Features

* **api-contracts:** add rust dto generation for storage webhooks ([#11450](https://github.com/vm0-ai/vm0/issues/11450)) ([5e42002](https://github.com/vm0-ai/vm0/commit/5e42002fa5ed4aede5e0e4399913d8e0c6f51f8d))

## [0.25.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.8...guest-agent-v0.25.0) (2026-04-28)


### Features

* **guest-agent:** codex command path + framework dispatch ([#11423](https://github.com/vm0-ai/vm0/issues/11423)) ([520e73c](https://github.com/vm0-ai/vm0/commit/520e73c1e0a1d15cddd096bd3f0f7c0746605e05))
* **guest-agent:** codex session resume + checkpoint scan ([#11430](https://github.com/vm0-ai/vm0/issues/11430)) ([fd267b5](https://github.com/vm0-ai/vm0/commit/fd267b568eb9ae86b9f55d8357e486ed67285486))

## [0.24.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.7...guest-agent-v0.24.8) (2026-04-28)


### Refactoring

* deduplicate guest-agent http retries ([#11368](https://github.com/vm0-ai/vm0/issues/11368)) ([8c230e1](https://github.com/vm0-ai/vm0/commit/8c230e15592fd65892932a8b1bbffcc67562dfa1))

## [0.24.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.6...guest-agent-v0.24.7) (2026-04-27)


### Refactoring

* centralize guest system log path ([#11246](https://github.com/vm0-ai/vm0/issues/11246)) ([b93fc42](https://github.com/vm0-ai/vm0/commit/b93fc42833815fd843f073044b4e872505812025))

## [0.24.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.5...guest-agent-v0.24.6) (2026-04-27)

## [0.24.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.4...guest-agent-v0.24.5) (2026-04-27)


### Bug Fixes

* **guest-agent:** build artifact archives in-process ([#11216](https://github.com/vm0-ai/vm0/issues/11216)) ([d84a024](https://github.com/vm0-ai/vm0/commit/d84a0246d700a713c508ae5bee995131054127f9))
* **guest-agent:** delay initial telemetry tick ([#11235](https://github.com/vm0-ai/vm0/issues/11235)) ([fb8c855](https://github.com/vm0-ai/vm0/commit/fb8c855026c6fb160604f52846af7453db5f85f5))

## [0.24.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.3...guest-agent-v0.24.4) (2026-04-26)


### Bug Fixes

* **guest-agent:** reduce streaming upload allocations ([#11156](https://github.com/vm0-ai/vm0/issues/11156)) ([53cc666](https://github.com/vm0-ai/vm0/commit/53cc6663c89c41a50a754e34237ccf3eb61b0f27))
* stabilize run stdout event visibility ([#11149](https://github.com/vm0-ai/vm0/issues/11149)) ([479c57e](https://github.com/vm0-ai/vm0/commit/479c57e06f22ef706e3be087a21c4a7588bbea38))

## [0.24.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.2...guest-agent-v0.24.3) (2026-04-25)


### Refactoring

* **guest-agent:** serialize telemetry uploads via single-writer actor ([#11100](https://github.com/vm0-ai/vm0/issues/11100)) ([1a0a747](https://github.com/vm0-ai/vm0/commit/1a0a747d479e73676a87bb1cdeffaf844ebde3f4))

## [0.24.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.1...guest-agent-v0.24.2) (2026-04-24)


### Refactoring

* **guest-agent:** replace telemetry bool flag with an upload-mode enum ([#11030](https://github.com/vm0-ai/vm0/issues/11030)) ([93bbb5f](https://github.com/vm0-ai/vm0/commit/93bbb5fdf5c90d8b4fa04b986a4ae4d25143abfc))

## [0.24.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.0...guest-agent-v0.24.1) (2026-04-24)


### Bug Fixes

* **guest-agent:** align telemetry reads to newline boundary ([#11026](https://github.com/vm0-ai/vm0/issues/11026)) ([df5532c](https://github.com/vm0-ai/vm0/commit/df5532cadc03d52337bbccbba519f1ea20702e78))


### Performance Improvements

* **guest-agent:** skip vas snapshot for unchanged artifacts (part 2 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10989](https://github.com/vm0-ai/vm0/issues/10989)) ([4d4b18e](https://github.com/vm0-ai/vm0/commit/4d4b18ede0f7f13c767cb8d50726d9ea1e69c780))

## [0.24.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.23.1...guest-agent-v0.24.0) (2026-04-24)


### Features

* thread storage id from web to guest-agent (part 1 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10978](https://github.com/vm0-ai/vm0/issues/10978)) ([85f2193](https://github.com/vm0-ai/vm0/commit/85f219383d3cf7b81ca6f41358276d5388acb8c0))

## [0.23.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.23.0...guest-agent-v0.23.1) (2026-04-24)


### Performance Improvements

* **guest-agent:** parallelize session history upload and artifact snapshot ([#10962](https://github.com/vm0-ai/vm0/issues/10962)) ([27718e3](https://github.com/vm0-ai/vm0/commit/27718e39c2ff1870502dae16d72fc711c13a2cf0))

## [0.23.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.3...guest-agent-v0.23.0) (2026-04-24)


### Features

* **guest-agent:** emit mount path in artifact snapshots ([#10924](https://github.com/vm0-ai/vm0/issues/10924)) ([0db3944](https://github.com/vm0-ai/vm0/commit/0db3944a3291367d1324eba0a9101036ec58927f)), closes [#10911](https://github.com/vm0-ai/vm0/issues/10911) [#10906](https://github.com/vm0-ai/vm0/issues/10906)

## [0.22.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.2...guest-agent-v0.22.3) (2026-04-23)


### Bug Fixes

* **guest-agent:** reap cli process group after type=result ([#10879](https://github.com/vm0-ai/vm0/issues/10879)) ([#10897](https://github.com/vm0-ai/vm0/issues/10897)) ([1ac27f9](https://github.com/vm0-ai/vm0/commit/1ac27f9884d00d01ef072bef59c4b5389c053d1a))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.1...guest-agent-v0.22.2) (2026-04-23)


### Performance Improvements

* **runner:** post /complete from guest-agent after checkpoint lands ([#10787](https://github.com/vm0-ai/vm0/issues/10787)) ([69e00f0](https://github.com/vm0-ai/vm0/commit/69e00f0540348aaab547b13c7533bd97af88ad23))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.0...guest-agent-v0.22.1) (2026-04-22)


### Refactoring

* drop residual memory plumbing, legacy snapshot columns, and vm0 memory cli ([#10707](https://github.com/vm0-ai/vm0/issues/10707)) ([08f3ce8](https://github.com/vm0-ai/vm0/commit/08f3ce81273faf8ea7e2e4df67b69e774bcb963e))
* emit memory as artifacts[] entry and delete guest-agent symlink bootstrap ([#10700](https://github.com/vm0-ai/vm0/issues/10700)) ([e3f0120](https://github.com/vm0-ai/vm0/commit/e3f0120fbd90d9b9fb750e13440a9f21ea809d3a))
* **guest-agent:** simplify checkpoint session-read error handling ([#10710](https://github.com/vm0-ai/vm0/issues/10710)) ([ad9ee70](https://github.com/vm0-ai/vm0/commit/ad9ee701531c25c4ad3e7285e5a5a0d07d9d1431))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.7...guest-agent-v0.22.0) (2026-04-22)


### Features

* multi-mount artifact backend + checkpoint schema ([#10629](https://github.com/vm0-ai/vm0/issues/10629)) ([0f8af96](https://github.com/vm0-ai/vm0/commit/0f8af96cd55dedd89534ff430765cc34661a55fc))

## [0.21.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.6...guest-agent-v0.21.7) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.21.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.5...guest-agent-v0.21.6) (2026-04-21)


### Bug Fixes

* **guest-agent:** bump stuck tool timeout from 60s to 180s ([#10453](https://github.com/vm0-ai/vm0/issues/10453)) ([ef2e832](https://github.com/vm0-ai/vm0/commit/ef2e832e15813203614c4a754dc67e3033fdb4bb)), closes [#10450](https://github.com/vm0-ai/vm0/issues/10450)

## [0.21.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.4...guest-agent-v0.21.5) (2026-04-19)


### Bug Fixes

* **guest-agent:** fail fast on empty session id before checkpoint ([#10147](https://github.com/vm0-ai/vm0/issues/10147)) ([42746f0](https://github.com/vm0-ai/vm0/commit/42746f0899575f43a1d9ec411c50feda29c24be6))
* **guest-agent:** record per-op durations for checkpoint session reads ([#10141](https://github.com/vm0-ai/vm0/issues/10141)) ([10d5a57](https://github.com/vm0-ai/vm0/commit/10d5a572e7cce65a0ac65fc3776626a1849ea6ff))

## [0.21.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.3...guest-agent-v0.21.4) (2026-04-18)


### Performance Improvements

* **guest-agent:** parallelize final telemetry upload with checkpoint ([#9894](https://github.com/vm0-ai/vm0/issues/9894)) ([d799d98](https://github.com/vm0-ai/vm0/commit/d799d981f153f4d09cabe60faae8fbc30e4732d3))
* **guest-agent:** skip storages api when memory unchanged since boot ([#9921](https://github.com/vm0-ai/vm0/issues/9921)) ([e33ec2c](https://github.com/vm0-ai/vm0/commit/e33ec2c6faf747b3d1e6c68796d35f501c4bc218))

## [0.21.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.2...guest-agent-v0.21.3) (2026-04-17)


### Bug Fixes

* **guest-agent:** mask substring secrets with aho-corasick leftmost-longest ([#9808](https://github.com/vm0-ai/vm0/issues/9808)) ([f1bcd8e](https://github.com/vm0-ai/vm0/commit/f1bcd8e1c61880d22e83f3cdf328318810f4123f))

## [0.21.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.1...guest-agent-v0.21.2) (2026-04-13)


### Performance Improvements

* **guest-agent:** stream artifact upload instead of buffering entire file ([#9043](https://github.com/vm0-ai/vm0/issues/9043)) ([fb0506b](https://github.com/vm0-ai/vm0/commit/fb0506b3df97f90fc8d01e2e522c0e44aad6c856))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.0...guest-agent-v0.21.1) (2026-04-12)


### Bug Fixes

* **guest-agent:** add stdout drain deadline to prevent hanging on orphaned pipes ([#8980](https://github.com/vm0-ai/vm0/issues/8980)) ([8c7b8f1](https://github.com/vm0-ai/vm0/commit/8c7b8f15ea74fd95542568f15f6f0d0f7a9a0812))
* **guest-agent:** terminate heartbeat loop after consecutive failures ([#8992](https://github.com/vm0-ai/vm0/issues/8992)) ([1c6b658](https://github.com/vm0-ai/vm0/commit/1c6b6588ed2c6e0ccebd2ed30dd28ff09a2ed873))

## [0.21.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.20.0...guest-agent-v0.21.0) (2026-04-10)


### Features

* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))


### Bug Fixes

* **runner:** address feature switch review findings ([#8801](https://github.com/vm0-ai/vm0/issues/8801)) ([ae7eaba](https://github.com/vm0-ai/vm0/commit/ae7eabad66b72d38d16a4a01b97437bd5d962b3b))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.5...guest-agent-v0.20.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.19.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.4...guest-agent-v0.19.5) (2026-04-08)


### Bug Fixes

* **checkpoint:** use presigned url for session history upload ([#8445](https://github.com/vm0-ai/vm0/issues/8445)) ([4a019bb](https://github.com/vm0-ai/vm0/commit/4a019bb53dc2323e2981f74d02e78f4eaf2e185c))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.3...guest-agent-v0.19.4) (2026-03-31)


### Bug Fixes

* **guest-agent:** use explicit file list for tar to match manifest ([#7311](https://github.com/vm0-ai/vm0/issues/7311)) ([448f019](https://github.com/vm0-ai/vm0/commit/448f019d2ad0f2e061d6e924e31567dc02f36bfd))

## [0.19.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.2...guest-agent-v0.19.3) (2026-03-29)


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.19.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.1...guest-agent-v0.19.2) (2026-03-23)


### Bug Fixes

* use file_type() in walk_dir to avoid following symlinks ([#6184](https://github.com/vm0-ai/vm0/issues/6184)) ([b173f34](https://github.com/vm0-ai/vm0/commit/b173f34e8ed4edaf6bc169c8e18c9462c6aaa789))

## [0.19.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.0...guest-agent-v0.19.1) (2026-03-21)


### Bug Fixes

* **guest-agent:** add -- separator to prevent variadic flags from swallowing prompt ([#5789](https://github.com/vm0-ai/vm0/issues/5789)) ([b9b2fab](https://github.com/vm0-ai/vm0/commit/b9b2fabe509046af54776cb540b71deee0653c11))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.18.0...guest-agent-v0.19.0) (2026-03-20)


### Features

* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.17.0...guest-agent-v0.18.0) (2026-03-19)


### Features

* add storage version lineage table for artifact/memory parent tracking ([#5501](https://github.com/vm0-ai/vm0/issues/5501)) ([c2b3115](https://github.com/vm0-ai/vm0/commit/c2b311506f65889215730b27a4ad0d244c651747))
* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)

## [0.17.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.4...guest-agent-v0.17.0) (2026-03-18)


### Features

* add append-system-prompt support to runner and guest-agent ([#5384](https://github.com/vm0-ai/vm0/issues/5384)) ([37aaa76](https://github.com/vm0-ai/vm0/commit/37aaa76b7acdf8c24f2928590de54317870c3a21)), closes [#5375](https://github.com/vm0-ai/vm0/issues/5375)

## [0.16.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.3...guest-agent-v0.16.4) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.16.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.2...guest-agent-v0.16.3) (2026-03-15)


### Bug Fixes

* **guest-agent:** add stuck-tool watchdog for claude code network tool hang ([#4833](https://github.com/vm0-ai/vm0/issues/4833)) ([7b71fa7](https://github.com/vm0-ai/vm0/commit/7b71fa78f9d7155f08059118391416ecf785027f)), closes [#4785](https://github.com/vm0-ai/vm0/issues/4785)

## [0.16.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.1...guest-agent-v0.16.2) (2026-03-12)


### Bug Fixes

* add explicit file size limits to storage upload handlers ([#4586](https://github.com/vm0-ai/vm0/issues/4586)) ([d899fdb](https://github.com/vm0-ai/vm0/commit/d899fdbc23a30b5e586fa0755a22f0c4d6826d8b)), closes [#4576](https://github.com/vm0-ai/vm0/issues/4576)

## [0.16.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.0...guest-agent-v0.16.1) (2026-03-10)


### Bug Fixes

* skip retry on non-retriable 4xx errors in guest-agent ([#4121](https://github.com/vm0-ai/vm0/issues/4121)) ([713b5df](https://github.com/vm0-ai/vm0/commit/713b5df9ee89a7f893bae3940c7895dd3f24b4d7))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.1...guest-agent-v0.16.0) (2026-03-08)


### Features

* **sandbox:** symlink vm0 memory to claude code auto-memory path ([#3928](https://github.com/vm0-ai/vm0/issues/3928)) ([9aaf0e4](https://github.com/vm0-ai/vm0/commit/9aaf0e4fc8a3b530693e939307b86e9db6514fef))


### Bug Fixes

* **guest-agent:** switch cpu measurement to delta-based tracking ([#3918](https://github.com/vm0-ai/vm0/issues/3918)) ([7adfee2](https://github.com/vm0-ai/vm0/commit/7adfee2664f408fe0b3a51e41aeafcf6293d7477))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.0...guest-agent-v0.15.1) (2026-03-07)


### Bug Fixes

* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.1...guest-agent-v0.15.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))


### Bug Fixes

* **guest-agent:** decouple event sending from stdout reading loop ([#3884](https://github.com/vm0-ai/vm0/issues/3884)) ([c27e8a1](https://github.com/vm0-ai/vm0/commit/c27e8a1daf8447b317aba356d127fdc9405a84d0))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.0...guest-agent-v0.14.1) (2026-03-07)


### Bug Fixes

* **guest-agent:** defer event sends during stdout drain to prevent drops ([#3859](https://github.com/vm0-ai/vm0/issues/3859)) ([843fda1](https://github.com/vm0-ai/vm0/commit/843fda1a212d53ea424c2d28a09e8d7b09c2a5a7))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.13.0...guest-agent-v0.14.0) (2026-03-04)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.13.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.3...guest-agent-v0.13.0) (2026-03-03)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.2...guest-agent-v0.12.3) (2026-03-02)


### Bug Fixes

* **guest-agent:** detect cli process exit to prevent hanging on orphaned pipes ([#3409](https://github.com/vm0-ai/vm0/issues/3409)) ([2381c50](https://github.com/vm0-ai/vm0/commit/2381c50ef76c889e8ab03ee37c994950fd0bd9e3))
* **guest-agent:** only set claude-specific env vars for claude-code cli ([#3416](https://github.com/vm0-ai/vm0/issues/3416)) ([df3f92c](https://github.com/vm0-ai/vm0/commit/df3f92cff9611b017b04d6adfc5a1d43d36376ee))


### Performance Improvements

* **guest-agent:** disable non-essential cli network traffic on startup ([#3407](https://github.com/vm0-ai/vm0/issues/3407)) ([4b45f77](https://github.com/vm0-ai/vm0/commit/4b45f773632adbb1d3323eeab7e7a4c95506842b))

## [0.12.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.1...guest-agent-v0.12.2) (2026-03-02)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.0...guest-agent-v0.12.1) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.11.0...guest-agent-v0.12.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.11.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.10.0...guest-agent-v0.11.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.10.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.9.0...guest-agent-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.5...guest-agent-v0.9.0) (2026-03-01)


### Performance Improvements

* **guest-agent:** pre-warm dns cache before cli spawn ([#3298](https://github.com/vm0-ai/vm0/issues/3298)) ([b3e3fb2](https://github.com/vm0-ai/vm0/commit/b3e3fb268df1e3a3570070d81be3c6506277ed2d))

## [0.8.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.4...guest-agent-v0.8.5) (2026-02-28)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.3...guest-agent-v0.8.4) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.2...guest-agent-v0.8.3) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.1...guest-agent-v0.8.2) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.0...guest-agent-v0.8.1) (2026-02-26)


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.7.0...guest-agent-v0.8.0) (2026-02-25)


### Features

* add intermediate e2e telemetry metrics for cli cold-start diagnosis ([#3251](https://github.com/vm0-ai/vm0/issues/3251)) ([82121a9](https://github.com/vm0-ai/vm0/commit/82121a93edcca096cacc787283edbc7275b88f42)), closes [#3250](https://github.com/vm0-ai/vm0/issues/3250)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.6.0...guest-agent-v0.7.0) (2026-02-25)


### Features

* **guest-agent:** add api_to_cli_init telemetry metric ([#3245](https://github.com/vm0-ai/vm0/issues/3245)) ([b1f78b6](https://github.com/vm0-ai/vm0/commit/b1f78b63fbf1da80dd37ee92c3602319cfd1ecdc)), closes [#3244](https://github.com/vm0-ai/vm0/issues/3244)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.5.0...guest-agent-v0.6.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.4.0...guest-agent-v0.5.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.3.0...guest-agent-v0.4.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.2.0...guest-agent-v0.3.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.1.0...guest-agent-v0.2.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))
